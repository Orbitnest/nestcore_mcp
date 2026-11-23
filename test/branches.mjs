/**
 * Project branch tools end to end against the built server with an in-memory
 * MCP client and a fake API:
 *   - nestcore_list_branches / create / changes hit /api/projects/:id/branches[...]
 *   - nestcore_promote_branch previews by default and never POSTs without apply
 *   - apply sends every pending change, functions, buckets, NEW jobs only, and
 *     no env vars / auth settings unless asked
 *   - nestcore_reset_branch refuses without confirm: true
 *
 *   npm run build && node test/branches.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nestcore-mcp-branches-'));
const home = path.join(tmp, 'home');
const work = path.join(tmp, 'work');
fs.mkdirSync(work, { recursive: true });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', email: 'owner@example.com', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
fs.mkdirSync(path.join(home, '.nestcore'), { recursive: true });
fs.writeFileSync(path.join(home, '.nestcore', 'credentials.json'), JSON.stringify({ access_token: token, user: { id: 'u1', email: 'owner@example.com' } }));

const P = '11111111-1111-4111-8111-111111111111';
const D = '22222222-2222-4222-8222-222222222222';
const list = {
  enabled: true, production_id: P,
  branches: [
    { id: P, branch: 'production', slug: 'shop', provisioning_status: 'ready', pending_changes: 0 },
    { id: D, branch: 'development', slug: 'shop__dev', provisioning_status: 'ready', pending_changes: 2 },
  ],
};
const preview = {
  branch_id: D, production_id: P, production_name: 'Shop', drift: { checked: true, changed: false },
  changes: [
    { id: 'c1', seq: 1, change_type: 'sql', statement: 'CREATE TABLE t (id int)', destructive: false },
    { id: 'c2', seq: 2, change_type: 'sql', statement: 'ALTER TABLE u DROP COLUMN x', destructive: true },
  ],
  config: {
    functions: [{ name: 'checkout', status: 'new' }],
    env_vars: [{ name: 'STRIPE_KEY' }],
    buckets: [{ name: 'avatars' }],
    jobs: [{ name: 'nightly', status: 'new' }, { name: 'hourly', status: 'changed' }],
    auth_settings: { changed: true },
  },
};

const hits = [];
const api = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined;
    hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const base = `/api/projects/${P}/branches`;
    if (req.method === 'GET' && req.url === base) return send(200, { success: true, data: list });
    if (req.method === 'POST' && req.url === `${base}/development`) return send(201, { success: true, data: list.branches[1] });
    if (req.method === 'GET' && req.url === `${base}/development/changes`) return send(200, { success: true, data: preview.changes });
    if (req.method === 'GET' && req.url === `${base}/development/promote`) return send(200, { success: true, data: preview });
    if (req.method === 'POST' && req.url === `${base}/development/promote`) return send(200, { success: true, data: { promotion_id: 'p1', status: 'succeeded', summary: { changes: body.change_ids.length } } });
    if (req.method === 'POST' && req.url === `${base}/development/reset`) return send(200, { success: true, data: list.branches[1] });
    send(200, { data: { id: 'u1', email: 'owner@example.com' } });
  });
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.NESTCORE_API_URL = `http://127.0.0.1:${api.address().port}`;
process.env.LOG_LEVEL = 'error';
process.env.NESTCORE_MCP_MODE = 'tools'; // these checks call the direct tools
process.chdir(work);

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { loadConfig } = await import('../dist/config.js');
const { createServer } = await import('../dist/server.js');
const { setLogLevel } = await import('../dist/utils/logger.js');
setLogLevel('error');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`); };
const { server } = await createServer(loadConfig());
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await server.connect(serverSide);
const client = new Client({ name: 'branches-test', version: '0.0.0' });
await client.connect(clientSide);
const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
const last = () => hits[hits.length - 1];

const { tools } = await client.listTools();
for (const n of ['nestcore_list_branches', 'nestcore_create_branch', 'nestcore_reset_branch', 'nestcore_branch_changes', 'nestcore_promote_branch']) {
  ok(`${n} is listed`, tools.some((t) => t.name === n));
}

const listed = await call('nestcore_list_branches', { projectId: P });
ok('list_branches unwraps the envelope', listed.production_id === P && listed.branches.length === 2);
ok('list_branches sends the admin token', last().auth === `Bearer ${token}` && last().url === `/api/projects/${P}/branches`);

const created = await call('nestcore_create_branch', { projectId: P });
ok('create_branch POSTs /development', last().method === 'POST' && last().url.endsWith('/branches/development') && created.slug === 'shop__dev');

const changes = await call('nestcore_branch_changes', { projectId: P });
ok('branch_changes returns the pending changes', Array.isArray(changes) && changes.length === 2);

const before = hits.length;
const pv = await call('nestcore_promote_branch', { projectId: P });
ok('promote without apply is a preview', pv.preview === true && pv.changes.length === 2);
ok('preview never POSTs', hits.slice(before).every((h) => h.method === 'GET'));

const applied = await call('nestcore_promote_branch', { projectId: P, apply: true, confirmDestructive: true });
const sent = last().body;
ok('apply POSTs every pending change', last().method === 'POST' && sent.change_ids.join() === 'c1,c2' && applied.status === 'succeeded');
ok('apply sends functions and buckets', sent.functions.join() === 'checkout' && sent.buckets.join() === 'avatars');
ok('apply sends NEW jobs only', sent.jobs.join() === 'nightly');
ok('env vars and auth settings stay off unless asked', sent.env_vars.length === 0 && sent.auth_settings === false);
ok('confirm/ack flags pass through', sent.confirm_destructive === true && sent.acknowledge_drift === false);

await call('nestcore_promote_branch', { projectId: P, apply: true, includeEnvVars: true, includeAuthSettings: true, changeIds: ['c1'] });
ok('opt-ins and a change subset are honoured', last().body.env_vars.join() === 'STRIPE_KEY' && last().body.auth_settings === true && last().body.change_ids.join() === 'c1');

const refused = await client.callTool({ name: 'nestcore_reset_branch', arguments: { projectId: P } });
ok('reset_branch refuses without confirm: true', refused.isError === true);
await call('nestcore_reset_branch', { projectId: P, confirm: true });
ok('reset_branch sends confirm: true', last().url.endsWith('/development/reset') && last().body.confirm === true);

await client.close();
api.closeAllConnections();
await new Promise((r) => api.close(r));
process.chdir(os.tmpdir());
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
console.log(`\nOK — ${passed} branch checks passed.`);
process.exitCode = 0;
