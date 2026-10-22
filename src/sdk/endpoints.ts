// MEDIUM-02: URL-encode every interpolated path segment so a tool input
// containing "/", "..", "?", or "#" (e.g. filePath = "../../admin/admins/<id>")
// can't reshape the request path, smuggle query params, or escape the project
// scope under the admin bearer token. This file only builds paths (query
// strings are assembled separately via URLSearchParams), so encoding all
// segments is correct.
const e = (v: string | number): string => encodeURIComponent(String(v));

// Encode a multi-segment file path: preserve legitimate "/" separators (nested
// folders) but reject any "." / ".." traversal segment and percent-encode the
// rest, so a value like "../../admin" can't climb out of the bucket scope.
const ep = (p: string): string =>
  String(p)
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.' && seg !== '..')
    .map((seg) => encodeURIComponent(seg))
    .join('/');

// Authentication
export const AUTH = {
  SIGNIN: '/auth/signin',
  SIGNIN_MFA: '/auth/signin/mfa',
  SIGNUP: '/auth/signup',
  SIGNUP_WITH_VERIFICATION: '/auth/signup-with-verification',
  REQUEST_VERIFICATION: '/auth/request-verification',
  REFRESH: '/auth/refresh',
  SIGNOUT: '/auth/signout',
  PROFILE: '/auth/profile',
  RESET_PASSWORD_REQUEST: '/auth/reset-password-request',
  RESET_PASSWORD: '/auth/reset-password',
  CHANGE_PASSWORD: '/auth/change-password',
} as const;

// Admin Management
export const ADMIN = {
  LIST: '/admin/admins',
  // There is no direct "create admin with password" endpoint by design — new
  // admins are added via an email invitation (which they accept to set their
  // own password). createAdmin() posts here. (Requires SMTP configured.)
  INVITE: '/admin/invitations',
  GET: (id: string) => `/admin/admins/${e(id)}`,
  UPDATE: (id: string) => `/admin/admins/${e(id)}`,
  DELETE: (id: string) => `/admin/admins/${e(id)}`,
  UPDATE_PASSWORD: (id: string) => `/admin/admins/${e(id)}/password`,
  SET_ACTIVE: (id: string) => `/admin/admins/${e(id)}/active`,
  API_KEYS_CREATE: '/admin/api-keys',
  API_KEYS_LIST: '/admin/api-keys',
  API_KEYS_DELETE: (id: string) => `/admin/api-keys/${e(id)}`,
  // Admin panel
  PROJECTS: '/admin/projects',
  PROJECT_OVERVIEW: (id: string) => `/admin/projects/${e(id)}/overview`,
  PROJECT_ACTIVITY: (id: string) => `/admin/projects/${e(id)}/activity/recent`,
  PROJECT_AUTH_ACTIVITY: (id: string) => `/admin/projects/${e(id)}/activity/auth`,
} as const;

// Admin Storage (uses projectId, not slug)
export const ADMIN_STORAGE = {
  LIST_BUCKETS: (id: string) => `/admin/projects/${e(id)}/storage/buckets`,
  CREATE_BUCKET: (id: string) => `/admin/projects/${e(id)}/storage/buckets`,
  LIST_FILES: (id: string, bucket: string) => `/admin/projects/${e(id)}/storage/buckets/${e(bucket)}/files`,
  DELETE_FILES: (id: string, bucket: string) => `/admin/projects/${e(id)}/storage/buckets/${e(bucket)}/files`,
  UPLOAD: (id: string, bucket: string) => `/admin/projects/${e(id)}/storage/buckets/${e(bucket)}/upload`,
  UPLOAD_MULTIPLE: (id: string, bucket: string) => `/admin/projects/${e(id)}/storage/buckets/${e(bucket)}/upload-multiple`,
  BUCKET_SIZE: (id: string, bucket: string) => `/admin/projects/${e(id)}/storage/buckets/${e(bucket)}/size`,
  DELETE_BUCKET: (id: string, bucket: string) => `/admin/projects/${e(id)}/storage/buckets/${e(bucket)}`,
} as const;

