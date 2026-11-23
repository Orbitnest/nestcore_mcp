/**
 * Code Mode vs direct tools, end to end against a LOCAL NestCore stack, with a
 * context-cost comparison. NOT part of `npm test` (needs the docker stack).
 *
 *   NESTCORE_E2E=1 node test/code-mode-e2e.mjs
 *   NESTCORE_E2E=1 NESTCORE_E2E_API=http://localhost:3002 node test/code-mode-e2e.mjs
 *
 * Creates a throwaway admin (e2e-codemode-<rand>@example.test), a project
 * "E2E codemode" with 6 tables of different row counts, then runs the same
 * task — list tables, count rows in each, top 5 by count — twice:
 *   (a) code mode: tools/list + one search + one execute
 *   (b) tools mode: tools/list + nestcore_get_schema + one nestcore_execute_sql per table
 * and prints bytes / estimated tokens of everything that would enter the
 * model's context. Cleans up the project (API) and the admin (psql via docker
 * exec on orbitnest-postgres, same as studio_api/e2e/local/cleanup.mjs).
 */
import assert from 'node:assert';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.env.NESTCORE_E2E !== '1') {
  console.log('code-mode-e2e: skipped (set NESTCORE_E2E=1 to run against the local docker stack).');
  process.exit(0);
}
const API = (process.env.NESTCORE_E2E_API || 'http://localhost:3002').replace(/\/+$/, '');
const MAILPIT = process.env.NESTCORE_E2E_MAILPIT || 'http://localhost:8025';
if (/(orbitnest|nestcore)\.io/i.test(API)) throw new Error('refusing to run against production');

const rand = crypto.randomBytes(4).toString('hex');
const EMAIL = `e2e-codemode-${rand}@example.test`;
const PASSWORD = 'E2e-Pass123!';
const rndIp = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${1 + ((Math.random() * 250) | 0)}`;

async function http(method, p, { token, body } = {}) {
  const headers = { 'x-forwarded-for': rndIp() };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(API + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signupAdmin() {
  const direct = await http('POST', '/api/auth/signup', { body: { full_name: 'E2E codemode', email: EMAIL, password: PASSWORD } });
  if (direct.status === 201 && direct.json?.access_token) return direct.json;
  // Fall back to the verified flow (Mailpit catches the code), like studio_api/e2e/local.
  const since = Date.now();
  const rv = await http('POST', '/api/auth/request-verification', { body: { full_name: 'E2E codemode', email: EMAIL, password: PASSWORD } });
  assert.strictEqual(rv.status, 200, `request-verification: ${rv.status} ${rv.text.slice(0, 200)}`);
  let code;
  for (let i = 0; i < 50 && !code; i++) {
    const list = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${EMAIL}"`)}&limit=5`)).json();
    const hit = (list.messages || []).find((m) => new Date(m.Created).getTime() >= since - 2000);
    if (hit) {
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json();
      code = /code[^\d]{0,60}?(\d{4})(?!\d)/i.exec(`${full.Text || ''} ${(full.HTML || '').replace(/<[^>]+>/g, ' ')}`)?.[1];
    }
    if (!code) await sleep(400);
  }
  assert.ok(code, 'no verification code in Mailpit');
  const r = await http('POST', '/api/auth/signup-with-verification', { body: { full_name: 'E2E codemode', email: EMAIL, password: PASSWORD, code } });
  assert.strictEqual(r.status, 201, `signup-with-verification: ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
}

