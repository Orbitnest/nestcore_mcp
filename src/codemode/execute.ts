/**
 * Code Mode `execute`: runs a model-written snippet in the QuickJS sandbox and
 * bridges `nestcore.<ns>.<method>(args)` calls to the SAME tool handlers the
 * direct tools use, so every in-handler guard (SQL guard, auth-table guard,
 * confirm flags, secret redaction) applies unchanged.
 *
 * Per bridge call: look up the method → validate args with the tool's zod shape
 * → enforce class rules (writes disabled, destructive confirmation) → call the
 * handler → unwrap its JSON text → throw a structured error into the VM when
 * the tool reported a failure.
 */
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodError } from 'zod';
import type { SessionService } from '../auth/session.service.js';
import type { CodeModeConfig } from '../types/config.types.js';
import { logger } from '../utils/logger.js';
import { classifyCall, type ToolEntry, type ToolResult } from './registry.js';
import { needsBridgeConfirm } from './typegen.js';
import type { CodeModeCatalog } from './tools.js';
import { HostCallError, runSandboxed, type HostControl, type SandboxErrorInfo } from './sandbox.js';

export const MAX_CODE_LENGTH = 100_000;
const STACK_BYTES = 256 * 1024;

export interface ExecuteDeps {
  catalog: CodeModeCatalog;
  config: CodeModeConfig;
  session: SessionService;
  /** The MCP server (for client capabilities + elicitation). */
  server: McpServer;
}

export interface ExecuteResult {
  /** JSON-serialisable body returned to the client. */
  body: Record<string, unknown>;
  isError: boolean;
}

const LOGIN_HINT = 'Not signed in (or the session expired). Call the nestcore_login tool (outside execute) to sign in, then retry.';

/** Map a tool's error `code` to the error `type` the snippet sees. */
function typeForCode(code: string | undefined, statusCode: unknown): string {
  if (code === 'AUTH_ERROR' || statusCode === 401) return 'auth';
  if (code === 'SAFETY_ERROR') return 'guard';
  if (code === 'VALIDATION_ERROR') return 'validation';
  if (code === 'PROJECT_CONTEXT_ERROR') return 'project';
  return 'api';
}

function formatZodError(path: string, err: ZodError): string {
  const parts = err.issues.slice(0, 8).map((i) => `${i.path.length ? i.path.join('.') : '(args)'}: ${i.message}`);
  return `Invalid arguments for nestcore.${path} — ${parts.join('; ')}${err.issues.length > 8 ? '; …' : ''}. Use search to see the signature.`;
}

/** Unwrap a handler result: the JSON text content, parsed when possible. */
export function unwrapToolResult(result: ToolResult): { value: unknown; failed: boolean } {
  const texts = (result?.content ?? []).filter((c) => c?.type === 'text').map((c) => String(c.text ?? ''));
  let value: unknown;
  if (texts.length === 0) value = result?.content ?? null;
  else {
    const joined = texts.join('\n');
    try {
      value = JSON.parse(joined);
    } catch {
      value = joined;
    }
  }
  const o = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const looksLikeError =
    !!o &&
    typeof o.error === 'string' &&
    (typeof o.code === 'string' || o.success === false);
  return { value, failed: result?.isError === true || looksLikeError };
}

/** Error raised inside the VM for a failed tool result. */
function toolFailure(path: string, value: unknown): HostCallError {
  const o = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const code = typeof o.code === 'string' ? o.code : undefined;
  const type = typeForCode(code, o.statusCode);
  let message = typeof o.error === 'string' ? o.error : typeof value === 'string' ? value : 'Tool call failed';
  if (type === 'auth') message = `${message} ${LOGIN_HINT}`;
  const details: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (k !== 'error' && k !== 'code') details[k] = v;
  return new HostCallError({
    type,
    message,
    code: code ?? (o.success === false ? 'FAILED' : 'TOOL_ERROR'),
    method: path,
    ...(Object.keys(details).length ? { details } : {}),
  });
}

