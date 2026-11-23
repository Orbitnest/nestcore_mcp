/**
 * Code Mode guards, against a fake API:
 *   - db.executeSql through execute is rejected exactly like the direct
 *     nestcore_execute_sql call (auth-table mutation, unconfirmed DROP,
 *     statement chaining) and never reaches the API
 *   - nestcore_create_table / nestcore_run_migrations now run the SQL guard
 *   - NESTCORE_MCP_ALLOW_WRITES=false hides writes and blocks write SQL
 *   - destructive methods without their own flag need confirm: true, or an
 *     elicitation prompt when the client supports it; tools with a flag keep
 *     their behaviour
 *   - a not-signed-in failure tells the model to call nestcore_login
 *
 *   npm run build && node test/code-mode-guards.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, passedCount, isolatedHome, fakeApi, connect, PROJECT_ID } from './code-mode-helpers.mjs';

const env = isolatedHome('cm-guards');
const api = await fakeApi((req) => {
  if (req.url.endsWith('/database/sql')) return [200, { success: true, data: [{ n: 3 }], rows_affected: 0 }];
  return undefined;
});
const sqlHits = () => api.hits.filter((h) => h.url.endsWith('/database/sql')).map((h) => h.body?.sql ?? '');
const P = `'${PROJECT_ID}'`;

const tools = await connect({ NESTCORE_MCP_MODE: 'tools' });
const code = await connect({});

console.log('executeSql parity (direct vs execute)');
const cases = [
  ['auth-table mutation', "DELETE FROM auth_users WHERE id = '1'", true],
  ['DROP without confirmDestructive', 'DROP TABLE posts', false],
  ['statement chaining', 'SELECT 1; DROP TABLE posts', true],
  ['UNION injection', "SELECT id FROM posts UNION SELECT password_hash FROM auth_users", false],
];
for (const [label, sql, confirmDestructive] of cases) {
  const before = sqlHits().length;
  const direct = await tools.callTool('nestcore_execute_sql', { projectId: PROJECT_ID, sql, confirmDestructive });
  const viaExec = await code.execute(`return await nestcore.db.executeSql({ projectId: ${P}, sql: ${JSON.stringify(sql)}, confirmDestructive: ${confirmDestructive} })`);
  ok(`${label}: direct call rejected with SAFETY_ERROR`, direct.isError && direct.body.code === 'SAFETY_ERROR');
  ok(`${label}: execute rejected with the same code and message`, viaExec.isError && viaExec.body.error.code === direct.body.code && viaExec.body.error.message === direct.body.error && viaExec.body.error.type === 'guard' && viaExec.body.error.method === 'db.executeSql');
  ok(`${label}: no SQL reached the API`, sqlHits().length === before);
}
const caughtGuard = await code.execute(`try { await nestcore.db.executeSql({ projectId: ${P}, sql: 'DROP TABLE posts' }) } catch (e) { return { code: e.code, details: e.details } }`);
ok('guard error is catchable with code + details', !caughtGuard.isError && caughtGuard.body.result.code === 'SAFETY_ERROR' && Array.isArray(caughtGuard.body.result.details?.details?.operations));
const select = await code.execute(`const r = await nestcore.db.executeSql({ projectId: ${P}, sql: 'SELECT count(*) AS n FROM posts' }); return r.data[0].n`);
ok('read-only SQL runs through execute', !select.isError && select.body.result === 3 && sqlHits().at(-1) === 'SELECT count(*) AS n FROM posts');
const confirmedDrop = await code.execute(`return await nestcore.db.executeSql({ projectId: ${P}, sql: 'DROP TABLE posts', confirmDestructive: true })`);
ok('DROP with the tool\'s own confirmDestructive runs (behaviour unchanged)', !confirmedDrop.isError && sqlHits().at(-1) === 'DROP TABLE posts');

console.log('create_table + migrations guard');
let before = sqlHits().length;
const evilDefault = await tools.callTool('nestcore_create_table', { projectId: PROJECT_ID, tableName: 'posts2', columns: [{ name: 'id', type: 'int', default: '1; DROP TABLE users' }] });
ok('create_table blocks chained SQL in a DEFAULT', evilDefault.isError && evilDefault.body.code === 'SAFETY_ERROR' && sqlHits().length === before);
const authTable = await code.execute(`return await nestcore.db.createTable({ projectId: ${P}, tableName: 'auth_users', columns: [{ name: 'id', type: 'int' }] })`);
ok('create_table blocks auth tables (via execute too)', authTable.isError && authTable.body.error.code === 'SAFETY_ERROR' && sqlHits().length === before);
const goodTable = await tools.callTool('nestcore_create_table', { projectId: PROJECT_ID, tableName: 'notes', columns: [{ name: 'id', type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' }, { name: 'update', type: 'text' }], enableRLS: true });
ok('a normal create_table (+ RLS, a column named "update") still runs', !goodTable.isError && /CREATE TABLE "notes"/.test(sqlHits().at(-1)) && /ENABLE ROW LEVEL SECURITY/.test(sqlHits().at(-1)));

const migDir = path.join(env.work, 'migrations');
fs.mkdirSync(migDir, { recursive: true });
fs.writeFileSync(path.join(migDir, '001_init.sql'), '-- create\nCREATE TABLE things (id int);\nALTER TABLE things ADD COLUMN name text;\n');
fs.writeFileSync(path.join(migDir, '002_evil.sql'), "UPDATE auth_users SET email = 'x@example.test';\n");
before = sqlHits().length;
const evilMig = await tools.callTool('nestcore_run_migrations', { projectId: PROJECT_ID, migrationsDir: migDir });
ok('run_migrations refuses a pending migration that mutates auth tables', evilMig.isError && evilMig.body.code === 'SAFETY_ERROR');
ok('…before executing any migration file', !sqlHits().slice(before).some((s) => /things|auth_users/.test(s)));
fs.rmSync(path.join(migDir, '002_evil.sql'));
const goodMig = await tools.callTool('nestcore_run_migrations', { projectId: PROJECT_ID, migrationsDir: migDir });
ok('a normal multi-statement, commented migration still runs', !goodMig.isError && sqlHits().some((s) => s.includes('CREATE TABLE things')));

console.log('destructive confirmation');
before = api.hits.length;
const noConfirm = await code.execute(`return await nestcore.webhooks.delete({ projectId: ${P}, webhookId: 'w1' })`);
ok('destructive method without a flag needs confirm: true', noConfirm.isError && noConfirm.body.error.code === 'CONFIRMATION_REQUIRED' && noConfirm.body.error.type === 'guard');
ok('…and nothing reached the API', !api.hits.slice(before).some((h) => h.method === 'DELETE'));
const withConfirm = await code.execute(`return await nestcore.webhooks.delete({ projectId: ${P}, webhookId: 'w1', confirm: true })`);
ok('confirm: true runs it', !withConfirm.isError && api.hits.at(-1).method === 'DELETE' && api.hits.at(-1).url.endsWith('/webhooks/w1'));
const keys = await code.execute(`return await nestcore.projects.createApiKeys({ projectId: ${P}, description: 'ci', confirm: true })`);
ok('the bridge strips confirm before calling the handler', !keys.isError && api.hits.at(-1).method === 'POST' && !('confirm' in (api.hits.at(-1).body ?? {})));
const ownFlagExec = await code.execute(`return await nestcore.projects.delete({ projectId: ${P}, confirmDeletion: false })`);
const ownFlagDirect = await tools.callTool('nestcore_delete_project', { projectId: PROJECT_ID, confirmDeletion: false });
ok('a tool with its own flag keeps its behaviour (same refusal as the direct tool)', ownFlagExec.isError && ownFlagExec.body.error.message === ownFlagDirect.body.error && ownFlagExec.body.error.code === 'CONFIRMATION_REQUIRED');
ok('…and nothing was deleted', !api.hits.some((h) => h.method === 'DELETE' && h.url.includes('/projects/') && !h.url.includes('webhooks')));

console.log('elicitation');
const prompts = [];
let answer = { action: 'accept', content: { confirm: true } };
const elicit = await connect({}, {
  clientCapabilities: { elicitation: {} },
  onElicit: async (req) => { prompts.push(req.params.message); return answer; },
});
const accepted = await elicit.execute(`return await nestcore.webhooks.delete({ projectId: ${P}, webhookId: 'w2' })`);
ok('with elicitation support the user is asked (method + target in the message)', prompts.length === 1 && /webhooks\.delete/.test(prompts[0]) && /webhookId=w2/.test(prompts[0]));
ok('accept runs the destructive call without a confirm flag', !accepted.isError && api.hits.at(-1).url.endsWith('/webhooks/w2'));
answer = { action: 'decline' };
before = api.hits.length;
const declined = await elicit.execute(`return await nestcore.webhooks.delete({ projectId: ${P}, webhookId: 'w3', confirm: true })`);
ok('decline → cancelled by user, nothing deleted', declined.isError && declined.body.error.type === 'cancelled' && /cancelled by user/.test(declined.body.error.message) && api.hits.length === before);
answer = { action: 'accept', content: { confirm: false } };
const unticked = await elicit.execute(`try { await nestcore.webhooks.delete({ projectId: ${P}, webhookId: 'w4' }) } catch (e) { return e.code }`);
ok('accept without ticking confirm is a cancel (catchable)', !unticked.isError && unticked.body.result === 'CANCELLED');
const ownFlagElicit = await elicit.execute(`return await nestcore.db.deleteRow({ projectId: ${P}, tableName: 'posts', rowId: '1', confirmDeletion: true })`);
ok('tools with their own flag are not prompted', prompts.length === 3 && !ownFlagElicit.isError);
await elicit.close();

console.log('NESTCORE_MCP_ALLOW_WRITES=false');
const ro = await connect({ NESTCORE_MCP_ALLOW_WRITES: 'false' });
const roMethods = ro.catalog.entries.map((e) => e.path);
ok('only read methods (+ executeSql, projects.setActive) are exposed', ro.catalog.entries.every((e) => e.cls === 'read' || e.path === 'db.executeSql' || e.path === 'projects.setActive'));
ok('write/destructive methods are not in the declarations', !/\binsertRow\(/.test(ro.catalog.declarations.full) && !/\n\s+delete\(/.test(ro.catalog.declarations.full));
const roSearch = await ro.client.callTool({ name: 'search', arguments: { query: 'delete project' } });
ok('search does not offer hidden methods', !roSearch.content[0].text.includes('projects.delete') && !roSearch.content[0].text.includes('(destructive)'));
const typeofs = await ro.execute(`return [typeof nestcore.db.insertRow, typeof nestcore.projects.delete, typeof nestcore.db.getSchema, typeof nestcore.projects.setActive]`);
ok('hidden methods are undefined inside execute', JSON.stringify(typeofs.body.result) === JSON.stringify(['undefined', 'undefined', 'function', 'function']));
before = sqlHits().length;
const roWrite = await ro.execute(`return await nestcore.db.executeSql({ projectId: ${P}, sql: "UPDATE posts SET title = 'x' WHERE id = 1", confirmDestructive: true })`);
ok('write SQL is rejected with WRITES_DISABLED before the handler runs', roWrite.isError && roWrite.body.error.code === 'WRITES_DISABLED' && sqlHits().length === before);
const roRead = await ro.execute(`return (await nestcore.db.executeSql({ projectId: ${P}, sql: 'SELECT 1' })).data[0].n`);
ok('read-only SQL still runs', !roRead.isError && roRead.body.result === 3);
ok('execute is annotated read-only when writes are off', (await ro.client.listTools()).tools.find((t) => t.name === 'execute').annotations.readOnlyHint === true);
ok(`${roMethods.length} read methods exposed`, roMethods.length > 50);
await ro.close();

console.log('not signed in');
fs.rmSync(path.join(env.home, '.nestcore', 'credentials.json'));
const anon = await connect({});
const noAuth = await anon.execute(`return await nestcore.projects.list({})`);
ok('AUTH_ERROR tells the model to call nestcore_login', noAuth.isError && noAuth.body.error.type === 'auth' && noAuth.body.error.code === 'AUTH_ERROR' && /nestcore_login/.test(noAuth.body.error.message));
await anon.close();

await tools.close();
await code.close();
await api.close();
env.cleanup();
console.log(`\nOK — ${passedCount()} code-mode guard checks passed.`);
process.exitCode = 0;
