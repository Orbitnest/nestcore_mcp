import dotenv from 'dotenv';
import { createRequire } from 'node:module';
import type { AppConfig } from './types/config.types.js';

dotenv.config();

// The published version is the single source of truth (dist/ and src/ both sit
// one level below package.json).
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

function env(key: string, fallback?: string): string {
  return process.env[key] ?? fallback ?? '';
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

export function loadConfig(): AppConfig {
  return {
    // A trailing slash would produce `//api/...` URLs that 404.
    apiUrl: env('ORBITNEST_API_URL', 'https://api.orbitnest.io').replace(/\/+$/, ''),
    apiBasePath: env('ORBITNEST_API_BASE_PATH', '/api'),
    serverName: env('MCP_SERVER_NAME', 'orbitnest-studio'),
    serverVersion: version,
    logLevel: env('LOG_LEVEL', 'info'),
    defaultProjectId: env('DEFAULT_PROJECT_ID') || null,
    enableSqlGuard: envBool('ENABLE_SQL_GUARD', true),
    blockAuthTableMutations: envBool('BLOCK_AUTH_TABLE_MUTATIONS', true),
    schemaCacheTtl: envInt('SCHEMA_CACHE_TTL', 300000),
    tokenRefreshThreshold: envInt('TOKEN_REFRESH_THRESHOLD', 60000),
  };
}
