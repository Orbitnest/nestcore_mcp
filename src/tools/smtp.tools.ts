import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './index.js';
import { formatErrorResponse } from '../utils/errors.js';
import { requireProjectId } from '../utils/validators.js';
import { redactSecrets } from '../utils/redact.js';

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
        content: [{ type: 'text' as const, text: JSON.stringify(redactSecrets(result), null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Update SMTP Settings ───
  server.registerTool('nestcore_update_smtp_settings', {
    description: 'Update the SMTP email configuration for a project. The password is stored encrypted and never returned.',
    inputSchema: {
      projectId: z.string().optional(),
      host: z.string().min(1).max(255),
      port: z.number().int().min(1).max(65535),
      username: z.string().max(320),
      password: z.string().max(1024),
      fromEmail: z.string().email().max(320),
      fromName: z.string().max(100).optional(),
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
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: redactSecrets(result) }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });
}
