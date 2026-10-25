import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './index.js';
import { formatErrorResponse } from '../utils/errors.js';
import { requireProjectId } from '../utils/validators.js';

const SCHEDULE_PRESETS: Record<string, string> = {
  'every-minute':     '* * * * *',
  'every-5-minutes':  '*/5 * * * *',
  'every-15-minutes': '*/15 * * * *',
  'every-hour':       '0 * * * *',
  'every-6-hours':    '0 */6 * * *',
  'daily':            '0 0 * * *',
  'weekly':           '0 0 * * 0',
};

const TIMEOUT_MAP: Record<string, number> = {
  '10s': 10_000,
  '30s': 30_000,
  '60s': 60_000,
  '120s': 120_000,
};

function resolveSchedule(schedule: string): string {
  return SCHEDULE_PRESETS[schedule] ?? schedule;
}

function parseTimeoutToMs(label: string): number {
  return TIMEOUT_MAP[label] ?? 30_000;
}

export function registerBackgroundJobsTools(server: McpServer, ctx: ToolContext): void {

  // ─── Create Job ───
  server.registerTool('nestcore_create_job', {
    description: 'Create a background job that runs on a cron schedule. Write the same handler as edge functions.',
    inputSchema: {
      projectId: z.string().optional(),
      name: z.string().min(1),
      description: z.string().optional(),
      sourceCode: z.string().min(1),
      schedule: z.string().describe('Cron expression (e.g. "*/5 * * * *") or preset: every-minute, every-5-minutes, every-15-minutes, every-hour, every-6-hours, daily, weekly'),
      timezone: z.string().optional().describe('IANA timezone, default UTC'),
      timeout: z.enum(['10s', '30s', '60s', '120s']).optional().describe('Max execution time. Default 30s.'),
    },
  }, async ({ projectId, name, description, sourceCode, schedule, timezone, timeout }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const executionConfig = timeout ? { timeout: parseTimeoutToMs(timeout) } : undefined;
      const result = await ctx.apiClient.createJob(id, {
        name,
        description,
        sourceCode,
        schedule: resolveSchedule(schedule),
        timezone,
        executionConfig,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── List Jobs ───
  server.registerTool('nestcore_list_jobs', {
    description: 'List all background jobs for a project.',
    inputSchema: { projectId: z.string().optional() },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.listJobs(id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Get Job ───
  server.registerTool('nestcore_get_job', {
    description: 'Get details of a specific background job including its source code and schedule.',
    inputSchema: { projectId: z.string().optional(), jobName: z.string() },
  }, async ({ projectId, jobName }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getJob(id, jobName);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Update Job ───
  server.registerTool('nestcore_update_job', {
    description: 'Update a background job\'s source code, schedule, description, or timeout.',
    inputSchema: {
      projectId: z.string().optional(),
      jobName: z.string(),
      sourceCode: z.string().optional(),
      description: z.string().optional(),
      schedule: z.string().optional().describe('Cron expression or preset'),
      timezone: z.string().optional(),
      status: z.enum(['active', 'inactive']).optional(),
      timeout: z.enum(['10s', '30s', '60s', '120s']).optional(),
    },
  }, async ({ projectId, jobName, sourceCode, description, schedule, timezone, status, timeout }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const executionConfig = timeout ? { timeout: parseTimeoutToMs(timeout) } : undefined;
      const result = await ctx.apiClient.updateJob(id, jobName, {
        sourceCode,
        description,
        schedule: schedule ? resolveSchedule(schedule) : undefined,
        timezone,
        status,
        executionConfig,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Delete Job ───
  server.registerTool('nestcore_delete_job', {
    description: 'Delete a background job. Requires confirmation.',
    inputSchema: {
      projectId: z.string().optional(),
      jobName: z.string(),
      confirmDeletion: z.boolean(),
    },
  }, async ({ projectId, jobName, confirmDeletion }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      if (!confirmDeletion) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Job deletion requires confirmDeletion=true.',
          }, null, 2) }],
        };
      }
      const result = await ctx.apiClient.deleteJob(id, jobName);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: result }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Trigger Job ───
  server.registerTool('nestcore_trigger_job', {
    description: 'Manually trigger a background job to run immediately.',
    inputSchema: {
      projectId: z.string().optional(),
      jobName: z.string(),
    },
  }, async ({ projectId, jobName }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.triggerJob(id, jobName);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Get Job Runs ───
  server.registerTool('nestcore_get_job_runs', {
    description: 'Retrieve execution history (runs) for a specific background job.',
    inputSchema: {
      projectId: z.string().optional(),
      jobName: z.string(),
      limit: z.number().optional(),
    },
  }, async ({ projectId, jobName, limit }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getJobRuns(id, jobName, { limit });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });
}
