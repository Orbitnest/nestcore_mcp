import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { AddressInfo } from 'node:net';
import type { AppConfig } from '../types/config.types.js';
import { logger } from '../utils/logger.js';

export type OAuthProvider = 'google' | 'github' | 'apple';

/** Tokens from the sign-in. Shape matches what SessionService.setAuthFromSignin() expects. */
export interface OAuthLoginResult {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  provider: OAuthProvider;
}

/** How long we wait for the user to finish in the browser: the provider sign-in,
 *  two-factor if it's on, and the Approve click. Matches the handoff's lifetime. */
const LOGIN_TIMEOUT_MS = 300_000;

/** Readable text for errors the browser side can report. */
export function describeOAuthError(code: string): string {
  switch (code) {
    case 'mfa_cancelled':
      return 'Sign-in was cancelled on the NestCore two-factor page.';
    case 'mfa_required':
      return 'This account has two-factor authentication on and the NestCore page could not ask for the code. ' +
        'Retry nestcore_login, or sign in with nestcore_admin_signin and mfa_code.';
    case 'access_denied':
      return 'Sign-in was cancelled.';
    default:
      return `OAuth sign-in failed: ${code}`;
  }
}

const base64url = (b: Buffer) => b.toString('base64url');
export const s256 = (verifier: string) => base64url(createHash('sha256').update(verifier).digest());

const isLoopback = (host: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);

/**
 * `${apiUrl}${apiBasePath}` for the sign-in handoff, refusing anything that
 * would move it off the configured API host. A base path is a plain path
 * (`/api`); raw concatenation of e.g. `.evil.example/x` or `:8080` would
 * otherwise change the authority. Like NestCoreClient, http is only allowed
 * for loopback (the handoff code and PKCE verifier travel on this URL).
 */
export function oauthApiBase(apiUrl: string, apiBasePath?: string): string {
  const basePath = (apiBasePath || '/api').replace(/\/+$/, '');
  if (basePath && !/^\/[A-Za-z0-9._~\-\/]*$/.test(basePath)) {
    throw new Error(`Invalid NESTCORE_API_BASE_PATH "${apiBasePath}": use a plain path such as /api.`);
  }
  let origin: URL;
  try {
    origin = new URL(apiUrl);
  } catch {
    throw new Error(`Invalid NESTCORE_API_URL: ${apiUrl}`);
  }
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && isLoopback(origin.hostname))) {
    throw new Error(`Refusing to sign in through ${apiUrl}: use https:// (http is only allowed for localhost).`);
  }
  if (origin.username || origin.password || origin.search || origin.hash) {
    throw new Error(`Invalid NESTCORE_API_URL: ${apiUrl}`);
  }
  const base = `${apiUrl.replace(/\/+$/, '')}${basePath}`;
  if (new URL(base).origin !== origin.origin) {
    throw new Error(`Invalid NESTCORE_API_BASE_PATH "${apiBasePath}": it changes the API host.`);
  }
  return base;
}

