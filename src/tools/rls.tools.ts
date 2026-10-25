import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './index.js';
import { formatErrorResponse } from '../utils/errors.js';
import { requireProjectId } from '../utils/validators.js';
import { guardRlsDisable } from '../safety/operation.guard.js';

export function registerRlsTools(server: McpServer, ctx: ToolContext): void {

  // ─── Get RLS Status ───
  server.registerTool('nestcore_get_rls_status', {
    description: 'Check if Row-Level Security is enabled on a specific table.',
    inputSchema: { projectId: z.string().optional(), tableName: z.string() },
  }, async ({ projectId, tableName }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getRlsStatus(id, tableName);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Enable RLS ───
  server.registerTool('nestcore_enable_rls', {
    description: 'Enable Row-Level Security on a table. This restricts access to rows based on policies.',
    inputSchema: { projectId: z.string().optional(), tableName: z.string() },
  }, async ({ projectId, tableName }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.enableRls(id, tableName);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: result }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Disable RLS ───
  server.registerTool('nestcore_disable_rls', {
    description: 'Disable Row-Level Security on a table. Cannot disable RLS on auth tables. Requires confirmation.',
    inputSchema: {
      projectId: z.string().optional(),
      tableName: z.string(),
      confirmDisable: z.boolean(),
    },
  }, async ({ projectId, tableName, confirmDisable }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      guardRlsDisable(tableName);
      if (!confirmDisable) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Disabling RLS requires confirmDisable=true.',
          }, null, 2) }],
        };
      }
      const result = await ctx.apiClient.disableRls(id, tableName);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: result }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── List Policies ───
  server.registerTool('nestcore_list_policies', {
    description: 'List all RLS policies for a specific table.',
    inputSchema: { projectId: z.string().optional(), tableName: z.string() },
  }, async ({ projectId, tableName }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.listPolicies(id, tableName);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Create Policy ───
  server.registerTool('nestcore_create_policy', {
    description: 'Create a new RLS policy on a table. Policies define row-level access rules for different operations and roles.',
    inputSchema: {
      projectId: z.string().optional(),
      tableName: z.string(),
      policyName: z.string(),
      command: z.enum(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL']),
      using: z.string(),
      withCheck: z.string().optional(),
      role: z.string().optional(),
    },
  }, async ({ projectId, tableName, policyName, command, using, withCheck, role }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.createPolicy(id, tableName, {
        policyName, command, using, withCheck, role,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: result }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Delete Policy ───
  server.registerTool('nestcore_delete_policy', {
    description: 'Delete an RLS policy from a table. Requires confirmation.',
    inputSchema: {
      projectId: z.string().optional(),
      tableName: z.string(),
      policyName: z.string(),
      confirmDeletion: z.boolean(),
    },
  }, async ({ projectId, tableName, policyName, confirmDeletion }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      if (!confirmDeletion) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Policy deletion requires confirmDeletion=true.',
          }, null, 2) }],
        };
      }
      const result = await ctx.apiClient.deletePolicy(id, tableName, policyName);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: result }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });
}
