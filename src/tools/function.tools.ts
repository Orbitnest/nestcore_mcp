import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './index.js';
import { formatErrorResponse } from '../utils/errors.js';
import { requireProjectId } from '../utils/validators.js';

const TIMEOUT_MAP: Record<string, number> = {
  '10s': 10_000,
  '30s': 30_000,
  '60s': 60_000,
  '120s': 120_000,
};

function parseTimeoutToMs(label: string): number {
  return TIMEOUT_MAP[label] ?? 30_000;
}

// Appended to create/update function descriptions so the agent knows what the
// function runtime can (and cannot) read — and, crucially, that the service
// role key is opt-in. Without this, a function written to bypass RLS via
// NESTCORE_SERVICE_ROLE_KEY silently gets an empty value and "doesn't work"
// with no obvious reason.
const FUNCTION_ENV_NOTE =
  ' ENVIRONMENT / CREDENTIALS: read env vars inside the function with `Deno.env.get("NAME")`. ' +
  'Available by default: NESTCORE_URL, NESTCORE_ANON_KEY (the PUBLIC, RLS-protected key), ' +
  'PROJECT_ID, PROJECT_URL, FUNCTION_NAME, plus any project env vars you have added ' +
  '(the pre-rename ORBITNEST_* names of these variables still work). ' +
  'IMPORTANT: NESTCORE_SERVICE_ROLE_KEY (which bypasses RLS / grants full DB access) is NOT ' +
  'injected by default and will read back as an empty string. If a function needs privileged, ' +
  'RLS-bypassing access, the user must add it explicitly as a project environment variable — ' +
  'copy the service_role key from the dashboard (Project → API Keys) and add an env var named ' +
  'NESTCORE_SERVICE_ROLE_KEY (or call nestcore_create_env_variable). Prefer the anon key + RLS ' +
  'where possible; only request service_role when truly necessary. Do NOT assume ' +
  'NESTCORE_SERVICE_ROLE_KEY exists — if a function relying on it returns empty/denied results, ' +
  'tell the user to add that env var.';

export function registerFunctionTools(server: McpServer, ctx: ToolContext): void {

  // ─── Create Function ───
  server.registerTool('nestcore_create_function', {
    description: 'Create a new edge function. IMPORTANT: projectId must be the project UUID (e.g. f354f2cf-...), NOT the project slug — passing the slug causes a silent 500 error. Edge function code format: JavaScript or TypeScript (TS is transpiled), no `import` statements, use `async function handler(req) { ... }` and end with `export default handler`.' + FUNCTION_ENV_NOTE,
    inputSchema: {
      projectId: z.string().optional(),
      name: z.string().min(1),
      description: z.string().optional(),
      sourceCode: z.string().min(1),
      timeout: z.enum(['10s', '30s', '60s', '120s']).optional().describe('Max execution time. Allowed: 10s, 30s (default), 60s, 120s.'),
    },
  }, async ({ projectId, name, description, sourceCode, timeout }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const executionConfig = timeout ? { timeout: parseTimeoutToMs(timeout) } : undefined;
      const result = await ctx.apiClient.createFunction(id, { name, description, sourceCode, executionConfig });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── List Functions ───
  server.registerTool('nestcore_list_functions', {
    description: 'List all edge functions for a project. IMPORTANT: projectId must be the project UUID (not the slug). Returns function names, descriptions, status, and timestamps — but not source code (use get_function for that).',
    inputSchema: { projectId: z.string().optional() },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.listFunctions(id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Get Function ───
  server.registerTool('nestcore_get_function', {
    description: 'Get details of a specific edge function including its source code.',
    inputSchema: { projectId: z.string().optional(), functionName: z.string() },
  }, async ({ projectId, functionName }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getFunction(id, functionName);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Update Function ───
  server.registerTool('nestcore_update_function', {
    description: 'Update an edge function\'s source code, description, or timeout. IMPORTANT: projectId must be the project UUID (e.g. f354f2cf-...), NOT the project slug. Edge function code format: JavaScript or TypeScript (TS is transpiled), no `import` statements, use `async function handler(req) { ... }` and end with `export default handler`.' + FUNCTION_ENV_NOTE,
    inputSchema: {
      projectId: z.string().optional(),
      functionName: z.string(),
      sourceCode: z.string().optional(),
      description: z.string().optional(),
      timeout: z.enum(['10s', '30s', '60s', '120s']).optional().describe('Max execution time. Allowed: 10s, 30s, 60s, 120s.'),
    },
  }, async ({ projectId, functionName, sourceCode, description, timeout }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const executionConfig = timeout ? { timeout: parseTimeoutToMs(timeout) } : undefined;
      const result = await ctx.apiClient.updateFunction(id, functionName, { sourceCode, description, executionConfig });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Delete Function ───
  server.registerTool('nestcore_delete_function', {
    description: 'Delete an edge function. Requires confirmation.',
    inputSchema: {
      projectId: z.string().optional(),
      functionName: z.string(),
      confirmDeletion: z.boolean(),
    },
  }, async ({ projectId, functionName, confirmDeletion }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      if (!confirmDeletion) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Function deletion requires confirmDeletion=true.',
          }, null, 2) }],
        };
      }
      const result = await ctx.apiClient.deleteFunction(id, functionName);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: result }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Get Function Logs ───
  server.registerTool('nestcore_get_function_logs', {
    description: 'Retrieve the most recent execution logs for a specific edge function (use nestcore_query_logs with logType=edge-functions for time-range filtering).',
    inputSchema: {
      projectId: z.string().optional(),
      functionName: z.string(),
      limit: z.number().optional(),
    },
  }, async ({ projectId, functionName, limit }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getFunctionLogs(id, functionName, { limit });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Manage Environment Variables ───
  server.registerTool('nestcore_get_env_variables', {
    description: 'List environment variable names for a project. Note: values are not returned for security — the API only exposes variable names (values appear as ***HIDDEN*** or ***ENCRYPTED***).',
    inputSchema: { projectId: z.string().optional() },
  }, async ({ projectId }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.getEnvVariables(id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  server.registerTool('nestcore_create_env_variable', {
    description: 'Create a new environment variable for a project.',
    inputSchema: {
      projectId: z.string().optional(),
      key: z.string().min(1),
      value: z.string(),
      encrypted: z.boolean().optional(),
    },
  }, async ({ projectId, key, value, encrypted }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.createEnvVariable(id, { key, value, encrypted });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  server.registerTool('nestcore_update_env_variable', {
    description: 'Update an existing environment variable. Pass the variable\'s name (e.g. STRIPE_SECRET_KEY), not its ID. The API accepts only { value } in the request body — renaming a variable is not supported.',
    inputSchema: {
      projectId: z.string().optional(),
      variableName: z.string().describe('The variable name (e.g. STRIPE_SECRET_KEY), not its UUID.'),
      value: z.string(),
    },
  }, async ({ projectId, variableName, value }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.updateEnvVariable(id, variableName, { value });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  server.registerTool('nestcore_delete_env_variable', {
    description: 'Delete an environment variable. Pass the variable\'s name (e.g. STRIPE_SECRET_KEY), not its ID.',
    inputSchema: { projectId: z.string().optional(), variableName: z.string().describe('The variable name (e.g. STRIPE_SECRET_KEY), not its UUID.') },
  }, async ({ projectId, variableName }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const id = requireProjectId(projectId, ctx.session.getSession().currentProjectId);
      const result = await ctx.apiClient.deleteEnvVariable(id, variableName);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: result }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });
}
