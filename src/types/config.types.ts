export interface AppConfig {
  apiUrl: string;
  apiBasePath: string;
  serverName: string;
  serverVersion: string;
  logLevel: string;
  defaultProjectId: string | null;
  enableSqlGuard: boolean;
  blockAuthTableMutations: boolean;
  schemaCacheTtl: number;
  tokenRefreshThreshold: number;
  /** Code Mode settings (NESTCORE_MCP_*). */
  codeMode: CodeModeConfig;
}

/** NESTCORE_MCP_MODE: `code` (search + execute + nestcore_login), `tools` (every direct tool) or `both`. */
export type McpMode = 'code' | 'tools' | 'both';

export interface CodeModeConfig {
  mode: McpMode;
  /** NESTCORE_MCP_ALLOW_WRITES (default true). False: only read methods and read-only SQL in `execute`. */
  allowWrites: boolean;
  /** NESTCORE_MCP_EXEC_TIMEOUT_MS (default 30000): default and maximum wall clock per execute. */
  timeoutMs: number;
  /** NESTCORE_MCP_EXEC_MEMORY_MB (default 128). */
  memoryMb: number;
  /** NESTCORE_MCP_EXEC_MAX_CALLS (default 50): nestcore.* calls per execute. */
  maxCalls: number;
  /** NESTCORE_MCP_EXEC_MAX_OUTPUT_BYTES (default 100000). */
  maxOutputBytes: number;
}