// Admin integrations (webhooks, SMS/Twilio config, direct connection string)
export const ADMIN_INTEGRATIONS = {
  CONNECTION: (id: string) => `/admin/projects/${e(id)}/connection`,
  WEBHOOKS: (id: string) => `/admin/projects/${e(id)}/webhooks`,
  WEBHOOK: (id: string, wid: string) => `/admin/projects/${e(id)}/webhooks/${e(wid)}`,
  WEBHOOK_TEST: (id: string, wid: string) => `/admin/projects/${e(id)}/webhooks/${e(wid)}/test`,
  SMS_CONFIG: (id: string) => `/admin/projects/${e(id)}/sms-config`,
  SMS_TEST: (id: string) => `/admin/projects/${e(id)}/sms-config/test`,
  AUTH_SETTINGS: (id: string) => `/projects/${e(id)}/auth-settings`,
  AI_PROVIDERS: (id: string) => `/projects/${e(id)}/ai/providers`,
  AI_CAPS: (id: string) => `/projects/${e(id)}/ai/caps`,
  AI_USAGE: (id: string, days: number) => `/projects/${e(id)}/ai/usage?days=${days}`,
} as const;

// Projects
export const PROJECTS = {
  CREATE: '/projects',
  LIST: '/projects',
  GET: (id: string) => `/projects/${e(id)}`,
  UPDATE: (id: string) => `/projects/${e(id)}`,
  DELETE: (id: string) => `/projects/${e(id)}`,
  STATS: (id: string) => `/projects/${e(id)}/stats`,
  HEALTH: (id: string) => `/projects/${e(id)}/health`,
  DEBUG_MODE: (id: string) => `/projects/${e(id)}/debug-mode`,
  DECRYPTION_KEY: '/projects/decryption-key',
  API_KEYS_CREATE: (id: string) => `/projects/${e(id)}/api-keys`,
  API_KEYS_LIST: (id: string) => `/projects/${e(id)}/api-keys`,
  API_KEYS_DELETE: (id: string, keyId: string) => `/projects/${e(id)}/api-keys/${e(keyId)}`,
  ENV_VARS: (id: string) => `/projects/${e(id)}/environment-variables`,
  ENV_VAR: (id: string, name: string) => `/projects/${e(id)}/environment-variables/${e(name)}`,
  ENV_VARS_BULK: (id: string) => `/projects/${e(id)}/environment-variables/bulk`,
  SMTP: (id: string) => `/projects/${e(id)}/smtp`,
  SMTP_TEST: (id: string) => `/projects/${e(id)}/smtp/test`,
} as const;

// Database
export const DATABASE = {
  SQL: (id: string) => `/projects/${e(id)}/database/sql`,
  SQL_HISTORY: (id: string) => `/projects/${e(id)}/database/sql/history`,
  SQL_HISTORY_ITEM: (id: string, historyId: string) => `/projects/${e(id)}/database/sql/history/${e(historyId)}`,
  SQL_HISTORY_FAVORITE: (id: string, historyId: string) => `/projects/${e(id)}/database/sql/history/${e(historyId)}/favorite`,
  SQL_HISTORY_NAME: (id: string, historyId: string) => `/projects/${e(id)}/database/sql/history/${e(historyId)}/name`,
  TABLES: (id: string) => `/projects/${e(id)}/database/tables`,
  TABLES_LIST: (id: string) => `/projects/${e(id)}/database/tables/list`,
  TABLE_DELETE: (id: string, table: string) => `/projects/${e(id)}/database/tables/${e(table)}`,
  TABLE_DATA: (id: string, table: string) => `/projects/${e(id)}/database/tables/${e(table)}/data`,
  INSERT_ROW: (id: string, table: string) => `/projects/${e(id)}/database/tables/${e(table)}/rows`,
  UPDATE_ROW: (id: string, table: string, rowId: string) => `/projects/${e(id)}/database/tables/${e(table)}/rows/${e(rowId)}`,
  DELETE_ROW: (id: string, table: string, rowId: string) => `/projects/${e(id)}/database/tables/${e(table)}/rows/${e(rowId)}`,
  BULK_INSERT: (id: string, table: string) => `/projects/${e(id)}/database/tables/${e(table)}/bulk-insert`,
  BULK_UPDATE: (id: string, table: string) => `/projects/${e(id)}/database/tables/${e(table)}/bulk-update`,
  BULK_DELETE: (id: string, table: string) => `/projects/${e(id)}/database/tables/${e(table)}/bulk-delete`,
} as const;

