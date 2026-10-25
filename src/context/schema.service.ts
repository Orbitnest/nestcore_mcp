import type { DatabaseSchema } from '../types/session.types.js';
import { NestCoreClient } from '../sdk/nestcore.client.js';
import { isAuthTable } from '../safety/auth-table.guard.js';
import { logger } from '../utils/logger.js';

export class SchemaService {
  private cache: Map<string, { schema: DatabaseSchema; fetchedAt: number }> = new Map();
  private ttl: number;
  private apiClient: NestCoreClient;

  constructor(apiClient: NestCoreClient, ttlMs: number = 300000) {
    this.apiClient = apiClient;
    this.ttl = ttlMs;
  }

  async getSchema(projectId: string, forceRefresh: boolean = false): Promise<DatabaseSchema> {
    const cached = this.cache.get(projectId);
    if (cached && !forceRefresh && (Date.now() - cached.fetchedAt) < this.ttl) {
      logger.debug('Returning cached schema', { projectId });
      return cached.schema;
    }

    logger.info('Fetching schema from API', { projectId });
    const result = await this.apiClient.getTableMetadata(projectId);

    const tables = Array.isArray(result.tables) ? result.tables : (Array.isArray(result) ? result : []);

    const schema: DatabaseSchema = {
      tables: (tables as Record<string, unknown>[]).map((t) => ({
        tableName: (t.tableName ?? t.table_name ?? '') as string,
        schemaName: (t.schemaName ?? t.schema_name ?? 'public') as string,
        columns: (t.columns ?? []) as DatabaseSchema['tables'][0]['columns'],
        constraints: (t.constraints ?? []) as DatabaseSchema['tables'][0]['constraints'],
        indexes: (t.indexes ?? []) as DatabaseSchema['tables'][0]['indexes'],
        rlsEnabled: (t.rlsEnabled ?? t.rls_enabled ?? false) as boolean,
        isAuthTable: isAuthTable((t.tableName ?? t.table_name ?? '') as string),
        estimatedRows: (t.estimatedRows ?? t.estimated_rows) as number | undefined,
      })),
      functions: [],
      policies: [],
      lastUpdated: new Date(),
    };

    this.cache.set(projectId, { schema, fetchedAt: Date.now() });
    return schema;
  }

  invalidate(projectId: string): void {
    this.cache.delete(projectId);
  }

  invalidateAll(): void {
    this.cache.clear();
  }
}
