/**
 * Human confirmation for the highest-risk operations (spend, identity, auth
 * security, Production schema, secret reveal).
 *
 * The tools' own `confirm*` booleans are set by the model, so on their own
 * they only prove the model chose to proceed. When the MCP client supports
 * elicitation, these operations additionally ask the HUMAN (direct tools: in
 * the registered handler wrapper, see codemode/registry.ts; Code Mode: in the
 * execute bridge, see codemode/execute.ts). When the client does not support
 * elicitation the tool falls back to its flags plus the MCP tool annotations
 * (destructiveHint / openWorldHint), which clients use to prompt the user.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

type Args = Record<string, unknown>;

const str = (v: unknown, max = 80) => String(v ?? '').slice(0, max);

/**
 * What the operation would do, phrased to complete "Allow the AI to …?", or
 * null when this call needs no human confirmation (other tools, preview modes,
 * or calls the tool itself refuses because its own flag is false).
 */
export function userConfirmationFor(name: string, args: Args | null | undefined): string | null {
  const a = args ?? {};
  switch (name) {
    case 'nestcore_buy_credits':
      return `create a Stripe checkout link for the AI credit pack "${str(a.pack, 40)}"`;
    case 'nestcore_set_credit_cap':
      return a.monthlyCapUsd === null ? "remove the workspace's monthly AI credit spend cap" : null;
    case 'nestcore_set_auth_security': {
      const keys = Object.keys(a).filter((k) => k !== 'projectId' && a[k] !== undefined);
      return `change the end-user auth limits (${keys.join(', ') || 'none'}) of every app signing in to the project`;
    }
    case 'nestcore_reset_branch':
      return "reset the Development branch (deletes ALL of Development's rows, end users and files)";
    case 'nestcore_promote_branch':
      return a.apply === true
        ? `apply the Development schema changes to PRODUCTION${a.confirmDestructive === true ? ' including destructive changes' : ''}`
        : null;
    case 'nestcore_create_admin':
      return a.confirmCreate === true ? `invite ${str(a.email, 120)} as a workspace admin` : null;
    case 'nestcore_update_admin':
      return a.confirmUpdate === true
        ? `update admin ${str(a.adminId)}${a.isActive !== undefined ? ` (set active=${String(a.isActive)})` : ''}${a.email !== undefined ? ' (change email)' : ''}`
        : null;
    case 'nestcore_delete_admin':
      return a.confirmDeletion === true ? `delete admin ${str(a.adminId)}` : null;
    case 'nestcore_disable_rls':
      return a.confirmDisable === true ? `disable Row-Level Security on table "${str(a.tableName, 63)}"` : null;
    case 'nestcore_get_connection_string':
      return a.revealPassword === true ? "reveal the project's live database password to the AI" : null;
    case 'nestcore_delete_project':
      return a.confirmDeletion === true
        ? `permanently delete project ${str(a.projectId)} and ALL of its data, users, files and branches`
        : null;
    default:
      return null;
  }
}

/** Every tool {@link userConfirmationFor} can gate (for docs/tests). */
export const USER_CONFIRMATION_TOOLS: readonly string[] = [
  'nestcore_buy_credits',
  'nestcore_set_credit_cap',
  'nestcore_set_auth_security',
  'nestcore_reset_branch',
  'nestcore_promote_branch',
  'nestcore_create_admin',
  'nestcore_update_admin',
  'nestcore_delete_admin',
  'nestcore_disable_rls',
  'nestcore_get_connection_string',
  'nestcore_delete_project',
];

export function clientSupportsElicitation(server: McpServer): boolean {
  try {
    return !!server.server.getClientCapabilities()?.elicitation;
  } catch {
    return false;
  }
}

/**
 * Ask the human (via MCP elicitation) to allow an operation. Resolves true only
 * on an explicit accept with the box ticked; false on decline, cancel, an
 * unticked box, or a failed request.
 */
export async function askUserToConfirm(
  server: McpServer,
  message: string,
  title: string,
  wrap: <T>(p: Promise<T>) => Promise<T> = (p) => p,
): Promise<boolean> {
  try {
    const result = await wrap(
      server.server.elicitInput({
        message,
        requestedSchema: {
          type: 'object',
          properties: { confirm: { type: 'boolean', title, description: message } },
          required: ['confirm'],
        },
      }),
    );
    return result.action === 'accept' && result.content?.confirm === true;
  } catch {
    return false;
  }
}
