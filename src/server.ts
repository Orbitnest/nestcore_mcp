import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AppConfig } from './types/config.types.js';
import { NestCoreClient } from './sdk/nestcore.client.js';
import { SessionService } from './auth/session.service.js';
import { SchemaService } from './context/schema.service.js';
import { WorkspaceService } from './context/workspace.service.js';
import { ProjectService } from './context/project.service.js';
import { SessionTracker } from './context/session-tracker.js';
import { registerAllTools, type ToolContext } from './tools/index.js';
import { withLegacyToolNames } from './legacy-tool-names.js';
import { logger } from './utils/logger.js';

/**
 * Build the COMPACT orientation summary served by the project://context
 * resource. Emits only a name, a one-line description, item counts and a
 * pointer to the full tool — never the full memory. Hard-capped at `maxChars`
 * so it can never inflate the prompt (clients auto-read resources every turn).
 */
export function buildCompactSummary(
  ctx: Record<string, unknown>,
  projectName: string,
  maxChars: number,
): Record<string, unknown> {
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const profile = (ctx?.profile ?? null) as Record<string, unknown> | null;
  const features = (ctx?.features ?? {}) as Record<string, unknown>;
  const featureCount =
    arr(features.planned).length + arr(features.in_progress).length + arr(features.released).length;

  // One-line description from the stored summary (plain text or a JSON blob the
  // AI wrote as { kind:'project_summary', tagline, description, ... }).
  let description = '';
  const rawSummary = profile?.summary;
  if (typeof rawSummary === 'string' && rawSummary.trim()) {
    const t = rawSummary.trim();
    if (t.startsWith('{')) {
      try {
        const o = JSON.parse(t) as Record<string, unknown>;
        description = String(o.tagline ?? o.description ?? '');
      } catch {
        description = t;
      }
    } else {
      description = t;
    }
  }
  description = description.replace(/\s+/g, ' ').slice(0, 280);

  const note =
    'Compact overview only — NOT full memory. Call the nestcore_get_project_context tool for detail, or nestcore_search_memory to find specific items.';

  const summary: Record<string, unknown> = {
    project: projectName,
    ...(description ? { description } : {}),
    ...(arr(profile?.stack).length ? { stack: arr(profile?.stack).slice(0, 12) } : {}),
    counts: {
      openTasks: arr(ctx?.openTasks).length,
      activeDecisions: arr(ctx?.activeDecisions).length,
      features: featureCount,
      recentEvents: arr(ctx?.recentEvents).length,
    },
    ...(profile?.digest_at || profile?.updated_at
      ? { lastUpdated: profile?.digest_at ?? profile?.updated_at }
      : {}),
    note,
  };

  // Hard cap. Shed the heavy optional fields, then fall back to counts + note.
  if (JSON.stringify(summary).length > maxChars) {
    delete summary.description;
    delete summary.stack;
    if (JSON.stringify(summary).length > maxChars) {
      return { project: projectName, counts: summary.counts, note };
    }
  }
  return summary;
}

