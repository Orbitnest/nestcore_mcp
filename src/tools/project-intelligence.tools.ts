import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './index.js';
import { formatErrorResponse } from '../utils/errors.js';
import { requireProjectId } from '../utils/validators.js';

// ── Structured content schemas ────────────────────────────────────────────────
// The AI sends STRUCTURED data (not a text blob). We serialize to JSON and store
// it in the profile's text columns; the Studio UI renders each section cleanly
// and the API flattens it to prose for embeddings.

const sessionDigestSchema = z.object({
  date:    z.string().max(40).optional().describe('Session date, ISO (e.g. "2026-06-24")'),
  title:   z.string().min(1).max(120).describe('Short session title, e.g. "UI/UX + bugfix pass"'),
  summary: z.string().max(600).optional().describe('1–2 sentence overview of the session'),
  done: z.array(z.object({
    title:  z.string().min(1).max(200).describe('What was accomplished, concise'),
    detail: z.string().max(800).optional().describe('Supporting detail / how it was done'),
  })).max(40).optional().describe('Completed work items this session'),
  next:     z.array(z.string().max(400)).max(30).optional().describe('Next steps / follow-ups for the next session'),
  blockers: z.array(z.string().max(400)).max(30).optional().describe('Open blockers, risks, or things to investigate'),
});

const projectSummarySchema = z.object({
  tagline:     z.string().max(200).optional().describe('One-line description of the project'),
  description: z.string().min(1).max(3000).describe('Paragraph describing what the project is and does'),
  highlights:  z.array(z.string().max(400)).max(30).optional().describe('Key features / capabilities as bullet points'),
});

// Must match the API (project-intelligence.types.ts EVENT_TYPES / DTO minimums).
const EVENT_TYPES = ['deploy', 'bug', 'decision', 'update', 'milestone', 'incident', 'commit', 'release', 'note', 'other'] as const;

/** One retry on 429 — the intelligence routes share a 60 req/min per-IP throttle. */
async function withThrottleRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode !== 429) throw e;
    await new Promise((r) => setTimeout(r, 3000));
    return fn();
  }
}

function encodeDigest(d: z.infer<typeof sessionDigestSchema>): string {
  return JSON.stringify({ v: 1, kind: 'session_digest', ...d });
}
function encodeSummary(s: z.infer<typeof projectSummarySchema>): string {
  return JSON.stringify({ v: 1, kind: 'project_summary', ...s });
}