/**
 * The command that opens `url` in the default browser, run WITHOUT a shell
 * (args array, shell: false), or null when the URL is not a plain http(s) URL.
 * On Windows `cmd /c start` would re-parse the URL (`|`, `^`, `%` ...), so
 * url.dll's FileProtocolHandler is used, as in the CLI.
 */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] | null {
  // Control characters, whitespace, quotes and shell metacharacters never
  // appear in the sign-in URL we build (query values are percent-encoded);
  // refusing them keeps any opener from seeing extra arguments or operators.
  if (/[\u0000- \u007f-\u009f"<>^`{|}\\]/.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

/**
 * Browser sign-in through NestCore's PKCE handoff (the flow the NestCore Agent
 * desktop app uses), so no token ever appears in a URL or in browser history:
 *
 *  1. We mint a PKCE verifier + challenge and a state nonce, listen on a
 *     one-time 127.0.0.1 port, and register a handoff with the API
 *     (GET /auth/handoff/start, redirect_uri = that loopback).
 *  2. The browser signs in with the chosen provider (and two-factor, if on) and
 *     lands on Studio's approval page for this handoff. Approve sends the
 *     browser to our loopback with only a one-time `code` and our `state`.
 *  3. We exchange code + verifier at POST /auth/handoff/token for the session.
 *     The code is useless without the verifier, which never leaves this process,
 *     and it is single-use and expires in 5 minutes.
 */
export async function loginWithOAuth(provider: OAuthProvider, config: AppConfig): Promise<OAuthLoginResult> {
  const api = oauthApiBase(config.apiUrl, config.apiBasePath);
  const verifier = base64url(randomBytes(32)); // 43 chars
  const challenge = s256(verifier);
  const state = randomBytes(16).toString('hex');

  return new Promise<OAuthLoginResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn();
    };

    const server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (reqUrl.pathname !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const q = reqUrl.searchParams;
      // CSRF: only the redirect of OUR handoff carries our state.
      if (q.get('state') !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(resultPage('error', 'State mismatch — please retry sign-in from your editor.'));
        return;
      }
      const error = q.get('error') ?? q.get('oauth_error');
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(resultPage('error', describeOAuthError(error)));
        finish(() => reject(new Error(describeOAuthError(error))));
        return;
      }
      const code = q.get('code');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(resultPage('error', 'Sign-in did not return a code. Please retry.'));
        finish(() => reject(new Error('OAuth sign-in did not return a code')));
        return;
      }
      try {
        const r = await fetch(`${api}/auth/handoff/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'NestCore MCP' },
          body: JSON.stringify({ code, code_verifier: verifier }),
        });
        const body = (await r.json().catch(() => ({}))) as Record<string, any>;
        if (!r.ok || !body.access_token || !body.refresh_token) {
          const msg = body?.message || `Code exchange failed (${r.status})`;
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(resultPage('error', `Sign-in failed: ${msg}`));
          finish(() => reject(new Error(`OAuth sign-in failed: ${msg}`)));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(resultPage('success', 'Signed in successfully. You can close this tab and return to your editor.'));
        finish(() =>
          resolve({
            access_token: body.access_token,
            refresh_token: body.refresh_token,
            expires_in: typeof body.expires_in === 'number' ? body.expires_in : undefined,
            provider,
          }),
        );
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'text/html' });
        res.end(resultPage('error', 'Could not reach NestCore to finish sign-in. Please retry.'));
        finish(() => reject(new Error(`OAuth code exchange failed: ${err instanceof Error ? err.message : String(err)}`)));
      }
    });

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Timed out after ${LOGIN_TIMEOUT_MS / 1000}s waiting for browser sign-in.`)));
    }, LOGIN_TIMEOUT_MS);

    server.on('error', (err) => finish(() => reject(new Error(`Could not start local login server: ${err.message}`))));

    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address() as AddressInfo;
      try {
        const startUrl = new URL(`${api}/auth/handoff/start`);
        startUrl.searchParams.set('redirect_uri', `http://127.0.0.1:${port}/callback`);
        startUrl.searchParams.set('state', state);
        startUrl.searchParams.set('code_challenge', challenge);
        startUrl.searchParams.set('code_challenge_method', 'S256');
        startUrl.searchParams.set('client', 'nestcore-mcp');
        const r = await fetch(startUrl, { headers: { Accept: 'application/json', 'User-Agent': 'NestCore MCP' } });
        const h = (await r.json().catch(() => ({}))) as { handoffId?: string; message?: string };
        if (!r.ok || !h.handoffId) throw new Error(h.message || `handoff start failed (${r.status})`);
        // Provider sign-in first, then Studio's approval page for this handoff.
        const browserUrl = new URL(`${api}/auth/oauth/${provider}/start`);
        browserUrl.searchParams.set('redirect_to', `/auth/handoff?h=${h.handoffId}`);
        logger.info('Opening browser for sign-in', { provider, port });
        logger.info(`If your browser did not open, visit: ${browserUrl.toString()}`);
        openBrowser(browserUrl.toString());
      } catch (err) {
        finish(() => reject(new Error(`Could not start sign-in: ${err instanceof Error ? err.message : String(err)}`)));
      }
    });
  });
}

/** Open the default browser without adding a dependency. Best-effort. */
function openBrowser(url: string): void {
  if (process.env.NESTCORE_NO_BROWSER === '1') return; // tests / headless: the URL is logged above
  const command = browserCommand(url);
  if (!command) {
    logger.warn('Not opening the sign-in URL automatically: it is not a plain http(s) URL');
    return;
  }
  try {
    const [cmd, args] = command;
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, shell: false, windowsHide: true });
    child.on('error', (err) => logger.warn('Failed to open browser automatically', { error: err.message }));
    child.unref();
  } catch (err) {
    logger.warn('Failed to open browser automatically', { error: err instanceof Error ? err.message : String(err) });
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Minimal self-contained page shown in the browser tab after the redirect. */
function resultPage(kind: 'success' | 'error', message: string): string {
  const color = kind === 'success' ? '#0ea5a4' : '#b91c1c';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>NestCore</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f8fafc;color:#0f172a;">
  <div style="max-width:420px;margin:80px auto;padding:32px;background:#fff;border:1px solid #e2e8f0;border-radius:14px;text-align:center;">
    <div style="font-size:18px;font-weight:700;color:${color};margin-bottom:10px;">NestCore</div>
    <p style="font-size:14px;line-height:1.6;color:#334155;margin:0;">${escapeHtml(message)}</p>
  </div>
</body></html>`;
}
