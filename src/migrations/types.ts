/**
 * Migration engine types — self-contained so the MCP server has no runtime
 * dependency on the Node SDK. Mirrors `@nestcorehq/node`'s migration types.
 */

export type MigrationStatus = 'success' | 'failed';

export interface MigrationFile {
  /** Numeric prefix used for ordering + registry primary key (e.g. "001"). */
  migrationId: string;
  /** Full file name (e.g. "001_init.sql"). */
  name: string;
  /** Absolute path on disk. */
  path: string;
  /** Raw SQL contents (the whole file). */
  content: string;
  /** Forward SQL (before `-- migrate:down`, or the whole file). */
  up: string;
  /** Rollback SQL (after `-- migrate:down`), or "" when none. */
  down: string;
  /** SHA-256 (hex) of the contents. */
  checksum: string;
}

export interface MigrationRecord {
  migration_id: string;
  name: string;
  checksum: string;
  executed_at: string;
  status: MigrationStatus;
}

export interface MigrationStatusEntry {
  migrationId: string;
  name: string;
  checksum: string;
  status: MigrationStatus | 'pending';
  applied: boolean;
  executedAt?: string;
  checksumMismatch: boolean;
}

export interface RunResult {
  ran: string[];
  skipped: string[];
  failed?: { migrationId: string; name: string; error: string };
}

/** Result shape returned by {@link MigrationSqlClient.query}. */
export interface SqlResult<T = Record<string, unknown>> {
  data: { rows: T[] } | null;
  error: { message: string } | null;
}

/**
 * Minimal SQL surface the engine needs. The MCP adapts `apiClient.executeSql`
 * (which throws on failure) into this `{ data, error }` shape.
 */
export interface MigrationSqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<SqlResult<T>>;
}

export class MigrationError extends Error {
  constructor(message: string, public readonly result?: RunResult) {
    super(message);
    this.name = 'MigrationError';
  }
}