export async function createServer(config: AppConfig): Promise<{ server: McpServer; tracker: SessionTracker; apiClient: NestCoreClient }> {
  const apiClient = new NestCoreClient({ apiUrl: config.apiUrl, accessToken: '' });

  const sessionService = new SessionService(config, apiClient);
  const schemaService = new SchemaService(apiClient, config.schemaCacheTtl);
  const workspaceService = new WorkspaceService();
  const projectService = new ProjectService(apiClient);
  const tracker = new SessionTracker();

  await sessionService.initialize();

  // Detect workspace config and set active project.
  const wsConfig = await workspaceService.detectWorkspace();
  if (wsConfig) {
    const session = sessionService.getSession();
    if (!session.currentProjectId) {
      session.currentProjectId = wsConfig.projectId;
      session.currentProjectSlug = wsConfig.projectSlug ?? null;
      logger.info('Project context loaded from workspace', { projectId: wsConfig.projectId });
    }
  }

  // ── Register the active project with the tracker ────────────────────────
  // The workspace marker (.nestcore/config.json) tells us WHICH project this
  // is; that's the auto-hook. We deliberately do NOT pull the project context
  // here. Embedding a live snapshot into the server instructions inflates the
  // system prompt on every single request — a large stored digest then blows
  // past the model's context limit. Context is pulled on demand instead, once,
  // via nestcore_get_project_context.
  const activeProjectId = sessionService.getSession().currentProjectId;
  if (activeProjectId) tracker.setProject(activeProjectId);

  // ── SESSION_INSTRUCTIONS ─────────────────────────────────────────────────
  // Surfaced by MCP clients as the server's system instructions — they ride
  // along on every request, so keep them SMALL. Pointers to tools, no data.
  const SESSION_INSTRUCTIONS = [
    'Persistent memory for NestCore projects (Project Intelligence). Pull context on demand; never assume it is already loaded.',
    '',
    'SESSION START: if no project is set, call nestcore_list_projects then nestcore_set_active_project.',
    'Then call nestcore_get_project_context ONCE to load this project\'s memory (profile, open tasks, decisions, recent events). Do not call it again unless you need a refresh.',
    '',
    'DURING THE SESSION, write as things happen (not batched at the end):',
    '  nestcore_add_decision — an architectural/product decision',
    '  nestcore_add_task     — a follow-up / TODO',
    '  nestcore_add_event    — a deploy / bug / milestone',
    '  nestcore_search_memory — recall anything not in the loaded context',
    '',
    'SESSION END: call nestcore_sync_memory once with a digest (what was done, decisions, blockers, what\'s next) plus any unsaved decisions/tasks/events. Keep the digest concise — a summary, not a transcript or file dumps. Memory is only persisted when you call a tool.',
  ].join('\n');

  // ── Create MCP server ────────────────────────────────────────────────────
  const server = new McpServer(
    { name: config.serverName, version: config.serverVersion },
    { instructions: SESSION_INSTRUCTIONS },
  );

  // ── Register project://context resource ─────────────────────────────────
  // Clients auto-read resources into the prompt on EVERY request, so this MUST
  // stay tiny (target ≤4KB). It returns a COMPACT orientation summary only —
  // project name, a one-line description, counts, and a pointer to the full
  // tool. It must NEVER serialize the whole project memory (that overflowed the
  // context window: a large project's full context was ~1.7M tokens). Full
  // detail is pulled deliberately via the nestcore_get_project_context tool;
  // specific recall is done via nestcore_search_memory (vector/FTS) so the AI
  // skims, not reads everything.
  const RESOURCE_MAX_CHARS = 4000;
  try {
    server.registerResource(
      'project-context',
      'project://context',
      {
        title: 'Project Intelligence — compact summary',
        description:
          'Compact orientation summary for the active NestCore project (name, one-line description, item counts). ' +
          'NOT the full memory. Call the nestcore_get_project_context tool for full detail, or nestcore_search_memory to find specific items.',
        mimeType: 'application/json',
      },
      async () => {
        const emit = (obj: unknown) => ({
          contents: [{ uri: 'project://context', mimeType: 'application/json', text: JSON.stringify(obj) }],
        });
        try {
          await sessionService.ensureAuthenticated();
        } catch {
          // Clients read this resource every turn — never throw from it.
          return emit({ error: 'Not signed in. Call nestcore_admin_signin or nestcore_login first.' });
        }
        const session = sessionService.getSession();
        const pid = session.currentProjectId;
        if (!pid) {
          return emit({ error: 'No active project. Call nestcore_set_active_project first.' });
        }
        try {
          const ctx = await apiClient.getProjectContext(pid, { events: 20 });
          const summary = buildCompactSummary(ctx, session.currentProjectSlug ?? pid, RESOURCE_MAX_CHARS);
          return emit(summary);
        } catch {
          // Never fail the session over an orientation blurb.
          return emit({
            project: session.currentProjectSlug ?? pid,
            note: 'Context summary unavailable. Call nestcore_get_project_context for detail.',
          });
        }
      },
    );
    logger.info('Registered MCP resource: project://context (compact)');
  } catch (err) {
    logger.warn('Could not register project://context resource', { err: String(err) });
  }

  // ── Build tool context and register tools ────────────────────────────────
  const toolContext: ToolContext = {
    session: sessionService,
    apiClient,
    schemaService,
    workspaceService,
    projectService,
    config,
    tracker,
  };

  registerAllTools(server, toolContext);

  logger.info('MCP server initialized', {
    tools: 'all registered',
    authenticated: String(sessionService.isAuthenticated()),
    activeProject: sessionService.getSession().currentProjectId ?? 'none',
  });

  return { server, tracker, apiClient };
}

export async function startStdioServer(server: McpServer): Promise<void> {
  // Clients that cached the pre-rename `orbitnest_*` tool names keep working.
  const transport = withLegacyToolNames(new StdioServerTransport());
  await server.connect(transport);
  logger.info('NestCore MCP server running on stdio');
}
