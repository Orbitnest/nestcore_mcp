/**
 * Code Mode unit checks against the built server:
 *   - registry/catalog: every registered tool mapped exactly once, no stale
 *     catalog rows, no path collisions, annotations on direct tools
 *   - modes: tools/list in code, tools and both mode
 *   - type generation (zod → TypeScript), including a syntax check with tsc
 *   - search ranking + determinism + the search tool's output
 *   - bridge argument validation errors and isError on direct-tool errors
 *
 *   npm run build && node test/code-mode-unit.mjs
 */
import ts from 'typescript';
import { z } from 'zod';
import { ok, passedCount, isolatedHome, fakeApi, connect, PROJECT_ID } from './code-mode-helpers.mjs';

const env = isolatedHome('cm-unit');
const api = await fakeApi((req) => {
  if (req.url.endsWith('/database/sql')) return [200, { success: true, data: [{ n: 1 }] }];
  return undefined;
});

const { TOOL_CATALOG, NAMESPACES, SANDBOX_EXCLUDED } = await import('../dist/codemode/catalog.js');
const { emitType, generateDeclarations } = await import('../dist/codemode/typegen.js');
const { SearchIndex, stem, words } = await import('../dist/codemode/search.js');
const { classifyCall, annotationsFor } = await import('../dist/codemode/registry.js');

// ── registry + catalog ───────────────────────────────────────────────────────
console.log('registry / catalog');
const tools = await connect({ NESTCORE_MCP_MODE: 'tools' });
const listed = (await tools.client.listTools()).tools;
const registered = tools.registry.all();
ok(`tools mode lists every registered tool (${listed.length})`, listed.length === registered.length && listed.length === 133);
ok('no tool fell back to an unmapped path', registered.every((e) => !e.unmapped));
ok('every registered tool is in the catalog', registered.every((e) => TOOL_CATALOG[e.name]));
const regNames = new Set(registered.map((e) => e.name));
const stale = Object.keys(TOOL_CATALOG).filter((n) => !regNames.has(n));
ok(`no stale catalog rows (${stale.join(', ') || 'none'})`, stale.length === 0);
const paths = registered.map((e) => e.path);
ok('every Code Mode path is unique', new Set(paths).size === paths.length);
ok('every method name is camelCase', registered.every((e) => /^[a-z][A-Za-z0-9]*$/.test(e.method)));
ok('every namespace is in NAMESPACES', registered.every((e) => NAMESPACES.includes(e.ns)));
const byName = Object.fromEntries(listed.map((t) => [t.name, t]));
ok('nestcore_get_schema is annotated readOnlyHint', byName.nestcore_get_schema.annotations?.readOnlyHint === true);
ok('nestcore_delete_project is annotated destructiveHint', byName.nestcore_delete_project.annotations?.destructiveHint === true);
ok('nestcore_create_table is a non-destructive write', byName.nestcore_create_table.annotations?.readOnlyHint === false && byName.nestcore_create_table.annotations?.destructiveHint === false);
ok('nestcore_execute_sql is annotated destructiveHint (per-call class)', byName.nestcore_execute_sql.annotations?.destructiveHint === true);
ok('every listed tool has annotations', listed.every((t) => t.annotations && typeof t.annotations.readOnlyHint === 'boolean'));
ok('classifyCall: SELECT is read', classifyCall({ name: 'nestcore_execute_sql', cls: 'write' }, { sql: 'SELECT 1' }) === 'read');
ok('classifyCall: DROP is destructive', classifyCall({ name: 'nestcore_execute_sql', cls: 'write' }, { sql: 'DROP TABLE x' }) === 'destructive');
ok('classifyCall: CREATE TABLE is write', classifyCall({ name: 'nestcore_execute_sql', cls: 'write' }, { sql: 'CREATE TABLE x (id int)' }) === 'write');
ok('annotationsFor read is idempotent', annotationsFor('nestcore_list_projects', 'read').idempotentHint === true);

const direct = await tools.callTool('nestcore_execute_sql', { projectId: PROJECT_ID, sql: "DELETE FROM auth_users WHERE id = '1'", confirmDestructive: true });
ok('direct tool errors set isError: true', direct.isError === true && direct.body.code === 'SAFETY_ERROR');
await tools.close();

