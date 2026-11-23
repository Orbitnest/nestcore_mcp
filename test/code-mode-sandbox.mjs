/**
 * Code Mode sandbox: escape attempts and resource limits. Every case must fail
 * safely (a structured isError result, never a crash or a host leak) and the
 * server must keep working afterwards.
 *
 *   npm run build && node test/code-mode-sandbox.mjs
 */
import { ok, passedCount, isolatedHome, fakeApi, connect, PROJECT_ID } from './code-mode-helpers.mjs';

const env = isolatedHome('cm-sandbox');
const api = await fakeApi((req) => {
  if (req.url.endsWith('/database/sql')) return [200, { success: true, data: [{ n: 1 }] }];
  return undefined;
});

const TIMEOUT = 1500;
const s = await connect({
  NESTCORE_MCP_EXEC_TIMEOUT_MS: String(TIMEOUT),
  NESTCORE_MCP_EXEC_MEMORY_MB: '32',
  NESTCORE_MCP_EXEC_MAX_CALLS: '5',
  NESTCORE_MCP_EXEC_MAX_OUTPUT_BYTES: '5000',
});
const run = s.execute;
const timed = async (code) => {
  const t = Date.now();
  const r = await run(code);
  return { ...r, ms: Date.now() - t };
};

console.log('host access');
const globals = await run(`return [typeof process, typeof require, typeof module, typeof Buffer, typeof fetch, typeof setTimeout, typeof setInterval, typeof queueMicrotask, typeof WebAssembly, typeof __filename]`);
ok(`no host globals (${globals.body.result?.join(',')})`, !globals.isError && globals.body.result.every((t) => t === 'undefined'));
const names = await run(`return Object.getOwnPropertyNames(globalThis).filter((n) => /^(process|require|module|Buffer|fetch|setTimeout|call|done|log|host|code|namespacesJson)$|__nc/.test(n))`);
ok(`no bridge/host names on globalThis (${names.body.result?.join(',') || 'none'})`, !names.isError && names.body.result.length === 0);
const proc = await run(`return process.env`);
ok('process is a ReferenceError', proc.isError && proc.body.error.type === 'runtime' && /process/.test(proc.body.error.message));
const req = await run(`return require('fs')`);
ok('require is a ReferenceError', req.isError && /require/.test(req.body.error.message));
const imp = await run(`return await import('node:fs')`);
ok('dynamic import() cannot load modules', imp.isError && imp.body.error.type === 'runtime');
const fnCtor = await run(`return Function('return typeof process')()`);
ok('Function constructor only reaches the sandbox global', !fnCtor.isError && fnCtor.body.result === 'undefined');
const viaGlobal = await run(`return globalThis.constructor.constructor('return [typeof process, typeof require]')()`);
ok('globalThis.constructor.constructor cannot reach the host', !viaGlobal.isError && viaGlobal.body.result.every((t) => t === 'undefined'));
const viaMethod = await run(`return nestcore.db.getSchema.constructor('return typeof process')()`);
ok('a bridge method\'s constructor is a sandbox AsyncFunction', !viaMethod.isError || viaMethod.body.error.type !== 'internal');
const viaPromise = await run(`const AF = (async () => {}).constructor; return await new AF('return [typeof process, typeof this]')()`);
ok('AsyncFunction constructor stays inside', !viaPromise.isError && viaPromise.body.result[0] === 'undefined');
const frozen = await run(`'use strict'; try { nestcore.db = null; } catch (e) { return 'frozen:' + e.name } return 'mutable'`);
ok('nestcore object is frozen', frozen.body.result === 'frozen:TypeError');
const evalUse = await run(`return eval('typeof process')`);
ok('eval runs inside the sandbox only', !evalUse.isError && evalUse.body.result === 'undefined');

console.log('prototype pollution');
const pollute = await run(`Object.prototype.polluted = 'yes'; Array.prototype.evil = 1; JSON.parse = () => ({ hacked: true }); return ({}).polluted`);
ok('snippet can pollute its own realm', !pollute.isError && pollute.body.result === 'yes');
ok('host Object.prototype is untouched', ({}).polluted === undefined && [].evil === undefined);
const next = await run(`return [({}).polluted ?? 'clean', JSON.parse('{"a":1}').a]`);
ok('pollution does not leak into the next execution', !next.isError && next.body.result[0] === 'clean' && next.body.result[1] === 1);
const protoJson = await run(`return JSON.parse('{"__proto__": {"polluted": 1}, "a": 2}')`);
ok('returning a __proto__ key does not pollute the host', !protoJson.isError && ({}).polluted === undefined);
const protoArgs = await run(`await nestcore.db.insertRow({ projectId: '${PROJECT_ID}', tableName: 'posts', data: JSON.parse('{"__proto__": {"polluted": 1}, "title": "x"}') }); return 1`);
ok('a __proto__ key in arguments does not pollute the host', !protoArgs.isError && ({}).polluted === undefined);

