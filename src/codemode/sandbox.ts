/**
 * QuickJS sandbox for Code Mode `execute`.
 *
 * Why QuickJS (quickjs-emscripten, pure WASM) and not isolated-vm: isolated-vm
 * is a native addon — it needs a C++ toolchain / matching prebuilt binary at
 * install time and Node must run with --no-node-snapshot on Node 20+, which
 * breaks `npx @nestcorehq/mcp-server` for most users. The WASM build installs
 * everywhere Node runs, gives a separate heap with a hard memory limit, an
 * interrupt handler for CPU limits, and no host objects at all unless we pass
 * them in.
 *
 * We use quickjs-emscripten-core + the single release-sync WASM variant (the
 * same library as the `quickjs-emscripten` meta package, ~1.5 MB instead of ~9 MB).
 *
 * What the snippet sees: the ECMAScript built-ins, a frozen `nestcore` object
 * (namespace → async methods) and a `console` whose output is captured.
 * No require/import/process/fs/fetch/timers. Data crosses the boundary only as
 * JSON strings; host functions are passed as closure arguments and never put
 * on `globalThis`. Every run gets a fresh runtime + context, disposed after.
 */
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSWASMModule,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from 'quickjs-emscripten-core';
import releaseSyncVariant from '@jitl/quickjs-wasmfile-release-sync';
import { logger } from '../utils/logger.js';

export type SandboxErrorType =
  | 'syntax'
  | 'runtime'
  | 'timeout'
  | 'memory'
  | 'call_limit'
  | 'serialization'
  | 'internal'
  // set by the host bridge on method failures:
  | 'validation'
  | 'guard'
  | 'auth'
  | 'api'
  | 'cancelled'
  | 'not_found'
  | string;

export interface SandboxErrorInfo {
  type: SandboxErrorType;
  message: string;
  code?: string;
  method?: string;
  details?: unknown;
}

/**
 * Thrown by a host method. Non-fatal errors become a catchable Error inside
 * the VM (with .type/.code/.method/.details); fatal ones (call cap) end the run.
 */
export class HostCallError extends Error {
  constructor(
    readonly info: SandboxErrorInfo,
    readonly fatal = false,
  ) {
    super(info.message);
    this.name = 'HostCallError';
  }
}

export interface HostControl {
  /** Stop the wall clock while `p` is pending (e.g. a human confirmation prompt). */
  suspendClock<T>(p: Promise<T>): Promise<T>;
  /** Append a line to the run's logs (e.g. a bridge warning). */
  log(level: string, message: string): void;
}

export interface SandboxHost {
  /** Namespace → method names exposed as `nestcore.<ns>.<method>`. */
  namespaces: Record<string, string[]>;
  call(path: string, args: unknown, control: HostControl): Promise<unknown>;
}

export interface SandboxLimits {
  timeoutMs: number;
  memoryBytes: number;
  maxStackBytes: number;
  /** Cap on captured console output (bytes). */
  maxLogBytes: number;
}

export interface SandboxOutcome {
  ok: boolean;
  /** JSON text of the returned value (ok only). */
  resultJson?: string;
  error?: SandboxErrorInfo;
  logs: string[];
  logsTruncated: boolean;
}

// ── module cache ─────────────────────────────────────────────────────────────
let modulePromise: Promise<QuickJSWASMModule> | null = null;

function getModule(): Promise<QuickJSWASMModule> {
  if (!modulePromise) {
    // Emscripten prints to the console by default (e.g. "Aborted(...)" when a
    // leaky runtime is disposed); route it to the logger at debug level.
    const variant = newVariant(releaseSyncVariant as never, {
      emscriptenModule: {
        print: (m: string) => logger.debug('quickjs', { message: m }),
        printErr: (m: string) => logger.debug('quickjs', { message: m }),
      } as never,
    });
    modulePromise = newQuickJSWASMModuleFromVariant(variant).catch((e) => {
      modulePromise = null;
      throw e;
    });
  }
  return modulePromise;
}

/** Drop the cached WASM module (after a failed dispose) so the next run starts clean. */
function discardModule(): void {
  modulePromise = null;
}

