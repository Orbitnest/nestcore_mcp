import { ApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import * as EP from './endpoints.js';

export interface LogFilterOpts {
  level?: string;
  search?: string;
  limit?: number;
  offset?: number;
  startTime?: string;
  endTime?: string;
}

export interface NestCoreClientConfig {
  apiUrl: string;
  accessToken: string;
}

/**
 * Shape returned by the table-data endpoint. Rows live under `data` (NOT
 * `rows`) — this interface exists so callers stop guessing the envelope. It
 * mirrors the API's TableDataResult exactly.
 */
export interface TableDataResponse {
  success: boolean;
  table_name: string;
  total_rows: number;
  returned_rows: number;
  page: number;
  limit: number;
  columns: Array<{ name: string; type: string }>;
  /** The actual rows. This is `data`, not `rows`. */
  data: Array<Record<string, unknown>>;
  count: number;
}

// LOW-01: outbound request timeout (ms). Generous enough for slow operations
// (large SQL, uploads) but bounded so the agent never hangs indefinitely.
const REQUEST_TIMEOUT_MS = 60_000;

export class NestCoreClient {
  private baseUrl: string;
  private accessToken: string;

  constructor(config: NestCoreClientConfig) {
    // LOW-02: the admin bearer token rides on every request. Refuse cleartext
    // http to a non-loopback host (it would expose the token to anyone on the
    // network path) and warn on a non-default API host.
    try {
      const u = new URL(config.apiUrl);
      const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
      if (u.protocol !== 'https:' && !isLoopback) {
        throw new ApiError(
          `Refusing to use an insecure API URL: ${config.apiUrl}. The admin token would be sent in cleartext — use https:// (http is only allowed for localhost).`,
          0,
        );
      }
      if (u.protocol !== 'https:') {
        logger.warn(`Using cleartext http API URL (loopback dev only): ${config.apiUrl}`);
      } else if (u.hostname !== 'api.nestcore.io' && u.hostname !== 'api.orbitnest.io') {
        logger.warn(`Using a non-default NestCore API host: ${u.hostname}`);
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(`Invalid NESTCORE_API_URL: ${config.apiUrl}`, 0);
    }
    this.baseUrl = `${config.apiUrl}/api`;
    this.accessToken = config.accessToken;
  }

  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { noAuth?: boolean; query?: Record<string, string> }
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (options?.query) {
      const params = new URLSearchParams(
        Object.fromEntries(Object.entries(options.query).filter(([, v]) => v !== undefined && v !== ''))
      );
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (!options?.noAuth && this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }

    const fetchOptions: RequestInit = { method, headers };
    if (body !== undefined) {
      fetchOptions.body = JSON.stringify(body);
    }

    // LOW-01: bound every request so a slow/unresponsive API (or a hostile
    // redirect target) can't hang the tool call forever.
    fetchOptions.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    logger.debug(`API ${method} ${path}`);

    let response: Response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new ApiError(`API ${method} ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`, 504);
      }
      throw err;
    }

    await this.throwIfError(response, `API ${method}`, path);

    const text = await response.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  /**
   * Like request() but returns the raw Response (after the error check) for
   * non-JSON bodies — file downloads and CSV exports.
   */
  private async requestRaw(path: string, query?: Record<string, string>): Promise<Response> {
    let url = `${this.baseUrl}${path}`;
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== '')),
    ).toString();
    if (qs) url += `?${qs}`;
    const headers: Record<string, string> = {};
    if (this.accessToken) headers['Authorization'] = `Bearer ${this.accessToken}`;
    let response: Response;
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new ApiError(`API GET ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`, 504);
      }
      throw err;
    }
    await this.throwIfError(response, 'API GET', path);
    return response;
  }

  private async throwIfError(response: Response, label: string, path: string): Promise<void> {
    if (response.ok) return;
    const errorBody = await response.json().catch(() => ({ message: response.statusText }));
    let msg: unknown = (errorBody as Record<string, unknown>).message || response.statusText;
    if (Array.isArray(msg)) msg = msg.join('; ');
    let text = `${label} ${path} failed: ${msg}`;
    if (response.status === 403 && /restricted to the project owner/i.test(String(msg))) {
      text +=
        '. Raw SQL (execute_sql, create_table, migrations), drop table, RLS enable/disable and policy create/delete ' +
        'are limited to the user who created the project. Browsing and row edits work for every workspace member; ' +
        'ask the project owner to run this operation.';
    }
    throw new ApiError(text, response.status);
  }

  /**
   * Upload a file as multipart/form-data. The storage endpoints use a
   * FileInterceptor('file') and read `path`/`upsert` form fields — they do NOT
   * accept a JSON base64 body (that returned "No file provided"). Callers pass
   * base64 content; we decode it to bytes and post a real multipart form.
   */
  private async uploadMultipart<T>(
    path: string,
    args: { filePath: string; fileContent: string; contentType?: string; upsert?: boolean },
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const bytes = Buffer.from(args.fileContent, 'base64');
    const fileName = args.filePath.split('/').pop() || 'file';
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: args.contentType || 'application/octet-stream' }), fileName);
    form.append('path', args.filePath);
    if (args.upsert !== undefined) form.append('upsert', String(args.upsert));

    const headers: Record<string, string> = {};
    if (this.accessToken) headers['Authorization'] = `Bearer ${this.accessToken}`;
    // NOTE: do NOT set Content-Type — fetch sets the multipart boundary itself.

    let response: Response;
    try {
      response = await fetch(url, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new ApiError(`Upload ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`, 504);
      }
      throw err;
    }
    await this.throwIfError(response, 'Upload', path);
    const text = await response.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  // ─── Authentication ───

  async signin(email: string, password: string, mfaCode?: string) {
    const res = await this.request<Record<string, unknown>>('POST', EP.AUTH.SIGNIN, { email, password }, { noAuth: true });
    // MFA step-up: when the admin has two-factor enabled, signin returns a
    // short-lived challenge instead of tokens. If a code was supplied, complete
    // it here and return real tokens; otherwise hand the challenge back so the
    // tool can ask the user for a code.
    if (res?.mfa_required) {
      if (!mfaCode) return res;
      return this.request<Record<string, unknown>>(
        'POST',
        EP.AUTH.SIGNIN_MFA,
        { challenge_token: res.challenge_token, code: mfaCode },
        { noAuth: true },
      );
    }
    return res;
  }

  // Signup DTOs: CreateAdminDto { full_name, email, password } and
  // CompleteSignupDto { full_name, email, password, code } — unknown keys are 400.
  async signup(email: string, password: string, fullName: string) {
    return this.request<Record<string, unknown>>('POST', EP.AUTH.SIGNUP, { full_name: fullName, email, password }, { noAuth: true });
  }

  async signupWithVerification(email: string, password: string, fullName: string, code: string) {
    return this.request<Record<string, unknown>>('POST', EP.AUTH.SIGNUP_WITH_VERIFICATION, {
      full_name: fullName, email, password, code,
    }, { noAuth: true });
  }

  async requestVerification(email: string, password: string, fullName: string) {
    return this.request<Record<string, unknown>>('POST', EP.AUTH.REQUEST_VERIFICATION, { full_name: fullName, email, password }, { noAuth: true });
  }

  async refreshToken(refreshToken: string) {
    return this.request<Record<string, unknown>>('POST', EP.AUTH.REFRESH, { refresh_token: refreshToken });
  }

  async signout(refreshToken: string) {
    return this.request<Record<string, unknown>>('POST', EP.AUTH.SIGNOUT, { refresh_token: refreshToken });
  }

  async getProfile() {
    return this.request<Record<string, unknown>>('GET', EP.AUTH.PROFILE);
  }

  async changePassword(currentPassword: string, newPassword: string) {
    return this.request<Record<string, unknown>>('POST', EP.AUTH.CHANGE_PASSWORD, {
      current_password: currentPassword, new_password: newPassword,
    });
  }

  // ─── Admin Management ───

  async listAdmins() {
    return this.request<unknown[]>('GET', EP.ADMIN.LIST);
  }

  /**
   * Invite a new admin by email. The platform has no direct create-with-password
   * route (that's intentional) — admins are added via an invitation they accept
   * to set their own password. Requires SMTP configured to deliver the invite.
   */
  async inviteAdmin(email: string) {
    return this.request<Record<string, unknown>>('POST', EP.ADMIN.INVITE, { email });
  }

  async getAdmin(adminId: string) {
    return this.request<Record<string, unknown>>('GET', EP.ADMIN.GET(adminId));
  }

  /** Self only. An email change requires `current_password` and revokes all sessions. */
  async updateAdmin(adminId: string, data: { full_name?: string; email?: string; current_password?: string }) {
    return this.request<Record<string, unknown>>('PATCH', EP.ADMIN.UPDATE(adminId), data);
  }

  /** Activate / deactivate a workspace member (admin role). */
  async setAdminActive(adminId: string, isActive: boolean) {
    return this.request<Record<string, unknown>>('PATCH', EP.ADMIN.SET_ACTIVE(adminId), { is_active: isActive });
  }

  async deleteAdmin(adminId: string) {
    return this.request<Record<string, unknown>>('DELETE', EP.ADMIN.DELETE(adminId));
  }

  async updateAdminPassword(adminId: string, currentPassword: string, newPassword: string) {
    return this.request<Record<string, unknown>>('PATCH', EP.ADMIN.UPDATE_PASSWORD(adminId), {
      current_password: currentPassword, new_password: newPassword,
    });
  }

  // Admin Panel
  async getAdminProjects() {
    return this.request<unknown[]>('GET', EP.ADMIN.PROJECTS);
  }

  async getProjectOverview(projectId: string) {
    return this.request<Record<string, unknown>>('GET', EP.ADMIN.PROJECT_OVERVIEW(projectId));
  }

  async getProjectActivity(projectId: string, limit?: number) {
    const query: Record<string, string> = {};
    if (limit !== undefined) query['limit'] = String(limit);
    return this.request<unknown[]>('GET', EP.ADMIN.PROJECT_ACTIVITY(projectId), undefined, { query });
  }

  // ─── Projects ───

  async createProject(data: { name: string; description?: string }) {
    return this.request<Record<string, unknown>>('POST', EP.PROJECTS.CREATE, data);
  }

  async listProjects() {
    return this.request<unknown[]>('GET', EP.PROJECTS.LIST);
  }

  async getProject(projectId: string) {
    return this.request<Record<string, unknown>>('GET', EP.PROJECTS.GET(projectId));
  }

  async updateProject(projectId: string, data: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('PATCH', EP.PROJECTS.UPDATE(projectId), data);
  }

  async deleteProject(projectId: string) {
    return this.request<Record<string, unknown>>('DELETE', EP.PROJECTS.DELETE(projectId));
  }

  async getProjectStats(projectId: string) {
    return this.request<Record<string, unknown>>('GET', EP.PROJECTS.STATS(projectId));
  }

  async getProjectHealth(projectId: string) {
    return this.request<Record<string, unknown>>('GET', EP.PROJECTS.HEALTH(projectId));
  }

  async toggleDebugMode(projectId: string, enabled: boolean) {
    return this.request<Record<string, unknown>>('PATCH', EP.PROJECTS.UPDATE(projectId), { is_debug_mode: enabled });
  }

  async createProjectApiKeys(projectId: string, data?: { name?: string; description?: string }) {
    return this.request<Record<string, unknown>>('POST', EP.PROJECTS.API_KEYS_CREATE(projectId), data);
  }

  async getProjectApiKeys(projectId: string) {
    return this.request<Record<string, unknown>>('GET', EP.PROJECTS.API_KEYS_LIST(projectId));
  }

  // ─── Admin integrations (webhooks, SMS/Twilio, connection string) ───

  async getConnectionString(projectId: string) {
    return this.request<Record<string, unknown>>('GET', EP.ADMIN_INTEGRATIONS.CONNECTION(projectId));
  }

  // ── End-user auth security (auth_settings) ──
  async getAuthSecurity(projectId: string) {
    const res = await this.request<{ data: unknown }>('GET', EP.ADMIN_INTEGRATIONS.AUTH_SETTINGS(projectId));
    return res.data;
  }

  async setAuthSecurity(projectId: string, patch: Record<string, Record<string, number>>) {
    const res = await this.request<{ data: unknown }>('PUT', EP.ADMIN_INTEGRATIONS.AUTH_SETTINGS(projectId), patch);
    return res.data;
  }

  // ── AI gateway (read-only: keys come back masked) ──
  async getAiSettings(projectId: string) {
    const [providers, caps] = await Promise.all([
      this.request<{ data: unknown }>('GET', EP.ADMIN_INTEGRATIONS.AI_PROVIDERS(projectId)),
      this.request<{ data: unknown }>('GET', EP.ADMIN_INTEGRATIONS.AI_CAPS(projectId)),
    ]);
    return { providers: providers.data, caps: caps.data };
  }

  async getAiUsage(projectId: string, days = 30) {
    const res = await this.request<{ data: unknown }>('GET', EP.ADMIN_INTEGRATIONS.AI_USAGE(projectId, days));
    return res.data;
  }

  // ── AI data (memory, collections, traces, automatic embeddings) ──
  async getAiOverview(projectId: string) {
    const res = await this.request<{ data: unknown }>('GET', EP.ADMIN_INTEGRATIONS.AI_OVERVIEW(projectId));
    return res.data;
  }

  async listAiCollections(projectId: string) {
    const res = await this.request<{ data: unknown }>('GET', EP.ADMIN_INTEGRATIONS.AI_COLLECTIONS(projectId));
    return res.data;
  }

  async listMemorySubjects(projectId: string, type?: string) {
    const res = await this.request<{ data: unknown }>('GET', EP.ADMIN_INTEGRATIONS.AI_MEMORY_SUBJECTS(projectId), undefined, {
      query: type ? { type } : {},
    });
    return res.data;
  }

  async getAiTraces(projectId: string, opts: { limit?: number; offset?: number; status?: 'ok' | 'error' } = {}) {
    const query: Record<string, string> = {};
    if (opts.limit !== undefined) query.limit = String(opts.limit);
    if (opts.offset !== undefined) query.offset = String(opts.offset);
    if (opts.status) query.status = opts.status;
    const res = await this.request<{ data: unknown }>('GET', EP.ADMIN_INTEGRATIONS.AI_TRACES(projectId), undefined, { query });
    return res.data;
  }

  async listEmbeddings(projectId: string) {
    const res = await this.request<{ data: unknown }>('GET', EP.ADMIN_INTEGRATIONS.EMBEDDINGS(projectId));
    return res.data;
  }

  async enableEmbeddings(projectId: string, body: { table: string; sourceColumns: string[]; targetColumn?: string; model?: string }) {
    const res = await this.request<{ data: unknown }>('POST', EP.ADMIN_INTEGRATIONS.EMBEDDINGS(projectId), body);
    return res.data;
  }

  async listWebhooks(projectId: string) {
    return this.request<Record<string, unknown>>('GET', EP.ADMIN_INTEGRATIONS.WEBHOOKS(projectId));
  }

  async createWebhook(projectId: string, body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('POST', EP.ADMIN_INTEGRATIONS.WEBHOOKS(projectId), body);
  }

  async deleteWebhook(projectId: string, webhookId: string) {
    return this.request<Record<string, unknown>>('DELETE', EP.ADMIN_INTEGRATIONS.WEBHOOK(projectId, webhookId));
  }

  async testWebhook(projectId: string, webhookId: string) {
    return this.request<Record<string, unknown>>('POST', EP.ADMIN_INTEGRATIONS.WEBHOOK_TEST(projectId, webhookId));
  }

  async getSmsConfig(projectId: string) {
    return this.request<Record<string, unknown>>('GET', EP.ADMIN_INTEGRATIONS.SMS_CONFIG(projectId));
  }

  async updateSmsConfig(projectId: string, body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('PUT', EP.ADMIN_INTEGRATIONS.SMS_CONFIG(projectId), body);
  }

  async testSms(projectId: string, to: string) {
    return this.request<Record<string, unknown>>('POST', EP.ADMIN_INTEGRATIONS.SMS_TEST(projectId), { to });
  }

  // ─── Database ───

  async executeSql(projectId: string, sql: string, params?: unknown[]) {
    const body = params && params.length > 0 ? { sql, params } : { sql };
    return this.request<Record<string, unknown>>('POST', EP.DATABASE.SQL(projectId), body);
  }

  async getTableMetadata(projectId: string, tableName?: string) {
    const query: Record<string, string> = {};
    if (tableName) query['table'] = tableName;
    return this.request<Record<string, unknown>>('GET', EP.DATABASE.TABLES(projectId), undefined, { query });
  }

  async listTables(projectId: string) {
    return this.request<Record<string, unknown>>('GET', EP.DATABASE.TABLES_LIST(projectId));
  }

  async deleteTable(projectId: string, tableName: string) {
    return this.request<Record<string, unknown>>('DELETE', EP.DATABASE.TABLE_DELETE(projectId, tableName));
  }

  async getTableData(
    projectId: string,
    tableName: string,
    opts?: { page?: number; limit?: number; offset?: number; orderBy?: string; orderDirection?: string; filter?: string }
  ) {
    const query: Record<string, string> = {};
    // The route is page-based (no `offset`); translate offset → page (API default limit 20).
    const page = opts?.page ?? (opts?.offset ? Math.floor(opts.offset / (opts.limit ?? 20)) + 1 : undefined);
    if (page !== undefined) query['page'] = String(page);
    if (opts?.limit !== undefined) query['limit'] = String(opts.limit);
    if (opts?.orderBy) query['orderBy'] = opts.orderBy;
    if (opts?.orderDirection) query['orderDirection'] = opts.orderDirection;
    if (opts?.filter) query['filter'] = opts.filter;
    // Returns { ..., data: [...] } — see TableDataResponse. Rows are under `data`.
    return this.request<TableDataResponse>('GET', EP.DATABASE.TABLE_DATA(projectId, tableName), undefined, { query });
  }

  // NOTE: the row/bulk endpoints wrap the payload — the API reads `data`,
  // `updates`, and `conditions` off the body (NOT the raw object / `rows` /
  // `ids`). Sending the wrong envelope makes the API see an empty payload and
  // reject it ("Data object cannot be empty"). These wrappers match the
  // server DTOs exactly.
  async insertRow(projectId: string, tableName: string, data: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('POST', EP.DATABASE.INSERT_ROW(projectId, tableName), { data });
  }

  async updateRow(projectId: string, tableName: string, rowId: string, data: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('PUT', EP.DATABASE.UPDATE_ROW(projectId, tableName, rowId), { data });
  }

  async deleteRow(projectId: string, tableName: string, rowId: string) {
    return this.request<Record<string, unknown>>('DELETE', EP.DATABASE.DELETE_ROW(projectId, tableName, rowId));
  }

  async bulkInsert(projectId: string, tableName: string, rows: Record<string, unknown>[]) {
    return this.request<Record<string, unknown>>('POST', EP.DATABASE.BULK_INSERT(projectId, tableName), { data: rows });
  }

  async bulkUpdate(
    projectId: string,
    tableName: string,
    updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
  ) {
    return this.request<Record<string, unknown>>('PUT', EP.DATABASE.BULK_UPDATE(projectId, tableName), { updates });
  }

  async bulkDelete(projectId: string, tableName: string, conditions: Array<Record<string, unknown>>) {
    return this.request<Record<string, unknown>>('DELETE', EP.DATABASE.BULK_DELETE(projectId, tableName), { conditions });
  }

  // SQL History
  async getSqlHistory(projectId: string, opts?: { limit?: number; offset?: number; favorites?: boolean }) {
    const query: Record<string, string> = {};
    if (opts?.limit !== undefined) query['limit'] = String(opts.limit);
    if (opts?.offset !== undefined) query['offset'] = String(opts.offset);
    if (opts?.favorites !== undefined) query['favorites'] = String(opts.favorites);
    return this.request<unknown[]>('GET', EP.DATABASE.SQL_HISTORY(projectId), undefined, { query });
  }

  // ─── RLS ───

  async getRlsStatus(projectId: string, tableName: string) {
    return this.request<Record<string, unknown>>('GET', EP.RLS.GET_STATUS(projectId, tableName));
  }

  async enableRls(projectId: string, tableName: string) {
    return this.request<Record<string, unknown>>('POST', EP.RLS.ENABLE(projectId, tableName));
  }

  async disableRls(projectId: string, tableName: string) {
    return this.request<Record<string, unknown>>('POST', EP.RLS.DISABLE(projectId, tableName));
  }

  async listPolicies(projectId: string, tableName: string) {
    return this.request<unknown[]>('GET', EP.RLS.POLICIES(projectId, tableName));
  }

  async createPolicy(projectId: string, tableName: string, data: {
    policyName: string;
    command: string;
    using: string;
    withCheck?: string;
    role?: string;
  }) {
    // The API DTO uses snake_case `name` / `with_check` / singular `role`
    // (NOT policyName / withCheck / roles[]). Sending the camelCase shape made
    // validation reject the body (400). Map to the server contract here.
    const payload: Record<string, unknown> = {
      name: data.policyName,
      command: data.command,
      using: data.using,
    };
    if (data.withCheck !== undefined) payload.with_check = data.withCheck;
    if (data.role !== undefined) payload.role = data.role;
    return this.request<Record<string, unknown>>('POST', EP.RLS.POLICIES(projectId, tableName), payload);
  }

  async deletePolicy(projectId: string, tableName: string, policyName: string) {
    return this.request<Record<string, unknown>>('DELETE', EP.RLS.DELETE_POLICY(projectId, tableName, policyName));
  }

  // ─── Edge Functions ───

  async createFunction(projectId: string, data: { name: string; description?: string; sourceCode: string; executionConfig?: { timeout?: number; memory?: number; enableLogs?: boolean } }) {
    return this.request<Record<string, unknown>>('POST', EP.FUNCTIONS.CREATE(projectId), data);
  }

  async listFunctions(projectId: string) {
    return this.request<unknown[]>('GET', EP.FUNCTIONS.LIST(projectId));
  }

  async getFunction(projectId: string, name: string) {
    return this.request<Record<string, unknown>>('GET', EP.FUNCTIONS.GET(projectId, name));
  }

  async updateFunction(projectId: string, name: string, data: { sourceCode?: string; description?: string; executionConfig?: { timeout?: number; memory?: number; enableLogs?: boolean } }) {
    return this.request<Record<string, unknown>>('PUT', EP.FUNCTIONS.UPDATE(projectId, name), data);
  }

  async deleteFunction(projectId: string, name: string) {
    return this.request<Record<string, unknown>>('DELETE', EP.FUNCTIONS.DELETE(projectId, name));
  }

  async invokeFunction(projectId: string, name: string, body?: unknown, method: string = 'POST') {
    return this.request<Record<string, unknown>>(method, EP.FUNCTIONS.INVOKE(projectId, name), body);
  }

  // The route only reads `limit`.
  async getFunctionLogs(projectId: string, name: string, opts?: { limit?: number }) {
    const query: Record<string, string> = {};
    if (opts?.limit !== undefined) query['limit'] = String(opts.limit);
    return this.request<unknown[]>('GET', EP.FUNCTIONS.LOGS(projectId, name), undefined, { query });
  }

  // ─── Background Jobs ───

  async createJob(projectId: string, data: { name: string; description?: string; sourceCode: string; schedule: string; timezone?: string; executionConfig?: { timeout?: number; memory?: number; enableLogs?: boolean } }) {
    return this.request<Record<string, unknown>>('POST', EP.JOBS.CREATE(projectId), data);
  }

  async listJobs(projectId: string) {
    return this.request<unknown[]>('GET', EP.JOBS.LIST(projectId));
  }

  async getJob(projectId: string, name: string) {
    return this.request<Record<string, unknown>>('GET', EP.JOBS.GET(projectId, name));
  }

  async updateJob(projectId: string, name: string, data: { sourceCode?: string; description?: string; schedule?: string; timezone?: string; status?: string; executionConfig?: { timeout?: number; memory?: number; enableLogs?: boolean } }) {
    return this.request<Record<string, unknown>>('PUT', EP.JOBS.UPDATE(projectId, name), data);
  }

  async deleteJob(projectId: string, name: string) {
    return this.request<Record<string, unknown>>('DELETE', EP.JOBS.DELETE(projectId, name));
  }

  async triggerJob(projectId: string, name: string) {
    return this.request<Record<string, unknown>>('POST', EP.JOBS.TRIGGER(projectId, name));
  }

  async getJobRuns(projectId: string, name: string, opts?: { limit?: number }) {
    const query: Record<string, string> = {};
    if (opts?.limit !== undefined) query['limit'] = String(opts.limit);
    return this.request<unknown[]>('GET', EP.JOBS.RUNS(projectId, name), undefined, { query });
  }

  // ─── Environment Variables ───

  async getEnvVariables(projectId: string) {
    return this.request<unknown[]>('GET', EP.PROJECTS.ENV_VARS(projectId));
  }

  async createEnvVariable(projectId: string, data: { key: string; value: string; encrypted?: boolean }) {
    return this.request<Record<string, unknown>>('POST', EP.PROJECTS.ENV_VARS(projectId), {
      name: data.key,
      value: data.value,
      is_secret: data.encrypted,
    });
  }

  async updateEnvVariable(projectId: string, name: string, data: { value?: string }) {
    // API only accepts { value } — sending { key } or additional fields returns 400
    return this.request<Record<string, unknown>>('PUT', EP.PROJECTS.ENV_VAR(projectId, name), { value: data.value });
  }

  async deleteEnvVariable(projectId: string, name: string) {
    return this.request<Record<string, unknown>>('DELETE', EP.PROJECTS.ENV_VAR(projectId, name));
  }

  // ─── Admin Storage (uses projectId) ───

  async adminListBuckets(projectId: string) {
    return this.request<unknown[]>('GET', EP.ADMIN_STORAGE.LIST_BUCKETS(projectId));
  }

  async adminCreateBucket(projectId: string, data: { name: string; public?: boolean }) {
    return this.request<Record<string, unknown>>('POST', EP.ADMIN_STORAGE.CREATE_BUCKET(projectId), data);
  }

  async adminListFiles(projectId: string, bucketName: string, opts?: { prefix?: string; limit?: number; offset?: number }) {
    const query: Record<string, string> = {};
    if (opts?.prefix) query['prefix'] = opts.prefix;
    if (opts?.limit !== undefined) query['limit'] = String(opts.limit);
    if (opts?.offset !== undefined) query['offset'] = String(opts.offset);
    return this.request<unknown[]>('GET', EP.ADMIN_STORAGE.LIST_FILES(projectId, bucketName), undefined, { query });
  }

  async adminDeleteFiles(projectId: string, bucketName: string, paths: string[]) {
    return this.request<Record<string, unknown>>('DELETE', EP.ADMIN_STORAGE.DELETE_FILES(projectId, bucketName), { paths });
  }

  async adminUploadFile(projectId: string, bucketName: string, data: {
    filePath: string; fileContent: string; contentType?: string; upsert?: boolean;
  }) {
    return this.uploadMultipart<Record<string, unknown>>(EP.ADMIN_STORAGE.UPLOAD(projectId, bucketName), data);
  }

  async adminGetBucketSize(projectId: string, bucketName: string) {
    return this.request<Record<string, unknown>>('GET', EP.ADMIN_STORAGE.BUCKET_SIZE(projectId, bucketName));
  }

  async adminDeleteBucket(projectId: string, bucketName: string) {
    return this.request<Record<string, unknown>>('DELETE', EP.ADMIN_STORAGE.DELETE_BUCKET(projectId, bucketName));
  }

  // ─── Storage (slug-based) ───

  async listBuckets(projectSlug: string) {
    return this.request<unknown[]>('GET', EP.STORAGE.LIST_BUCKETS(projectSlug));
  }

  async createBucket(projectSlug: string, bucketName: string, isPublic?: boolean) {
    return this.request<Record<string, unknown>>('POST', EP.STORAGE.CREATE_BUCKET(projectSlug, bucketName), { public: isPublic });
  }

  async deleteBucket(projectSlug: string, bucketName: string) {
    return this.request<Record<string, unknown>>('DELETE', EP.STORAGE.DELETE_BUCKET(projectSlug, bucketName));
  }

  async listFiles(projectSlug: string, bucketName: string, opts?: { prefix?: string; limit?: number }) {
    const query: Record<string, string> = {};
    if (opts?.prefix) query['prefix'] = opts.prefix;
    if (opts?.limit !== undefined) query['limit'] = String(opts.limit);
    return this.request<unknown[]>('GET', EP.STORAGE.LIST_FILES(projectSlug, bucketName), undefined, { query });
  }

  async uploadFile(projectSlug: string, bucketName: string, data: {
    filePath: string; fileContent: string; contentType?: string; upsert?: boolean;
  }) {
    return this.uploadMultipart<Record<string, unknown>>(EP.STORAGE.UPLOAD(projectSlug, bucketName), data);
  }

  /** The route streams the raw file bytes (not JSON). */
  async downloadFile(projectSlug: string, bucketName: string, filePath: string) {
    const res = await this.requestRaw(EP.STORAGE.DOWNLOAD(projectSlug, bucketName, filePath));
    const bytes = Buffer.from(await res.arrayBuffer());
    return { contentType: res.headers.get('content-type') ?? 'application/octet-stream', bytes };
  }

  async deleteFiles(projectSlug: string, bucketName: string, paths: string[]) {
    return this.request<Record<string, unknown>>('DELETE', EP.STORAGE.DELETE_FILES(projectSlug, bucketName), { paths });
  }

  async getPublicUrl(projectSlug: string, bucketName: string, filePath: string) {
    return this.request<Record<string, unknown>>('GET', EP.STORAGE.PUBLIC_URL(projectSlug, bucketName, filePath));
  }

  async getBucketSize(projectSlug: string, bucketName: string) {
    return this.request<Record<string, unknown>>('GET', EP.STORAGE.BUCKET_SIZE(projectSlug, bucketName));
  }

  // ─── Logging ───

  // Every log route takes the same LogFiltersDto (snake_case; unknown keys → 400).
  private logQuery(opts?: LogFilterOpts): Record<string, string> {
    const query: Record<string, string> = {};
    if (opts?.level) query['level'] = opts.level;
    if (opts?.search) query['search'] = opts.search;
    if (opts?.limit !== undefined) query['limit'] = String(opts.limit);
    if (opts?.offset !== undefined) query['offset'] = String(opts.offset);
    if (opts?.startTime) query['start_time'] = opts.startTime;
    if (opts?.endTime) query['end_time'] = opts.endTime;
    return query;
  }

  async getLogs(projectId: string, opts?: LogFilterOpts) {
    return this.request<Record<string, unknown>>('GET', EP.LOGS.ALL(projectId), undefined, { query: this.logQuery(opts) });
  }

  async getDatabaseLogs(projectId: string, opts?: LogFilterOpts) {
    return this.request<Record<string, unknown>>('GET', EP.LOGS.DATABASE(projectId), undefined, { query: this.logQuery(opts) });
  }

  async getSlowQueryLogs(projectId: string, opts?: { limit?: number }) {
    const query: Record<string, string> = {};
    if (opts?.limit !== undefined) query['limit'] = String(opts.limit);
    return this.request<Record<string, unknown>>('GET', EP.LOGS.DATABASE_SLOW(projectId), undefined, { query });
  }

  async getAuthLogs(projectId: string, opts?: LogFilterOpts) {
    return this.request<Record<string, unknown>>('GET', EP.LOGS.AUTH(projectId), undefined, { query: this.logQuery(opts) });
  }

  async getEdgeFunctionLogs(projectId: string, opts?: LogFilterOpts) {
    return this.request<Record<string, unknown>>('GET', EP.LOGS.EDGE_FUNCTIONS(projectId), undefined, { query: this.logQuery(opts) });
  }

  /** The export route streams a file (a JSON array, or CSV), so it is returned as text. */
  async exportLogs(projectId: string, opts?: LogFilterOpts & { format?: 'json' | 'csv' }) {
    const query = this.logQuery(opts);
    if (opts?.format) query['format'] = opts.format;
    const res = await this.requestRaw(EP.LOGS.EXPORT(projectId), query);
    return { truncated: res.headers.get('x-export-truncated') === 'true', body: await res.text() };
  }

  async getLogStats(projectId: string) {
    return this.request<Record<string, unknown>>('GET', EP.LOGS.STATS(projectId));
  }

  // ─── SMTP ───

  async getSmtpSettings(projectId: string) {
    return this.request<Record<string, unknown>>('GET', EP.PROJECTS.SMTP(projectId));
  }

  async updateSmtpSettings(projectId: string, data: Record<string, unknown>) {
    // Map camelCase tool params → snake_case API fields
    const payload: Record<string, unknown> = {};
    if (data.host !== undefined)      payload.smtp_host       = data.host;
    if (data.port !== undefined)      payload.smtp_port       = data.port;
    if (data.secure !== undefined)    payload.smtp_secure     = data.secure;
    if (data.username !== undefined)  payload.smtp_user       = data.username;
    if (data.password !== undefined)  payload.smtp_password   = data.password;
    if (data.fromEmail !== undefined) payload.smtp_from_email = data.fromEmail;
    if (data.fromName !== undefined)  payload.smtp_from_name  = data.fromName;
    return this.request<Record<string, unknown>>('PUT', EP.PROJECTS.SMTP(projectId), payload);
  }

  async deleteSmtpSettings(projectId: string) {
    return this.request<Record<string, unknown>>('DELETE', EP.PROJECTS.SMTP(projectId));
  }

  async testSmtpConnection(projectId: string, data: Record<string, unknown>) {
    return this.request<Record<string, unknown>>('POST', EP.PROJECTS.SMTP_TEST(projectId), data);
  }

  // ─── Dashboard ───

  async getDashboardStats() {
    return this.request<Record<string, unknown>>('GET', EP.DASHBOARD.STATS);
  }

  async getDashboardActivity() {
    return this.request<unknown[]>('GET', EP.DASHBOARD.ACTIVITY);
  }

  // ─── Realtime ───

  async listRealtimeTables(projectId: string) {
    return this.request<unknown[]>('GET', EP.REALTIME.TABLES(projectId));
  }

  async enableRealtimeTable(
    projectId: string,
    data: { table: string; schema?: string; columns?: string[] },
  ) {
    return this.request<Record<string, unknown>>(
      'POST',
      EP.REALTIME.TABLES(projectId),
      data,
    );
  }

  async disableRealtimeTable(
    projectId: string,
    schema: string,
    table: string,
  ) {
    return this.request<Record<string, unknown>>(
      'DELETE',
      EP.REALTIME.DISABLE_TABLE(projectId, schema, table),
    );
  }

  async broadcastRealtime(
    projectId: string,
    data: { channel: string; event: string; payload: unknown },
  ) {
    return this.request<{ ok: boolean }>(
      'POST',
      EP.REALTIME.BROADCAST(projectId),
      data,
    );
  }

  // ─── Analytics ───

  async getAnalyticsOverview(projectId: string, opts?: { from?: string; to?: string; granularity?: string; platform?: string; app_version?: string }) {
    const query: Record<string, string> = {};
    if (opts?.from) query['from'] = opts.from;
    if (opts?.to) query['to'] = opts.to;
    if (opts?.granularity) query['granularity'] = opts.granularity;
    if (opts?.platform) query['platform'] = opts.platform;
    if (opts?.app_version) query['app_version'] = opts.app_version;
    return this.request<Record<string, unknown>>('GET', EP.ANALYTICS.OVERVIEW(projectId), undefined, { query });
  }

  async getAnalyticsEventTimeseries(projectId: string, opts?: { from?: string; to?: string; granularity?: string; platform?: string; app_version?: string }) {
    const query: Record<string, string> = {};
    if (opts?.from) query['from'] = opts.from;
    if (opts?.to) query['to'] = opts.to;
    if (opts?.granularity) query['granularity'] = opts.granularity;
    if (opts?.platform) query['platform'] = opts.platform;
    if (opts?.app_version) query['app_version'] = opts.app_version;
    return this.request<Record<string, unknown>>('GET', EP.ANALYTICS.EVENTS_TIMESERIES(projectId), undefined, { query });
  }

  async getTopAnalyticsEvents(projectId: string, opts?: { from?: string; to?: string; granularity?: string; platform?: string; app_version?: string; limit?: number }) {
    const query: Record<string, string> = {};
    if (opts?.from) query['from'] = opts.from;
    if (opts?.to) query['to'] = opts.to;
    if (opts?.granularity) query['granularity'] = opts.granularity;
    if (opts?.platform) query['platform'] = opts.platform;
    if (opts?.app_version) query['app_version'] = opts.app_version;
    if (opts?.limit !== undefined) query['limit'] = String(opts.limit);
    return this.request<Record<string, unknown>>('GET', EP.ANALYTICS.EVENTS_TOP(projectId), undefined, { query });
  }

  async getTopAnalyticsScreens(projectId: string, opts?: { from?: string; to?: string; granularity?: string; platform?: string; app_version?: string; limit?: number }) {
    const query: Record<string, string> = {};
    if (opts?.from) query['from'] = opts.from;
    if (opts?.to) query['to'] = opts.to;
    if (opts?.granularity) query['granularity'] = opts.granularity;
    if (opts?.platform) query['platform'] = opts.platform;
    if (opts?.app_version) query['app_version'] = opts.app_version;
    if (opts?.limit !== undefined) query['limit'] = String(opts.limit);
    return this.request<Record<string, unknown>>('GET', EP.ANALYTICS.SCREENS_TOP(projectId), undefined, { query });
  }

  async getAnalyticsRetention(projectId: string, opts?: { from?: string; to?: string; granularity?: string }) {
    const query: Record<string, string> = {};
    if (opts?.from) query['from'] = opts.from;
    if (opts?.to) query['to'] = opts.to;
    if (opts?.granularity) query['granularity'] = opts.granularity;
    return this.request<Record<string, unknown>>('GET', EP.ANALYTICS.RETENTION(projectId), undefined, { query });
  }

  async getAnalyticsFunnel(projectId: string, data: { steps: string[]; from?: string; to?: string }) {
    return this.request<Record<string, unknown>>('POST', EP.ANALYTICS.FUNNEL(projectId), data);
  }

  async getAnalyticsPerformance(projectId: string, opts?: { from?: string; to?: string; granularity?: string; platform?: string; app_version?: string }) {
    const query: Record<string, string> = {};
    if (opts?.from) query['from'] = opts.from;
    if (opts?.to) query['to'] = opts.to;
    if (opts?.granularity) query['granularity'] = opts.granularity;
    if (opts?.platform) query['platform'] = opts.platform;
    if (opts?.app_version) query['app_version'] = opts.app_version;
    return this.request<Record<string, unknown>>('GET', EP.ANALYTICS.PERFORMANCE(projectId), undefined, { query });
  }

  async getAnalyticsCrashes(projectId: string, opts?: { from?: string; to?: string; granularity?: string; platform?: string; app_version?: string }) {
    const query: Record<string, string> = {};
    if (opts?.from) query['from'] = opts.from;
    if (opts?.to) query['to'] = opts.to;
    if (opts?.granularity) query['granularity'] = opts.granularity;
    if (opts?.platform) query['platform'] = opts.platform;
    if (opts?.app_version) query['app_version'] = opts.app_version;
    return this.request<Record<string, unknown>>('GET', EP.ANALYTICS.CRASHES(projectId), undefined, { query });
  }

  async createAnalyticsToken(projectId: string, data?: { name?: string }) {
    return this.request<Record<string, unknown>>('POST', EP.ANALYTICS.TOKENS(projectId), data ?? {});
  }

  async listAnalyticsTokens(projectId: string) {
    return this.request<Record<string, unknown>>('GET', EP.ANALYTICS.TOKENS(projectId));
  }

  async updateAnalyticsToken(projectId: string, tokenId: string, data: { is_active: boolean }) {
    return this.request<Record<string, unknown>>('PATCH', EP.ANALYTICS.TOKEN(projectId, tokenId), data);
  }

  async revokeAnalyticsToken(projectId: string, tokenId: string) {
    return this.request<Record<string, unknown>>('DELETE', EP.ANALYTICS.TOKEN(projectId, tokenId));
  }

  // ── Project Intelligence ──────────────────────────────────────────────────

  async getProjectContext(
    projectId: string,
    opts?: { includeSchema?: boolean; events?: number; tasks?: number; view?: 'full' | 'ai'; detail?: boolean },
  ) {
    const query: Record<string, string> = {};
    if (opts?.includeSchema) query['includeSchema'] = 'true';
    if (opts?.events) query['events'] = String(opts.events);
    if (opts?.tasks) query['tasks'] = String(opts.tasks);
    if (opts?.view) query['view'] = opts.view;
    if (opts?.detail) query['detail'] = 'true';
    return this.request<Record<string, unknown>>('GET', EP.INTELLIGENCE.CONTEXT(projectId), undefined, { query });
  }

  async getRecentChanges(projectId: string, opts?: { since?: string; limit?: number }) {
    const query: Record<string, string> = {};
    if (opts?.since) query['since'] = opts.since;
    if (opts?.limit) query['limit'] = String(opts.limit);
    return this.request<unknown[]>('GET', EP.INTELLIGENCE.CHANGES(projectId), undefined, { query });
  }

  async getOpenTasks(projectId: string, opts?: { status?: string; priority?: string }) {
    const query: Record<string, string> = {};
    if (opts?.status) query['status'] = opts.status;
    if (opts?.priority) query['priority'] = opts.priority;
    return this.request<unknown[]>('GET', EP.INTELLIGENCE.TASKS(projectId), undefined, { query });
  }

  async getProjectDecisions(projectId: string, opts?: { status?: string; limit?: number }) {
    const query: Record<string, string> = {};
    if (opts?.status) query['status'] = opts.status;
    if (opts?.limit) query['limit'] = String(opts.limit);
    return this.request<unknown[]>('GET', EP.INTELLIGENCE.DECISIONS(projectId), undefined, { query });
  }

  async addDecision(projectId: string, data: { decision: string; reason?: string; metadata?: Record<string, unknown> }) {
    return this.request<Record<string, unknown>>('POST', EP.INTELLIGENCE.DECISIONS(projectId), data);
  }

  async addTask(projectId: string, data: { title: string; detail?: string; priority?: string; linkedFeatureId?: string }) {
    return this.request<Record<string, unknown>>('POST', EP.INTELLIGENCE.TASKS(projectId), data);
  }

  async completeTask(projectId: string, taskId: string, data?: { note?: string }) {
    return this.request<Record<string, unknown>>('PATCH', EP.INTELLIGENCE.COMPLETE_TASK(projectId, taskId), data ?? {});
  }

  async addFeature(projectId: string, data: { name: string; description?: string; status?: string; dependencies?: string[] }) {
    return this.request<Record<string, unknown>>('POST', EP.INTELLIGENCE.FEATURES(projectId), data);
  }

  async updateFeature(projectId: string, featureId: string, data: { status?: string; description?: string }) {
    return this.request<Record<string, unknown>>('PATCH', EP.INTELLIGENCE.FEATURE(projectId, featureId), data);
  }

  async addEvent(projectId: string, data: { type: string; summary: string; metadata?: Record<string, unknown> }) {
    return this.request<Record<string, unknown>>('POST', EP.INTELLIGENCE.EVENTS(projectId), data);
  }

  async searchProjectMemory(projectId: string, data: { query: string; sourceType?: string; limit?: number; minScore?: number }) {
    return this.request<unknown[]>('POST', EP.INTELLIGENCE.SEARCH(projectId), data);
  }

  async setProjectProfile(projectId: string, data: { summary?: string; stack?: string[]; conventions?: Record<string, unknown>; digest?: string }) {
    return this.request<Record<string, unknown>>('PUT', EP.INTELLIGENCE.PROFILE(projectId), data);
  }
}

/** @deprecated Renamed to {@link NestCoreClient}. */
export const OrbitNestClient = NestCoreClient;
/** @deprecated Renamed to {@link NestCoreClient}. */
export type OrbitNestClient = NestCoreClient;
/** @deprecated Renamed to {@link NestCoreClientConfig}. */
export type OrbitNestClientConfig = NestCoreClientConfig;
