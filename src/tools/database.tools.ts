import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './index.js';
import { formatErrorResponse } from '../utils/errors.js';
import { requireProjectId } from '../utils/validators.js';
import { validateSql } from '../safety/sql.guard.js';
import { guardTableOperation, guardBulkOperation } from '../safety/operation.guard.js';

export function registerDatabaseTools(server: McpServer, ctx: ToolContext): void {

  // ─── Get Schema ───
  server.registerTool('orbitnest_get_schema', {
    description: 'Fetch the database schema for a project: tables, columns (type, nullability, default, key constraint) and whether RLS is enabled. Results are cached for 5 minutes.',
    inputSchema: { projectId: z.string().optional(), forceRefresh: z.boolean().optional() },
  }, async ({ projectId, forceRefresh }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const schema = await ctx.schemaService.getSchema(id, forceRefresh ?? false);
      ctx.session.setSchemaSnapshot(schema);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          tables: schema.tables.map(t => ({
            name: t.tableName,
            schema: t.schemaName,
            columns: t.columns,
            rlsEnabled: t.rlsEnabled,
            isAuthTable: t.isAuthTable,
          })),
          lastUpdated: schema.lastUpdated,
        }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Execute SQL ───
  server.registerTool('orbitnest_execute_sql', {
    description: 'Execute a raw SQL query against the project database. Safety guards validate queries to prevent SQL injection, auth table modifications, and unconfirmed destructive operations.',
    inputSchema: {
      projectId: z.string().optional(),
      sql: z.string().min(1),
      confirmDestructive: z.boolean().optional(),
    },
  }, async ({ projectId, sql, confirmDestructive }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const session = ctx.session.getSession();

      const analysis = validateSql(sql, {
        confirmDestructive,
        blockAuthMutations: ctx.config.blockAuthTableMutations,
        enableSqlGuard: session.safetyEnabled,
      });

      const result = await ctx.apiClient.executeSql(id, sql);

      // Invalidate schema cache if DDL operation
      if (analysis.operations.some(op => ['CREATE', 'ALTER', 'DROP'].includes(op))) {
        ctx.schemaService.invalidate(id);
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Create Table ───
  server.registerTool('orbitnest_create_table', {
    description: 'Create a new database table from a structured definition. Generates and executes the CREATE TABLE SQL statement.',
    inputSchema: {
      projectId: z.string().optional(),
      tableName: z.string().min(1),
      columns: z.array(z.object({
        name: z.string(),
        type: z.string(),
        nullable: z.boolean().optional(),
        primaryKey: z.boolean().optional(),
        unique: z.boolean().optional(),
        default: z.string().optional(),
        references: z.object({ table: z.string(), column: z.string() }).optional(),
      })),
      enableRLS: z.boolean().optional(),
    },
  }, async ({ projectId, tableName, columns, enableRLS }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);

      // Generate CREATE TABLE SQL
      const colDefs = columns.map(col => {
        let def = `"${col.name}" ${col.type}`;
        if (col.primaryKey) def += ' PRIMARY KEY';
        if (col.unique) def += ' UNIQUE';
        if (col.nullable === false) def += ' NOT NULL';
        if (col.default) def += ` DEFAULT ${col.default}`;
        if (col.references) def += ` REFERENCES "${col.references.table}"("${col.references.column}")`;
        return def;
      });

      let sql = `CREATE TABLE "${tableName}" (\n  ${colDefs.join(',\n  ')}\n)`;
      if (enableRLS) {
        sql += `;\nALTER TABLE "${tableName}" ENABLE ROW LEVEL SECURITY`;
      }

      const result = await ctx.apiClient.executeSql(id, sql);
      ctx.schemaService.invalidate(id);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          message: `Table "${tableName}" created`,
          sql,
          data: result,
        }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Get Table Data ───
  server.registerTool('orbitnest_get_table_data', {
    description: 'Retrieve rows from a table with ordering and pagination (max 100 rows per call; offset should be a multiple of limit).',
    inputSchema: {
      projectId: z.string().optional(),
      tableName: z.string(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
      orderBy: z.string().optional(),
    },
  }, async ({ projectId, tableName, limit, offset, orderBy }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getTableData(id, tableName, { limit, offset, orderBy });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Insert Row ───
  server.registerTool('orbitnest_insert_row', {
    description: 'Insert a new row into a database table.',
    inputSchema: {
      projectId: z.string().optional(),
      tableName: z.string(),
      data: z.record(z.unknown()),
    },
  }, async ({ projectId, tableName, data }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      guardTableOperation(tableName, 'INSERT');
      const result = await ctx.apiClient.insertRow(id, tableName, data);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Update Row ───
  server.registerTool('orbitnest_update_row', {
    description: 'Update an existing row in a table by its ID.',
    inputSchema: {
      projectId: z.string().optional(),
      tableName: z.string(),
      rowId: z.string(),
      data: z.record(z.unknown()),
    },
  }, async ({ projectId, tableName, rowId, data }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      guardTableOperation(tableName, 'UPDATE');
      const result = await ctx.apiClient.updateRow(id, tableName, rowId, data);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Delete Row ───
  server.registerTool('orbitnest_delete_row', {
    description: 'Delete a single row from a table by its ID. Requires confirmation.',
    inputSchema: {
      projectId: z.string().optional(),
      tableName: z.string(),
      rowId: z.string(),
      confirmDeletion: z.boolean(),
    },
  }, async ({ projectId, tableName, rowId, confirmDeletion }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      guardTableOperation(tableName, 'DELETE');
      if (!confirmDeletion) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Row deletion requires confirmDeletion=true.',
          }, null, 2) }],
        };
      }
      const result = await ctx.apiClient.deleteRow(id, tableName, rowId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: result }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Bulk Insert ───
  server.registerTool('orbitnest_bulk_insert', {
    description: 'Insert multiple rows into a table in a single transaction.',
    inputSchema: {
      projectId: z.string().optional(),
      tableName: z.string(),
      rows: z.array(z.record(z.unknown())),
    },
  }, async ({ projectId, tableName, rows }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      guardTableOperation(tableName, 'INSERT');
      const result = await ctx.apiClient.bulkInsert(id, tableName, rows);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Bulk Update ───
  // Each update is { where, data } — the API matches rows by `where` and
  // applies `data`. (A flat array of rows can't express which rows to update.)
  server.registerTool('orbitnest_bulk_update', {
    description: 'Update multiple rows in a table. Each update is { where, data }: rows matching `where` get `data` applied.',
    inputSchema: {
      projectId: z.string().optional(),
      tableName: z.string(),
      updates: z.array(z.object({
        where: z.record(z.unknown()),
        data: z.record(z.unknown()),
      })),
    },
  }, async ({ projectId, tableName, updates }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      guardTableOperation(tableName, 'UPDATE');
      const result = await ctx.apiClient.bulkUpdate(id, tableName, updates);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Bulk Delete ───
  // Deletes by `conditions` (each is a column=value match, ANDed). For a simple
  // id list, pass conditions like [{ id: "..." }, { id: "..." }].
  server.registerTool('orbitnest_bulk_delete', {
    description: 'Delete multiple rows from a table by match conditions. Each condition is a column=value object (e.g. { id: "..." }). Requires confirmation for large operations.',
    inputSchema: {
      projectId: z.string().optional(),
      tableName: z.string(),
      conditions: z.array(z.record(z.unknown())),
      confirmDeletion: z.boolean(),
    },
  }, async ({ projectId, tableName, conditions, confirmDeletion }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      guardTableOperation(tableName, 'DELETE');
      if (!confirmDeletion) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Bulk deletion requires confirmDeletion=true.',
          }, null, 2) }],
        };
      }
      guardBulkOperation(conditions.length, 1000, confirmDeletion);
      const result = await ctx.apiClient.bulkDelete(id, tableName, conditions);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: result }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });
}