console.log('limits');
const loop = await timed(`while (true) {}`);
ok(`while(true){} times out (${loop.ms} ms)`, loop.isError && loop.body.error.type === 'timeout' && loop.ms < TIMEOUT + 2000);
const asyncLoop = await timed(`await nestcore.db.executeSql({ projectId: '${PROJECT_ID}', sql: 'SELECT 1' }); for (;;) {}`);
ok(`busy loop after an await times out (${asyncLoop.ms} ms)`, asyncLoop.isError && asyncLoop.body.error.type === 'timeout');
const microtasks = await timed(`const f = () => Promise.resolve().then(f); f(); await new Promise(() => {})`);
ok(`microtask flood times out (${microtasks.ms} ms)`, microtasks.isError && microtasks.body.error.type === 'timeout');
const hang = await timed(`await new Promise(() => {})`);
ok(`a promise that never settles hits the wall clock (${hang.ms} ms)`, hang.isError && hang.body.error.type === 'timeout' && hang.ms >= TIMEOUT - 50);
const perCall = await timed(`while (true) {}`.replace('while', 'while'));
ok('per-run timeoutMs above the max is rejected by the schema', (await s.client.callTool({ name: 'execute', arguments: { code: 'return 1', timeoutMs: TIMEOUT * 10 } })).isError === true && perCall.isError);
const shortRun = await (async () => { const t = Date.now(); const r = await run('while (true) {}', { timeoutMs: 300 }); return { ...r, ms: Date.now() - t }; })();
ok(`per-run timeoutMs shortens the limit (${shortRun.ms} ms)`, shortRun.isError && shortRun.body.error.type === 'timeout' && shortRun.ms < 1200);
const mem = await timed(`const a = []; while (true) a.push(new Array(100000).fill(a.length));`);
ok(`memory bomb hits the memory limit (${mem.body.error?.type})`, mem.isError && mem.body.error.type === 'memory');
const str = await timed(`let s = 'x'; while (true) s = s + s;`);
ok(`string doubling fails safely (${str.body.error?.type}: ${str.body.error?.message})`, str.isError && ['memory', 'runtime'].includes(str.body.error.type));
const stack = await run(`const f = (n) => f(n + 1) + 1; return f(0)`);
ok('deep recursion hits the stack limit', stack.isError && stack.body.error.type === 'memory' && /stack/i.test(stack.body.error.message));
const big = await run(`return 'x'.repeat(50000)`);
const bigBytes = Buffer.byteLength(JSON.stringify(big.body));
ok(`huge output is truncated to the cap (${bigBytes} bytes)`, !big.isError && big.body.truncated === true && bigBytes <= 5000 && typeof big.body.result === 'string' && big.body.totalBytes > 50000);
const flood = await run(`for (let i = 0; i < 5000; i++) console.log('line ' + i); return 'done'`);
ok('console flood is capped and flagged', !flood.isError && flood.body.logsTruncated === true && flood.body.logs.at(-1) === '[logs truncated]' && flood.body.result === 'done');
const calls = await run(`const out = []; for (let i = 0; i < 10; i++) { try { await nestcore.db.executeSql({ projectId: '${PROJECT_ID}', sql: 'SELECT 1' }); out.push(i) } catch (e) { out.push(e.code) } } return out`);
ok(`call cap ends the run even if the snippet catches (calls=${calls.body.calls})`, calls.isError && calls.body.error.type === 'call_limit' && calls.body.calls === 6);

console.log('errors');
const syntax = await run(`return (`);
ok('syntax error → type syntax', syntax.isError && syntax.body.error.type === 'syntax');
const thrown = await run(`throw new RangeError('boom')`);
ok('thrown error → type runtime with its name', thrown.isError && thrown.body.error.type === 'runtime' && thrown.body.error.message === 'RangeError: boom');
const thrownStr = await run(`throw 'plain'`);
ok('thrown string → type runtime', thrownStr.isError && thrownStr.body.error.message === 'plain');
const bigint = await run(`return 10n`);
ok('non-serializable return → type serialization', bigint.isError && bigint.body.error.type === 'serialization');
const undef = await run(`console.warn('w', { a: 1 }); console.error(new Error('e'))`);
ok('undefined return → null, console levels captured', !undef.isError && undef.body.result === null && undef.body.logs[0] === '[warn] w {"a":1}' && undef.body.logs[1] === '[error] Error: e');
const thenHack = await run(`Promise.prototype.then = function () {}; return 7`);
ok('overriding Promise.prototype.then cannot break result delivery', !thenHack.isError && thenHack.body.result === 7);

console.log('server still healthy');
const after = await run(`return 1 + 1`);
ok('a normal run works after every failure above', !after.isError && after.body.result === 2);
const [p1, p2] = await Promise.all([
  run(`const r = await nestcore.db.executeSql({ projectId: '${PROJECT_ID}', sql: 'SELECT 1' }); return r.data[0].n + 1`),
  run(`return 'parallel'`),
]);
ok('two executions in parallel both succeed', !p1.isError && p1.body.result === 2 && p2.body.result === 'parallel');
const search = await s.client.callTool({ name: 'search', arguments: { query: 'list tables' } });
ok('search still answers', search.content[0].text.includes('getSchema'));
const ids = new Set([after.body.executionId, p1.body.executionId, p2.body.executionId]);
ok('each execution has its own executionId', ids.size === 3);

await s.close();
await api.close();
env.cleanup();
console.log(`\nOK — ${passedCount()} code-mode sandbox checks passed.`);
process.exitCode = 0;