// RLS (nested under /database/tables/{tableName})
export const RLS = {
  GET_STATUS: (id: string, table: string) => `/projects/${e(id)}/database/rls/${e(table)}`,
  ENABLE: (id: string, table: string) => `/projects/${e(id)}/database/tables/${e(table)}/rls/enable`,
  DISABLE: (id: string, table: string) => `/projects/${e(id)}/database/tables/${e(table)}/rls/disable`,
  POLICIES: (id: string, table: string) => `/projects/${e(id)}/database/tables/${e(table)}/policies`,
  DELETE_POLICY: (id: string, table: string, policy: string) => `/projects/${e(id)}/database/tables/${e(table)}/policies/${e(policy)}`,
} as const;

// Edge Functions
export const FUNCTIONS = {
  CREATE: (id: string) => `/projects/${e(id)}/functions`,
  LIST: (id: string) => `/projects/${e(id)}/functions`,
  GET: (id: string, name: string) => `/projects/${e(id)}/functions/${e(name)}`,
  UPDATE: (id: string, name: string) => `/projects/${e(id)}/functions/${e(name)}`,
  DELETE: (id: string, name: string) => `/projects/${e(id)}/functions/${e(name)}`,
  INVOKE: (id: string, name: string) => `/projects/${e(id)}/functions/${e(name)}/invoke`,
  LOGS: (id: string, name: string) => `/projects/${e(id)}/functions/${e(name)}/logs`,
} as const;

// Background Jobs
export const JOBS = {
  CREATE: (id: string) => `/projects/${e(id)}/jobs`,
  LIST: (id: string) => `/projects/${e(id)}/jobs`,
  GET: (id: string, name: string) => `/projects/${e(id)}/jobs/${e(name)}`,
  UPDATE: (id: string, name: string) => `/projects/${e(id)}/jobs/${e(name)}`,
  DELETE: (id: string, name: string) => `/projects/${e(id)}/jobs/${e(name)}`,
  TRIGGER: (id: string, name: string) => `/projects/${e(id)}/jobs/${e(name)}/trigger`,
  RUNS: (id: string, name: string) => `/projects/${e(id)}/jobs/${e(name)}/runs`,
} as const;

// Storage (project slug-based, for API key auth)
export const STORAGE = {
  LIST_BUCKETS: (slug: string) => `/projects/${e(slug)}/storage`,
  CREATE_BUCKET: (slug: string, bucket: string) => `/projects/${e(slug)}/storage/${e(bucket)}/create`,
  DELETE_BUCKET: (slug: string, bucket: string) => `/projects/${e(slug)}/storage/${e(bucket)}/delete`,
  LIST_FILES: (slug: string, bucket: string) => `/projects/${e(slug)}/storage/${e(bucket)}/files`,
  UPLOAD: (slug: string, bucket: string) => `/projects/${e(slug)}/storage/${e(bucket)}/upload`,
  UPLOAD_MULTIPLE: (slug: string, bucket: string) => `/projects/${e(slug)}/storage/${e(bucket)}/upload-multiple`,
  DOWNLOAD: (slug: string, bucket: string, path: string) => `/projects/${e(slug)}/storage/${e(bucket)}/download/${ep(path)}`,
  DELETE_FILES: (slug: string, bucket: string) => `/projects/${e(slug)}/storage/${e(bucket)}`,
  PUBLIC_URL: (slug: string, bucket: string, path: string) => `/projects/${e(slug)}/storage/${e(bucket)}/public-url/${ep(path)}`,
  BUCKET_SIZE: (slug: string, bucket: string) => `/projects/${e(slug)}/storage/${e(bucket)}/size`,
} as const;

