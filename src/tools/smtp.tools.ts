import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './index.js';
import { formatErrorResponse } from '../utils/errors.js';
import { requireProjectId } from '../utils/validators.js';

export function registerSmtpTools(server: McpServer, ctx: ToolContext): void {

  // ─── Get SMTP Settings ───
  server.registerTool('nestcore_get_smtp_settings', {
    description: 'Get the SMTP email configuration for a project.',
    inputSchema: { projectId: z.string().optional() },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getSmtpSettings(id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Update SMTP Settings ───
  server.registerTool('nestcore_update_smtp_settings', {
    description: 'Update the SMTP email configuration for a project.',
    inputSchema: {
      projectId: z.string().optional(),
      host: z.string(),
      port: z.number(),
      username: z.string(),
      password: z.string(),
      fromEmail: z.string().email(),
      fromName: z.string().optional(),
      secure: z.boolean().optional(),
    },
  }, async ({ projectId, host, port, username, password, fromEmail, fromName, secure }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.updateSmtpSettings(id, {
        host, port, username, password, fromEmail, fromName, secure,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: result }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });
}
