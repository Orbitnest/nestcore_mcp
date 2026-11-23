/**
 * The single, explicit table that maps every registered `nestcore_*` tool to
 *   - its Code Mode path (`<namespace>.<method>`), and
 *   - its safety class.
 *
 * Classes:
 *   read        — no side effects on the platform.
 *   write       — creates or changes something; recoverable.
 *   destructive — deletes data, rotates credentials, changes billing, or runs
 *                 DDL that cannot be undone.
 *   session     — changes this MCP session's sign-in / active project.
 *
 * `nestcore_execute_sql` is listed as `write` here but is classified per call
 * from its SQL (see {@link classifyCall}).
 *
 * test/code-mode-unit.mjs asserts that every registered tool is in this table
 * exactly once and that no two tools share a path.
 */
export type ToolClass = 'read' | 'write' | 'destructive' | 'session';

export interface CatalogEntry {
  ns: string;
  method: string;
  cls: ToolClass;
}

type Row = [ns: string, method: string, cls: ToolClass];

const ROWS: Record<string, Row> = {
  // ── auth ──────────────────────────────────────────────────────────────────
  nestcore_admin_signin: ['auth', 'signin', 'session'],
  nestcore_login: ['auth', 'login', 'session'],
  nestcore_admin_signup: ['auth', 'signup', 'session'],
  nestcore_admin_signup_verified: ['auth', 'signupVerified', 'session'],
  nestcore_request_verification: ['auth', 'requestVerification', 'session'],
  nestcore_refresh_token: ['auth', 'refreshToken', 'session'],
  nestcore_admin_signout: ['auth', 'signout', 'session'],
  nestcore_get_profile: ['auth', 'getProfile', 'read'],

  // ── projects ──────────────────────────────────────────────────────────────
  nestcore_create_project: ['projects', 'create', 'write'],
  nestcore_get_project_eligibility: ['projects', 'getEligibility', 'read'],
  nestcore_list_projects: ['projects', 'list', 'read'],
  nestcore_set_project_status: ['projects', 'setStatus', 'destructive'],
  nestcore_get_project: ['projects', 'get', 'read'],
  nestcore_update_project: ['projects', 'update', 'write'],
  nestcore_delete_project: ['projects', 'delete', 'destructive'],
  nestcore_set_active_project: ['projects', 'setActive', 'session'],
  nestcore_toggle_debug_mode: ['projects', 'toggleDebugMode', 'write'],
  nestcore_create_api_keys: ['projects', 'createApiKeys', 'destructive'],
  nestcore_get_api_keys: ['projects', 'getApiKeys', 'read'],
  nestcore_get_project_health: ['projects', 'getHealth', 'read'],

  // ── db ────────────────────────────────────────────────────────────────────
  nestcore_get_schema: ['db', 'getSchema', 'read'],
  nestcore_execute_sql: ['db', 'executeSql', 'write'],
  nestcore_create_table: ['db', 'createTable', 'write'],
  nestcore_get_table_data: ['db', 'getTableData', 'read'],
  nestcore_insert_row: ['db', 'insertRow', 'write'],
  nestcore_update_row: ['db', 'updateRow', 'write'],
  nestcore_delete_row: ['db', 'deleteRow', 'destructive'],
  nestcore_bulk_insert: ['db', 'bulkInsert', 'write'],
  nestcore_bulk_update: ['db', 'bulkUpdate', 'write'],
  nestcore_bulk_delete: ['db', 'bulkDelete', 'destructive'],
  nestcore_get_connection_string: ['db', 'getConnectionString', 'read'],
  nestcore_enable_extension: ['db', 'enableExtension', 'write'],

  // ── rls ───────────────────────────────────────────────────────────────────
  nestcore_get_rls_status: ['rls', 'getStatus', 'read'],
  nestcore_enable_rls: ['rls', 'enable', 'write'],
  nestcore_disable_rls: ['rls', 'disable', 'destructive'],
  nestcore_list_policies: ['rls', 'listPolicies', 'read'],
  nestcore_create_policy: ['rls', 'createPolicy', 'write'],
  nestcore_delete_policy: ['rls', 'deletePolicy', 'destructive'],

  // ── functions (edge functions + their env variables) ─────────────────────
  nestcore_create_function: ['functions', 'create', 'write'],
  nestcore_list_functions: ['functions', 'list', 'read'],
  nestcore_get_function: ['functions', 'get', 'read'],
  nestcore_update_function: ['functions', 'update', 'write'],
  nestcore_delete_function: ['functions', 'delete', 'destructive'],
  nestcore_get_function_logs: ['functions', 'getLogs', 'read'],
  nestcore_get_env_variables: ['functions', 'getEnvVariables', 'read'],
  nestcore_create_env_variable: ['functions', 'createEnvVariable', 'write'],
  nestcore_update_env_variable: ['functions', 'updateEnvVariable', 'write'],
  nestcore_delete_env_variable: ['functions', 'deleteEnvVariable', 'destructive'],

  // ── jobs ──────────────────────────────────────────────────────────────────
  nestcore_create_job: ['jobs', 'create', 'write'],
  nestcore_list_jobs: ['jobs', 'list', 'read'],
  nestcore_get_job: ['jobs', 'get', 'read'],
  nestcore_update_job: ['jobs', 'update', 'write'],
  nestcore_delete_job: ['jobs', 'delete', 'destructive'],
  nestcore_trigger_job: ['jobs', 'trigger', 'write'],
  nestcore_get_job_runs: ['jobs', 'getRuns', 'read'],

  // ── storage ───────────────────────────────────────────────────────────────
  nestcore_list_buckets: ['storage', 'listBuckets', 'read'],
  nestcore_create_bucket: ['storage', 'createBucket', 'write'],
  nestcore_delete_bucket: ['storage', 'deleteBucket', 'destructive'],
  nestcore_list_files: ['storage', 'listFiles', 'read'],
  nestcore_upload_file: ['storage', 'uploadFile', 'write'],
  nestcore_download_file: ['storage', 'downloadFile', 'read'],
  nestcore_delete_files: ['storage', 'deleteFiles', 'destructive'],
  nestcore_get_public_url: ['storage', 'getPublicUrl', 'read'],
  nestcore_get_bucket_size: ['storage', 'getBucketSize', 'read'],

  // ── logs ──────────────────────────────────────────────────────────────────
  nestcore_query_logs: ['logs', 'query', 'read'],
  nestcore_get_slow_queries: ['logs', 'getSlowQueries', 'read'],
  nestcore_export_logs: ['logs', 'export', 'read'],
  nestcore_get_log_stats: ['logs', 'getStats', 'read'],

  // ── analytics ─────────────────────────────────────────────────────────────
  nestcore_get_analytics_overview: ['analytics', 'getOverview', 'read'],
  nestcore_get_analytics_events: ['analytics', 'getEvents', 'read'],
  nestcore_get_top_analytics_events: ['analytics', 'getTopEvents', 'read'],
  nestcore_get_top_analytics_screens: ['analytics', 'getTopScreens', 'read'],
  nestcore_get_analytics_retention: ['analytics', 'getRetention', 'read'],
  nestcore_get_analytics_funnel: ['analytics', 'getFunnel', 'read'],
  nestcore_get_analytics_performance: ['analytics', 'getPerformance', 'read'],
  nestcore_get_analytics_crashes: ['analytics', 'getCrashes', 'read'],
  nestcore_create_analytics_token: ['analytics', 'createToken', 'write'],
  nestcore_list_analytics_tokens: ['analytics', 'listTokens', 'read'],
  nestcore_revoke_analytics_token: ['analytics', 'revokeToken', 'destructive'],

  // ── migrations ────────────────────────────────────────────────────────────
  nestcore_run_migrations: ['migrations', 'run', 'destructive'],
  nestcore_list_migrations: ['migrations', 'list', 'read'],
  nestcore_migration_status: ['migrations', 'status', 'read'],

  // ── branches ──────────────────────────────────────────────────────────────
  nestcore_list_branches: ['branches', 'list', 'read'],
  nestcore_create_branch: ['branches', 'create', 'write'],
  nestcore_reset_branch: ['branches', 'reset', 'destructive'],
  nestcore_branch_changes: ['branches', 'changes', 'read'],
  nestcore_promote_branch: ['branches', 'promote', 'write'],

  // ── admins ────────────────────────────────────────────────────────────────
  nestcore_list_admins: ['admins', 'list', 'read'],
  nestcore_get_admin: ['admins', 'get', 'read'],
  nestcore_create_admin: ['admins', 'create', 'write'],
  nestcore_update_admin: ['admins', 'update', 'write'],
  nestcore_delete_admin: ['admins', 'delete', 'destructive'],

  // ── smtp ──────────────────────────────────────────────────────────────────
  nestcore_get_smtp_settings: ['smtp', 'getSettings', 'read'],
  nestcore_update_smtp_settings: ['smtp', 'updateSettings', 'write'],

  // ── authSecurity ──────────────────────────────────────────────────────────
  nestcore_get_auth_security: ['authSecurity', 'get', 'read'],
  nestcore_set_auth_security: ['authSecurity', 'set', 'write'],

  // ── ai ────────────────────────────────────────────────────────────────────
  nestcore_get_ai_settings: ['ai', 'getSettings', 'read'],
  nestcore_ai_usage: ['ai', 'usage', 'read'],
  nestcore_ai_overview: ['ai', 'overview', 'read'],
  nestcore_ai_traces: ['ai', 'traces', 'read'],

  // ── embeddings ────────────────────────────────────────────────────────────
  nestcore_list_collections: ['embeddings', 'listCollections', 'read'],
  nestcore_list_embeddings: ['embeddings', 'list', 'read'],
  nestcore_enable_embeddings: ['embeddings', 'enable', 'write'],
  nestcore_memory_subjects: ['embeddings', 'memorySubjects', 'read'],

  // ── memory (Project Intelligence) ─────────────────────────────────────────
  nestcore_get_project_context: ['memory', 'getProjectContext', 'read'],
  nestcore_sync_memory: ['memory', 'sync', 'write'],
  nestcore_get_recent_changes: ['memory', 'getRecentChanges', 'read'],
  nestcore_get_open_tasks: ['memory', 'getOpenTasks', 'read'],
  nestcore_add_task: ['memory', 'addTask', 'write'],
  nestcore_complete_task: ['memory', 'completeTask', 'write'],
  nestcore_get_decisions: ['memory', 'getDecisions', 'read'],
  nestcore_add_decision: ['memory', 'addDecision', 'write'],
  nestcore_add_feature: ['memory', 'addFeature', 'write'],
  nestcore_update_feature: ['memory', 'updateFeature', 'write'],
  nestcore_add_event: ['memory', 'addEvent', 'write'],
  nestcore_search_memory: ['memory', 'search', 'read'],
  nestcore_set_project_profile: ['memory', 'setProfile', 'write'],

  // ── webhooks ──────────────────────────────────────────────────────────────
  nestcore_list_webhooks: ['webhooks', 'list', 'read'],
  nestcore_create_webhook: ['webhooks', 'create', 'write'],
  nestcore_delete_webhook: ['webhooks', 'delete', 'destructive'],
  nestcore_test_webhook: ['webhooks', 'test', 'write'],

  // ── sms ───────────────────────────────────────────────────────────────────
  nestcore_get_sms_config: ['sms', 'getConfig', 'read'],
  nestcore_set_sms_config: ['sms', 'setConfig', 'write'],
  nestcore_test_sms: ['sms', 'test', 'write'],

  // ── realtime ──────────────────────────────────────────────────────────────
  nestcore_list_realtime_tables: ['realtime', 'listTables', 'read'],
  nestcore_enable_realtime: ['realtime', 'enable', 'write'],
  nestcore_disable_realtime: ['realtime', 'disable', 'write'],
  nestcore_broadcast: ['realtime', 'broadcast', 'write'],

  // ── credits ───────────────────────────────────────────────────────────────
  nestcore_get_credits: ['credits', 'get', 'read'],
  nestcore_set_credit_cap: ['credits', 'setCap', 'write'],
  nestcore_buy_credits: ['credits', 'buy', 'destructive'],

  // ── dashboard ─────────────────────────────────────────────────────────────
  nestcore_get_dashboard_stats: ['dashboard', 'getStats', 'read'],
  nestcore_get_activity: ['dashboard', 'getActivity', 'read'],
};