// Logging
export const LOGS = {
  ALL: (id: string) => `/projects/${e(id)}/logs`,
  STATS: (id: string) => `/projects/${e(id)}/logs/stats`,
  DATABASE: (id: string) => `/projects/${e(id)}/logs/database`,
  DATABASE_SLOW: (id: string) => `/projects/${e(id)}/logs/database/slow`,
  DATABASE_ERRORS: (id: string) => `/projects/${e(id)}/logs/database/errors`,
  AUTH: (id: string) => `/projects/${e(id)}/logs/auth`,
  AUTH_FAILURES: (id: string) => `/projects/${e(id)}/logs/auth/failures`,
  AUTH_SECURITY: (id: string) => `/projects/${e(id)}/logs/auth/security`,
  EDGE_FUNCTIONS: (id: string) => `/projects/${e(id)}/logs/edge-functions`,
  FUNCTION_CONSOLE: (id: string, name: string) => `/projects/${e(id)}/logs/edge-functions/${e(name)}/console`,
  FUNCTION_ERRORS: (id: string, name: string) => `/projects/${e(id)}/logs/edge-functions/${e(name)}/errors`,
  EXPORT: (id: string) => `/projects/${e(id)}/logs/export`,
} as const;

// Dashboard
export const DASHBOARD = {
  STATS: '/dashboard/stats',
  ACTIVITY: '/dashboard/activity',
} as const;

// Realtime (admin-scoped; uses JWT auth + project UUID)
export const REALTIME = {
  TABLES: (id: string) => `/admin/projects/${e(id)}/realtime/tables`,
  DISABLE_TABLE: (id: string, schema: string, table: string) =>
    `/admin/projects/${e(id)}/realtime/tables/${e(schema)}/${e(table)}`,
  BROADCAST: (id: string) => `/admin/projects/${e(id)}/realtime/broadcast`,
} as const;

// Analytics
export const ANALYTICS = {
  INGEST: '/analytics/events',
  SDK_CONFIG: (id: string) => `/analytics/projects/${e(id)}/sdk-config`,
  OVERVIEW: (id: string) => `/analytics/projects/${e(id)}/overview`,
  EVENTS_TIMESERIES: (id: string) => `/analytics/projects/${e(id)}/events/timeseries`,
  EVENTS_TOP: (id: string) => `/analytics/projects/${e(id)}/events/top`,
  SCREENS_TOP: (id: string) => `/analytics/projects/${e(id)}/screens/top`,
  RETENTION: (id: string) => `/analytics/projects/${e(id)}/retention`,
  FUNNEL: (id: string) => `/analytics/projects/${e(id)}/funnel`,
  PERFORMANCE: (id: string) => `/analytics/projects/${e(id)}/performance`,
  CRASHES: (id: string) => `/analytics/projects/${e(id)}/crashes`,
  TOKENS: (id: string) => `/analytics/projects/${e(id)}/tokens`,
  TOKEN: (id: string, tokenId: string) => `/analytics/projects/${e(id)}/tokens/${e(tokenId)}`,
} as const;

// Project Intelligence
export const INTELLIGENCE = {
  CONTEXT:       (p: string) => `/projects/${e(p)}/intelligence/context`,
  CHANGES:       (p: string) => `/projects/${e(p)}/intelligence/changes`,
  TASKS:         (p: string) => `/projects/${e(p)}/intelligence/tasks`,
  DECISIONS:     (p: string) => `/projects/${e(p)}/intelligence/decisions`,
  COMPLETE_TASK: (p: string, t: string) => `/projects/${e(p)}/intelligence/tasks/${e(t)}/complete`,
  FEATURES:      (p: string) => `/projects/${e(p)}/intelligence/features`,
  FEATURE:       (p: string, f: string) => `/projects/${e(p)}/intelligence/features/${e(f)}`,
  EVENTS:        (p: string) => `/projects/${e(p)}/intelligence/events`,
  SEARCH:        (p: string) => `/projects/${e(p)}/intelligence/search`,
  PROFILE:       (p: string) => `/projects/${e(p)}/intelligence/profile`,
} as const;
