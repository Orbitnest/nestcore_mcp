import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape } from 'zod';
import { logger } from '../utils/logger.js';
import { analyzeSql } from '../safety/sql.guard.js';
import { DYNAMIC_SQL_TOOL, OPEN_WORLD_TOOLS, TOOL_CATALOG, type ToolClass } from './catalog.js';
import { askUserToConfirm, clientSupportsElicitation, userConfirmationFor } from '../safety/confirmation.js';
import { formatErrorResponse, McpError } from '../utils/errors.js';

/** What a tool handler returns (the SDK's CallToolResult, loosely typed). */
export interface ToolResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  [k: string]: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolHandler = (args: any, extra?: any) => ToolResult | Promise<ToolResult>;

export interface ToolEntry {
  /** Registered MCP tool name, e.g. `nestcore_get_schema`. */
  name: string;
  description: string;
  /** The zod raw shape the tool was registered with. */
  shape: ZodRawShape;
  handler: ToolHandler;
  cls: ToolClass;
  ns: string;
  method: string;
  /** `<ns>.<method>`, the Code Mode path. */
  path: string;
  /** The tool's own confirmation argument (`confirmDeletion`, `confirm`, …), if any. */
  confirmFlag: string | null;
  /** True when the tool was not in the catalog and got a fallback mapping. */
  unmapped?: boolean;
}

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * Records every tool the server defines — name, description, input shape,
 * handler and class — so Code Mode can generate types, search them and call
 * the same handlers from the sandbox. Handlers stay untouched.
 */
export class ToolRegistry {
  private readonly byName = new Map<string, ToolEntry>();
  private readonly byPathMap = new Map<string, ToolEntry>();

  add(name: string, description: string, shape: ZodRawShape | undefined, handler: ToolHandler): ToolEntry {
    let cat = TOOL_CATALOG[name];
    let unmapped = false;
    if (!cat) {
      // Never crash a published server over a missing mapping; the unit test
      // fails on any fallback so it cannot ship unnoticed.
      unmapped = true;
      cat = { ns: 'misc', method: camel(name.replace(/^nestcore_/, '')), cls: 'write' };
      logger.warn('Tool missing from the Code Mode catalog; using a fallback mapping', { tool: name });
    }
    const s = shape ?? {};
    const confirmFlag = Object.keys(s).find((k) => /^confirm/.test(k)) ?? null;
    const entry: ToolEntry = {
      name,
      description,
      shape: s,
      handler,
      cls: cat.cls,
      ns: cat.ns,
      method: cat.method,
      path: `${cat.ns}.${cat.method}`,
      confirmFlag,
      ...(unmapped ? { unmapped } : {}),
    };
    if (this.byName.has(name)) throw new Error(`Tool registered twice: ${name}`);
    if (this.byPathMap.has(entry.path)) {
      throw new Error(`Code Mode path collision: ${entry.path} (${this.byPathMap.get(entry.path)!.name} and ${name})`);
    }
    this.byName.set(name, entry);
    this.byPathMap.set(entry.path, entry);
    return entry;
  }

  get(name: string): ToolEntry | undefined {
    return this.byName.get(name);
  }

  byPath(path: string): ToolEntry | undefined {
    return this.byPathMap.get(path);
  }

  all(): ToolEntry[] {
    return [...this.byName.values()];
  }

  get size(): number {
    return this.byName.size;
  }
}

/**
 * Class of one call. Only `db.executeSql` depends on its arguments: read-only
 * SQL is `read`, writes are `write`, destructive statements `destructive`.
 */
export function classifyCall(entry: Pick<ToolEntry, 'name' | 'cls'>, args: unknown): ToolClass {
  if (entry.name !== DYNAMIC_SQL_TOOL) return entry.cls;
  const sql = (args as { sql?: unknown } | null)?.sql;
  if (typeof sql !== 'string') return 'write';
  const a = analyzeSql(sql);
  if (a.isReadOnly) return 'read';
  return a.isDestructive ? 'destructive' : 'write';
}

const IDEMPOTENT_VERB = /^nestcore_(get|list|update|set|enable|disable|delete|toggle)_/;
const IDEMPOTENT_DESTRUCTIVE_VERB = /^nestcore_(delete|set|disable|revoke)_/;

/** MCP tool annotations derived from the class table. */
export function annotationsFor(name: string, cls: ToolClass): ToolAnnotations {
  const openWorldHint = OPEN_WORLD_TOOLS.has(name);
  if (name === DYNAMIC_SQL_TOOL) {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint };
  }
  switch (cls) {
    case 'read':
      return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint };
    case 'destructive':
      return {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: IDEMPOTENT_DESTRUCTIVE_VERB.test(name),
        openWorldHint,
      };
    case 'write':
      return {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: IDEMPOTENT_VERB.test(name) && !/^nestcore_toggle_/.test(name),
        openWorldHint,
      };
    case 'session':
    default:
      return { readOnlyHint: false, destructiveHint: false, openWorldHint };
  }
}

/**
 * Wrap a direct tool's handler so the highest-risk calls (see
 * safety/confirmation.ts) ask the human through MCP elicitation when the
 * client supports it. Without elicitation support the handler runs as before
 * (its own confirm flags + the tool annotations apply).
 */
export function withUserConfirmation(server: McpServer, name: string, handler: ToolHandler): ToolHandler {
  return async (args, extra) => {
    const what = userConfirmationFor(name, args as Record<string, unknown>);
    if (what && clientSupportsElicitation(server)) {
      const allowed = await askUserToConfirm(server, `Allow the AI to ${what}? (${name})`, `Run ${name}`);
      if (!allowed) {
        return formatErrorResponse(new McpError(`${name} was cancelled by user (not confirmed).`, 'CANCELLED'));
      }
    }
    return handler(args, extra);
  };
}

interface RegisterConfig {
  description?: string;
  inputSchema?: ZodRawShape;
  annotations?: ToolAnnotations;
  [k: string]: unknown;
}

/**
 * A view of `server` whose `registerTool` records each tool in `registry` and
 * registers it on the real server only when `expose(name)` is true (with
 * annotations added). Everything else (registerPrompt, …) passes through.
 */
export function recordingServer(
  server: McpServer,
  registry: ToolRegistry,
  expose: (name: string) => boolean,
): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'registerTool') {
        return (name: string, config: RegisterConfig, handler: ToolHandler) => {
          const entry = registry.add(name, config.description ?? '', config.inputSchema, handler);
          if (!expose(name)) return undefined;
          return target.registerTool(
            name,
            { ...config, annotations: { ...annotationsFor(name, entry.cls), ...(config.annotations ?? {}) } } as never,
            withUserConfirmation(target, name, handler) as never,
          );
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
