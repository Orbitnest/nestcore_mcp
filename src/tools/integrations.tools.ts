import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './index.js';
import { formatErrorResponse } from '../utils/errors.js';
import { requireProjectId } from '../utils/validators.js';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });

// Extensions an agent may enable on demand (avoids arbitrary CREATE EXTENSION).
const ALLOWED_EXTENSIONS = new Set(['vector', 'pg_trgm', 'citext', 'unaccent', 'uuid-ossp']);

export function registerIntegrationTools(server: McpServer, ctx: ToolContext): void {
  const pid = (projectId?: string) => requireProjectId(projectId, ctx.session.getSession().currentProjectId);

  // ─── Direct connection string ───
  server.registerTool('orbitnest_get_connection_string', {
    description: 'Get the direct Postgres connection string for a project (only when the deployment has direct connections enabled).',
    inputSchema: { projectId: z.string().optional() },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      return json(await ctx.apiClient.getConnectionString(pid(projectId)));
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── AI gateway ───
  server.registerTool('orbitnest_get_ai_settings', {
    description: 'AI gateway settings of a project: saved provider keys (masked, last 4 characters), default models and monthly spend caps.',
    inputSchema: { projectId: z.string().optional() },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      return json(await ctx.apiClient.getAiSettings(pid(projectId)));
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  server.registerTool('orbitnest_ai_usage', {
    description: "AI gateway usage of a project with its own keys: calls, errors, tokens and cost for the last N days, per day, per model and top end users.",
    inputSchema: { projectId: z.string().optional(), days: z.number().int().min(1).max(365).optional() },
  }, async ({ projectId, days }) => {
    try {
      await ctx.session.ensureAuthenticated();
      return json(await ctx.apiClient.getAiUsage(pid(projectId), days ?? 30));
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Webhooks ───
  server.registerTool('orbitnest_list_webhooks', {
    description: 'List the database webhooks configured for a project.',
    inputSchema: { projectId: z.string().optional() },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      return json(await ctx.apiClient.listWebhooks(pid(projectId)));
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  server.registerTool('orbitnest_create_webhook', {
    description: 'Create a database webhook (signed HTTP POST on row INSERT/UPDATE/DELETE). Returns the signing secret once.',
    inputSchema: {
      projectId: z.string().optional(),
      name: z.string(),
      url: z.string().url(),
      events: z.array(z.enum(['INSERT', 'UPDATE', 'DELETE'])).optional(),
      table_name: z.string().optional(),
    },
  }, async ({ projectId, name, url, events, table_name }) => {
    try {
      await ctx.session.ensureAuthenticated();
      return json(await ctx.apiClient.createWebhook(pid(projectId), { name, url, events, table_name }));
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  server.registerTool('orbitnest_delete_webhook', {
    description: 'Delete a database webhook by id.',
    inputSchema: { projectId: z.string().optional(), webhookId: z.string() },
  }, async ({ projectId, webhookId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      return json(await ctx.apiClient.deleteWebhook(pid(projectId), webhookId));
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  server.registerTool('orbitnest_test_webhook', {
    description: 'Send a sample ping event to a webhook to verify the endpoint.',
    inputSchema: { projectId: z.string().optional(), webhookId: z.string() },
  }, async ({ projectId, webhookId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      return json(await ctx.apiClient.testWebhook(pid(projectId), webhookId));
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── SMS / Twilio config ───
  server.registerTool('orbitnest_get_sms_config', {
    description: "Get a project's SMS (Twilio) configuration. The auth token is never returned.",
    inputSchema: { projectId: z.string().optional() },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      return json(await ctx.apiClient.getSmsConfig(pid(projectId)));
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  server.registerTool('orbitnest_set_sms_config', {
    description: "Create or update a project's Twilio SMS settings (auth token stored encrypted).",
    inputSchema: {
      projectId: z.string().optional(),
      account_sid: z.string().optional(),
      auth_token: z.string().optional(),
      from_number: z.string().optional(),
      is_enabled: z.boolean().optional(),
    },
  }, async ({ projectId, account_sid, auth_token, from_number, is_enabled }) => {
    try {
      await ctx.session.ensureAuthenticated();
      return json(await ctx.apiClient.updateSmsConfig(pid(projectId), { account_sid, auth_token, from_number, is_enabled }));
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  server.registerTool('orbitnest_test_sms', {
    description: 'Send a test SMS to verify the Twilio configuration.',
    inputSchema: { projectId: z.string().optional(), to: z.string() },
  }, async ({ projectId, to }) => {
    try {
      await ctx.session.ensureAuthenticated();
      return json(await ctx.apiClient.testSms(pid(projectId), to));
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Enable a Postgres extension (e.g. pgvector) ───
  server.registerTool('orbitnest_enable_extension', {
    description: 'Enable a Postgres extension on a project (e.g. "vector" for pgvector semantic search). Allowed: vector, pg_trgm, citext, unaccent, uuid-ossp.',
    inputSchema: { projectId: z.string().optional(), name: z.string() },
  }, async ({ projectId, name }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const ext = name.trim().toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        throw new Error(`Extension "${name}" is not allowed. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`);
      }
      const result = await ctx.apiClient.executeSql(pid(projectId), `CREATE EXTENSION IF NOT EXISTS "${ext}"`);
      return json({ success: true, extension: ext, result });
    } catch (error) {
      return formatErrorResponse(error);
    }
  });
}