function psql(sql, db = 'orbitnest_central') {
  return execFileSync('docker', ['exec', '-i', 'orbitnest-postgres', 'psql', '-U', 'postgres', '-d', db, '-At', '-v', 'ON_ERROR_STOP=1'], {
    input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

// ── context accounting ──────────────────────────────────────────────────────
const bytes = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v));
function meter(label) {
  const items = [];
  return {
    label,
    items,
    add(what, v) { items.push({ what, bytes: bytes(v) }); },
    total() { return items.reduce((s, i) => s + i.bytes, 0); },
  };
}

let tmp;
let token;
let projectId;
let exitCode = 0;
try {
  // ── fixtures ──────────────────────────────────────────────────────────────
  const auth = await signupAdmin();
  token = auth.access_token;
  const onboard = await http('POST', '/api/auth/complete-onboarding', { token, body: { organization_name: `E2E Org codemode ${rand}` } });
  assert.ok([200, 201].includes(onboard.status), `complete-onboarding: ${onboard.status} ${onboard.text.slice(0, 200)}`);
  const prof = await http('GET', '/api/auth/profile', { token });
  const me = prof.json?.data ?? prof.json;
  const proj = await http('POST', '/api/projects', { token, body: { name: 'E2E codemode' } });
  assert.strictEqual(proj.status, 201, `create project: ${proj.status} ${proj.text.slice(0, 300)}`);
  const project = proj.json?.data ?? proj.json;
  projectId = project.id;
  console.log(`admin ${EMAIL}, project ${projectId} (${project.slug})`);

  const TABLES = { customers: 42, orders: 137, products: 25, invoices: 88, reviews: 9, events: 260 };
  for (const [t, n] of Object.entries(TABLES)) {
    for (const stmt of [
      `CREATE TABLE "${t}" (id serial PRIMARY KEY, label text NOT NULL, created_at timestamptz DEFAULT now())`,
      `INSERT INTO "${t}" (label) SELECT '${t} ' || g FROM generate_series(1, ${n}) g`,
    ]) {
      const r = await http('POST', `/api/projects/${projectId}/database/sql`, { token, body: { sql: stmt } });
      assert.ok([200, 201].includes(r.status) && r.json?.success !== false, `fixture SQL: ${r.status} ${r.text.slice(0, 300)}`);
    }
  }
  const expectedTop5 = Object.entries(TABLES).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([table, rows]) => ({ table, rows }));

  // ── MCP server env: temp HOME with credentials, workspace marker ─────────
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nestcore-mcp-e2e-'));
  const home = path.join(tmp, 'home');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(path.join(home, '.nestcore'), { recursive: true });
  fs.mkdirSync(path.join(work, '.nestcore'), { recursive: true });
  fs.writeFileSync(path.join(home, '.nestcore', 'credentials.json'), JSON.stringify({
    access_token: auth.access_token,
    refresh_token: auth.refresh_token,
    user: { id: me?.id ?? me?.admin?.id, email: EMAIL },
  }));
  fs.writeFileSync(path.join(work, '.nestcore', 'config.json'), JSON.stringify({ projectId, projectSlug: project.slug }));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.NESTCORE_API_URL = API;
  process.env.LOG_LEVEL = 'error';
  process.chdir(work);

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { loadConfig } = await import('../dist/config.js');
  const { createServer } = await import('../dist/server.js');
  const { setLogLevel } = await import('../dist/utils/logger.js');
  setLogLevel('error');

  async function connect(mode) {
    process.env.NESTCORE_MCP_MODE = mode;
    const { server } = await createServer(loadConfig());
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: 'code-mode-e2e', version: '0.0.0' });
    await client.connect(c);
    return client;
  }
  async function call(client, m, name, args) {
    m.add(`${name} arguments`, args);
    const res = await client.callTool({ name, arguments: args });
    m.add(`${name} result`, res.content);
    if (res.isError) throw new Error(`${name} failed: ${res.content[0]?.text}`);
    return res.content[0].text;
  }

  // ── (a) code mode ─────────────────────────────────────────────────────────
  const a = meter('code mode');
  const codeClient = await connect('code');
  a.add('server instructions', codeClient.getInstructions() ?? '');
  a.add('tools/list', (await codeClient.listTools()).tools);
  const searchText = await call(codeClient, a, 'search', { query: 'list tables count rows', limit: 4 });
  assert.ok(searchText.includes('getSchema') && searchText.includes('executeSql'), 'search found getSchema + executeSql');
  const snippet = [
    'const { tables } = await nestcore.db.getSchema({});',
    'const counts = [];',
    "for (const t of tables.filter((t) => t.schema === 'public' && !t.isAuthTable)) {",
    '  const r = await nestcore.db.executeSql({ sql: `SELECT count(*)::int AS n FROM "${t.name}"` });',
    '  const row = (r.data ?? r.rows ?? [])[0] ?? {};',
    '  counts.push({ table: t.name, rows: Number(row.n) });',
    '}',
    'return counts.sort((x, y) => y.rows - x.rows).slice(0, 5);',
  ].join('\n');
  const execText = await call(codeClient, a, 'execute', { code: snippet });
  const execBody = JSON.parse(execText);
  const codeTop5 = execBody.result;
  console.log(`code mode: ${execBody.calls} bridge calls, result ${JSON.stringify(codeTop5)}`);
  assert.deepStrictEqual(codeTop5, expectedTop5, 'code mode top 5');
  await codeClient.close();

  // ── (b) tools mode ────────────────────────────────────────────────────────
  const b = meter('tools mode');
  const toolsClient = await connect('tools');
  b.add('server instructions', toolsClient.getInstructions() ?? '');
  b.add('tools/list', (await toolsClient.listTools()).tools);
  const schema = JSON.parse(await call(toolsClient, b, 'nestcore_get_schema', {}));
  const counts = [];
  for (const t of schema.tables.filter((t) => t.schema === 'public' && !t.isAuthTable)) {
    const r = JSON.parse(await call(toolsClient, b, 'nestcore_execute_sql', { sql: `SELECT count(*)::int AS n FROM "${t.name}"` }));
    counts.push({ table: t.name, rows: Number((r.data ?? r.rows ?? [])[0]?.n) });
  }
  const toolsTop5 = counts.sort((x, y) => y.rows - x.rows).slice(0, 5);
  console.log(`tools mode: ${1 + counts.length} tool calls, result ${JSON.stringify(toolsTop5)}`);
  assert.deepStrictEqual(toolsTop5, expectedTop5, 'tools mode top 5');
  await toolsClient.close();

  // ── comparison ────────────────────────────────────────────────────────────
  const tok = (n) => Math.round(n / 4);
  const fmt = (n) => String(n).padStart(9);
  const listOf = (m) => m.items.find((i) => i.what === 'tools/list').bytes;
  const instrOf = (m) => m.items.find((i) => i.what === 'server instructions').bytes;
  const callsOf = (m) => m.total() - listOf(m) - instrOf(m);
  const rows = [
    ['server instructions', instrOf(a), instrOf(b)],
    ['tools/list payload', listOf(a), listOf(b)],
    ['tool calls (args + results)', callsOf(a), callsOf(b)],
    ['TOTAL', a.total(), b.total()],
  ];
  console.log('\nContext cost — same task (6 tables: list, count rows, top 5). Tokens are an ESTIMATE (chars / 4).');
  console.log(`${'component'.padEnd(30)}| ${'code bytes'.padStart(10)} | ${'~tokens'.padStart(9)} | ${'tools bytes'.padStart(11)} | ${'~tokens'.padStart(9)}`);
  console.log(`${'-'.repeat(30)}+${'-'.repeat(12)}+${'-'.repeat(11)}+${'-'.repeat(13)}+${'-'.repeat(10)}`);
  for (const [k, x, y] of rows) {
    console.log(`${k.padEnd(30)}| ${String(x).padStart(10)} | ${fmt(tok(x))} | ${String(y).padStart(11)} | ${fmt(tok(y))}`);
  }
  console.log(`\nmodel round trips: code mode ${a.items.filter((i) => i.what.endsWith('result')).length} tool calls, tools mode ${b.items.filter((i) => i.what.endsWith('result')).length} tool calls`);
  console.log(`code mode uses ${(100 * a.total() / b.total()).toFixed(1)}% of the tools-mode context (${(b.total() / a.total()).toFixed(1)}x less).`);
  console.log('\nper item (code mode):');
  for (const i of a.items) console.log(`  ${i.what.padEnd(28)} ${String(i.bytes).padStart(7)} B`);
  console.log('per item (tools mode, calls aggregated):');
  const agg = new Map();
  for (const i of b.items) agg.set(i.what, (agg.get(i.what) ?? 0) + i.bytes);
  for (const [k, v] of agg) console.log(`  ${k.padEnd(36)} ${String(v).padStart(7)} B`);
} catch (e) {
  exitCode = 1;
  console.error('E2E FAILED:', e && e.stack ? e.stack : e);
} finally {
  // ── cleanup ───────────────────────────────────────────────────────────────
  try {
    if (projectId && token) {
      const d = await http('DELETE', `/api/projects/${projectId}`, { token });
      console.log(`\ncleanup: DELETE project → ${d.status}`);
    }
  } catch (e) {
    console.error('cleanup (project) failed:', e.message);
  }
  try {
    const esc = EMAIL.replace(/'/g, "''");
    const org = psql(`SELECT organization_id FROM admins WHERE email = '${esc}'`);
    psql(`DELETE FROM admins WHERE email = '${esc}'`);
    if (org) psql(`DELETE FROM organizations o WHERE o.id = '${org}' AND o.name LIKE 'E2E Org %' AND NOT EXISTS (SELECT 1 FROM admins a WHERE a.organization_id = o.id)`);
    const left = psql(`SELECT count(*) FROM admins WHERE email = '${esc}'`);
    console.log(`cleanup: admin removed (${left} left)${org ? ', org removed' : ''}`);
  } catch (e) {
    console.error('cleanup (admin) failed — run studio_api/e2e/local/cleanup.mjs --yes:', e.message.split('\n')[0]);
  }
  if (tmp) {
    process.chdir(os.tmpdir());
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  process.exitCode = exitCode;
}
