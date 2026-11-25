import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './index.js';
import { formatErrorResponse } from '../utils/errors.js';
import { requireProjectId } from '../utils/validators.js';
import { untrustedResult } from '../utils/untrusted.js';

const CHANGES_SOURCE = 'recorded schema changes (SQL statements written by workspace members, the CLI or AI agents)';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });

type Branch = { id: string; branch: 'production' | 'development'; slug: string; provisioning_status: string; pending_changes: number };
type BranchList = { enabled: boolean; production_id: string; branches: Branch[] };

/**
 * Project branches. Every App project has Production (the live project, its
 * existing id) and Development (its own project id, URL, keys and database:
 * Production's schema and config, none of its data). Work on Development by
 * making its id the active project; promote reviewed changes to Production.
 */
export function registerBranchTools(server: McpServer, ctx: ToolContext): void {
  const projectOf = (projectId?: string) => requireProjectId(projectId, ctx.session.getSession().currentProjectId);

  server.registerTool('nestcore_list_branches', {
    description:
      "A project's branches: Production (the live app) and Development (safe copy: same schema and config, its own data, users, URL and keys). " +
      'Returns each branch id, slug, setup status, database/file size and the number of schema changes waiting to be promoted. ' +
      'To work on Development, call nestcore_set_active_project with the development branch id: every other tool then targets it. ' +
      'Prefer Development for schema experiments; never test destructive SQL on Production.',
    inputSchema: { projectId: z.string().optional().describe('Project or branch id (default: active project)') },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      return json(await ctx.apiClient.branches<BranchList>('GET', projectOf(projectId)));
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  server.registerTool('nestcore_create_branch', {
    description:
      'Create the Development branch of a project if it has none (idempotent). Copies schema and config from Production (tables, RLS, functions, ' +
      'buckets, auth settings, env vars with their values); never copies rows, end users or files. Jobs and webhooks start disabled. Takes a few seconds.',
    inputSchema: { projectId: z.string().optional() },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      return json(await ctx.apiClient.branches('POST', projectOf(projectId), '/development'));
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  server.registerTool('nestcore_reset_branch', {
    description:
      "Rebuild Development from Production: drops Development's database and re-clones Production's schema; ALL Development rows, end users and files " +
      'are deleted and unpromoted changes discarded. URL, keys, env vars and functions are kept. Production is not touched. ' +
      'Destructive for Development: only with the user\'s explicit request. Pass confirm: true.',
    inputSchema: {
      projectId: z.string().optional(),
      confirm: z.literal(true).describe('Must be true: reset deletes all Development data'),
    },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const res = await ctx.apiClient.branches<Branch>('POST', projectOf(projectId), '/development/reset', { confirm: true });
      ctx.schemaService.invalidate(res.id);
      return json(res);
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  server.registerTool('nestcore_branch_changes', {
    description:
      'Schema changes recorded on Development and not yet promoted (DDL from the SQL editor, table editor, RLS, realtime, CLI or MCP), in order. ' +
      '`destructive: true` marks DROP / RENAME / type changes / RLS off. Data changes (INSERT/UPDATE/DELETE) are never recorded or promoted.',
    inputSchema: { projectId: z.string().optional() },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      return untrustedResult(await ctx.apiClient.branches('GET', projectOf(projectId), '/development/changes'), CHANGES_SOURCE);
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  server.registerTool('nestcore_promote_branch', {
    description:
      'Promote Development to Production. Without apply: true it only PREVIEWS (pending schema changes, functions, buckets, jobs, env vars missing on ' +
      'Production, auth-setting differences, and whether Production drifted). With apply: true (workspace admins) the schema changes run on Production in ONE ' +
      'transaction (any failure rolls all back), then functions, new buckets and new jobs (created disabled) are copied. Env vars and auth settings are only ' +
      'copied when asked. Production data is never touched. ALWAYS show the preview to the user and get their explicit go-ahead before apply: true; ' +
      'destructive changes also need confirmDestructive and drift needs acknowledgeDrift, both only with the user\'s say-so. ' +
      'Clients that support it ask the user before apply: true runs.',
    inputSchema: {
      projectId: z.string().optional(),
      apply: z.boolean().optional().describe('false/omitted = preview only'),
      changeIds: z.array(z.string().min(1).max(128)).max(1000).optional().describe('Subset of pending change ids (default: all)'),
      includeEnvVars: z.boolean().optional().describe('Also add env vars missing on Production (Development values)'),
      includeAuthSettings: z.boolean().optional().describe("Replace Production's auth settings with Development's"),
      confirmDestructive: z.boolean().optional(),
      acknowledgeDrift: z.boolean().optional(),
    },
  }, async ({ projectId, apply, changeIds, includeEnvVars, includeAuthSettings, confirmDestructive, acknowledgeDrift }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = projectOf(projectId);
      const preview = await ctx.apiClient.branches<any>('GET', id, '/development/promote');
      if (!apply) return untrustedResult({ preview: true, ...preview }, CHANGES_SOURCE);
      const cfg = preview.config ?? {};
      const result = await ctx.apiClient.branches<any>('POST', id, '/development/promote', {
        change_ids: changeIds ?? (preview.changes ?? []).map((c: { id: string }) => c.id),
        functions: (cfg.functions ?? []).map((f: { name: string }) => f.name),
        buckets: (cfg.buckets ?? []).map((b: { name: string }) => b.name),
        jobs: (cfg.jobs ?? []).filter((j: { status: string }) => j.status === 'new').map((j: { name: string }) => j.name),
        env_vars: includeEnvVars ? (cfg.env_vars ?? []).map((e: { name: string }) => e.name) : [],
        auth_settings: !!includeAuthSettings,
        confirm_destructive: !!confirmDestructive,
        acknowledge_drift: !!acknowledgeDrift,
      });
      ctx.schemaService.invalidate(preview.production_id);
      return json(result);
    } catch (error) {
      return formatErrorResponse(error);
    }
  });
}
