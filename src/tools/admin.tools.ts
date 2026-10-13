import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './index.js';
import { formatErrorResponse, ValidationError } from '../utils/errors.js';

export function registerAdminTools(server: McpServer, ctx: ToolContext): void {

  // ─── List Admins ───
  server.registerTool('orbitnest_list_admins', {
    description: 'List all admin users in the OrbitNest platform.',
    inputSchema: {},
  }, async () => {
    try {
      await ctx.session.ensureAuthenticated();
      const result = await ctx.apiClient.listAdmins();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Get Admin ───
  server.registerTool('orbitnest_get_admin', {
    description: 'Get details of a specific admin user.',
    inputSchema: { adminId: z.string() },
  }, async ({ adminId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const result = await ctx.apiClient.getAdmin(adminId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Invite Admin ───
  // HIGH-02: provisioning a new platform admin is identity-mutating, so it
  // requires an explicit confirmation flag. NOTE: the platform has no direct
  // create-with-password endpoint by design — a new admin is INVITED by email
  // and sets their own password by accepting the invite. Requires SMTP.
  server.registerTool('orbitnest_create_admin', {
    description: 'Invite a new admin by email (the platform adds admins via invitation, not direct password creation; requires SMTP configured). Requires confirmCreate=true.',
    inputSchema: {
      email: z.string().email(),
      confirmCreate: z.boolean(),
    },
  }, async ({ email, confirmCreate }) => {
    try {
      await ctx.session.ensureAuthenticated();
      if (!confirmCreate) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            success: false,
            error: 'Inviting a platform admin requires confirmCreate=true.',
          }, null, 2) }],
        };
      }
      const result = await ctx.apiClient.inviteAdmin(email);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: result }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Update Admin ───
  // HIGH-02: changing email / active state is identity-mutating (can lock out a
  // legitimate admin), so require an explicit confirmation flag.
  server.registerTool('orbitnest_update_admin', {
    description:
      'Update an admin. fullName/email can only be changed on YOUR OWN account; an email change needs currentPassword ' +
      'and signs out all of your sessions (including this one). isActive activates/deactivates another workspace member ' +
      'and needs the admin role. Requires confirmUpdate=true.',
    inputSchema: {
      adminId: z.string(),
      fullName: z.string().min(1).max(100).optional(),
      email: z.string().email().optional(),
      currentPassword: z.string().max(128).optional().describe('Required when changing email'),
      isActive: z.boolean().optional(),
      confirmUpdate: z.boolean(),
    },
  }, async ({ adminId, fullName, email, currentPassword, isActive, confirmUpdate }) => {
    try {
      await ctx.session.ensureAuthenticated();
      if (!confirmUpdate) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            success: false,
            error: 'Updating an admin requires confirmUpdate=true.',
          }, null, 2) }],
        };
      }
      if (fullName === undefined && email === undefined && isActive === undefined) {
        return formatErrorResponse(new ValidationError('Nothing to update: pass fullName, email or isActive.'));
      }
      const result: Record<string, unknown> = {};
      if (fullName !== undefined || email !== undefined) {
        result.profile = await ctx.apiClient.updateAdmin(adminId, {
          full_name: fullName, email, current_password: currentPassword,
        });
      }
      if (isActive !== undefined) {
        result.active = await ctx.apiClient.setAdminActive(adminId, isActive);
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Delete Admin ───
  server.registerTool('orbitnest_delete_admin', {
    description: 'Delete an admin user. Requires confirmation.',
    inputSchema: { adminId: z.string(), confirmDeletion: z.boolean() },
  }, async ({ adminId, confirmDeletion }) => {
    try {
      await ctx.session.ensureAuthenticated();
      if (!confirmDeletion) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Admin deletion requires confirmDeletion=true.',
          }, null, 2) }],
        };
      }
      const result = await ctx.apiClient.deleteAdmin(adminId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: result }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });
}