// The prelude runs first in every fresh context. It receives the host
// functions as arguments (never globals), builds `console` and `nestcore`,
// compiles the snippet with the AsyncFunction constructor (so a syntax error
// is reported as such and the snippet cannot break out of the wrapper), and
// reports exactly one JSON envelope through `done`.
const PRELUDE = String.raw`(function (call, log, done, code, namespacesJson) {
  'use strict';
  const stringify = JSON.stringify, parse = JSON.parse, ErrorCtor = Error, Str = String;
  const freeze = Object.freeze, keys = Object.keys, map = Array.prototype.map, then = Promise.prototype.then;
  const safe = (v) => { try { const s = stringify(v); return s === undefined ? Str(v) : s; } catch (e) { return Str(v); } };
  const fmt = (args) => map.call(args, (a) => typeof a === 'string' ? a
    : (a instanceof ErrorCtor ? a.name + ': ' + a.message : safe(a))).join(' ');
  const level = (l) => function () { log(l, fmt(arguments)); };
  globalThis.console = freeze({ log: level('log'), info: level('info'), warn: level('warn'), error: level('error'), debug: level('debug') });
  const namespaces = parse(namespacesJson);
  const api = {};
  for (const ns of keys(namespaces)) {
    const obj = {};
    for (const m of namespaces[ns]) {
      const path = ns + '.' + m;
      obj[m] = async function (args) {
        let json;
        try { json = args === undefined ? '{}' : stringify(args); }
        catch (e) { throw new TypeError(path + ': arguments must be JSON-serializable (' + Str(e && e.message) + ')'); }
        const env = parse(await call(path, json === undefined ? '{}' : json));
        if (env.ok) return env.value;
        const err = new ErrorCtor(env.error.message);
        err.name = 'NestCoreError';
        err.type = env.error.type;
        if (env.error.code !== undefined) err.code = env.error.code;
        err.method = path;
        if (env.error.details !== undefined) err.details = env.error.details;
        throw err;
      };
    }
    api[ns] = freeze(obj);
  }
  globalThis.nestcore = freeze(api);
  const AsyncFunction = (async function () {}).constructor;
  let fn;
  try { fn = new AsyncFunction(code); }
  catch (e) { done(stringify({ ok: false, error: { type: 'syntax', message: Str(e && e.message || e) } })); return; }
  then.call(fn(), (value) => {
    let out;
    try { out = stringify(value === undefined ? null : value); }
    catch (e) { done(stringify({ ok: false, error: { type: 'serialization', message: 'Return value is not JSON-serializable: ' + Str(e && e.message || e) } })); return; }
    done('{"ok":true,"value":' + (out === undefined ? 'null' : out) + '}');
  }, (e) => {
    const o = e !== null && typeof e === 'object';
    done(stringify({ ok: false, error: {
      type: o && typeof e.type === 'string' ? e.type : 'runtime',
      name: o && e.name ? Str(e.name) : undefined,
      message: o && 'message' in e ? Str(e.message) : Str(e),
      code: o && e.code !== undefined ? Str(e.code) : undefined,
      method: o && typeof e.method === 'string' ? e.method : undefined,
    } }));
  });
})`;

function classifyVmError(raw: unknown, interrupted: boolean): SandboxErrorInfo {
  const o = (raw && typeof raw === 'object' ? raw : {}) as { name?: unknown; message?: unknown };
  const message = typeof o.message === 'string' ? o.message : String(raw);
  if (interrupted || /interrupted/i.test(message)) {
    return { type: 'timeout', message: 'Execution timed out (CPU interrupt).' };
  }
  if (/out of memory/i.test(message)) return { type: 'memory', message: 'Memory limit exceeded.' };
  if (/stack overflow/i.test(message)) return { type: 'memory', message: 'Stack size limit exceeded (stack overflow).' };
  const name = typeof o.name === 'string' ? o.name : '';
  if (name === 'SyntaxError') return { type: 'syntax', message };
  return { type: 'runtime', message: name ? `${name}: ${message}` : message };
}

