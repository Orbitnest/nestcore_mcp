/**
 * Shared setup for the Code Mode test scripts: an isolated HOME with a signed-in
 * credentials file, a fake NestCore API on 127.0.0.1, and an in-memory MCP
 * client connected to createServer(loadConfig()) for a given env.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

let passed = 0;
export function ok(name, cond) {
  if (!cond) throw new Error(`FAILED: ${name}`);
  passed++;
  console.log(`  ✓ ${name}`);
}
export const passedCount = () => passed;

/** Temp HOME with ~/.nestcore/credentials.json and an empty workspace dir (cwd). */
export function isolatedHome(label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `nestcore-mcp-${label}-`));
  const home = path.join(tmp, 'home');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(work, { recursive: true });
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', email: 'owner@example.com', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  fs.mkdirSync(path.join(home, '.nestcore'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.nestcore', 'credentials.json'),
    JSON.stringify({ access_token: token, user: { id: 'u1', email: 'owner@example.com' } }),
  );
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.chdir(work);
  return {
    tmp,
    home,
    work,
    token,
    cleanup() {
      process.chdir(os.tmpdir()); // Windows can't remove the cwd
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

/**
 * Fake API: every request is recorded in `hits`; `routes(req, body)` may return
 * `[status, json]`, otherwise a generic `{ success: true, data: {} }`.
 */
export async function fakeApi(routes = () => undefined) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
      hits.push({ method: req.method, url: req.url, body });
      const out = routes(req, body) ?? [200, { success: true, data: {} }];
      res.writeHead(out[0], { 'content-type': 'application/json' });
      res.end(JSON.stringify(out[1]));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  process.env.NESTCORE_API_URL = url;
  return {
    url,
    hits,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

/**
 * Start a server for `env` (NESTCORE_* overrides) and connect a client.
 * `clientCapabilities` / `onElicit` let a test act as an elicitation-capable client.
 */
export async function connect(env = {}, { clientCapabilities, onElicit } = {}) {
  for (const k of ['NESTCORE_MCP_MODE', 'NESTCORE_MCP_ALLOW_WRITES', 'NESTCORE_MCP_EXEC_TIMEOUT_MS', 'NESTCORE_MCP_EXEC_MEMORY_MB', 'NESTCORE_MCP_EXEC_MAX_CALLS', 'NESTCORE_MCP_EXEC_MAX_OUTPUT_BYTES']) {
    delete process.env[k];
  }
  Object.assign(process.env, env);
  process.env.LOG_LEVEL = 'error';
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { ElicitRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const { loadConfig } = await import('../dist/config.js');
  const { createServer } = await import('../dist/server.js');
  const { withLegacyToolNames } = await import('../dist/legacy-tool-names.js');
  const { setLogLevel } = await import('../dist/utils/logger.js');
  setLogLevel('error');

  const created = await createServer(loadConfig());
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await created.server.connect(withLegacyToolNames(serverSide));
  const client = new Client({ name: 'code-mode-test', version: '0.0.0' }, { capabilities: clientCapabilities ?? {} });
  if (onElicit) client.setRequestHandler(ElicitRequestSchema, onElicit);
  await client.connect(clientSide);

  /** Run an execute snippet; returns { isError, body } with the parsed JSON body. */
  const execute = async (code, extraArgs = {}) => {
    const res = await client.callTool({ name: 'execute', arguments: { code, ...extraArgs } });
    return { isError: res.isError === true, body: JSON.parse(res.content[0].text) };
  };
  const callTool = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    let body;
    try { body = JSON.parse(res.content[0].text); } catch { body = res.content[0].text; }
    return { isError: res.isError === true, body, raw: res };
  };
  return { ...created, client, execute, callTool, close: () => client.close() };
}
