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
  server.registerTool('nestcore_get_connection_string', {
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

  // ─── End-user auth security ───
  server.registerTool('nestcore_get_auth_security', {
    description: "A project's end-user auth limits in force: code length, code expiry, wrong codes allowed, codes per email per hour, and password lockout (attempts, minutes).",
    inputSchema: { projectId: z.string().optional() },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      return json(await ctx.apiClient.getAuthSecurity(pid(projectId)));
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  server.registerTool('nestcore_set_auth_security', {
    description: 'Change end-user auth limits (only the given ones). Applies to every app signing in to the project within 30 seconds. Needs the workspace admin role.',
    inputSchema: {
      projectId: z.string().optional(),
      codeLength: z.number().int().min(6).max(8).optional().describe('Digits in emailed codes'),
      codeExpiryMinutes: z.number().int().min(1).max(60).optional(),
      maxWrongCodes: z.number().int().min(1).max(10).optional().describe('Wrong codes before the codes are invalidated for 15 minutes'),
      codesPerHour: z.number().int().min(1).max(100).optional().describe('Codes per email per hour, all flows together'),
      lockoutAttempts: z.number().int().min(1).max(50).optional().describe('Wrong passwords before the email is locked'),
      lockoutMinutes: z.number().int().min(1).max(1440).optional(),
    },
  }, async ({ projectId, codeLength, codeExpiryMinutes, maxWrongCodes, codesPerHour, lockoutAttempts, lockoutMinutes }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const patch: Record<string, Record<string, number>> = {};
      const put = (group: string, key: string, v?: number) => { if (v !== undefined) (patch[group] ??= {})[key] = v; };
      put('otp_config', 'code_length', codeLength);
      put('otp_config', 'expiry_minutes', codeExpiryMinutes);
      put('otp_config', 'max_attempts', maxWrongCodes);
      put('rate_limiting', 'otp_requests_per_hour', codesPerHour);
      put('lockout_policy', 'max_failed_attempts', lockoutAttempts);
      put('lockout_policy', 'lockout_duration_minutes', lockoutMinutes);
      if (!Object.keys(patch).length) return json({ error: 'Pass at least one setting to change.' });
      return json(await ctx.apiClient.setAuthSecurity(pid(projectId), patch));
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── AI gateway ───
  server.registerTool('nestcore_get_ai_settings', {
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

  server.registerTool('nestcore_ai_usage', {
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

  // ─── AI data: memory, collections, traces, automatic embeddings ───
  server.registerTool('nestcore_ai_overview', {
    description:
      "Counts of a project's AI data: memories, memory subjects, collections, documents, threads, messages, traces in the last 24 hours " +
      'and embedded columns. enabled=false (all zeros) means the project has not used an AI feature yet.',
    inputSchema: { projectId: z.string().optional() },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      return json(await ctx.apiClient.getAiOverview(pid(projectId)));
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  server.registerTool('nestcore_list_collections', {
    description: 'Vector collections of a project: name, embedding model, chunk size/overlap, whether users may add their own documents, and document counts (total and still processing).',
    inputSchema: { projectId: z.string().optional() },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      return json(await ctx.apiClient.listAiCollections(pid(projectId)));
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  server.registerTool('nestcore_memory_subjects', {
    description: 'Subjects that have AI memories in a project (e.g. "user:<id>", "agent:support"), with memory counts and last update, newest first (up to 100).',
    inputSchema: {
      projectId: z.string().optional(),
      type: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).optional().describe('Only this subject type, e.g. "user" or "agent"'),
    },
  }, async ({ projectId, type }) => {
    try {
      await ctx.session.ensureAuthenticated();
      return json(await ctx.apiClient.listMemorySubjects(pid(projectId), type));
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  server.registerTool('nestcore_list_embeddings', {
    description:
      'Automatically embedded columns of a project with progress: source columns, model, rows, embedded (with the current model), ' +
      'pending and failed queue entries, and the last error.',
    inputSchema: { projectId: z.string().optional() },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      return json(await ctx.apiClient.listEmbeddings(pid(projectId)));
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  server.registerTool('nestcore_ai_traces', {
    description:
      'Recent AI calls of a project, newest first: kind (chat/embed), caller, model, tokens in/out, cost, latency, status and error. ' +
      'Prompts and replies are never stored (only a hash). Kept 1/7/30 days on Free/Starter/Pro.',
    inputSchema: {
      projectId: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional().describe('Default 50'),
      offset: z.number().int().min(0).optional(),
      status: z.enum(['ok', 'error']).optional(),
    },
  }, async ({ projectId, limit, offset, status }) => {
    try {
      await ctx.session.ensureAuthenticated();
      return json(await ctx.apiClient.getAiTraces(pid(projectId), { limit: limit ?? 50, offset, status }));
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  server.registerTool('nestcore_enable_embeddings', {
    description:
      'Embed a table automatically: adds a vector(768) column (default "<first source>_embedding") plus <target>_embed_model and ' +
      '<target>_embed_hash, a trigger that queues changed rows, and an HNSW index, then backfills existing rows in the background ' +
      "with the project's own AI provider key (counts against the monthly embedding allowance). The table needs a primary key; " +
      'ai_* and auth_* tables are refused. Apps then query it with semantic(). Needs the workspace admin role. Requires confirmEnable=true.',
    inputSchema: {
      projectId: z.string().optional(),
      table: z.string().max(63),
      sourceColumns: z.array(z.string().max(63)).min(1).max(10).describe('Text columns joined (in order) into the embedded text'),
      targetColumn: z.string().max(50).optional().describe('Vector column name; defaults to <first source>_embedding'),
      model: z.string().max(200).optional().describe("Embedding model; defaults to the provider's default embedding model"),
      confirmEnable: z.boolean(),
    },
  }, async ({ projectId, table, sourceColumns, targetColumn, model, confirmEnable }) => {
    try {
      await ctx.session.ensureAuthenticated();
      if (!confirmEnable) {
        return json({
          success: false,
          error: 'Enabling embeddings changes the table (new columns, trigger, index) and spends embedding tokens on every row. Set confirmEnable=true to proceed.',
        });
      }
      return json(await ctx.apiClient.enableEmbeddings(pid(projectId), { table, sourceColumns, targetColumn, model }));
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Webhooks ───
  server.registerTool('nestcore_list_webhooks', {
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

  server.registerTool('nestcore_create_webhook', {
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

  server.registerTool('nestcore_delete_webhook', {
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

  server.registerTool('nestcore_test_webhook', {
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
  server.registerTool('nestcore_get_sms_config', {
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

  server.registerTool('nestcore_set_sms_config', {
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

  server.registerTool('nestcore_test_sms', {
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
  server.registerTool('nestcore_enable_extension', {
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
