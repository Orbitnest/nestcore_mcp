import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './index.js';
import { formatErrorResponse } from '../utils/errors.js';
import { requireProjectId } from '../utils/validators.js';

export function registerProjectTools(server: McpServer, ctx: ToolContext): void {

  // ─── Create Project ───
  server.registerTool('nestcore_create_project', {
    description: 'Create a new NestCore project with a dedicated database. Returns project details including API keys.',
    inputSchema: { name: z.string().min(3).max(120), description: z.string().max(500).optional() },
  }, async ({ name, description }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const result = await ctx.apiClient.createProject({ name, description });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── List Projects ───
  server.registerTool('nestcore_list_projects', {
    description: 'List all projects for the authenticated admin user.',
    inputSchema: {},
  }, async () => {
    try {
      await ctx.session.ensureAuthenticated();
      const result = await ctx.apiClient.listProjects();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Get Project ───
  server.registerTool('nestcore_get_project', {
    description: 'Get detailed information about a specific project. IMPORTANT: projectId must be the project UUID (e.g. f354f2cf-...), NOT the project slug.',
    inputSchema: { projectId: z.string().optional() },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getProject(id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Update Project ───
  server.registerTool('nestcore_update_project', {
    description: 'Update project settings like name or configuration.',
    inputSchema: {
      projectId: z.string().optional(),
      name: z.string().min(3).max(50).optional(),
      settings: z.record(z.unknown()).optional(),
    },
  }, async ({ projectId, name, settings }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const data: Record<string, unknown> = {};
      if (name) data.name = name;
      if (settings) data.settings = settings;
      const result = await ctx.apiClient.updateProject(id, data);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Delete Project ───
  server.registerTool('nestcore_delete_project', {
    description: 'Delete a project and all associated data. This is irreversible and requires explicit confirmation.',
    inputSchema: { projectId: z.string(), confirmDeletion: z.boolean() },
  }, async ({ projectId, confirmDeletion }) => {
    try {
      await ctx.session.ensureAuthenticated();
      if (!confirmDeletion) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Project deletion requires confirmDeletion=true. This action is irreversible.',
          }, null, 2) }],
        };
      }
      const result = await ctx.apiClient.deleteProject(projectId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          message: `Project ${projectId} deleted`,
          data: result,
        }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Set Active Project ───
  server.registerTool('nestcore_set_active_project', {
    description: 'Set the active project for the current session. Loads project metadata and caches database schema.',
    inputSchema: { projectId: z.string() },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const project = await ctx.projectService.loadProject(projectId);
      ctx.session.setActiveProject(project);
      ctx.tracker.setProject(project.id);

      // Cache schema — best effort: the project is already active, so a schema
      // failure must not report the whole call as failed.
      let tablesLoaded: number | undefined;
      let schemaWarning: string | undefined;
      try {
        const schema = await ctx.schemaService.getSchema(project.id, true);
        ctx.session.setSchemaSnapshot(schema);
        tablesLoaded = schema.tables.length;
      } catch (err) {
        schemaWarning = `Schema not cached: ${err instanceof Error ? err.message : String(err)}`;
      }

      // Persist into the CLI-linked workspace file, if there is one.
      const savedTo = ctx.workspaceService.saveWorkspaceConfig({
        projectId: project.id,
        projectSlug: project.slug,
        name: project.name,
        apiUrl: ctx.session.getSession().apiUrl,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          message: `Active project set to "${project.name}"`,
          project: { id: project.id, name: project.name, slug: project.slug },
          tablesLoaded,
          ...(schemaWarning ? { warning: schemaWarning } : {}),
          workspaceConfig: savedTo ?? 'not saved (no .nestcore/config.json found; run `nestcore link` in the project directory to persist it)',
        }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Toggle Debug Mode ───
  server.registerTool('nestcore_toggle_debug_mode', {
    description: 'Enable or disable debug mode for detailed logging on a project.',
    inputSchema: { projectId: z.string().optional(), enabled: z.boolean() },
  }, async ({ projectId, enabled }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.toggleDebugMode(id, enabled);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          debugMode: enabled,
          data: result,
        }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Create API Keys ───
  server.registerTool('nestcore_create_api_keys', {
    description: 'Generate new project API key pair. WARNING: This invalidates all existing keys for the project.',
    inputSchema: { projectId: z.string().optional(), description: z.string().optional() },
  }, async ({ projectId, description }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.createProjectApiKeys(id, { name: description || 'default' });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Get API Keys ───
  server.registerTool('nestcore_get_api_keys', {
    description: 'Get existing API keys for a project.',
    inputSchema: { projectId: z.string().optional() },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getProjectApiKeys(id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Get Project Health ───
  server.registerTool('nestcore_get_project_health', {
    description: 'Check the health status of a project including database connectivity.',
    inputSchema: { projectId: z.string().optional() },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getProjectHealth(id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });
}