export function registerProjectIntelligenceTools(server: McpServer, ctx: ToolContext): void {
  const { tracker } = ctx;

  // ─── Get Project Context ──────────────────────────────────────────────────
  // Keywords: load memory, load context, sync memory, project state, orientation
  server.registerTool('orbitnest_get_project_context', {
    description: [
      'Load (or refresh) the project memory and context.',
      'Returns: project summary, tech stack, agent digest, open tasks, active decisions, in-progress/planned features, and recent events.',
      '',
      'By default this returns a TRIMMED, token-budgeted view (long text truncated, released features and raw event metadata omitted) so it never bloats your context. Pass detail=true for a fuller payload (longer text, released features, more events), or use orbitnest_search_memory to pull specific items in full.',
      '',
      'WHEN TO CALL: Once at session start — before taking any action on the project. Do not re-call unless you need a refresh.',
      '',
      'Keywords: load memory, load context, refresh context, project state, orient, catch up, what is the project, what was done.',
    ].join('\n'),
    inputSchema: {
      projectId: z.string().uuid().optional().describe('Project ID (uses active project if omitted)'),
      detail: z.boolean().optional().describe('Return a fuller payload (longer text, released features, more events). Default false = lean.'),
      includeSchema: z.boolean().optional().describe('Also return the DB schema alongside the context'),
      eventLimit: z.number().int().min(1).max(50).optional().describe('How many recent events to include'),
    },
  }, async ({ projectId, detail, includeSchema, eventLimit }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const pid = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      tracker.setProject(pid);
      const result = await ctx.apiClient.getProjectContext(pid, {
        view: 'ai', detail, includeSchema, events: eventLimit,
      });
      return {
        content: [{
          type: 'text' as const,
          text: [
            JSON.stringify(result),
            '',
            '─── NEXT STEPS ───',
            '• Review open tasks and the latest digest.',
            '• At session end, call orbitnest_sync_memory to save your work.',
          ].join('\n'),
        }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Sync Memory (one-call session-end) ───────────────────────────────────
  // Keywords: save memory, sync memory, persist memory, end session, write back,
  //           update project memory, commit session, session digest
  server.registerTool('orbitnest_sync_memory', {
    description: [
      'ONE-CALL SESSION-END MEMORY SYNC. Save everything to the project memory in a single call.',
      '',
      'Pass:',
      '  • digest    — STRUCTURED session summary (title + done[] + next[] + blockers[]). NOT a text blob.',
      '  • decisions — list of decisions made this session (if not already written via add_decision)',
      '  • tasks     — list of follow-up items (if not already written via add_task)',
      '  • events    — notable events: deploys, bugs, milestones (if not already written via add_event)',
      '',
      'The digest MUST be structured: break work into discrete `done` items (each with a title and optional',
      'detail), list `next` steps as separate strings, and `blockers` as separate strings. Do NOT cram',
      'everything into one paragraph — the UI renders each section separately for readability.',
      '',
      'Items are written one by one; any item the API rejects is listed with its error so you can fix and retry it.',
      'No need to call add_task / add_decision / add_event separately.',
      '',
      'WHEN TO CALL: At the end of EVERY session, before the conversation closes.',
      'Also call it proactively if the user asks to "save", "sync", "persist", or "commit" memory.',
      '',
      'Keywords: save memory, sync memory, persist context, commit session, end session, write back, update project memory.',
    ].join('\n'),
    inputSchema: {
      projectId: z.string().uuid().optional(),
      digest: sessionDigestSchema.describe(
        'STRUCTURED session digest: { title, summary?, done: [{title, detail?}], next: [...], blockers: [...] }. Break work into discrete items — do not write a single paragraph.',
      ),
      decisions: z.array(z.object({
        decision: z.string().min(3).max(500).describe('The decision, in one sentence'),
        reason:   z.string().max(2000).optional().describe('Why this decision was made'),
      })).optional().describe('Decisions made this session not yet written via orbitnest_add_decision'),
      tasks: z.array(z.object({
        title:    z.string().min(3).max(200),
        detail:   z.string().max(2000).optional(),
        priority: z.enum(['urgent', 'high', 'medium', 'low']).optional(),
      })).optional().describe('Follow-up tasks identified this session not yet written via orbitnest_add_task'),
      events: z.array(z.object({
        type:    z.enum(EVENT_TYPES),
        summary: z.string().min(3).max(500),
      })).optional().describe('Notable events not yet written via orbitnest_add_event'),
    },
  }, async ({ projectId, digest, decisions, tasks, events }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const pid = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      tracker.setProject(pid);

      // Sequential (not parallel) so a big sync doesn't trip the per-IP throttle.
      type Item = { kind: 'digest' | 'decision' | 'task' | 'event'; label: string; run: () => Promise<unknown> };
      const items: Item[] = [
        { kind: 'digest', label: digest.title, run: () => ctx.apiClient.setProjectProfile(pid, { digest: encodeDigest(digest) }) },
        ...(decisions ?? []).map((d) => ({ kind: 'decision' as const, label: d.decision, run: () => ctx.apiClient.addDecision(pid, d) })),
        ...(tasks ?? []).map((t) => ({ kind: 'task' as const, label: t.title, run: () => ctx.apiClient.addTask(pid, t) })),
        ...(events ?? []).map((e) => ({ kind: 'event' as const, label: `[${e.type}] ${e.summary}`, run: () => ctx.apiClient.addEvent(pid, e) })),
      ];
      const failures: Array<{ item: Item; error: string }> = [];
      for (const item of items) {
        try {
          await withThrottleRetry(item.run);
        } catch (e) {
          failures.push({ item, error: e instanceof Error ? e.message : String(e) });
        }
      }

      // Only what was actually persisted counts as synced: if the digest
      // failed, keep every pending write; otherwise keep just the failed items
      // so the reminder footer and the shutdown auto-digest still cover them.
      const digestFailed = failures.some((f) => f.item.kind === 'digest');
      if (!digestFailed) tracker.markSynced();
      for (const f of failures) {
        if (f.item.kind !== 'digest') tracker.record({ kind: f.item.kind, summary: f.item.label });
      }

      const count = (kind: Item['kind'], total: number) =>
        total ? `  ${kind[0].toUpperCase()}${kind.slice(1)}s: ${total - failures.filter((f) => f.item.kind === kind).length}/${total} written.` : '';
      const summary = [
        failures.length ? '⚠ Session memory partially synced.' : '✓ Session memory synced.',
        digestFailed ? '  Digest NOT written.' : '  Digest written.',
        count('decision', decisions?.length ?? 0),
        count('task', tasks?.length ?? 0),
        count('event', events?.length ?? 0),
        failures.length ? '\nFailed items (fix and retry with orbitnest_sync_memory or the add_* tools):' : '',
        ...failures.map((f) => `  - [${f.item.kind}] ${f.item.label.slice(0, 120)}: ${f.error}`),
      ].filter(Boolean).join('\n');

      return { content: [{ type: 'text' as const, text: summary }] };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Get Recent Changes ───────────────────────────────────────────────────
  server.registerTool('orbitnest_get_recent_changes', {
    description:
      'Get recent project events since a given timestamp. ' +
      'Use to catch up on what changed since your last session, or to see what happened while you were away.',
    inputSchema: {
      projectId: z.string().uuid().optional(),
      since: z.string().optional().describe('ISO 8601 timestamp — only return events after this point'),
      limit:  z.number().int().min(1).max(100).optional(),
    },
  }, async ({ projectId, since, limit }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const pid = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getRecentChanges(pid, { since, limit });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Get Open Tasks ───────────────────────────────────────────────────────
  server.registerTool('orbitnest_get_open_tasks', {
    description: 'Get open tasks (todo + in_progress) for the project, sorted by priority. Use to see what work is pending.',
    inputSchema: {
      projectId: z.string().uuid().optional(),
      priority: z.enum(['urgent', 'high', 'medium', 'low']).optional().describe('Filter by priority'),
    },
  }, async ({ projectId, priority }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const pid = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getOpenTasks(pid, { priority });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Add Task ─────────────────────────────────────────────────────────────
  server.registerTool('orbitnest_add_task', {
    description:
      'Record a follow-up task or action item in the project memory. ' +
      'Call this IMMEDIATELY when you identify a TODO — do not wait until session end. ' +
      'Prefer orbitnest_sync_memory at session end to batch-write multiple tasks at once.',
    inputSchema: {
      projectId:       z.string().uuid().optional(),
      title:           z.string().min(3).max(200),
      detail:          z.string().max(2000).optional(),
      priority:        z.enum(['urgent', 'high', 'medium', 'low']).optional(),
      linkedFeatureId: z.string().uuid().optional(),
    },
  }, async ({ projectId, title, detail, priority, linkedFeatureId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const pid = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      tracker.setProject(pid);
      const result = await ctx.apiClient.addTask(pid, { title, detail, priority, linkedFeatureId });
      tracker.record({ kind: 'task', summary: title });
      const footer = tracker.reminderFooter() ?? '';
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) + footer }] };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Complete Task ────────────────────────────────────────────────────────
  server.registerTool('orbitnest_complete_task', {
    description: 'Mark a task as done. Optionally add a completion note.',
    inputSchema: {
      projectId: z.string().uuid().optional(),
      taskId:    z.string().uuid(),
      note:      z.string().max(500).optional(),
    },
  }, async ({ projectId, taskId, note }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const pid = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.completeTask(pid, taskId, { note });
      tracker.record({ kind: 'complete', summary: `task ${taskId}` });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Get Decisions ────────────────────────────────────────────────────────
  server.registerTool('orbitnest_get_decisions', {
    description:
      'Retrieve stored architectural and product decisions. ' +
      'Always reference these before making design choices to avoid contradicting past decisions.',
    inputSchema: {
      projectId: z.string().uuid().optional(),
      status:    z.enum(['active', 'superseded', 'all']).optional(),
      limit:     z.number().int().min(1).max(100).optional(),
    },
  }, async ({ projectId, status, limit }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const pid = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getProjectDecisions(pid, { status, limit });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Add Decision ─────────────────────────────────────────────────────────
  server.registerTool('orbitnest_add_decision', {
    description:
      'Record an architectural or product decision in the project memory. ' +
      'Call this IMMEDIATELY when a significant technical choice is made (e.g. "use JWT over sessions", "adopt REST over GraphQL"). ' +
      'Prefer orbitnest_sync_memory at session end to batch-write multiple decisions at once.',
    inputSchema: {
      projectId: z.string().uuid().optional(),
      decision:  z.string().min(3).max(500).describe('The decision, in one sentence'),
      reason:    z.string().max(2000).optional().describe('Why this decision was made'),
      metadata:  z.record(z.unknown()).optional(),
    },
  }, async ({ projectId, decision, reason, metadata }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const pid = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      tracker.setProject(pid);
      const result = await ctx.apiClient.addDecision(pid, { decision, reason, metadata: metadata as Record<string, unknown> | undefined });
      tracker.record({ kind: 'decision', summary: decision });
      const footer = tracker.reminderFooter() ?? '';
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) + footer }] };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Add Feature ──────────────────────────────────────────────────────────
  server.registerTool('orbitnest_add_feature', {
    description: 'Add a feature to the project roadmap. Use when a new feature is identified or planned.',
    inputSchema: {
      projectId:    z.string().uuid().optional(),
      name:         z.string().min(2).max(200),
      description:  z.string().max(2000).optional(),
      status:       z.enum(['planned', 'in_progress', 'released', 'cancelled']).optional(),
      dependencies: z.array(z.string()).optional(),
    },
  }, async ({ projectId, name, description, status, dependencies }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const pid = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      tracker.setProject(pid);
      const result = await ctx.apiClient.addFeature(pid, { name, description, status, dependencies });
      tracker.record({ kind: 'task', summary: `[feature] ${name}` });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Update Feature ───────────────────────────────────────────────────────
  server.registerTool('orbitnest_update_feature', {
    description: 'Update a feature status or description (e.g. move in_progress → released after shipping).',
    inputSchema: {
      projectId:   z.string().uuid().optional(),
      featureId:   z.string().uuid(),
      status:      z.enum(['planned', 'in_progress', 'released', 'cancelled']).optional(),
      description: z.string().max(2000).optional(),
    },
  }, async ({ projectId, featureId, status, description }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const pid = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.updateFeature(pid, featureId, { status, description });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Add Event ────────────────────────────────────────────────────────────
  server.registerTool('orbitnest_add_event', {
    description:
      'Record a significant project event in the timeline (deploy, bug, milestone, incident, etc.). ' +
      'Call IMMEDIATELY when something notable happens — not at session end. ' +
      'This builds the historical context that future sessions read. ' +
      'Prefer orbitnest_sync_memory to batch-write multiple events at session end.',
    inputSchema: {
      projectId: z.string().uuid().optional(),
      type:      z.enum(EVENT_TYPES),
      summary:   z.string().min(3).max(500),
      metadata:  z.record(z.unknown()).optional(),
    },
  }, async ({ projectId, type, summary, metadata }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const pid = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      tracker.setProject(pid);
      const result = await ctx.apiClient.addEvent(pid, { type, summary, metadata: metadata as Record<string, unknown> | undefined });
      tracker.record({ kind: 'event', summary: `[${type}] ${summary}` });
      const footer = tracker.reminderFooter() ?? '';
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) + footer }] };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Search Memory ────────────────────────────────────────────────────────
  server.registerTool('orbitnest_search_memory', {
    description:
      'Semantic search over ALL project memory — decisions, tasks, features, events, and summaries. ' +
      'Use when you need to recall something not surfaced in the context snapshot. ' +
      'Keywords: search memory, recall, find past decision, look up, what did we decide about, history.',
    inputSchema: {
      projectId:  z.string().uuid().optional(),
      query:      z.string().min(3).max(500),
      sourceType: z.enum(['decision', 'task', 'feature', 'event', 'summary']).optional(),
      limit:      z.number().int().min(1).max(20).optional(),
    },
  }, async ({ projectId, query, sourceType, limit }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const pid = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.searchProjectMemory(pid, { query, sourceType, limit });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Set Project Profile ──────────────────────────────────────────────────
  server.registerTool('orbitnest_set_project_profile', {
    description: [
      'Update the project profile: summary, tech stack, conventions, and/or session digest.',
      'Use orbitnest_sync_memory instead when you want to save a digest PLUS decisions/tasks/events in one call.',
      'Use this tool directly to set the STRUCTURED project summary or update stack/conventions.',
      '',
      'The summary is STRUCTURED: { description, tagline?, highlights[] } — break key capabilities into',
      'separate `highlights` rather than one long paragraph.',
      '',
      'Keywords: update profile, set summary, update stack, write digest, save memory, persist.',
    ].join('\n'),
    inputSchema: {
      projectId:   z.string().uuid().optional(),
      summary:     projectSummarySchema.optional().describe('STRUCTURED project summary: { description, tagline?, highlights: [...] }'),
      stack:       z.array(z.string()).optional().describe('Tech stack (e.g. ["NestJS", "Next.js", "Postgres"])'),
      conventions: z.record(z.unknown()).optional().describe('Key conventions (e.g. { auth: "JWT", style: "snake_case" })'),
      digest:      sessionDigestSchema.optional().describe('STRUCTURED session digest: { title, done: [...], next: [...], blockers: [...] }'),
    },
  }, async ({ projectId, summary, stack, conventions, digest }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const pid = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.setProjectProfile(pid, {
        summary: summary ? encodeSummary(summary) : undefined,
        stack,
        conventions: conventions as Record<string, unknown> | undefined,
        digest: digest ? encodeDigest(digest) : undefined,
      });
      if (digest) tracker.markSynced();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });
}
