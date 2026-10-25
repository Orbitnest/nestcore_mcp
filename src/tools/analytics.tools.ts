import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './index.js';
import { formatErrorResponse } from '../utils/errors.js';
import { requireProjectId } from '../utils/validators.js';

export function registerAnalyticsTools(server: McpServer, ctx: ToolContext): void {

  // ─── Overview ───
  server.registerTool('nestcore_get_analytics_overview', {
    description: 'Get high-level analytics metrics for a project including events, sessions, DAU, and crashes.',
    inputSchema: {
      projectId: z.string().optional(),
      from: z.string().optional().describe('Start date (ISO 8601)'),
      to: z.string().optional().describe('End date (ISO 8601)'),
      granularity: z.enum(['hour', 'day', 'week', 'month']).optional(),
      platform: z.string().optional().describe('Filter by platform (e.g. ios, android, web)'),
      appVersion: z.string().optional().describe('Filter by app version'),
    },
  }, async ({ projectId, from, to, granularity, platform, appVersion }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getAnalyticsOverview(id, {
        from, to, granularity, platform, app_version: appVersion,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Event Timeseries ───
  server.registerTool('nestcore_get_analytics_events', {
    description: 'Get event counts as a timeseries for a project.',
    inputSchema: {
      projectId: z.string().optional(),
      from: z.string().optional().describe('Start date (ISO 8601)'),
      to: z.string().optional().describe('End date (ISO 8601)'),
      granularity: z.enum(['hour', 'day', 'week', 'month']).optional(),
      platform: z.string().optional(),
      appVersion: z.string().optional(),
    },
  }, async ({ projectId, from, to, granularity, platform, appVersion }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getAnalyticsEventTimeseries(id, {
        from, to, granularity, platform, app_version: appVersion,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Top Events ───
  server.registerTool('nestcore_get_top_analytics_events', {
    description: 'Get the top events by occurrence count for a project.',
    inputSchema: {
      projectId: z.string().optional(),
      from: z.string().optional().describe('Start date (ISO 8601)'),
      to: z.string().optional().describe('End date (ISO 8601)'),
      limit: z.number().optional().describe('Maximum number of events to return'),
    },
  }, async ({ projectId, from, to, limit }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getTopAnalyticsEvents(id, { from, to, limit });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Top Screens ───
  server.registerTool('nestcore_get_top_analytics_screens', {
    description: 'Get the top screens or pages by view count for a project.',
    inputSchema: {
      projectId: z.string().optional(),
      from: z.string().optional().describe('Start date (ISO 8601)'),
      to: z.string().optional().describe('End date (ISO 8601)'),
      limit: z.number().optional().describe('Maximum number of screens to return'),
    },
  }, async ({ projectId, from, to, limit }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getTopAnalyticsScreens(id, { from, to, limit });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Retention ───
  server.registerTool('nestcore_get_analytics_retention', {
    description: 'Get day-N rolling retention data for a project.',
    inputSchema: {
      projectId: z.string().optional(),
      from: z.string().optional().describe('Start date (ISO 8601)'),
      to: z.string().optional().describe('End date (ISO 8601)'),
      granularity: z.enum(['hour', 'day', 'week', 'month']).optional(),
    },
  }, async ({ projectId, from, to, granularity }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getAnalyticsRetention(id, { from, to, granularity });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Funnel ───
  server.registerTool('nestcore_get_analytics_funnel', {
    description: 'Run a funnel analysis across a sequence of event names for a project.',
    inputSchema: {
      projectId: z.string().optional(),
      steps: z.array(z.string()).min(2).describe('Ordered list of event names that form the funnel'),
      from: z.string().optional().describe('Start date (ISO 8601)'),
      to: z.string().optional().describe('End date (ISO 8601)'),
    },
  }, async ({ projectId, steps, from, to }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getAnalyticsFunnel(id, { steps, from, to });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Performance ───
  server.registerTool('nestcore_get_analytics_performance', {
    description: 'Get performance metric percentiles (e.g. load time, response time) for a project.',
    inputSchema: {
      projectId: z.string().optional(),
      from: z.string().optional().describe('Start date (ISO 8601)'),
      to: z.string().optional().describe('End date (ISO 8601)'),
      granularity: z.enum(['hour', 'day', 'week', 'month']).optional(),
      platform: z.string().optional(),
      appVersion: z.string().optional(),
    },
  }, async ({ projectId, from, to, granularity, platform, appVersion }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getAnalyticsPerformance(id, {
        from, to, granularity, platform, app_version: appVersion,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Crashes ───
  server.registerTool('nestcore_get_analytics_crashes', {
    description: 'Get crash groups and crash rate data for a project.',
    inputSchema: {
      projectId: z.string().optional(),
      from: z.string().optional().describe('Start date (ISO 8601)'),
      to: z.string().optional().describe('End date (ISO 8601)'),
      granularity: z.enum(['hour', 'day', 'week', 'month']).optional(),
      platform: z.string().optional(),
      appVersion: z.string().optional(),
    },
  }, async ({ projectId, from, to, granularity, platform, appVersion }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getAnalyticsCrashes(id, {
        from, to, granularity, platform, app_version: appVersion,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Create Token ───
  server.registerTool('nestcore_create_analytics_token', {
    description: 'Create an analytics ingestion token for a project.',
    inputSchema: {
      projectId: z.string().optional(),
      name: z.string().optional().describe('Human-readable label for the token'),
    },
  }, async ({ projectId, name }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.createAnalyticsToken(id, { name });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── List Tokens ───
  server.registerTool('nestcore_list_analytics_tokens', {
    description: 'List all analytics ingestion tokens for a project.',
    inputSchema: {
      projectId: z.string().optional(),
    },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.listAnalyticsTokens(id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Revoke Token ───
  server.registerTool('nestcore_revoke_analytics_token', {
    description: 'Revoke (delete) an analytics ingestion token. Requires confirmation.',
    inputSchema: {
      projectId: z.string().optional(),
      tokenId: z.string().describe('ID of the token to revoke'),
      confirmRevocation: z.boolean().describe('Must be true to proceed with revocation'),
    },
  }, async ({ projectId, tokenId, confirmRevocation }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      if (!confirmRevocation) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Token revocation requires confirmRevocation=true.',
          }, null, 2) }],
        };
      }
      const result = await ctx.apiClient.revokeAnalyticsToken(id, tokenId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: result }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });
}