console.log('modes');
const code = await connect({});
const codeTools = (await code.client.listTools()).tools.map((t) => t.name).sort();
ok(`default (code) mode lists search, execute, nestcore_login (${codeTools.join(', ')})`, JSON.stringify(codeTools) === JSON.stringify(['execute', 'nestcore_login', 'search']));
const execTool = (await code.client.listTools()).tools.find((t) => t.name === 'execute');
ok('execute description is short (< 1500 chars) and names namespaces', execTool.description.length < 1500 && execTool.description.includes('db, rls'));
ok('code mode exposes every tool but login in the sandbox', code.catalog.entries.length === 132 && !code.catalog.get('auth.login'));
const instructions = code.client.getInstructions?.() ?? '';
ok('code-mode instructions mention search, execute and nestcore_login', /search/.test(instructions) && /execute/.test(instructions) && /nestcore_login/.test(instructions));
const prompt = (await code.client.listPrompts()).prompts.map((p) => p.name);
ok('nestcore_load_project prompt still registered', prompt.includes('nestcore_load_project'));

const both = await connect({ NESTCORE_MCP_MODE: 'both' });
const bothTools = (await both.client.listTools()).tools.map((t) => t.name);
ok(`both mode lists 133 direct tools + search + execute (${bothTools.length})`, bothTools.length === 135 && bothTools.includes('search') && bothTools.includes('nestcore_get_schema'));
const legacy = await both.callTool('orbitnest_get_profile', {});
ok('legacy orbitnest_* names still route in both mode', legacy.isError === false);
await both.close();