/** Short description of what a destructive call targets, for the confirmation prompt. */
function describeTarget(args: Record<string, unknown>, session: SessionService): string {
  const parts: string[] = [];
  for (const k of ['webhookId', 'variableName', 'pack', 'migrationId', 'status', 'description']) {
    if (typeof args[k] === 'string' && args[k]) parts.push(`${k}=${String(args[k]).slice(0, 80)}`);
  }
  const s = session.getSession();
  const project = typeof args.projectId === 'string' ? args.projectId : s.currentProjectSlug ?? s.currentProjectId;
  if (project) parts.unshift(`project=${project}`);
  return parts.join(', ') || 'the active project';
}

function clientSupportsElicitation(server: McpServer): boolean {
  try {
    return !!server.server.getClientCapabilities()?.elicitation;
  } catch {
    return false;
  }
}

/** Run one `execute` request. */
export async function runExecute(
  code: string,
  timeoutMs: number | undefined,
  deps: ExecuteDeps,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra: any,
): Promise<ExecuteResult> {
  const { catalog, config } = deps;
  const executionId = randomUUID();
  const limit = Math.min(config.timeoutMs, Math.max(100, timeoutMs ?? config.timeoutMs));
  let calls = 0;

  const namespaces: Record<string, string[]> = {};
  for (const [ns, methods] of catalog.declarations.namespaces) namespaces[ns] = methods;

  const call = async (path: string, rawArgs: unknown, control: HostControl): Promise<unknown> => {
    calls++;
    if (calls > config.maxCalls) {
      throw new HostCallError(
        { type: 'call_limit', message: `Too many nestcore.* calls: the limit is ${config.maxCalls} per execute.`, method: path },
        true,
      );
    }
    const entry = catalog.get(path);
    if (!entry) {
      throw new HostCallError({ type: 'not_found', message: `Unknown method nestcore.${path}. Use search to find methods.`, code: 'NOT_FOUND', method: path });
    }
    const started = Date.now();
    let cls: string = entry.cls;
    let argKeys: string[] = [];
    try {
      if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
        throw new HostCallError({ type: 'validation', message: `nestcore.${path} takes one object argument, e.g. nestcore.${path}({ ... }).`, code: 'VALIDATION_ERROR', method: path });
      }
      const args = { ...(rawArgs as Record<string, unknown>) };
      argKeys = Object.keys(args);

      // Bridge-level confirmation for destructive tools that have no flag of their own.
      const bridgeConfirm = needsBridgeConfirm(entry);
      let confirmed = false;
      if (bridgeConfirm) {
        confirmed = args.confirm === true;
        delete args.confirm;
      }

      // Same parsing the SDK applies to direct tool calls.
      const schema = z.object(entry.shape);
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        throw new HostCallError({ type: 'validation', message: formatZodError(path, parsed.error), code: 'VALIDATION_ERROR', method: path });
      }
      const unknownKeys = argKeys.filter((k) => !(k in entry.shape) && !(bridgeConfirm && k === 'confirm'));
      if (unknownKeys.length) control.log('warn', `nestcore.${path}: ignored unknown argument(s): ${unknownKeys.join(', ')}`);

      cls = classifyCall(entry, parsed.data);
      if (!catalog.options.allowWrites && cls !== 'read' && entry.cls !== 'session') {
        throw new HostCallError({
          type: 'guard',
          message: `Writes are disabled (NESTCORE_MCP_ALLOW_WRITES=false): nestcore.${path} would run ${cls} SQL/operations. Only read-only calls are allowed.`,
          code: 'WRITES_DISABLED',
          method: path,
        });
      }

      if (bridgeConfirm) await confirmDestructive(entry, args, confirmed, control, deps);

      const result = (await entry.handler(parsed.data, extra)) as ToolResult;
      const { value, failed } = unwrapToolResult(result);
      if (failed) throw toolFailure(path, value);
      logger.info('codemode call', { executionId, method: path, class: cls, ms: Date.now() - started, ok: true, argKeys });
      return value;
    } catch (e) {
      const info: SandboxErrorInfo | undefined = e instanceof HostCallError ? e.info : undefined;
      logger.info('codemode call', {
        executionId,
        method: path,
        class: cls,
        ms: Date.now() - started,
        ok: false,
        argKeys,
        error: info?.code ?? info?.type ?? 'internal',
      });
      if (e instanceof HostCallError) throw e;
      throw new HostCallError({ type: 'internal', message: e instanceof Error ? e.message : String(e), method: path });
    }
  };

  const maxLogBytes = Math.max(1000, Math.floor(config.maxOutputBytes / 4));
  const outcome = await runSandboxed(code, { namespaces, call }, {
    timeoutMs: limit,
    memoryBytes: config.memoryMb * 1024 * 1024,
    maxStackBytes: STACK_BYTES,
    maxLogBytes,
  });
  logger.info('codemode execute', { executionId, ok: outcome.ok, calls, error: outcome.error?.type });

  if (!outcome.ok) {
    const error: Record<string, unknown> = { type: outcome.error?.type ?? 'internal', message: outcome.error?.message ?? '' };
    if (outcome.error?.code) error.code = outcome.error.code;
    if (outcome.error?.method) error.method = outcome.error.method;
    return { isError: true, body: { error, logs: outcome.logs, calls, executionId } };
  }

  const resultJson = outcome.resultJson ?? 'null';
  const body: Record<string, unknown> = { result: JSON.parse(resultJson), logs: outcome.logs, calls, executionId };
  const size = Buffer.byteLength(JSON.stringify(body));
  if (size > config.maxOutputBytes) {
    const overhead = Buffer.byteLength(JSON.stringify({ ...body, result: '', truncated: true, totalBytes: size }));
    const room = Math.max(0, config.maxOutputBytes - overhead - 64);
    body.result = Buffer.from(resultJson).subarray(0, room).toString('utf8').replace(/�+$/, '');
    body.truncated = true;
    body.totalBytes = Buffer.byteLength(resultJson);
    body.note = `Result exceeded ${config.maxOutputBytes} bytes; "result" is the first part of its JSON text. Return less (filter, slice, aggregate) to get it whole.`;
  }
  if (outcome.logsTruncated) body.logsTruncated = true;
  return { isError: false, body };
}

