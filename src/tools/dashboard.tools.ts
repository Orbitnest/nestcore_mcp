import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './index.js';
import { formatErrorResponse } from '../utils/errors.js';

export function registerDashboardTools(server: McpServer, ctx: ToolContext): void {

  // ─── Get Dashboard Stats ───
  server.registerTool('nestcore_get_dashboard_stats', {
    description: 'Get overall dashboard statistics including total projects, users, functions, and storage usage.',
    inputSchema: {},
  }, async () => {
    try {
      await ctx.session.ensureAuthenticated();
      const result = await ctx.apiClient.getDashboardStats();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Get Activity ───
  server.registerTool('nestcore_get_activity', {
    description: 'Get recent activity log from the dashboard.',
    inputSchema: {},
  }, async () => {
    try {
      await ctx.session.ensureAuthenticated();
      const result = await ctx.apiClient.getDashboardActivity();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });
}
