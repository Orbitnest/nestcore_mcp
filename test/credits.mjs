/**
 * Workspace AI credit tools and the credit/collection error contract, end to
 * end against the built server with an in-memory MCP client and a fake API:
 *   - nestcore_get_credits / nestcore_set_credit_cap / nestcore_buy_credits hit
 *     /api/billing/credits[/cap|/checkout] with the admin token
 *   - nestcore_buy_credits returns the checkout URL and never claims payment
 *   - 402 CREDITS_EXHAUSTED (balance, spend_cap) keeps reason + buyUrl
 *   - 402 QUOTA_EXCEEDED reason ai_collections explains the collection limit
 *
 *   npm run build && node test/credits.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nestcore-mcp-credits-'));
const home = path.join(tmp, 'home');
const work = path.join(tmp, 'work');
fs.mkdirSync(work, { recursive: true });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', email: 'owner@example.com', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
fs.mkdirSync(path.join(home, '.nestcore'), { recursive: true });
fs.writeFileSync(path.join(home, '.nestcore', 'credentials.json'), JSON.stringify({ access_token: token, user: { id: 'u1', email: 'owner@example.com' } }));

const summary = {
  account: 'org:o1', balanceUsd: 4.5, monthlyCapUsd: null, spentThisMonthUsd: 0.5, available: true, active: true, marginPct: 0,
  packs: [{ id: 'credits_5', priceUsd: 5, creditsUsd: 5 }, { id: 'credits_10', priceUsd: 10, creditsUsd: 10 }],
};
const BUY = 'https://nestcore.io/settings/billing?ref=credits';

// Next error the fake API should answer with (one-shot), else the normal reply.
let nextError = null;
const hits = [];
const api = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined;
    hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (nextError) { const e = nextError; nextError = null; return send(e.statusCode, e); }
    if (req.method === 'GET' && req.url === '/api/billing/credits') return send(200, { ...summary, ledger: [{ id: 1, kind: 'purchase', amount_usd: 5 }] });
    if (req.method === 'PUT' && req.url === '/api/billing/credits/cap') return send(200, { ...summary, monthlyCapUsd: body.monthlyCapUsd });
    if (req.method === 'POST' && req.url === '/api/billing/credits/checkout') {
      return send(200, { url: 'https://checkout.stripe.com/c/pay/cs_test_1', pack: summary.packs.find((p) => p.id === body.pack), ref: body.ref ?? null });
    }
    send(200, { data: { id: 'u1', email: 'owner@example.com' } });
  });
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const apiUrl = `http://127.0.0.1:${api.address().port}`;

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.NESTCORE_API_URL = apiUrl;
process.env.LOG_LEVEL = 'error';
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
const client = new Client({ name: 'credits-test', version: '0.0.0' });
await client.connect(clientSide);
const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
const last = () => hits[hits.length - 1];

const { tools } = await client.listTools();
for (const n of ['nestcore_get_credits', 'nestcore_set_credit_cap', 'nestcore_buy_credits']) ok(`${n} is listed`, tools.some((t) => t.name === n));

const got = await call('nestcore_get_credits');
ok('get_credits returns balance, packs and ledger', got.balanceUsd === 4.5 && got.packs.length === 2 && got.ledger.length === 1);
ok('get_credits sends GET /api/billing/credits with the admin token', last().method === 'GET' && last().url === '/api/billing/credits' && last().auth === `Bearer ${token}`);

const capped = await call('nestcore_set_credit_cap', { monthlyCapUsd: 20 });
ok('set_credit_cap sends PUT { monthlyCapUsd: 20 }', last().method === 'PUT' && last().body.monthlyCapUsd === 20 && capped.monthlyCapUsd === 20);
await call('nestcore_set_credit_cap', { monthlyCapUsd: null });
ok('set_credit_cap null clears the cap', last().body.monthlyCapUsd === null && 'monthlyCapUsd' in last().body);

const bought = await call('nestcore_buy_credits', { pack: 'credits_10' });
ok('buy_credits posts the pack with ref "mcp"', last().method === 'POST' && last().url === '/api/billing/credits/checkout' && last().body.pack === 'credits_10' && last().body.ref === 'mcp');
ok('buy_credits returns the checkout URL and paid=false', bought.checkoutUrl.startsWith('https://checkout.stripe.com/') && bought.paid === false && /No credit is added/.test(bought.next));
const badPack = await client.callTool({ name: 'nestcore_buy_credits', arguments: { pack: 'Not A Pack!' } });
ok('buy_credits rejects a malformed pack id before calling the API', badPack.isError === true);

nextError = { statusCode: 402, error: 'Payment Required', code: 'CREDITS_EXHAUSTED', reason: 'balance', message: 'This workspace has no AI credit left.', balanceUsd: 0, monthlyCapUsd: null, spentThisMonthUsd: 5, buyUrl: BUY };
const exhausted = await call('nestcore_get_credits');
ok('CREDITS_EXHAUSTED keeps the code and status', exhausted.code === 'CREDITS_EXHAUSTED' && exhausted.statusCode === 402);
ok('CREDITS_EXHAUSTED details carry reason, balance and buyUrl', exhausted.details.reason === 'balance' && exhausted.details.balanceUsd === 0 && exhausted.details.buyUrl === BUY);
ok('CREDITS_EXHAUSTED (balance) message says buy or add a key, with the link, no retry', /buy a pack/.test(exhausted.error) && /own provider key/.test(exhausted.error) && exhausted.error.includes(BUY) && /Do not retry/.test(exhausted.error));

nextError = { statusCode: 402, error: 'Payment Required', code: 'CREDITS_EXHAUSTED', reason: 'spend_cap', message: 'Cap reached.', balanceUsd: 3, monthlyCapUsd: 10, spentThisMonthUsd: 10, buyUrl: BUY };
const capHit = await call('nestcore_get_credits');
ok('CREDITS_EXHAUSTED (spend_cap) message points at the cap', /monthly AI credit cap/.test(capHit.error) && /nestcore_set_credit_cap/.test(capHit.error) && capHit.details.monthlyCapUsd === 10);

nextError = { statusCode: 402, error: 'Payment Required', code: 'QUOTA_EXCEEDED', quota: 'ai_collections', plan: 'free', limit: 3, usage: 3, reason: 'ai_collections', message: 'The free plan includes 3 AI collections per project.', upgradeUrl: 'https://nestcore.io/settings/billing?ref=ai_collections' };
const quota = await call('nestcore_get_credits');
ok('QUOTA_EXCEEDED ai_collections explains the collection limit with the upgrade link', quota.code === 'QUOTA_EXCEEDED' && /AI collections/.test(quota.error) && quota.error.includes('ref=ai_collections') && quota.details.reason === 'ai_collections' && quota.details.limit === 3);

await client.close();
api.closeAllConnections();
await new Promise((r) => api.close(r));
process.chdir(os.tmpdir()); // Windows can't remove the cwd
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
console.log(`\nOK — ${passed} credit checks passed.`);
process.exitCode = 0;
