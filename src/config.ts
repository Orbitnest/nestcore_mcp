import dotenv from 'dotenv';
import { createRequire } from 'node:module';
import type { AppConfig, McpMode } from './types/config.types.js';

dotenv.config();

// The published version is the single source of truth (dist/ and src/ both sit
// one level below package.json).
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

function env(key: string, fallback?: string): string {
  return process.env[key] ?? fallback ?? '';
}

/**
 * `NESTCORE_<name>`, falling back to the pre-rename `ORBITNEST_<name>` so
 * existing MCP client configs keep working.
 */
export function brandEnv(name: string): string | undefined {
  return process.env[`NESTCORE_${name}`] ?? process.env[`ORBITNEST_${name}`];
}

function envBool(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return fallback;
  return val === 'true' || val === '1';
}

function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (val === undefined) return fallback;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? fallback : parsed;
}

/** Positive integer from `NESTCORE_<name>` / `ORBITNEST_<name>`, clamped to [min, max]. */
function brandInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = parseInt(brandEnv(name) ?? '', 10);
  if (isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function mcpMode(): McpMode {
  const raw = (brandEnv('MCP_MODE') ?? '').trim().toLowerCase();
  if (raw === 'code' || raw === 'tools' || raw === 'both') return raw;
  if (raw) console.error(`[nestcore-mcp] Unknown NESTCORE_MCP_MODE "${raw}"; using "code" (valid: code, tools, both).`);
  return 'code';
}

function brandBool(name: string, fallback: boolean): boolean {
  const val = brandEnv(name);
  if (val === undefined || val === '') return fallback;
  return !/^(false|0|no|off)$/i.test(val.trim());
}

export function loadConfig(): AppConfig {
  return {
    // A trailing slash would produce `//api/...` URLs that 404.
    apiUrl: (brandEnv('API_URL') ?? 'https://api.nestcore.io').replace(/\/+$/, ''),
    apiBasePath: brandEnv('API_BASE_PATH') ?? '/api',
    serverName: env('MCP_SERVER_NAME', 'nestcore'),
    serverVersion: version,
    logLevel: env('LOG_LEVEL', 'info'),
    defaultProjectId: env('DEFAULT_PROJECT_ID') || null,
    enableSqlGuard: envBool('ENABLE_SQL_GUARD', true),
    blockAuthTableMutations: envBool('BLOCK_AUTH_TABLE_MUTATIONS', true),
    schemaCacheTtl: envInt('SCHEMA_CACHE_TTL', 300000),
    tokenRefreshThreshold: envInt('TOKEN_REFRESH_THRESHOLD', 60000),
    codeMode: {
      mode: mcpMode(),
      allowWrites: brandBool('MCP_ALLOW_WRITES', true),
      timeoutMs: brandInt('MCP_EXEC_TIMEOUT_MS', 30000, 100, 600000),
      memoryMb: brandInt('MCP_EXEC_MEMORY_MB', 128, 8, 2048),
      maxCalls: brandInt('MCP_EXEC_MAX_CALLS', 50, 1, 10000),
      maxOutputBytes: brandInt('MCP_EXEC_MAX_OUTPUT_BYTES', 100000, 1000, 10000000),
    },
  };
}
