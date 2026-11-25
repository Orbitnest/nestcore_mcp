/**
 * Untrusted-workspace hardening (run after `npm run build`):
 *   - a `.env` in the working directory (e.g. a cloned repo the MCP host opened)
 *     is NOT loaded, so it cannot pick the API host, base path or switch off the
 *     SQL guard; NESTCORE_ENV_FILE is the explicit opt-in
 *   - the sign-in handoff base refuses base paths that change the host
 *     (`.evil.example/x`, `:8080`), cleartext non-loopback http and userinfo
 *   - the browser opener never goes through a shell (no `cmd /c start`), only
 *     opens http(s) URLs and refuses control characters / shell metacharacters
 *
 *   npm run build && node test/local-config.mjs
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ok, passedCount } from './code-mode-helpers.mjs';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const { oauthApiBase, browserCommand, loginWithOAuth } = await import('../dist/auth/oauth-login.js');

console.log('cwd .env');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nestcore-mcp-dotenv-'));
const envFile = path.join(work, '.env');
fs.writeFileSync(envFile, [
  'NESTCORE_API_URL=https://api.evil.example',
  'NESTCORE_API_BASE_PATH=.evil.example/x',
  'ENABLE_SQL_GUARD=false',
  'NESTCORE_TEST_DOTENV_SENTINEL=from-cwd',
].join('\n'));

/** loadConfig() in a fresh process whose cwd holds the hostile .env. */
const configIn = (extraEnv = {}) => new Promise((resolve, reject) => {
  const env = { ...process.env };
  for (const k of ['NESTCORE_API_URL', 'ORBITNEST_API_URL', 'NESTCORE_API_BASE_PATH', 'ORBITNEST_API_BASE_PATH',
    'NESTCORE_ENV_FILE', 'ORBITNEST_ENV_FILE', 'ENABLE_SQL_GUARD', 'NESTCORE_TEST_DOTENV_SENTINEL']) delete env[k];
  Object.assign(env, extraEnv);
  const script = `const { loadConfig } = await import(${JSON.stringify(pathToFileURL(path.join(dist, 'config.js')).href)});
const c = loadConfig();
console.log(JSON.stringify({ apiUrl: c.apiUrl, apiBasePath: c.apiBasePath, sqlGuard: c.enableSqlGuard, sentinel: process.env.NESTCORE_TEST_DOTENV_SENTINEL ?? null }));`;
  execFile(process.execPath, ['--input-type=module', '-e', script], { cwd: work, env }, (err, stdout, stderr) => {
    if (err) return reject(new Error(`${err.message}\n${stderr}`));
    resolve(JSON.parse(stdout.trim().split('\n').pop()));
  });
});

let c = await configIn();
ok('a .env in the working directory is not loaded', c.sentinel === null);
ok('cwd .env cannot choose the API host', c.apiUrl === 'https://api.nestcore.io');
ok('cwd .env cannot choose the API base path', c.apiBasePath === '/api');
ok('cwd .env cannot switch off the SQL guard', c.sqlGuard === true);
c = await configIn({ NESTCORE_ENV_FILE: envFile });
ok('NESTCORE_ENV_FILE is the explicit opt-in', c.sentinel === 'from-cwd' && c.apiUrl === 'https://api.evil.example' && c.sqlGuard === false);
c = await configIn({ NESTCORE_ENV_FILE: envFile, NESTCORE_API_URL: 'https://api.nestcore.io' });
ok('real env vars still win over the env file', c.apiUrl === 'https://api.nestcore.io');

console.log('sign-in handoff base');
ok('default base', oauthApiBase('https://api.nestcore.io', '/api') === 'https://api.nestcore.io/api');
ok('trailing slashes trimmed', oauthApiBase('https://api.nestcore.io/', '/api/') === 'https://api.nestcore.io/api');
ok('missing base path → /api', oauthApiBase('https://api.nestcore.io', '') === 'https://api.nestcore.io/api');
ok('loopback http allowed (dev)', oauthApiBase('http://127.0.0.1:3000', '/api') === 'http://127.0.0.1:3000/api');
const throws = (name, fn, re) => {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  ok(name, err && (!re || re.test(err.message)));
};
throws('base path ".evil.example/x" (suffix host) refused', () => oauthApiBase('https://api.nestcore.io', '.evil.example/x'), /BASE_PATH/);
throws('base path ":8080/x" (port change) refused', () => oauthApiBase('http://127.0.0.1', ':8080/x'), /BASE_PATH/);
throws('base path "@evil.example" refused', () => oauthApiBase('https://api.nestcore.io', '@evil.example'), /BASE_PATH/);
throws('base path with cmd metacharacters refused', () => oauthApiBase('https://api.nestcore.io', '/x|calc'), /BASE_PATH/);
throws('cleartext http to a remote host refused', () => oauthApiBase('http://api.nestcore.io', '/api'), /https/);
throws('userinfo in the API URL refused', () => oauthApiBase('https://user:pw@api.nestcore.io', '/api'), /API_URL/);
throws('non-URL API URL refused', () => oauthApiBase('not a url', '/api'), /API_URL/);
let rejected = null;
await loginWithOAuth('google', { apiUrl: 'https://api.nestcore.io', apiBasePath: '.evil.example/x' }).catch((e) => { rejected = e; });
ok('loginWithOAuth rejects before any request with a host-changing base path', rejected && /BASE_PATH/.test(rejected.message));

console.log('browser opener');
const url = 'https://api.nestcore.io/api/auth/oauth/google/start?redirect_to=%2Fauth%2Fhandoff%3Fh%3Dh1&x=1';
const win = browserCommand(url, 'win32');
ok('win32 uses url.dll FileProtocolHandler, not cmd', win && win[0] === 'rundll32' && win[1][0] === 'url.dll,FileProtocolHandler' && win[1][1] === url);
ok('win32 URL is passed unmodified (no ^& escaping)', win[1][1].includes('&x=1'));
ok('darwin uses open', JSON.stringify(browserCommand(url, 'darwin')) === JSON.stringify(['open', [url]]));
ok('linux uses xdg-open', JSON.stringify(browserCommand(url, 'linux')) === JSON.stringify(['xdg-open', [url]]));
ok('loopback http allowed', browserCommand('http://127.0.0.1:3000/x', 'win32') !== null);
for (const bad of [
  'https://api.nestcore.io/x|calc',
  'https://api.nestcore.io/x^&calc',
  'https://api.nestcore.io/x"&calc',
  'https://api.nestcore.io/x calc',
  'https://api.nestcore.io/x\ncalc',
  'https://api.nestcore.io/x\u0007',
  'https://api.nestcore.io/x<y>',
  'javascript:alert(1)',
  'file:///C:/Windows/System32/calc.exe',
  'ms-settings:',
  '-a Calculator',
  'not a url',
]) {
  ok(`refused: ${JSON.stringify(bad)}`, ['win32', 'darwin', 'linux'].every((p) => browserCommand(bad, p) === null));
}

const src = fs.readFileSync(path.join(dist, 'auth', 'oauth-login.js'), 'utf8');
ok('no cmd /c start left in the built opener', !/['"]cmd['"]/.test(src) && !/['"]\/c['"]/.test(src));

fs.rmSync(work, { recursive: true, force: true });
console.log(`\nOK — ${passedCount()} local-config checks passed.`);