export const TOOL_CATALOG: Readonly<Record<string, CatalogEntry>> = Object.freeze(
  Object.fromEntries(
    Object.entries(ROWS).map(([name, [ns, method, cls]]) => [name, Object.freeze({ ns, method, cls })]),
  ),
);

/** Namespaces in display order. */
export const NAMESPACES: readonly string[] = [...new Set(Object.values(ROWS).map(([ns]) => ns))];

/** Tools whose class depends on the arguments of each call. */
export const DYNAMIC_SQL_TOOL = 'nestcore_execute_sql';

/**
 * Tools that are never callable from inside `execute`: browser sign-in can
 * take minutes, so `nestcore_login` stays a separate MCP tool.
 */
export const SANDBOX_EXCLUDED = new Set(['nestcore_login']);

/**
 * Session tools that only change this MCP process's local state (not the
 * platform), so they stay available when writes are disabled.
 */
export const LOCAL_SESSION_TOOLS = new Set(['nestcore_set_active_project']);

/**
 * Extra search words for tools whose name/description does not contain the
 * words people search with. Matched like method words in search.
 */
export const SEARCH_HINTS: Readonly<Record<string, string>> = {
  nestcore_get_schema: 'list tables columns structure describe',
  nestcore_execute_sql: 'query select count rows sql',
  nestcore_get_table_data: 'rows read browse select',
  nestcore_get_project_context: 'load memory session start overview',
  nestcore_search_memory: 'recall find',
  nestcore_sync_memory: 'digest session end save',
  nestcore_get_profile: 'whoami me account user',
  nestcore_list_projects: 'workspace',
  nestcore_get_api_keys: 'anon key service',
  nestcore_create_api_keys: 'rotate regenerate',
  nestcore_query_logs: 'errors requests',
  nestcore_list_files: 'objects',
};
