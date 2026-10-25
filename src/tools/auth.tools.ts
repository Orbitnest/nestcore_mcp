import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './index.js';
import { formatErrorResponse } from '../utils/errors.js';
import { clearCredentials } from '../auth/credentials.service.js';
import { loginWithOAuth } from '../auth/oauth-login.js';

export function registerAuthTools(server: McpServer, ctx: ToolContext): void {

  // ─── Admin Sign In ───
  server.registerTool('nestcore_admin_signin', {
    description:
      'Sign in as an NestCore admin user. Returns JWT tokens and saves credentials for subsequent requests. ' +
      'If the account has two-factor (TOTP) enabled, call again with the same email/password plus `mfa_code` ' +
      'set to a 6-digit authenticator code (or a recovery code).',
    inputSchema: {
      email: z.string().email(),
      password: z.string().min(1),
      mfa_code: z.string().optional().describe('6-digit authenticator code or a recovery code (only if 2FA is enabled)'),
    },
  }, async ({ email, password, mfa_code }) => {
    try {
      const result = await ctx.apiClient.signin(email, password, mfa_code);
      // MFA enabled but no code supplied — ask for one rather than failing.
      if (result?.mfa_required && !result.access_token) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            success: false,
            mfa_required: true,
            message: 'This account has two-factor authentication enabled. Call nestcore_admin_signin again with the same email and password, plus mfa_code set to your 6-digit authenticator code (or a recovery code).',
          }, null, 2) }],
        };
      }
      ctx.session.setAuthFromSignin(result);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          message: 'Successfully signed in',
        }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Admin Sign In via OAuth (Google / GitHub / Apple) ───
  // For admins who signed up with a provider and have no password. Opens the
  // browser to the existing OAuth flow and captures tokens via a one-time
  // localhost loopback server. See ../auth/oauth-login.ts.
  server.registerTool('nestcore_login', {
    description:
      'Sign in as an NestCore admin using Google, GitHub, or Apple. Opens your browser to complete sign-in, then captures the session automatically. Use this if you signed up with a social provider (no password). For password accounts use nestcore_admin_signin.',
    inputSchema: { provider: z.enum(['google', 'github', 'apple']).default('google') },
  }, async ({ provider }) => {
    try {
      const result = await loginWithOAuth(provider, ctx.config);
      ctx.session.setAuthFromSignin(result as unknown as Record<string, unknown>);
      const { email } = ctx.session.getSession();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          message: `Successfully signed in with ${provider}`,
          email,
        }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Admin Sign Up (direct) ───
  server.registerTool('nestcore_admin_signup', {
    description: 'Create a new NestCore admin account directly. Password: 8+ chars with upper, lower, digit and one of @$!%*?&.',
    inputSchema: { email: z.string().email(), password: z.string().min(8), fullName: z.string().min(1).max(100) },
  }, async ({ email, password, fullName }) => {
    try {
      const result = await ctx.apiClient.signup(email, password, fullName);
      ctx.session.setAuthFromSignin(result);
      // HIGH-03: never echo the raw signin response — it carries the access +
      // long-lived refresh token, which would land in the model's context /
      // transcript and could be replayed for admin access. The tokens are
      // already applied to the local session above; return only safe fields.
      const { email: sessionEmail } = ctx.session.getSession();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          message: 'Admin account created successfully',
          email: sessionEmail,
        }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Admin Sign Up (with verification) ───
  server.registerTool('nestcore_admin_signup_verified', {
    description: 'Complete admin signup with the 4-digit email verification code. First call nestcore_request_verification (same email, password and fullName) to get the code.',
    inputSchema: {
      email: z.string().email(),
      password: z.string().min(8),
      fullName: z.string().min(1).max(100),
      verificationCode: z.string().regex(/^\d{4}$/, 'The verification code is 4 digits'),
    },
  }, async ({ email, password, fullName, verificationCode }) => {
    try {
      const result = await ctx.apiClient.signupWithVerification(email, password, fullName, verificationCode);
      ctx.session.setAuthFromSignin(result);
      // HIGH-03: strip tokens from the tool output (see nestcore_admin_signup).
      const { email: sessionEmail } = ctx.session.getSession();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          message: 'Admin account created and verified successfully',
          email: sessionEmail,
        }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Request Verification Code ───
  server.registerTool('nestcore_request_verification', {
    description: 'Request an email verification code for admin signup. Password: 8+ chars with upper, lower, digit and one of @$!%*?&.',
    inputSchema: { email: z.string().email(), password: z.string().min(8), fullName: z.string().min(1).max(100) },
  }, async ({ email, password, fullName }) => {
    try {
      const result = await ctx.apiClient.requestVerification(email, password, fullName);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          message: 'Verification code sent to email',
          data: result,
        }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Refresh Token ───
  server.registerTool('nestcore_refresh_token', {
    description: 'Refresh expired JWT access token using stored refresh token.',
    inputSchema: {},
  }, async () => {
    try {
      await ctx.session.refreshAccessToken();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          message: 'Access token refreshed successfully',
        }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Sign Out ───
  server.registerTool('nestcore_admin_signout', {
    description: 'Sign out the current admin user and clear stored credentials.',
    inputSchema: {},
  }, async () => {
    // Revoke the server session best-effort, but ALWAYS clear local state — an
    // expired refresh token must not make signing out impossible.
    let revoked = false;
    try {
      await ctx.session.ensureAuthenticated();
      const refreshToken = ctx.session.getSession().refreshToken;
      if (refreshToken) {
        await ctx.apiClient.signout(refreshToken);
        revoked = true;
      }
    } catch {
      /* fall through to local cleanup */
    }
    ctx.session.clearSession();
    clearCredentials();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({
        success: true,
        message: revoked
          ? 'Signed out successfully'
          : 'Local credentials cleared. The server session could not be revoked (it was already invalid or expires on its own).',
      }, null, 2) }],
    };
  });

  // ─── Get Profile ───
  server.registerTool('nestcore_get_profile', {
    description: 'Get the current admin user profile.',
    inputSchema: {},
  }, async () => {
    try {
      await ctx.session.ensureAuthenticated();
      const result = await ctx.apiClient.getProfile();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });
}