async function confirmDestructive(
  entry: ToolEntry,
  args: Record<string, unknown>,
  confirmed: boolean,
  control: HostControl,
  deps: ExecuteDeps,
): Promise<void> {
  const path = entry.path;
  if (clientSupportsElicitation(deps.server)) {
    const target = describeTarget(args, deps.session);
    let result: { action?: string; content?: Record<string, unknown> };
    try {
      result = await control.suspendClock(
        deps.server.server.elicitInput({
          message: `Allow the AI to run the destructive operation nestcore.${path} on ${target}?`,
          requestedSchema: {
            type: 'object',
            properties: {
              confirm: { type: 'boolean', title: `Run ${path}`, description: `Run nestcore.${path} (${target})` },
            },
            required: ['confirm'],
          },
        }),
      );
    } catch (e) {
      throw new HostCallError({ type: 'cancelled', message: `Confirmation for nestcore.${path} failed: ${e instanceof Error ? e.message : String(e)}`, code: 'CANCELLED', method: path });
    }
    if (result.action !== 'accept' || result.content?.confirm !== true) {
      throw new HostCallError({ type: 'cancelled', message: `nestcore.${path} was cancelled by user.`, code: 'CANCELLED', method: path });
    }
    return;
  }
  if (!confirmed) {
    throw new HostCallError({
      type: 'guard',
      message: `nestcore.${path} is destructive. Pass confirm: true, only after the user explicitly asked for this operation.`,
      code: 'CONFIRMATION_REQUIRED',
      method: path,
    });
  }
}
