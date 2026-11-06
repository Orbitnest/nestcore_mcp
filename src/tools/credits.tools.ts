import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './index.js';
import { formatErrorResponse } from '../utils/errors.js';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });

/**
 * Workspace AI credit (prepaid). A project's own provider key always wins; without one,
 * the workspace's credit pays for AI calls at the platform's key plus the margin.
 * Credit is per workspace, shared by all its projects.
 */
export function registerCreditTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool('nestcore_get_credits', {
    description:
      "The workspace's AI credit: balance (USD), monthly cap (null = none), this month's spend, available (credit can pay for a call now), " +
      'active (credit was ever bought; a workspace that never bought credit is never charged), margin %, the credit packs for sale and the recent ledger. ' +
      "Credit only pays for AI calls of projects without their own provider key.",
    inputSchema: {},
  }, async () => {
    try {
      await ctx.session.ensureAuthenticated();
      return json(await ctx.apiClient.getCredits());
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  server.registerTool('nestcore_set_credit_cap', {
    description:
      "Set the workspace's monthly cap on AI credit spend in USD (0 to 100000), or pass null to remove the cap. " +
      'Calls paid from credit fail with CREDITS_EXHAUSTED (reason spend_cap) once the month reaches it. Needs the workspace admin role. Returns the new summary.',
    inputSchema: {
      monthlyCapUsd: z.number().min(0).max(100_000).nullable().describe('USD per month, or null for no cap'),
    },
  }, async ({ monthlyCapUsd }) => {
    try {
      await ctx.session.ensureAuthenticated();
      return json(await ctx.apiClient.setCreditCap(monthlyCapUsd));
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  server.registerTool('nestcore_buy_credits', {
    description:
      'Create a Stripe Checkout link for an AI credit pack (one-time payment) for a HUMAN to open and pay in a browser. ' +
      'This does NOT charge anything or add credit by itself: the credit lands only after the person pays and Stripe confirms. ' +
      'Never tell the user the purchase is done; give them the URL and check nestcore_get_credits afterwards. ' +
      'Pack ids come from nestcore_get_credits (e.g. credits_5, credits_10, credits_25). Needs the workspace admin role.',
    inputSchema: {
      pack: z.string().regex(/^[a-z0-9_-]{1,40}$/).describe('Credit pack id from nestcore_get_credits'),
    },
  }, async ({ pack }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const res = await ctx.apiClient.createCreditCheckout(pack, 'mcp');
      return json({
        checkoutUrl: res.url,
        pack: res.pack,
        paid: false,
        next: 'Give this URL to the user to open and pay in a browser. No credit is added until the payment completes; nestcore_get_credits shows the new balance then.',
      });
    } catch (error) {
      return formatErrorResponse(error);
    }
  });
}
