import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { AddressInfo } from 'node:net';
import type { AppConfig } from '../types/config.types.js';
import { logger } from '../utils/logger.js';

export type OAuthProvider = 'google' | 'github' | 'apple';

/** Tokens captured from the browser-loopback OAuth flow. Shape matches what
 *  SessionService.setAuthFromSignin() expects from a password signin. */
export interface OAuthLoginResult {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  provider: OAuthProvider;
}

/** How long we wait for the user to finish the browser flow before giving up. */
const LOGIN_TIMEOUT_MS = 180_000;

/**
 * Browser + loopback OAuth login (the `gh auth login` / `gcloud` pattern).
 *
 * Why a loopback relay and not a direct callback: the API delivers tokens in a
 * URL *fragment* to the studio callback page, and a fragment is never sent to a
 * server. The studio page reads the fragment client-side and re-emits the
 * tokens to this loopback server as a *query string* (server-readable), keyed
 * by a one-time `cli_state` nonce we mint here and thread through the API's
 * signed OAuth state. See studio/src/app/auth/oauth/callback/page.tsx.
 *
 * Nothing on the backend changes — we reuse the existing
 * `/api/auth/oauth/{provider}/start` flow (PKCE, signed state, token issuance).
 */
export async function loginWithOAuth(
  provider: OAuthProvider,
  config: AppConfig,
): Promise<OAuthLoginResult> {
  const cliState = randomBytes(16).toString('hex');

  return new Promise<OAuthLoginResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn();
    };

    const server = http.createServer((req, res) => {
      // Only the loopback callback path matters; ignore favicon etc.
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (reqUrl.pathname !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      const q = reqUrl.searchParams;
      const returnedState = q.get('cli_state');
      const oauthError = q.get('oauth_error') ?? q.get('error');
      const accessToken = q.get('access_token');
      const refreshToken = q.get('refresh_token');

      // CSRF: the relay must carry back the exact nonce we minted. A local
      // process that didn't go through our signed-state round-trip can't.
      if (returnedState !== cliState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(resultPage('error', 'State mismatch — please retry sign-in from your terminal.'));
        return;
      }

      if (oauthError) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(resultPage('error', `Sign-in failed: ${escapeHtml(oauthError)}`));
        finish(() => reject(new Error(`OAuth sign-in failed: ${oauthError}`)));
        return;
      }

      if (!accessToken || !refreshToken) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(resultPage('error', 'Sign-in did not return tokens. Please retry.'));
        finish(() => reject(new Error('OAuth sign-in did not return tokens')));
        return;
      }

      const expiresInRaw = q.get('expires_in');
      const expiresIn = expiresInRaw ? Number(expiresInRaw) : undefined;

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(resultPage('success', 'Signed in successfully. You can close this tab and return to your terminal.'));
      finish(() =>
        resolve({
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: Number.isFinite(expiresIn) ? expiresIn : undefined,
          provider,
        }),
      );
    });

    const timer = setTimeout(() => {
      finish(() =>
        reject(new Error(`Timed out after ${LOGIN_TIMEOUT_MS / 1000}s waiting for browser sign-in.`)),
      );
    }, LOGIN_TIMEOUT_MS);

    server.on('error', (err) => {
      finish(() => reject(new Error(`Could not start local login server: ${err.message}`)));
    });

    // Bind to an OS-assigned free port on loopback only.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const startUrl = buildStartUrl(config, provider, port, cliState);
      logger.info('Opening browser for OAuth sign-in', { provider, port });
      logger.info(`If your browser did not open, visit: ${startUrl}`);
      openBrowser(startUrl);
    });
  });
}

/**
 * Build the API start URL. `redirect_to` is a studio-origin *path* carrying our
 * loopback port + nonce; the API's safeRedirect() preserves the query string,
 * and the studio callback page relays the fragment tokens back to us.
 */
function buildStartUrl(
  config: AppConfig,
  provider: OAuthProvider,
  port: number,
  cliState: string,
): string {
  const base = config.apiUrl.replace(/\/+$/, '');
  const basePath = (config.apiBasePath || '/api').replace(/\/+$/, '');
  const url = new URL(`${base}${basePath}/auth/oauth/${provider}/start`);
  // URLSearchParams encodes the nested ?cli_port=…&cli_state=… safely.
  url.searchParams.set(
    'redirect_to',
    `/auth/oauth/callback?cli_port=${port}&cli_state=${cliState}`,
  );
  return url.toString();
}

/** Open the default browser without adding a dependency. Best-effort. */
function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    const [cmd, args] =
      platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', (err) => {
      logger.warn('Failed to open browser automatically', { error: err.message });
    });
    child.unref();
  } catch (err) {
    logger.warn('Failed to open browser automatically', {
      error: err instanceof Error ? err.message : String(err),
    });
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
