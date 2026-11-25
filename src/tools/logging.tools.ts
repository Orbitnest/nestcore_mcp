import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './index.js';
import { formatErrorResponse } from '../utils/errors.js';
import { requireProjectId } from '../utils/validators.js';
import { untrustedResult } from '../utils/untrusted.js';

const LOG_SOURCE = 'project log entries (messages, SQL, request data written by apps and their end users)';

export function registerLoggingTools(server: McpServer, ctx: ToolContext): void {

  // ─── Query Logs ───
  server.registerTool('nestcore_query_logs', {
    description: 'Query project logs with filtering by type, level, time range, and text search. Use `has_more` in the response to page with offset.',
    inputSchema: {
      projectId: z.string().optional(),
      logType: z.enum(['all', 'database', 'auth', 'edge-functions']).optional(),
      level: z.enum(['info', 'warn', 'error']).optional(),
      startTime: z.string().max(40).optional().describe('ISO 8601 date or timestamp'),
      endTime: z.string().max(40).optional().describe('ISO 8601 date or timestamp'),
      search: z.string().max(500).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      offset: z.number().int().min(0).max(1_000_000).optional(),
    },
  }, async ({ projectId, logType, level, startTime, endTime, search, limit, offset }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);

      const filters = { level, startTime, endTime, search, limit, offset };
      let result;
      switch (logType) {
        case 'database':
          result = await ctx.apiClient.getDatabaseLogs(id, filters);
          break;
        case 'auth':
          result = await ctx.apiClient.getAuthLogs(id, filters);
          break;
        case 'edge-functions':
          result = await ctx.apiClient.getEdgeFunctionLogs(id, filters);
          break;
        default:
          result = await ctx.apiClient.getLogs(id, filters);
      }

      return untrustedResult(result, LOG_SOURCE);
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Get Slow Queries ───
  server.registerTool('nestcore_get_slow_queries', {
    description: 'Get slow database queries (queries taking >1000ms) for performance monitoring.',
    inputSchema: { projectId: z.string().optional(), limit: z.number().int().min(1).max(1000).optional() },
  }, async ({ projectId, limit }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getSlowQueryLogs(id, { limit });
      return untrustedResult(result, 'slow query log entries (SQL text and parameters from apps and their end users)');
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Export Logs ───
  server.registerTool('nestcore_export_logs', {
    description: 'Export project logs (newest first, up to 10,000 rows) as JSON or CSV text.',
    inputSchema: {
      projectId: z.string().optional(),
      format: z.enum(['json', 'csv']).optional(),
      level: z.enum(['info', 'warn', 'error']).optional(),
      search: z.string().max(500).optional(),
      startTime: z.string().max(40).optional().describe('ISO 8601 date or timestamp'),
      endTime: z.string().max(40).optional().describe('ISO 8601 date or timestamp'),
    },
  }, async ({ projectId, format, level, search, startTime, endTime }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const { body, truncated } = await ctx.apiClient.exportLogs(id, { format, level, search, startTime, endTime });
      const note = truncated ? '\n\n[Export truncated at 10,000 rows — narrow the time range.]' : '';
      return untrustedResult(body, LOG_SOURCE, { raw: true, suffix: note });
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Get Log Stats ───
  server.registerTool('nestcore_get_log_stats', {
    description: 'Get log statistics and aggregations for a project.',
    inputSchema: { projectId: z.string().optional() },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getLogStats(id);
      return untrustedResult(result, 'log statistics (may include log messages written by apps and their end users)');
    } catch (error) {
      return formatErrorResponse(error);
    }
  });
}
