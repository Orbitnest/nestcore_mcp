/**
 * Code Mode MCP tools: `search` (find methods + their TypeScript declarations)
 * and `execute` (run a JS snippet against them in a sandbox).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolEntry, ToolRegistry } from './registry.js';
import { DYNAMIC_SQL_TOOL, LOCAL_SESSION_TOOLS, NAMESPACES, SANDBOX_EXCLUDED } from './catalog.js';
import { generateDeclarations, type Declarations } from './typegen.js';
import { SearchIndex, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, formatSearchResult } from './search.js';
import type { CodeModeConfig } from '../types/config.types.js';
import { MAX_CODE_LENGTH, runExecute, type ExecuteDeps } from './execute.js';

export interface CatalogOptions {
  /** NESTCORE_MCP_ALLOW_WRITES. When false only read methods (and read-only SQL) are exposed. */
  allowWrites: boolean;
}

/** The methods visible inside `execute` (and in `search`), with cached declarations. */
export class CodeModeCatalog {
  readonly entries: ToolEntry[];
  readonly declarations: Declarations;
  readonly index: SearchIndex;
  readonly namespaces: string[];
  private readonly byPath: Map<string, ToolEntry>;

  constructor(registry: ToolRegistry, readonly options: CatalogOptions) {
    this.entries = registry.all().filter((e) => isVisible(e, options));
    this.byPath = new Map(this.entries.map((e) => [e.path, e]));
    this.declarations = generateDeclarations(this.entries);
    this.index = new SearchIndex(this.entries);
    this.namespaces = NAMESPACES.filter((ns) => this.entries.some((e) => e.ns === ns));
  }

  get(path: string): ToolEntry | undefined {
    return this.byPath.get(path);
  }
}

export function isVisible(entry: ToolEntry, options: CatalogOptions): boolean {
  if (SANDBOX_EXCLUDED.has(entry.name)) return false;
  if (options.allowWrites) return true;
  return entry.cls === 'read' || entry.name === DYNAMIC_SQL_TOOL || LOCAL_SESSION_TOOLS.has(entry.name);
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export function registerSearchTool(server: McpServer, catalog: CodeModeCatalog): void {
  server.registerTool(
    'search',
    {
      description:
        'Find NestCore API methods for use inside `execute`. Returns the best matches (max 10) as TypeScript ' +
        'declarations (`declare namespace nestcore { const db: { getSchema(...): Promise<unknown> } }`) with each ' +
        'method\'s access class (read / write / destructive / session). Query with words, e.g. "list tables", ' +
        `"storage buckets", "add task", or a path like "db.getSchema". Namespaces: ${catalog.namespaces.join(', ')}.`,
      inputSchema: {
        query: z.string().min(1).max(200).describe('Words describing what you want to do, or a method path'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SEARCH_MAX_LIMIT)
          .optional()
          .describe(`Max matches (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT})`),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const matches = catalog.index.search(query, limit ?? SEARCH_DEFAULT_LIMIT);
      return text(
        formatSearchResult(query, matches, (p) => catalog.declarations.byPath.get(p), catalog.namespaces),
      );
    },
  );
}

export function executeToolDescription(catalog: CodeModeCatalog, config: CodeModeConfig): string {
  return [
    'Run JavaScript against the NestCore API in a sandbox. Call `search` first to get method signatures.',
    '`code` is the body of an async function: `await nestcore.<namespace>.<method>({ ...args })`, `return` the value you want back (JSON),',
    'console.log() goes to `logs`. Methods throw an Error with .code/.type on failure (catch it to handle). No network, fs, require/import or timers.',
    `Namespaces: ${catalog.namespaces.join(', ')}.`,
    `Limits per run: ${config.timeoutMs} ms, ${config.memoryMb} MB, ${config.maxCalls} calls, ${config.maxOutputBytes} bytes of output.`,
    catalog.options.allowWrites
      ? 'Destructive methods keep their own confirm flag; those without one need confirm: true (or a user prompt). If a call fails with AUTH_ERROR, call the nestcore_login tool.'
      : 'Writes are disabled: only read methods and read-only SQL are available. If a call fails with AUTH_ERROR, call the nestcore_login tool.',
    'Example: const s = await nestcore.db.getSchema({}); return s.tables.map(t => t.name);',
  ].join('\n');
}

export function registerExecuteTool(server: McpServer, deps: ExecuteDeps): void {
  const { catalog, config } = deps;
  server.registerTool(
    'execute',
    {
      description: executeToolDescription(catalog, config),
      inputSchema: {
        code: z.string().min(1).max(MAX_CODE_LENGTH).describe('Body of an async function; `return` the result'),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(config.timeoutMs)
          .optional()
          .describe(`Wall-clock limit for this run (default and max ${config.timeoutMs})`),
      },
      annotations: {
        readOnlyHint: !catalog.options.allowWrites,
        destructiveHint: catalog.options.allowWrites,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ code, timeoutMs }, extra) => {
      const { body, isError } = await runExecute(code, timeoutMs, deps, extra);
      return { content: [{ type: 'text' as const, text: JSON.stringify(body) }], ...(isError ? { isError: true } : {}) };
    },
  );
}