// ── type generation ──────────────────────────────────────────────────────────
console.log('type generation');
const decl = code.catalog.declarations;
const getTableData = decl.byPath.get('db.getTableData');
ok('db.getTableData has a required tableName', /\n\s+getTableData\(args: \{/.test(getTableData) && /\n\s+tableName: string;/.test(getTableData));
ok('db.getTableData limit is optional with integer 1..100 doc', /integer, 1\.\.100 \*\/\n\s+limit\?: number;/.test(getTableData));
ok('method JSDoc carries the description and access class', getTableData.includes('Retrieve rows from a table') && getTableData.includes('@access read'));
ok('no-arg method has an empty parameter list', decl.byPath.get('auth.getProfile').includes(' getProfile(): Promise<unknown>;'));
ok('destructive tool without a flag gets confirm?: true', /confirm\?: true;/.test(decl.byPath.get('projects.createApiKeys')));
ok('destructive tool with its own flag keeps it (no bridge confirm)', /confirmDeletion: boolean;/.test(decl.byPath.get('projects.delete')) && !/confirm\?: true/.test(decl.byPath.get('projects.delete')));
ok('z.literal(true) flag is emitted as `true`', /confirm: true;/.test(decl.byPath.get('branches.reset')));
ok('z.record emits Record<string, unknown>', /data: Record<string, unknown>;/.test(decl.byPath.get('db.insertRow')));
ok('z.enum emits a string-literal union', /status: "active" \| "paused";/.test(decl.byPath.get('projects.setStatus')));
ok('executeSql access is per SQL', decl.byPath.get('db.executeSql').includes('@access read|write|destructive (per SQL)'));
ok('tool-name references are rewritten to methods', !/nestcore_(?!login)[a-z]/.test(decl.full));
ok('login is not declared in the sandbox', !/\n\s+login\(/.test(decl.full));
ok('reserved-word methods are declared as properties (projects.delete, logs.export)', /\n\s+delete\(args: \{/.test(decl.byPath.get('projects.delete')) && /\n\s+export\(/.test(decl.byPath.get('logs.export')));
ok('full declarations open with declare namespace nestcore', decl.full.startsWith('declare namespace nestcore {'));
// Type-check the full declarations plus a snippet that uses them (and one that misuses them).
function typeCheck(snippet) {
  const files = { '/nestcore.d.ts': decl.full, '/use.ts': `export {};\nasync function main() {\n${snippet}\n}\nvoid main;` };
  const options = { target: ts.ScriptTarget.ES2022, lib: ['lib.es2022.d.ts'], strict: true, noEmit: true, types: [] };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (f) => files[f] ?? readFile(f);
  host.fileExists = (f) => f in files || fileExists(f);
  host.getSourceFile = (f, lv, ...rest) => (f in files ? ts.createSourceFile(f, files[f], lv, true) : getSourceFile(f, lv, ...rest));
  const program = ts.createProgram(Object.keys(files), options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}
const tcGood = typeCheck(`const s = await nestcore.db.getSchema({}); const r = await nestcore.db.getTableData({ tableName: 'posts', limit: 5 }); await nestcore.webhooks.delete({ webhookId: 'w', confirm: true }); return [s, r];`);
ok(`generated declarations type-check with a valid snippet (${tcGood.join(' | ') || 'no errors'})`, tcGood.length === 0);
const bad = typeCheck(`await nestcore.db.getTableData({ limit: 5 });`);
ok('a snippet missing a required arg fails the type check', bad.length > 0 && bad.some((m) => /tableName/.test(m)));

enum_: {
  const NE = { A: 'a', B: 'b' };
  const N2 = { X: 0, Y: 1, 0: 'X', 1: 'Y' };
  ok('emitType: nullable', emitType(z.string().nullable()) === 'string | null');
  ok('emitType: union', emitType(z.union([z.string(), z.number()])) === 'string | number');
  ok('emitType: literal', emitType(z.literal('x')) === '"x"');
  ok('emitType: default unwraps', emitType(z.number().default(3)) === 'number');
  ok('emitType: effects unwraps', emitType(z.string().refine((s) => s.length > 0)) === 'string');
  ok('emitType: nativeEnum (string)', emitType(z.nativeEnum(NE)) === '"a" | "b"');
  ok('emitType: nativeEnum (numeric, no reverse keys)', emitType(z.nativeEnum(N2)) === '0 | 1');
  ok('emitType: any / unknown', emitType(z.any()) === 'any' && emitType(z.unknown()) === 'unknown');
  ok('emitType: array of objects', emitType(z.array(z.object({ a: z.string() }))).startsWith('Array<{'));
  ok('emitType: array of primitives', emitType(z.array(z.string())) === 'string[]');
  const obj = emitType(z.object({ a: z.string().describe('the a'), b: z.boolean().optional().describe('maybe b'), 'x-y': z.number() }));
  ok('emitType: object props, optional, describe() JSDoc, quoted keys', obj.includes('/** the a */') && obj.includes('b?: boolean;') && obj.includes('/** maybe b */') && obj.includes('"x-y": number;'));
  const d = generateDeclarations([{ name: 't_x', description: 'Does X. Returns the thing.', shape: { id: z.string().uuid() }, handler: () => null, cls: 'read', ns: 'db', method: 'doX', path: 'db.doX', confirmFlag: null }]);
  ok('result hint from "Returns ..." in the description', d.full.includes('@returns the thing.'));
  ok('uuid constraint is documented', d.full.includes('/** uuid */'));
}

// ── search ───────────────────────────────────────────────────────────────────
console.log('search');
ok('stem handles plurals', stem('policies') === 'policy' && stem('buckets') === 'bucket' && stem('status') === 'status' && stem('statuses') === 'status');
ok('words splits camelCase / snake_case', JSON.stringify(words('getTableData nestcore_list_buckets')) === JSON.stringify(['get', 'table', 'data', 'nestcore', 'list', 'buckets']));
const idx = code.catalog.index;
const top = (q, n = 5) => idx.search(q, n).map((m) => m.path);
const lt = top('list tables');
ok(`"list tables" → db.getSchema and db.getTableData in the top 5 (${lt.join(', ')})`, lt.includes('db.getSchema') && lt.includes('db.getTableData'));
ok(`"storage buckets" → storage.listBuckets first (${top('storage buckets', 3).join(', ')})`, top('storage buckets')[0] === 'storage.listBuckets');
ok('"add task" → memory.addTask first', top('add task')[0] === 'memory.addTask');
ok('"delete project" → projects.delete first', top('delete project')[0] === 'projects.delete');
ok('"db.getSchema" (path) → db.getSchema first', top('db.getSchema')[0] === 'db.getSchema');
ok('"load project memory" → memory.getProjectContext first', top('load project memory')[0] === 'memory.getProjectContext');
ok('"slow queries" → logs.getSlowQueries first', top('slow queries')[0] === 'logs.getSlowQueries');
ok('search is deterministic', JSON.stringify(idx.search('list', 10)) === JSON.stringify(idx.search('list', 10)));
ok('limit is capped at 10', idx.search('get', 50).length === 10);
ok('nonsense query → no matches', idx.search('zzqqxx').length === 0);
ok('search never returns login', !idx.search('login sign in', 10).some((m) => m.path === 'auth.login'));
const sres = await code.client.callTool({ name: 'search', arguments: { query: 'storage buckets', limit: 3 } });
const stext = sres.content[0].text;
ok('search tool returns declarations with namespace header and classes', stext.includes('declare namespace nestcore {') && stext.includes('const storage: {') && stext.includes('// storage.listBuckets (read)') && stext.includes(' listBuckets('));
ok('search tool output is compact (< 4 KB for 3 matches)', Buffer.byteLength(stext) < 4096);
const none = await code.client.callTool({ name: 'search', arguments: { query: 'zzqqxx' } });
ok('search with no match lists namespaces', none.content[0].text.includes('Namespaces: auth, projects, db'));

// ── bridge argument validation ───────────────────────────────────────────────
console.log('bridge validation');
const missing = await code.execute(`return await nestcore.db.getTableData({ projectId: '${PROJECT_ID}' })`);
ok('missing required arg → validation error', missing.isError && missing.body.error.type === 'validation' && missing.body.error.code === 'VALIDATION_ERROR' && /tableName/.test(missing.body.error.message) && missing.body.error.method === 'db.getTableData');
const wrongType = await code.execute(`return await nestcore.db.getTableData({ projectId: '${PROJECT_ID}', tableName: 't', limit: 'ten' })`);
ok('wrong type → validation error naming the field', wrongType.isError && wrongType.body.error.type === 'validation' && /limit/.test(wrongType.body.error.message));
const outOfRange = await code.execute(`return await nestcore.db.getTableData({ projectId: '${PROJECT_ID}', tableName: 't', limit: 1000 })`);
ok('out-of-range number → validation error', outOfRange.isError && outOfRange.body.error.type === 'validation');
const notObject = await code.execute(`return await nestcore.db.getTableData('posts')`);
ok('non-object argument → validation error', notObject.isError && notObject.body.error.type === 'validation');
const caught = await code.execute(`try { await nestcore.db.getTableData({}) } catch (e) { return { name: e.name, code: e.code, type: e.type, method: e.method } }`);
ok('validation error is catchable inside the snippet', !caught.isError && caught.body.result.code === 'VALIDATION_ERROR' && caught.body.result.name === 'NestCoreError' && caught.body.result.method === 'db.getTableData');
const unknownArg = await code.execute(`await nestcore.db.getTableData({ projectId: '${PROJECT_ID}', tableName: 't', limt: 5 }); return 1`);
ok('unknown argument is ignored with a warning in logs', !unknownArg.isError && unknownArg.body.logs.some((l) => /ignored unknown argument\(s\): limt/.test(l)));
const noMethod = await code.execute(`return await nestcore.db.nope({})`);
ok('unknown method → TypeError in the snippet', noMethod.isError && noMethod.body.error.type === 'runtime' && /not a function/.test(noMethod.body.error.message));
const good = await code.execute(`const r = await nestcore.db.executeSql({ projectId: '${PROJECT_ID}', sql: 'SELECT 1 AS n' }); console.log('rows', r.data.length); return r.data[0].n`);
ok('valid call returns the handler JSON, logs captured, calls counted', !good.isError && good.body.result === 1 && good.body.logs[0] === 'rows 1' && good.body.calls === 1 && typeof good.body.executionId === 'string');
await code.close();

await api.close();
env.cleanup();
console.log(`\nOK — ${passedCount()} code-mode unit checks passed.`);
process.exitCode = 0;
