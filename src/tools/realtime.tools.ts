import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './index.js';
import { formatErrorResponse } from '../utils/errors.js';
import { requireProjectId } from '../utils/validators.js';

export function registerRealtimeTools(server: McpServer, ctx: ToolContext): void {

  // ─── List realtime tables ───
  server.registerTool('nestcore_list_realtime_tables', {
    description:
      'List all database tables that have realtime (change streaming) enabled for a project. ' +
      'Returns the schema, table name, column allowlist, and when realtime was enabled.',
    inputSchema: {
      projectId: z.string().optional(),
    },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.listRealtimeTables(id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Enable realtime on a table ───
  server.registerTool('nestcore_enable_realtime', {
    description:
      'Enable realtime change streaming on a table. Installs a trigger that emits INSERT, ' +
      'UPDATE, and DELETE events over the realtime WebSocket. Cannot be enabled on auth_* ' +
      'or _realtime_* tables. Pass `columns` to restrict which columns appear in the payload.',
    inputSchema: {
      projectId: z.string().optional(),
      table: z.string().min(1).max(63).describe('Table name (without schema prefix)'),
      schema: z.string().min(1).max(63).optional().describe("Postgres schema (default 'public')"),
      columns: z.array(z.string().min(1).max(63)).max(200).optional().describe('Allowlist of columns to include; empty = all'),
    },
  }, async ({ projectId, table, schema, columns }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.enableRealtimeTable(id, { table, schema, columns });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: result }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Disable realtime on a table ───
  server.registerTool('nestcore_disable_realtime', {
    description:
      'Disable realtime change streaming on a table. Drops the trigger and removes the ' +
      'subscription record. Existing subscribers will stop receiving events for this table.',
    inputSchema: {
      projectId: z.string().optional(),
      schema: z.string().min(1).max(63).describe("Postgres schema (e.g. 'public')"),
      table: z.string().min(1).max(63).describe('Table name'),
    },
  }, async ({ projectId, schema, table }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      await ctx.apiClient.disableRealtimeTable(id, schema, table);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, schema, table }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Broadcast a message ───
  server.registerTool('nestcore_broadcast', {
    description:
      'Fan out a broadcast message to every subscriber on the given channel. Broadcast ' +
      "channels don't require a database trigger. The `broadcast:` prefix is added " +
      'automatically if missing. `payload` can be any JSON value.',
    inputSchema: {
      projectId: z.string().optional(),
      channel: z.string().min(1).max(200).describe("Channel name (e.g. 'notifications' or 'broadcast:notifications')"),
      event: z.string().min(1).max(200).describe("Event name (e.g. 'new-alert')"),
      payload: z.unknown()
        .refine((v) => { try { return JSON.stringify(v ?? null).length <= 65_536; } catch { return false; } }, 'payload must be JSON of at most 64 KB')
        .describe('JSON payload to send to subscribers (at most 64 KB)'),
    },
  }, async ({ projectId, channel, event, payload }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.broadcastRealtime(id, { channel, event, payload });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: result }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });
}
