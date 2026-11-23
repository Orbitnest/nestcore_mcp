import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from '../tools/index.js';
import { requireProjectId } from '../utils/validators.js';
import { formatErrorResponse } from '../utils/errors.js';
import { loadProjectPromptFooter } from '../codemode/instructions.js';

export function registerProjectIntelligencePrompts(server: McpServer, ctx: ToolContext): void {

  server.registerPrompt('nestcore_load_project', {
    description:
      'Load the project intelligence context (lean AI view) and orient yourself for the session. ' +
      'Run this at the start of every work session before calling any other tool.',
    argsSchema: {
      projectId: z.string().uuid().optional().describe('Project ID (uses the active project if omitted)'),
      includeSchema: z.string().optional().describe('Pass "true" to include the DB schema'),
    },
  }, async ({ projectId, includeSchema }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const pid = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const context = await ctx.apiClient.getProjectContext(pid, {
        // The lean, token-budgeted view — the full view can overflow the context window.
        view: 'ai',
        includeSchema: includeSchema === 'true',
      });
      const text = [
        '# Project Intelligence Context',
        '',
        '## Profile',
        context && typeof context === 'object' && 'profile' in context && context.profile
          ? JSON.stringify((context as any).profile, null, 2)
          : '(no profile set yet)',
        '',
        '## Open Tasks',
        context && typeof context === 'object' && 'openTasks' in context
          ? JSON.stringify((context as any).openTasks, null, 2)
          : '[]',
        '',
        '## Active Decisions',
        context && typeof context === 'object' && 'activeDecisions' in context
          ? JSON.stringify((context as any).activeDecisions, null, 2)
          : '[]',
        '',
        '## Features',
        context && typeof context === 'object' && 'features' in context
          ? JSON.stringify((context as any).features, null, 2)
          : '{}',
        '',
        '## Recent Events',
        context && typeof context === 'object' && 'recentEvents' in context
          ? JSON.stringify((context as any).recentEvents, null, 2)
          : '[]',
        '',
        '---',
        ...loadProjectPromptFooter(ctx.config.codeMode.mode !== 'tools'),
      ].join('\n');
      return {
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
      };
    } catch (error) {
      return {
        messages: [{
          role: 'user' as const,
          content: { type: 'text' as const, text: `Failed to load project context: ${error instanceof Error ? error.message : String(error)}` },
        }],
      };
    }
  });
}