function hostThrowInfo(e: unknown): SandboxErrorInfo {
  const message = e instanceof Error ? e.message : String(e);
  if (/maximum call stack/i.test(message)) return { type: 'memory', message: 'Stack size limit exceeded (stack overflow).' };
  if (/out of memory|memory access out of bounds/i.test(message)) return { type: 'memory', message: 'Memory limit exceeded.' };
  return { type: 'internal', message: `Sandbox failure: ${message}` };
}

/** Run `code` (the body of an async function) in a fresh QuickJS context. */
export async function runSandboxed(code: string, host: SandboxHost, limits: SandboxLimits): Promise<SandboxOutcome> {
  const QuickJS = await getModule();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.maxStackBytes);

  let deadline = Date.now() + limits.timeoutMs;
  let clockPaused = 0;
  let interrupted = false;
  // > 0 while the host itself evaluates in the VM (dumping an error): never
  // interrupt our own work, or QuickJS leaks the half-built values.
  let hostWork = 0;
  runtime.setInterruptHandler(() => {
    if (hostWork === 0 && clockPaused === 0 && Date.now() > deadline) {
      interrupted = true;
      return true;
    }
    return false;
  });

  const vm = runtime.newContext();
  const dumpError = (h: QuickJSHandle): unknown => {
    hostWork++;
    try {
      return vm.dump(h);
    } finally {
      hostWork--;
      h.dispose();
    }
  };
  const pending = new Set<QuickJSDeferredPromise>();
  const ownHandles: QuickJSHandle[] = [];
  let disposed = false;

  const logs: string[] = [];
  let logBytes = 0;
  let logsTruncated = false;
  const pushLog = (lvl: string, message: string) => {
    if (logsTruncated) return;
    const line = lvl === 'log' ? message : `[${lvl}] ${message}`;
    const size = Buffer.byteLength(line);
    if (logBytes + size > limits.maxLogBytes) {
      const room = Math.max(0, limits.maxLogBytes - logBytes);
      if (room > 0) logs.push(line.slice(0, room));
      logs.push('[logs truncated]');
      logsTruncated = true;
      return;
    }
    logBytes += size;
    logs.push(line);
  };

  // A single settle point for: envelope delivered, fatal host error, VM job
  // error, wall-clock timeout.
  let settle!: (o: { envelope?: string; error?: SandboxErrorInfo }) => void;
  const finished = new Promise<{ envelope?: string; error?: SandboxErrorInfo }>((r) => {
    let done = false;
    settle = (o) => {
      if (done) return;
      done = true;
      r(o);
    };
  });

  let timer: NodeJS.Timeout | undefined;
  const armTimer = () => {
    const wait = Math.max(0, deadline - Date.now());
    timer = setTimeout(() => {
      if (clockPaused > 0) return armTimer();
      if (Date.now() < deadline) return armTimer();
      settle({ error: { type: 'timeout', message: `Execution timed out after ${limits.timeoutMs} ms.` } });
    }, Math.min(wait, 2 ** 31 - 1) + 5);
    timer.unref?.();
  };
  armTimer();

  const control: HostControl = {
    async suspendClock<T>(p: Promise<T>): Promise<T> {
      clockPaused++;
      const started = Date.now();
      try {
        return await p;
      } finally {
        clockPaused--;
        deadline += Date.now() - started;
      }
    },
    log: pushLog,
  };

  // An exception thrown out of the WASM instance itself (e.g. the host stack
  // overflowing inside it) leaves the instance unusable: report it and never
  // reuse the module.
  let wasmBroken = false;
  const onHostThrow = (e: unknown) => {
    wasmBroken = true;
    settle({ error: hostThrowInfo(e) });
  };

  const drainJobs = () => {
    if (disposed) return;
    try {
      const res = runtime.executePendingJobs();
      if (res.error) {
        const raw = dumpError(res.error);
        settle({ error: classifyVmError(raw, interrupted) });
      }
    } catch (e) {
      onHostThrow(e);
    }
  };

  try {
    const logFn = vm.newFunction('log', (lvlH, msgH) => {
      pushLog(vm.getString(lvlH), vm.getString(msgH));
    });
    const doneFn = vm.newFunction('done', (envH) => {
      settle({ envelope: vm.getString(envH) });
    });
    const callFn = vm.newFunction('call', (pathH, argsH) => {
      const path = vm.getString(pathH);
      const argsJson = vm.getString(argsH);
      const deferred = vm.newPromise();
      pending.add(deferred);
      void (async () => {
        let envelope: string;
        try {
          const value = await host.call(path, JSON.parse(argsJson), control);
          envelope = JSON.stringify({ ok: true, value: value === undefined ? null : value });
        } catch (e) {
          if (e instanceof HostCallError && e.fatal) {
            settle({ error: e.info });
            return;
          }
          const info: SandboxErrorInfo =
            e instanceof HostCallError ? e.info : { type: 'internal', message: e instanceof Error ? e.message : String(e) };
          envelope = JSON.stringify({ ok: false, error: info });
        }
        if (disposed) return;
        try {
          const h = vm.newString(envelope);
          deferred.resolve(h);
          h.dispose();
          pending.delete(deferred);
        } catch (e) {
          onHostThrow(e);
          return;
        }
        drainJobs();
      })();
      return deferred.handle;
    });
    ownHandles.push(logFn, doneFn, callFn);

    const preludeRes = vm.evalCode(PRELUDE, 'nestcore-prelude.js');
    if (preludeRes.error) {
      const raw = dumpError(preludeRes.error);
      return { ok: false, error: { type: 'internal', message: `Sandbox prelude failed: ${JSON.stringify(raw)}` }, logs, logsTruncated };
    }
    const preludeFn = preludeRes.value;
    ownHandles.push(preludeFn);
    const codeH = vm.newString(code);
    const nsH = vm.newString(JSON.stringify(host.namespaces));
    ownHandles.push(codeH, nsH);

    // Runs the snippet synchronously up to its first await (a sync infinite
    // loop is stopped here by the interrupt handler).
    try {
      const callRes = vm.callFunction(preludeFn, vm.undefined, callFn, logFn, doneFn, codeH, nsH);
      if (callRes.error) {
        const raw = dumpError(callRes.error);
        settle({ error: classifyVmError(raw, interrupted) });
      } else {
        callRes.value.dispose();
        drainJobs();
      }
    } catch (e) {
      onHostThrow(e);
    }

    const outcome = await finished;
    if (outcome.error) return { ok: false, error: outcome.error, logs, logsTruncated };

    let env: { ok?: unknown; value?: unknown; error?: SandboxErrorInfo };
    try {
      env = JSON.parse(outcome.envelope ?? '');
    } catch {
      return { ok: false, error: { type: 'internal', message: 'Sandbox returned an unreadable result.' }, logs, logsTruncated };
    }
    if (env.ok === true) {
      // Re-serialise from the parsed envelope: the snippet controls the text.
      return { ok: true, resultJson: JSON.stringify(env.value ?? null), logs, logsTruncated };
    }
    const err = env.error && typeof env.error === 'object' ? env.error : { type: 'runtime', message: 'Unknown error' };
    const info: SandboxErrorInfo = {
      type: String(err.type ?? 'runtime'),
      message: String(err.message ?? ''),
      ...(err.code !== undefined ? { code: String(err.code) } : {}),
      ...(err.method !== undefined ? { method: String(err.method) } : {}),
    };
    if (info.type === 'runtime') {
      const typed = classifyVmError({ message: info.message, name: (err as { name?: string }).name }, interrupted);
      if (typed.type !== 'runtime') return { ok: false, error: typed, logs, logsTruncated };
      const name = (err as { name?: string }).name;
      if (name && name !== 'Error' && name !== 'NestCoreError') info.message = `${name}: ${info.message}`;
    }
    return { ok: false, error: info, logs, logsTruncated };
  } finally {
    disposed = true;
    if (timer) clearTimeout(timer);
    for (const d of pending) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    pending.clear();
    for (const h of ownHandles) {
      try {
        if (h.alive) h.dispose();
      } catch {
        /* ignore */
      }
    }
    if (wasmBroken) discardModule();
    try {
      vm.dispose();
      runtime.dispose();
    } catch {
      // A leaked object (QuickJS can leak on out-of-memory paths) aborts the
      // WASM instance on dispose; never reuse it.
      discardModule();
    }
  }
}
