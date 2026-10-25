import type { McpSession, DatabaseSchema, ProjectMetadata } from '../types/session.types.js';
import type { AppConfig } from '../types/config.types.js';
import { loadCredentials, saveCredentials, withCredentialsLock } from './credentials.service.js';
import type { StoredCredentials } from '../types/session.types.js';
import { needsRefresh, getTokenExpiry, decodeTokenPayload } from './token.service.js';
import { NestCoreClient } from '../sdk/nestcore.client.js';
import { AuthenticationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export class SessionService {
  private session: McpSession;
  private config: AppConfig;
  private apiClient: NestCoreClient;

  constructor(config: AppConfig, apiClient: NestCoreClient) {
    this.config = config;
    this.apiClient = apiClient;
    this.session = {
      userId: null,
      email: null,
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
      currentProjectId: config.defaultProjectId,
      currentProjectSlug: null,
      schemaSnapshot: null,
      projectMetadata: null,
      apiUrl: config.apiUrl,
      safetyEnabled: config.enableSqlGuard,
    };
  }

  async initialize(): Promise<void> {
    const credentials = loadCredentials();
    if (!credentials || !credentials.access_token) {
      logger.info('No stored credentials found. Sign in required.');
      return;
    }

    this.session.accessToken = credentials.access_token;
    this.session.refreshToken = credentials.refresh_token ?? null;
    this.session.tokenExpiresAt = credentials.expires_at
      ? new Date(credentials.expires_at)
      : getTokenExpiry(credentials.access_token);

    // Older / partial credential files may not carry a `user` object. Falling
    // back to the JWT payload here keeps a legacy file from crashing the whole
    // server on startup — which previously dropped every tool from the client.
    let userId = credentials.user?.id ?? null;
    let email = credentials.user?.email ?? null;
    if (!userId || !email) {
      const payload = decodeTokenPayload(credentials.access_token);
      userId = userId ?? ((payload?.sub as string | undefined) ?? null);
      email = email ?? ((payload?.email as string | undefined) ?? null);
    }
    this.session.userId = userId;
    this.session.email = email;

    this.apiClient.setAccessToken(credentials.access_token);
    logger.info('Session initialized from stored credentials', { email: email ?? '(unknown)' });
  }

  getSession(): McpSession {
    return this.session;
  }

  isAuthenticated(): boolean {
    if (!this.session.accessToken) return false;
    if (this.session.tokenExpiresAt && Date.now() >= this.session.tokenExpiresAt.getTime()) return false;
    return true;
  }

  async ensureAuthenticated(): Promise<void> {
    if (!this.session.accessToken) {
      throw new AuthenticationError();
    }

    if (this.session.accessToken && needsRefresh(this.session.accessToken, this.config.tokenRefreshThreshold)) {
      await this.refreshAccessToken();
    }
  }

  async refreshAccessToken(): Promise<void> {
    if (!this.session.refreshToken) {
      throw new AuthenticationError('No refresh token available. Please sign in again.');
    }

    try {
      // CRITICAL: the server ROTATES refresh tokens and, when a consumed one is
      // replayed, revokes EVERY session of the admin (console, CLI, all MCPs).
      // Another process (a second MCP server, the CLI) shares this credentials
      // file, so rotate only while holding the shared lock, and first re-read
      // the file: if someone else already rotated, adopt their tokens instead
      // of replaying our now-consumed one.
      await withCredentialsLock(async () => {
        const disk = loadCredentials();
        if (disk?.access_token && disk.refresh_token && disk.refresh_token !== this.session.refreshToken) {
          this.adoptCredentials(disk);
          if (!needsRefresh(disk.access_token, this.config.tokenRefreshThreshold)) {
            logger.info('Adopted access token rotated by another NestCore client');
            return;
          }
        }

        logger.info('Refreshing access token...');
        const result = await this.apiClient.refreshToken(this.session.refreshToken!);
        const accessToken = result.access_token as string;
        const expiresIn = result.expires_in as number;
        // Fall back to the existing token only if the server didn't return one.
        const newRefreshToken = (result.refresh_token as string | undefined) ?? this.session.refreshToken!;

        this.session.accessToken = accessToken;
        this.session.refreshToken = newRefreshToken;
        this.session.tokenExpiresAt = expiresIn
          ? new Date(Date.now() + expiresIn * 1000)
          : getTokenExpiry(accessToken) ?? new Date(Date.now() + 15 * 60 * 1000);
        this.apiClient.setAccessToken(accessToken);

        saveCredentials({
          access_token: accessToken,
          refresh_token: newRefreshToken,
          expires_at: this.session.tokenExpiresAt.toISOString(),
          user: { id: this.session.userId!, email: this.session.email! },
        });
        logger.info('Access token refreshed successfully');
      });
    } catch (err) {
      logger.error('Token refresh failed', { error: String(err) });
      throw new AuthenticationError('Token refresh failed. Please sign in again.');
    }
  }

  private adoptCredentials(c: StoredCredentials): void {
    this.session.accessToken = c.access_token;
    this.session.refreshToken = c.refresh_token;
    this.session.tokenExpiresAt = c.expires_at ? new Date(c.expires_at) : getTokenExpiry(c.access_token);
    this.apiClient.setAccessToken(c.access_token);
  }

  setAuthFromSignin(data: Record<string, unknown>): void {
    // HIGH-03: never embed `data` in error messages — it may contain token
    // material that would then surface in the model's context via
    // formatErrorResponse.
    if (!data.access_token || !data.refresh_token) {
      throw new Error('Invalid signin response: missing access/refresh tokens.');
    }
    
    const accessToken = data.access_token as string;
    const refreshToken = data.refresh_token as string;
    
    // Extract user info from response or JWT token
    let userId: string;
    let email: string;
    
    const user = data.user as Record<string, string> | undefined;
    if (user?.id && user?.email) {
      userId = user.id;
      email = user.email;
    } else {
      // Extract from JWT payload
      const payload = decodeTokenPayload(accessToken);
      if (!payload || !payload.sub || !payload.email) {
        throw new Error('Invalid signin response: cannot extract user info from token.');
      }
      userId = payload.sub as string;
      email = payload.email as string;
    }
    
    this.session.accessToken = accessToken;
    this.session.refreshToken = refreshToken;
    this.session.userId = userId;
    this.session.email = email;

    const expiresIn = data.expires_in as number;
    this.session.tokenExpiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000)
      : getTokenExpiry(this.session.accessToken) ?? new Date(Date.now() + 15 * 60 * 1000);

    this.apiClient.setAccessToken(this.session.accessToken);

    saveCredentials({
      apiUrl: this.config.apiUrl,
      access_token: this.session.accessToken,
      refresh_token: this.session.refreshToken,
      expires_at: this.session.tokenExpiresAt.toISOString(),
      user: { id: this.session.userId, email: this.session.email },
    });
  }

  setActiveProject(project: ProjectMetadata): void {
    this.session.currentProjectId = project.id;
    this.session.currentProjectSlug = project.slug;
    this.session.projectMetadata = project;
  }

  setSchemaSnapshot(schema: DatabaseSchema): void {
    this.session.schemaSnapshot = schema;
  }

  clearSession(): void {
    this.session.accessToken = null;
    this.session.refreshToken = null;
    this.session.tokenExpiresAt = null;
    this.session.userId = null;
    this.session.email = null;
    this.session.currentProjectId = null;
    this.session.currentProjectSlug = null;
    this.session.schemaSnapshot = null;
    this.session.projectMetadata = null;
  }
}
