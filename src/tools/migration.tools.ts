import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './index.js';
import { formatErrorResponse } from '../utils/errors.js';
import { brandEnv } from '../config.js';
import { requireProjectId } from '../utils/validators.js';
import { createMigrationRunner, MigrationError, type MigrationSqlClient } from '../migrations/index.js';

const DEFAULT_DIR = brandEnv('MIGRATIONS_DIR') ?? 'migrations';

/**
 * Adapt the MCP API client (which throws on failure and returns
 * `{ success, data, rows_affected, columns }`) to the engine's `{ data, error }`
 * SQL surface.
 */
function sqlClientFor(ctx: ToolContext, projectId: string): MigrationSqlClient {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      try {
        const result = (await ctx.apiClient.executeSql(projectId, sql, params)) as Record<string, unknown>;
        const raw = (result?.['data'] ?? result?.['rows'] ?? []) as unknown;
        const rows = Array.isArray(raw) ? (raw as T[]) : [];
        return { data: { rows }, error: null };
      } catch (e) {
        return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
      }
    },
  };
}

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

export function registerMigrationTools(server: McpServer, ctx: ToolContext): void {
  // ─── Run migrations ───
  server.registerTool('nestcore_run_migrations', {
    description:
      'Apply pending database migrations from the migrations directory, in order, each inside a transaction. ' +
      'Stops on the first failure and never re-runs completed migrations. Pass `migrationId` to run a single migration. ' +
      'Requires DDL privileges (service-role / admin).',
    inputSchema: {
      projectId: z.string().optional(),
      migrationId: z.string().optional().describe('Run only this migration (numeric prefix, e.g. "001").'),
      migrationsDir: z.string().optional().describe(`Directory of *.sql files. Default "${DEFAULT_DIR}".`),
    },
  }, async ({ projectId, migrationId, migrationsDir }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const runner = createMigrationRunner(sqlClientFor(ctx, id), migrationsDir ?? DEFAULT_DIR);

      const result = migrationId ? await runner.runOne(migrationId) : await runner.runAll();

      // Migrations ran DDL — drop the cached schema so later reads are fresh.
      ctx.schemaService.invalidate(id);

      return json({ success: true, ...result });
    } catch (error) {
      if (error instanceof MigrationError) {
        ctx.schemaService.invalidate(requireProjectId(projectId, ctx.session.getSession().currentProjectId));
        return json({ success: false, error: error.message, result: error.result ?? null });
      }
      return formatErrorResponse(error);
    }
  });

  // ─── List migrations ───
  server.registerTool('nestcore_list_migrations', {
    description:
      'List every migration file in the migrations directory with its applied/pending/failed status from the registry.',
    inputSchema: {
      projectId: z.string().optional(),
      migrationsDir: z.string().optional().describe(`Directory of *.sql files. Default "${DEFAULT_DIR}".`),
    },
  }, async ({ projectId, migrationsDir }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const runner = createMigrationRunner(sqlClientFor(ctx, id), migrationsDir ?? DEFAULT_DIR);
      const migrations = await runner.getStatus();
      return json({ count: migrations.length, migrations });
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Migration status (summary) ───
  server.registerTool('nestcore_migration_status', {
    description:
      'Summarise migration state: counts of applied / pending / failed migrations, any checksum mismatches, and the full per-migration list.',
    inputSchema: {
      projectId: z.string().optional(),
      migrationsDir: z.string().optional().describe(`Directory of *.sql files. Default "${DEFAULT_DIR}".`),
    },
  }, async ({ projectId, migrationsDir }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const runner = createMigrationRunner(sqlClientFor(ctx, id), migrationsDir ?? DEFAULT_DIR);
      const migrations = await runner.getStatus();

      const summary = {
        total: migrations.length,
        applied: migrations.filter((m) => m.applied).length,
        pending: migrations.filter((m) => m.status === 'pending').length,
        failed: migrations.filter((m) => m.status === 'failed').length,
        checksumMismatches: migrations.filter((m) => m.checksumMismatch).map((m) => m.name),
        upToDate: migrations.every((m) => m.applied),
      };
      return json({ summary, migrations });
    } catch (error) {
      return formatErrorResponse(error);
    }
  });
}
