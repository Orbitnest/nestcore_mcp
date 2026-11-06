export class McpError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'McpError';
    this.code = code;
  }
}

export class AuthenticationError extends McpError {
  constructor(message: string = 'Not authenticated. Please sign in first using nestcore_admin_signin.') {
    super(message, 'AUTH_ERROR');
    this.name = 'AuthenticationError';
  }
}

export class ValidationError extends McpError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

export class SafetyError extends McpError {
  public readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, 'SAFETY_ERROR');
    this.name = 'SafetyError';
    this.details = details;
  }
}

export class ApiError extends McpError {
  public readonly statusCode: number;
  /** The API's error body (QUOTA_EXCEEDED carries quota/plan/limit/usage/kind/reason/upgradeUrl). */
  public readonly details?: Record<string, unknown>;

  /**
   * `apiCode` is the platform's own code when it sent one, e.g. QUOTA_EXCEEDED,
   * AGENT_PROJECT_RESTRICTED, NOT_AN_AGENT_PROJECT or PROJECT_PAUSED.
   */
  constructor(message: string, statusCode: number, apiCode?: string, details?: Record<string, unknown>) {
    super(message, apiCode ?? 'API_ERROR');
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

/** Fields of an API error body worth handing to the model (never the raw body). */
const API_DETAIL_FIELDS = ['quota', 'plan', 'limit', 'usage', 'kind', 'reason', 'upgradeUrl', 'status'] as const;

export class ProjectContextError extends McpError {
  constructor(message: string = 'No active project. Use nestcore_set_active_project first or provide projectId.') {
    super(message, 'PROJECT_CONTEXT_ERROR');
    this.name = 'ProjectContextError';
  }
}

export function formatErrorResponse(error: unknown): { content: Array<{ type: 'text'; text: string }> } {
  if (error instanceof SafetyError) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: error.message,
          code: error.code,
          details: error.details,
        }, null, 2),
      }],
    };
  }

  if (error instanceof ApiError) {
    const details: Record<string, unknown> = {};
    for (const k of API_DETAIL_FIELDS) if (error.details?.[k] !== undefined) details[k] = error.details[k];
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: error.message,
          code: error.code,
          statusCode: error.statusCode,
          ...(Object.keys(details).length ? { details } : {}),
        }, null, 2),
      }],
    };
  }

  if (error instanceof McpError) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: error.message,
          code: error.code,
        }, null, 2),
      }],
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ error: message, code: 'UNKNOWN_ERROR' }, null, 2),
    }],
  };
}
