/**
 * OrbitNest -> NestCore rename compatibility, end to end against the built
 * server with an in-memory MCP client and a fake API on localhost:
 *   - tools/list returns only nestcore_* names
 *   - tools/call with an old orbitnest_* name runs the renamed tool
 *   - ~/.orbitnest/credentials.json is used when ~/.nestcore has none
 *   - ORBITNEST_API_URL is used when NESTCORE_API_URL is unset
 *   - a workspace's .orbitnest/config.json is detected
 *
 *   npm run build && node test/legacy-tool-names.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// ── isolated home + workspace with only pre-rename files ────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nestcore-mcp-legacy-'));
const home = path.join(tmp, 'home');
const work = path.join(tmp, 'work');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', email: 'legacy@example.com', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
fs.mkdirSync(path.join(home, '.orbitnest'), { recursive: true });
fs.writeFileSync(path.join(home, '.orbitnest', 'credentials.json'), JSON.stringify({ access_token: token, user: { id: 'u1', email: 'legacy@example.com' } }));
fs.mkdirSync(path.join(work, '.orbitnest'), { recursive: true });
fs.writeFileSync(path.join(work, '.orbitnest', 'config.json'), JSON.stringify({ projectId: 'p-legacy', projectSlug: 'legacy' }));

// ── fake API ────────────────────────────────────────────────────────────────
const hits = [];
const api = http.createServer((req, res) => {
  hits.push({ url: req.url, auth: req.headers.authorization });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: { id: 'u1', email: 'legacy@example.com' } }));
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const apiUrl = `http://127.0.0.1:${api.address().port}`;

process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.NESTCORE_API_URL;
process.env.ORBITNEST_API_URL = apiUrl;
process.env.LOG_LEVEL = 'error';
process.chdir(work);

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { loadConfig } = await import('../dist/config.js');
const { createServer } = await import('../dist/server.js');
const { setLogLevel } = await import('../dist/utils/logger.js');
setLogLevel('error');
const { withLegacyToolNames, toCurrentToolName } = await import('../dist/legacy-tool-names.js');
const { NestCoreClient, OrbitNestClient } = await import('../dist/sdk/nestcore.client.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`); };

ok('toCurrentToolName maps orbitnest_* and leaves others', toCurrentToolName('orbitnest_get_profile') === 'nestcore_get_profile' && toCurrentToolName('nestcore_x') === 'nestcore_x');
ok('OrbitNestClient is a deprecated alias of NestCoreClient', OrbitNestClient === NestCoreClient);

const config = loadConfig();
ok('ORBITNEST_API_URL is used when NESTCORE_API_URL is unset', config.apiUrl === apiUrl);
ok('server identity is "nestcore"', config.serverName === 'nestcore');

const { server } = await createServer(config);
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await server.connect(withLegacyToolNames(serverSide));
const client = new Client({ name: 'legacy-test', version: '0.0.0' });
await client.connect(clientSide);

const { tools } = await client.listTools();
ok(`tools/list returns ${tools.length} tools`, tools.length > 100);
ok('every listed tool is nestcore_*', tools.every((t) => t.name.startsWith('nestcore_')));
ok('no listed tool is orbitnest_*', !tools.some((t) => t.name.startsWith('orbitnest_')));
ok('no tool description mentions an orbitnest_* tool', !tools.some((t) => /orbitnest_[a-z]/.test(t.description ?? '')));

const viaNew = await client.callTool({ name: 'nestcore_get_profile', arguments: {} });
const viaOld = await client.callTool({ name: 'orbitnest_get_profile', arguments: {} });
ok('nestcore_get_profile works with the legacy credentials file', !viaNew.isError && viaNew.content[0].text.includes('legacy@example.com'));
ok('orbitnest_get_profile (old name) runs the same tool', !viaOld.isError && viaOld.content[0].text === viaNew.content[0].text);
ok('both calls reached the API with the legacy token', hits.filter((h) => h.url === '/api/auth/profile' && h.auth === `Bearer ${token}`).length === 2);

const unknown = await client.callTool({ name: 'orbitnest_does_not_exist', arguments: {} }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
ok('an unknown old name still fails cleanly', unknown.isError === true);

const ctxRes = await client.readResource({ uri: 'project://context' });
const ctxText = ctxRes.contents[0].text;
ok('legacy .orbitnest/config.json selects the active project', !ctxText.includes('No active project'));

await client.close();
api.closeAllConnections();
await new Promise((r) => api.close(r));
process.chdir(os.tmpdir()); // Windows can't remove the cwd
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
console.log(`\nOK — ${passed} legacy-name checks passed.`);
process.exitCode = 0;
