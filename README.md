# NestCore MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for [NestCore](https://nestcore.io) that enables AI agents (Claude, etc.) to manage your NestCore projects, databases, edge functions, storage, and more through a structured tool interface.

By default it runs in **[Code Mode](#code-mode)**: the model gets three tools
(`search`, `execute`, `nestcore_login`) and drives the whole NestCore API by
writing short JavaScript snippets that run in a sandbox, instead of loading 133
tool definitions into its context. `NESTCORE_MCP_MODE=tools` restores the 1.x
tool list.

## Architecture

```
Claude / AI Agent
        ↓  MCP Protocol (stdio)
NestCore MCP Server  ← this project
        ↓  REST API + JWT
NestCore Backend (https://api.nestcore.io)
        ↓
PostgreSQL / Storage / Edge Functions
```

The MCP server **never accesses the database directly** — all operations are proxied through the NestCore backend API with full JWT authentication.

---

## Prerequisites

- **Node.js** v22 or later
- **npm** v9 or later
- npm (the package `@nestcorehq/mcp-server` is public), or access to the GitHub repository `Orbitnest/nestcore_mcp` for development builds
- NestCore account — sign in at [nestcore.io](https://nestcore.io)

---

## Installation

### Option A — Install from npm (recommended)

No cloning required. The package is published to npm as `@nestcorehq/mcp-server`; the pre-rename `@orbitneststudio/mcp-server` is deprecated.

```bash
npm install -g @nestcorehq/mcp-server
```

After installation the `nestcore-mcp` binary is available globally:

```bash
nestcore-mcp   # starts the MCP server
```

The pre-rename `orbitnest-mcp` command is installed too and starts the same server.

To install a specific version:

```bash
npm install -g @nestcorehq/mcp-server@1.6.0
```

To install straight from GitHub instead (for example an unreleased commit), `npm install` downloads the repository and compiles it via the `prepare` script:

```bash
npm install -g github:Orbitnest/nestcore_mcp
```

> **Private repo?** Make sure the machine has GitHub access. Either:
> - SSH key added to the GitHub account (`git@github.com:...`), or
> - A [Personal Access Token](https://github.com/settings/tokens) with `repo` scope configured in `~/.npmrc`:
>   ```
>   //npm.pkg.github.com/:_authToken=YOUR_TOKEN
>   ```

---

### Option B — Clone and build locally (for development)

```bash
git clone https://github.com/Orbitnest/nestcore_mcp.git
cd nestcore_mcp
npm install   # also runs `npm run build` automatically via prepare script
```

---

## Configuration

All settings are passed as environment variables. No `.env` file is required when configuring via an MCP client (see below) — simply set them in the `env` block of your MCP config.

For standalone use, copy the example file:

```bash
cp .env.example .env
# then edit .env as needed
```

| Variable | Default | Description |
|----------|---------|-------------|
| `NESTCORE_API_URL` | `https://api.nestcore.io` | NestCore backend URL (falls back to `ORBITNEST_API_URL`) |
| `NESTCORE_API_BASE_PATH` | `/api` | API base path (falls back to `ORBITNEST_API_BASE_PATH`) |
| `NESTCORE_MIGRATIONS_DIR` | `migrations` | Default migrations directory (falls back to `ORBITNEST_MIGRATIONS_DIR`) |
| `MCP_SERVER_NAME` | `nestcore` | MCP server identifier |
| `LOG_LEVEL` | `info` | Logging level: `debug`, `info`, `warn`, `error` |
| `DEFAULT_PROJECT_ID` | _(empty)_ | Auto-select project on startup |
| `ENABLE_SQL_GUARD` | `true` | Validate SQL before execution |
| `BLOCK_AUTH_TABLE_MUTATIONS` | `true` | Block writes to `auth_*` tables |
| `SCHEMA_CACHE_TTL` | `300000` | Schema cache lifetime in ms (5 min) |
| `TOKEN_REFRESH_THRESHOLD` | `60000` | Refresh token when < 60s from expiry |
| `NESTCORE_MCP_MODE` | `code` | `code`, `tools` or `both` — see [Code Mode](#code-mode) |
| `NESTCORE_MCP_ALLOW_WRITES` | `true` | `false`: Code Mode exposes read methods and read-only SQL only |
| `NESTCORE_MCP_EXEC_TIMEOUT_MS` | `30000` | Wall clock per `execute` |
| `NESTCORE_MCP_EXEC_MEMORY_MB` | `128` | Sandbox memory limit |
| `NESTCORE_MCP_EXEC_MAX_CALLS` | `50` | `nestcore.*` calls per `execute` |
| `NESTCORE_MCP_EXEC_MAX_OUTPUT_BYTES` | `100000` | `execute` response cap |

---

## Code Mode

From 2.0 the server starts in **Code Mode** by default. Instead of listing all
133 tools (about 92 KB of tool definitions, roughly 23k tokens, sent to the
model on every request), it exposes three:

| Tool | What it does |
|------|--------------|
| `search` | Finds API methods by keywords (`"list tables"`, `"storage buckets"`, `"db.getSchema"`) and returns their TypeScript declarations, with each method's class (read / write / destructive / session). Max 10 matches. |
| `execute` | Runs a JavaScript snippet in a sandbox. The snippet calls the methods as `await nestcore.<namespace>.<method>(args)`, can loop, filter and aggregate, and returns only what the model needs. |
| `nestcore_login` | The browser sign-in (unchanged). It can take minutes, so it is never called from inside `execute`. |

Each method is the existing tool, unchanged: `nestcore.db.getTableData(args)`
runs the `nestcore_get_table_data` handler with the same arguments, so every
guard, confirm flag and secret redaction applies exactly as before. See
[Available Tools](#available-tools) for the method behind every tool.

### Example

The model calls `search` once:

```json
{ "query": "list tables count rows", "limit": 4 }
```

and gets declarations like:

```ts
// db.getSchema (read)
// db.executeSql (read|write (per SQL))
declare namespace nestcore {
  const db: {
    /**
     * Fetch the database schema for a project: tables, columns (...) and whether RLS is enabled. ...
     * @access read
     */
    getSchema(args?: {
      projectId?: string;
      forceRefresh?: boolean;
    }): Promise<unknown>;
    ...
  };
}
```

Then one `execute` does the whole task (list tables, count rows in each, top 5):

```js
const { tables } = await nestcore.db.getSchema({});
const counts = [];
for (const t of tables.filter((t) => t.schema === 'public' && !t.isAuthTable)) {
  const r = await nestcore.db.executeSql({ sql: `SELECT count(*)::int AS n FROM "${t.name}"` });
  counts.push({ table: t.name, rows: r.data[0].n });
}
return counts.sort((a, b) => b.rows - a.rows).slice(0, 5);
```

Result:

```json
{ "result": [{ "table": "events", "rows": 260 }, ...], "logs": [], "calls": 7, "executionId": "..." }
```

Measured against the local stack (`test/code-mode-e2e.mjs`, same task on six
tables): code mode put about 7.4 KB into the model's context, tools mode about
130 KB (tool list 92 KB, schema result 35 KB, one call per table), about 17x
less. Token figures in that script are estimates (characters / 4).

More snippets:

```js
// Load the project memory at session start
return await nestcore.memory.getProjectContext({});

// Handle a failure inside the snippet
try {
  await nestcore.db.executeSql({ sql: 'DROP TABLE posts' });
} catch (e) {
  return { blocked: e.code, why: e.message };   // e.code === 'SAFETY_ERROR'
}

// Logs go to `logs`, not the result
const { tables } = await nestcore.db.getSchema({});
console.log('tables:', tables.length);
return tables.filter((t) => !t.rlsEnabled).map((t) => t.name);   // tables without RLS
```

### Snippet rules

- `code` is the body of an async function. `return` a JSON-serialisable value;
  `console.log/info/warn/error` output is returned in `logs`.
- Each method takes one object argument, validated against the tool's schema.
  Invalid arguments throw a `NestCoreError` with `type: 'validation'`.
- A failed call throws a `NestCoreError` with `.type` (`validation`, `guard`,
  `auth`, `api`, `cancelled`, ...), `.code` (the tool's code, e.g.
  `SAFETY_ERROR`, `AUTH_ERROR`, `CONFIRMATION_REQUIRED`), `.method` and
  `.details`. Uncaught, the run returns `isError: true` with
  `{ error: { type, message, code?, method? }, logs, executionId }`.
- `AUTH_ERROR`: call the `nestcore_login` tool, then retry.
- The sandbox has the JavaScript built-ins, `nestcore` and `console`, and
  nothing else: no network, filesystem, `require`/`import`, `process` or timers.

### Namespaces

`auth`, `projects`, `db`, `rls`, `functions` (edge functions and env
variables), `jobs`, `storage`, `logs`, `analytics`, `migrations`, `branches`,
`admins`, `smtp`, `authSecurity`, `ai`, `embeddings`, `memory` (Project
Intelligence), `webhooks`, `sms`, `realtime`, `credits`, `dashboard`.

### Destructive methods and writes

- Methods with their own confirm flag (`confirmDeletion`, `confirmDestructive`,
  `confirmDisable`, `confirm` on `branches.reset`, ...) behave exactly as the
  direct tools.
- Destructive methods that have no flag (`projects.setStatus`,
  `projects.createApiKeys`, `functions.deleteEnvVariable`, `webhooks.delete`,
  `migrations.run`, `credits.buy`) need `confirm: true`. When the MCP client
  supports elicitation, the server asks the user instead (method and target in
  the prompt; declining throws `cancelled by user`).
- `NESTCORE_MCP_ALLOW_WRITES=false` exposes only read methods (plus
  `projects.setActive`, which only changes this session). `db.executeSql` then
  rejects any SQL that is not read-only with `WRITES_DISABLED`.

### Limits and settings

| Variable | Default | Description |
|----------|---------|-------------|
| `NESTCORE_MCP_MODE` | `code` | `code` (search + execute + nestcore_login), `tools` (the 133 direct tools, as in 1.x) or `both` |
| `NESTCORE_MCP_ALLOW_WRITES` | `true` | `false`: read methods and read-only SQL only |
| `NESTCORE_MCP_EXEC_TIMEOUT_MS` | `30000` | Wall clock per `execute` (also the maximum for its `timeoutMs` argument). A CPU interrupt stops busy loops at the deadline |
| `NESTCORE_MCP_EXEC_MEMORY_MB` | `128` | Sandbox heap limit |
| `NESTCORE_MCP_EXEC_MAX_CALLS` | `50` | `nestcore.*` calls per `execute`; going over ends the run (`call_limit`) |
| `NESTCORE_MCP_EXEC_MAX_OUTPUT_BYTES` | `100000` | Response cap. A larger result is cut and marked `truncated: true`; logs are capped at a quarter of it |

Each variable also accepts the pre-rename `ORBITNEST_` prefix. Every bridge
call is logged to stderr (execution id, method, class, duration, ok/error and
the argument *names*, never their values).

The sandbox is [QuickJS](https://github.com/justjake/quickjs-emscripten)
compiled to WebAssembly: a fresh runtime per `execute`, with its own heap,
memory and stack limits, and no native build step, so `npx` installs keep
working everywhere Node 22+ runs.

### Moving from 1.x (tools mode)

Code Mode changes what `tools/list` returns. Set `NESTCORE_MCP_MODE=tools` when:

- a script or another program calls the `nestcore_*` tools by name;
- permission rules or allow-lists name individual tools (for example
  `mcp__nestcore__nestcore_execute_sql` in Claude Code); in code mode they
  would name `execute` instead;
- the model in use is not good at writing JavaScript.

`both` exposes the 133 tools plus `search` and `execute`, for a transition.
The old `orbitnest_*` tool names keep working in `tools` and `both` mode.

```json
{
  "mcpServers": {
    "nestcore": {
      "command": "npx",
      "args": ["-y", "@nestcorehq/mcp-server"],
      "env": { "NESTCORE_MCP_MODE": "tools" }
    }
  }
}
```

Also new in 2.0, in every mode: failed tool calls return `isError: true`
(the text is still the `{ error, code, ... }` JSON), and every tool carries MCP
annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`).

---

## Connecting to Claude Code

### Option 1 — Via npx (no local clone needed)

Add the server globally so it is available in any project. Claude Code will run the published npm package:

```bash
claude mcp add nestcore -- npx -y @nestcorehq/mcp-server
```

Or edit `~/.claude.json` manually:

```json
{
  "mcpServers": {
    "nestcore": {
      "command": "npx",
      "args": ["-y", "@nestcorehq/mcp-server"],
      "env": {
        "NESTCORE_API_URL": "https://api.nestcore.io"
      }
    }
  }
}
```

### Option 2 — Via globally installed binary

If you installed with `npm install -g`:

```bash
claude mcp add nestcore -- nestcore-mcp
```

### Option 3 — Project-level from local clone

The repository's `.mcp.json` is picked up automatically when you open this directory in Claude Code:

```bash
npm run build   # only needed the first time if prepare didn't run
```

### Verifying the connection

```bash
claude mcp list
# Should show: nestcore   connected
```

---

## Connecting to VSCode

A `.vscode/mcp.json` in the repository folder is picked up automatically by the **GitHub Copilot / Claude VSCode extension** with MCP support enabled. The `.vscode/` folder is gitignored, so each clone creates its own.

**Using a local clone (development):**

1. Open this folder in VSCode
2. Create `.vscode/mcp.json` with a `nestcore` server entry whose `command` is `node` and `args` is `["${workspaceFolder}/dist/index.js"]`; it starts automatically

**Using GitHub install on any other machine:**

1. Create or edit `.vscode/mcp.json` in your project:

```jsonc
{
  "servers": {
    "nestcore": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@nestcorehq/mcp-server"],
      "env": {
        "NESTCORE_API_URL": "https://api.nestcore.io",
        "LOG_LEVEL": "info",
        "ENABLE_SQL_GUARD": "true",
        "BLOCK_AUTH_TABLE_MUTATIONS": "true"
      }
    }
  }
}
```

2. Reload the VSCode window (`Ctrl+Shift+P` → `Developer: Reload Window`) — the server starts automatically.

To point at a different backend URL, change `NESTCORE_API_URL` in the `env` block.

---

## First-Time Setup

Once connected via Claude Code or VSCode, authenticate and set your project context.
The steps below name the direct tools; in Code Mode the model does the same
with `nestcore_login` (or `nestcore.auth.signin` inside `execute`),
`nestcore.projects.list({})` and `nestcore.projects.setActive({ projectId })`.

**1. Sign in as admin:**

If your account has a password:
```
Use nestcore_admin_signin with:
  email: "admin@example.com"
  password: "your-password"
```

If you signed up with **Google, GitHub, or Apple** (no password), use OAuth.
This opens your browser to complete sign-in and captures the session
automatically via a one-time localhost callback:
```
Use nestcore_login with:
  provider: "google"   # or "github" / "apple"
```

If the account has two-factor authentication on, the NestCore page in the
browser asks for the authenticator code (or a recovery code) after the provider
sign-in. The code is entered there, never in the chat. The browser then asks
**"Sign in to NestCore MCP?"**; click **Continue** (or **Cancel** to stop).
`nestcore_login` waits up to 5 minutes for the whole flow.

From 1.9.0 no token passes through a URL: the browser hands the local callback
a one-time code, and the server exchanges it (with a PKCE verifier that never
leaves your machine) for its session. Nothing usable ends up in browser history.

Credentials are saved to `~/.nestcore/credentials.json` and reloaded automatically on subsequent starts.

> `nestcore_login` opens a browser, so run it on the machine where the MCP
> server runs. It requires `NESTCORE_API_URL` to point at the NestCore API
> whose console hosts the OAuth callback page (default `https://api.nestcore.io`).

**2. List your projects:**
```
Use nestcore_list_projects
```

**3. Set active project:**
```
Use nestcore_set_active_project with:
  projectId: "proj_abc123"
```

All subsequent tools automatically use the active project — you rarely need to specify `projectId` again.

---

## Available Tools

133 tools, all named `nestcore_*`. In `tools` / `both` mode each is a direct MCP
tool; in Code Mode each is the method in the second column, called inside
`execute`. Class: **read** (no side effects), **write**, **destructive** (with
the confirmation it needs), **session** (sign-in / active project). Every
direct tool carries matching MCP annotations (`readOnlyHint`,
`destructiveHint`, `idempotentHint`).

Tools were called `orbitnest_*` before the rename: `tools/list` only returns the
new names, but a `tools/call` for an old `orbitnest_*` name still runs the
matching `nestcore_*` tool, so clients with a cached tool list keep working.

> **Function environment:** inside a function, read env vars with `Deno.env.get('NAME')`. Available by default: `NESTCORE_URL`, `NESTCORE_ANON_KEY` (public/RLS-protected), `PROJECT_ID`, `PROJECT_URL`, `FUNCTION_NAME`, plus any project env vars you add. **`NESTCORE_SERVICE_ROLE_KEY` (RLS-bypassing) is NOT provided by default** — if a function needs privileged DB access, add it as a project env var (copy the service_role key from the dashboard → API Keys, or use `nestcore_create_env_variable`).

> **AI credits:** prepaid AI credit is per workspace and pays for AI calls of projects without their own provider key (a project's own key always wins). Calls paid from credit fail with `CREDITS_EXHAUSTED` (`reason`: `balance` or `spend_cap`, plus `buyUrl`) when the balance is gone or the monthly cap is reached. `nestcore_buy_credits` only creates a Stripe Checkout link for a person to pay.

### Authentication — `auth` (8)

| Tool | Code Mode method | Class | Description |
|------|------------------|-------|-------------|
| `nestcore_admin_signin` | `auth.signin` | session | Sign in as an NestCore admin user. |
| `nestcore_login` | — (separate tool) | session | Sign in as a NestCore admin using Google, GitHub, or Apple. |
| `nestcore_admin_signup` | `auth.signup` | session | Create a new NestCore admin account directly. |
| `nestcore_admin_signup_verified` | `auth.signupVerified` | session | Complete admin signup with the 4-digit email verification code. |
| `nestcore_request_verification` | `auth.requestVerification` | session | Request an email verification code for admin signup. |
| `nestcore_refresh_token` | `auth.refreshToken` | session | Refresh expired JWT access token using stored refresh token. |
| `nestcore_admin_signout` | `auth.signout` | session | Sign out the current admin user and clear stored credentials. |
| `nestcore_get_profile` | `auth.getProfile` | read | Get the current admin user profile. |

### Projects — `projects` (12)

| Tool | Code Mode method | Class | Description |
|------|------------------|-------|-------------|
| `nestcore_create_project` | `projects.create` | write | Create a new NestCore project with a dedicated database. |
| `nestcore_get_project_eligibility` | `projects.getEligibility` | read | Can this workspace create one more project of a kind ("app" or "agent")? |
| `nestcore_list_projects` | `projects.list` | read | List all projects for the authenticated admin user. |
| `nestcore_set_project_status` | `projects.setStatus` | destructive (`confirm: true`) | Pause a project (API, realtime and relay go off; nothing is deleted) or resume it. |
| `nestcore_get_project` | `projects.get` | read | Get detailed information about a specific project. |
| `nestcore_update_project` | `projects.update` | write | Update project settings like name or configuration. |
| `nestcore_delete_project` | `projects.delete` | destructive (`confirmDeletion`) | Delete a project and all associated data. |
| `nestcore_set_active_project` | `projects.setActive` | session | Set the active project for the current session. |
| `nestcore_toggle_debug_mode` | `projects.toggleDebugMode` | write | Enable or disable debug mode for detailed logging on a project. |
| `nestcore_create_api_keys` | `projects.createApiKeys` | destructive (`confirm: true`) | Generate new project API key pair. |
| `nestcore_get_api_keys` | `projects.getApiKeys` | read | Get existing API keys for a project. |
| `nestcore_get_project_health` | `projects.getHealth` | read | Check the health status of a project including database connectivity. |

### Database — `db` (12)

| Tool | Code Mode method | Class | Description |
|------|------------------|-------|-------------|
| `nestcore_get_schema` | `db.getSchema` | read | Fetch the database schema for a project: tables, columns (type, nullability, default, key constraint) and whether RLS is enabled. |
| `nestcore_execute_sql` | `db.executeSql` | per SQL | Execute a raw SQL query against the project database. |
| `nestcore_create_table` | `db.createTable` | write | Create a new database table from a structured definition. |
| `nestcore_get_table_data` | `db.getTableData` | read | Retrieve rows from a table with ordering and pagination (max 100 rows per call; offset should be a multiple of limit). |
| `nestcore_insert_row` | `db.insertRow` | write | Insert a new row into a database table. |
| `nestcore_update_row` | `db.updateRow` | write | Update an existing row in a table by its ID. |
| `nestcore_delete_row` | `db.deleteRow` | destructive (`confirmDeletion`) | Delete a single row from a table by its ID. |
| `nestcore_bulk_insert` | `db.bulkInsert` | write | Insert multiple rows into a table in a single transaction. |
| `nestcore_bulk_update` | `db.bulkUpdate` | write | Update multiple rows in a table. |
| `nestcore_bulk_delete` | `db.bulkDelete` | destructive (`confirmDeletion`) | Delete multiple rows from a table by match conditions. |
| `nestcore_get_connection_string` | `db.getConnectionString` | read | Get the direct Postgres connection string for a project (only when the deployment has direct connections enabled). |
| `nestcore_enable_extension` | `db.enableExtension` | write | Enable a Postgres extension on a project (e.g. |

### Row-Level Security — `rls` (6)

| Tool | Code Mode method | Class | Description |
|------|------------------|-------|-------------|
| `nestcore_get_rls_status` | `rls.getStatus` | read | Check if Row-Level Security is enabled on a specific table. |
| `nestcore_enable_rls` | `rls.enable` | write | Enable Row-Level Security on a table. |
| `nestcore_disable_rls` | `rls.disable` | destructive (`confirmDisable`) | Disable Row-Level Security on a table. |
| `nestcore_list_policies` | `rls.listPolicies` | read | List all RLS policies for a specific table. |
| `nestcore_create_policy` | `rls.createPolicy` | write | Create a new RLS policy on a table. |
| `nestcore_delete_policy` | `rls.deletePolicy` | destructive (`confirmDeletion`) | Delete an RLS policy from a table. |

### Edge functions + env variables — `functions` (10)

| Tool | Code Mode method | Class | Description |
|------|------------------|-------|-------------|
| `nestcore_create_function` | `functions.create` | write | Create a new edge function. |
| `nestcore_list_functions` | `functions.list` | read | List all edge functions for a project. |
| `nestcore_get_function` | `functions.get` | read | Get details of a specific edge function including its source code. |
| `nestcore_update_function` | `functions.update` | write | Update an edge function's source code, description, or timeout. |
| `nestcore_delete_function` | `functions.delete` | destructive (`confirmDeletion`) | Delete an edge function. |
| `nestcore_get_function_logs` | `functions.getLogs` | read | Retrieve the most recent execution logs for a specific edge function (use nestcore_query_logs with logType=edge-functions for time-range… |
| `nestcore_get_env_variables` | `functions.getEnvVariables` | read | List environment variable names for a project. |
| `nestcore_create_env_variable` | `functions.createEnvVariable` | write | Create a new environment variable for a project. |
| `nestcore_update_env_variable` | `functions.updateEnvVariable` | write | Update an existing environment variable. |
| `nestcore_delete_env_variable` | `functions.deleteEnvVariable` | destructive (`confirm: true`) | Delete an environment variable. |

### Background jobs — `jobs` (7)

| Tool | Code Mode method | Class | Description |
|------|------------------|-------|-------------|
| `nestcore_create_job` | `jobs.create` | write | Create a background job that runs on a cron schedule. |
| `nestcore_list_jobs` | `jobs.list` | read | List all background jobs for a project. |
| `nestcore_get_job` | `jobs.get` | read | Get details of a specific background job including its source code and schedule. |
| `nestcore_update_job` | `jobs.update` | write | Update a background job's source code, schedule, description, or timeout. |
| `nestcore_delete_job` | `jobs.delete` | destructive (`confirmDeletion`) | Delete a background job. |
| `nestcore_trigger_job` | `jobs.trigger` | write | Manually trigger a background job to run immediately. |
| `nestcore_get_job_runs` | `jobs.getRuns` | read | Retrieve execution history (runs) for a specific background job. |

### Storage — `storage` (9)

| Tool | Code Mode method | Class | Description |
|------|------------------|-------|-------------|
| `nestcore_list_buckets` | `storage.listBuckets` | read | List all storage buckets for a project. |
| `nestcore_create_bucket` | `storage.createBucket` | write | Create a storage bucket. |
| `nestcore_delete_bucket` | `storage.deleteBucket` | destructive (`confirmDeletion`) | Delete a storage bucket. |
| `nestcore_list_files` | `storage.listFiles` | read | List files in a storage bucket with optional prefix filtering. |
| `nestcore_upload_file` | `storage.uploadFile` | write | Upload a file to a storage bucket. |
| `nestcore_download_file` | `storage.downloadFile` | read | Download a file from a storage bucket. |
| `nestcore_delete_files` | `storage.deleteFiles` | destructive (`confirmDeletion`) | Delete one or more files from a storage bucket. |
| `nestcore_get_public_url` | `storage.getPublicUrl` | read | Get the public URL for a file in a public bucket. |
| `nestcore_get_bucket_size` | `storage.getBucketSize` | read | Get the total size of a storage bucket. |

### Logs — `logs` (4)

| Tool | Code Mode method | Class | Description |
|------|------------------|-------|-------------|
| `nestcore_query_logs` | `logs.query` | read | Query project logs with filtering by type, level, time range, and text search. |
| `nestcore_get_slow_queries` | `logs.getSlowQueries` | read | Get slow database queries (queries taking >1000ms) for performance monitoring. |
| `nestcore_export_logs` | `logs.export` | read | Export project logs (newest first, up to 10,000 rows) as JSON or CSV text. |
| `nestcore_get_log_stats` | `logs.getStats` | read | Get log statistics and aggregations for a project. |

### Analytics — `analytics` (11)

| Tool | Code Mode method | Class | Description |
|------|------------------|-------|-------------|
| `nestcore_get_analytics_overview` | `analytics.getOverview` | read | Get high-level analytics metrics for a project including events, sessions, DAU, and crashes. |
| `nestcore_get_analytics_events` | `analytics.getEvents` | read | Get event counts as a timeseries for a project. |
| `nestcore_get_top_analytics_events` | `analytics.getTopEvents` | read | Get the top events by occurrence count for a project. |
| `nestcore_get_top_analytics_screens` | `analytics.getTopScreens` | read | Get the top screens or pages by view count for a project. |
| `nestcore_get_analytics_retention` | `analytics.getRetention` | read | Get day-N rolling retention data for a project. |
| `nestcore_get_analytics_funnel` | `analytics.getFunnel` | read | Run a funnel analysis across a sequence of event names for a project. |
| `nestcore_get_analytics_performance` | `analytics.getPerformance` | read | Get performance metric percentiles (e.g. |
| `nestcore_get_analytics_crashes` | `analytics.getCrashes` | read | Get crash groups and crash rate data for a project. |
| `nestcore_create_analytics_token` | `analytics.createToken` | write | Create an analytics ingestion token for a project. |
| `nestcore_list_analytics_tokens` | `analytics.listTokens` | read | List all analytics ingestion tokens for a project. |
| `nestcore_revoke_analytics_token` | `analytics.revokeToken` | destructive (`confirmRevocation`) | Revoke (delete) an analytics ingestion token. |

### Migrations — `migrations` (3)

| Tool | Code Mode method | Class | Description |
|------|------------------|-------|-------------|
| `nestcore_run_migrations` | `migrations.run` | destructive (`confirm: true`) | Apply pending database migrations from the migrations directory, in order, each inside a transaction. |
| `nestcore_list_migrations` | `migrations.list` | read | List every migration file in the migrations directory with its applied/pending/failed status from the registry. |
| `nestcore_migration_status` | `migrations.status` | read | Summarise migration state: counts of applied / pending / failed migrations, any checksum mismatches, and the full per-migration list. |

### Branches — `branches` (5)

| Tool | Code Mode method | Class | Description |
|------|------------------|-------|-------------|
| `nestcore_list_branches` | `branches.list` | read | A project's branches: Production (the live app) and Development (safe copy: same schema and config, its own data, users, URL and keys). |
| `nestcore_create_branch` | `branches.create` | write | Create the Development branch of a project if it has none (idempotent). |
| `nestcore_reset_branch` | `branches.reset` | destructive (`confirm`) | Rebuild Development from Production: drops Development's database and re-clones Production's schema; ALL Development rows, end users and… |
| `nestcore_branch_changes` | `branches.changes` | read | Schema changes recorded on Development and not yet promoted (DDL from the SQL editor, table editor, RLS, realtime, CLI or MCP), in order. |
| `nestcore_promote_branch` | `branches.promote` | write (`confirmDestructive`) | Promote Development to Production. |

### Admins — `admins` (5)

| Tool | Code Mode method | Class | Description |
|------|------------------|-------|-------------|
| `nestcore_list_admins` | `admins.list` | read | List all admin users in the NestCore platform. |
| `nestcore_get_admin` | `admins.get` | read | Get details of a specific admin user. |
| `nestcore_create_admin` | `admins.create` | write (`confirmCreate`) | Invite a new admin by email (the platform adds admins via invitation, not direct password creation; requires SMTP configured). |
| `nestcore_update_admin` | `admins.update` | write (`confirmUpdate`) | Update an admin. |
| `nestcore_delete_admin` | `admins.delete` | destructive (`confirmDeletion`) | Delete an admin user. |

### SMTP — `smtp` (2)

| Tool | Code Mode method | Class | Description |
|------|------------------|-------|-------------|
| `nestcore_get_smtp_settings` | `smtp.getSettings` | read | Get the SMTP email configuration for a project. |
| `nestcore_update_smtp_settings` | `smtp.updateSettings` | write | Update the SMTP email configuration for a project. |

### End-user auth limits — `authSecurity` (2)

| Tool | Code Mode method | Class | Description |
|------|------------------|-------|-------------|
| `nestcore_get_auth_security` | `authSecurity.get` | read | A project's end-user auth limits in force: code length, code expiry, wrong codes allowed, codes per email per hour, and password lockout… |
| `nestcore_set_auth_security` | `authSecurity.set` | write | Change end-user auth limits (only the given ones). |

### AI gateway — `ai` (4)

| Tool | Code Mode method | Class | Description |
|------|------------------|-------|-------------|
| `nestcore_get_ai_settings` | `ai.getSettings` | read | AI gateway settings of a project: saved provider keys (masked, last 4 characters), default models and monthly spend caps. |
| `nestcore_ai_usage` | `ai.usage` | read | AI gateway usage of a project with its own keys: calls, errors, tokens and cost for the last N days, per day, per model and top end users. |
| `nestcore_ai_overview` | `ai.overview` | read | Counts of a project's AI data: memories, memory subjects, collections, documents, threads, messages, traces in the last 24 hours and… |
| `nestcore_ai_traces` | `ai.traces` | read | Recent AI calls of a project, newest first: kind (chat/embed), caller, model, tokens in/out, cost, latency, status and error. |

### AI data (embeddings, collections, memory subjects) — `embeddings` (4)

| Tool | Code Mode method | Class | Description |
|------|------------------|-------|-------------|
| `nestcore_list_collections` | `embeddings.listCollections` | read | Vector collections of a project: name, embedding model, chunk size/overlap, whether users may add their own documents, and document… |
| `nestcore_memory_subjects` | `embeddings.memorySubjects` | read | Subjects that have AI memories in a project (e.g. |
| `nestcore_list_embeddings` | `embeddings.list` | read | Automatically embedded columns of a project with progress: source columns, model, rows, embedded (with the current model), pending and… |
| `nestcore_enable_embeddings` | `embeddings.enable` | write (`confirmEnable`) | Embed a table automatically: adds a vector(768) column (default "<first source>_embedding") plus <target>_embed_model and… |

### Project Intelligence (memory) — `memory` (13)

| Tool | Code Mode method | Class | Description |
|------|------------------|-------|-------------|
| `nestcore_get_project_context` | `memory.getProjectContext` | read | Load (or refresh) the project memory and context. |
| `nestcore_sync_memory` | `memory.sync` | write | ONE-CALL SESSION-END MEMORY SYNC. |
| `nestcore_get_recent_changes` | `memory.getRecentChanges` | read | Get recent project events since a given timestamp. |
| `nestcore_get_open_tasks` | `memory.getOpenTasks` | read | Get open tasks (todo + in_progress) for the project, sorted by priority. |
| `nestcore_add_task` | `memory.addTask` | write | Record a follow-up task or action item in the project memory. |
| `nestcore_complete_task` | `memory.completeTask` | write | Mark a task as done. |
| `nestcore_get_decisions` | `memory.getDecisions` | read | Retrieve stored architectural and product decisions. |
| `nestcore_add_decision` | `memory.addDecision` | write | Record an architectural or product decision in the project memory. |
| `nestcore_add_feature` | `memory.addFeature` | write | Add a feature to the project roadmap. |
| `nestcore_update_feature` | `memory.updateFeature` | write | Update a feature status or description (e.g. |
| `nestcore_add_event` | `memory.addEvent` | write | Record a significant project event in the timeline (deploy, bug, milestone, incident, etc.). |
| `nestcore_search_memory` | `memory.search` | read | Semantic search over ALL project memory — decisions, tasks, features, events, and summaries. |
| `nestcore_set_project_profile` | `memory.setProfile` | write | Update the project profile: summary, tech stack, conventions, and/or session digest. |

### Webhooks — `webhooks` (4)

| Tool | Code Mode method | Class | Description |
|------|------------------|-------|-------------|
| `nestcore_list_webhooks` | `webhooks.list` | read | List the database webhooks configured for a project. |
| `nestcore_create_webhook` | `webhooks.create` | write | Create a database webhook (signed HTTP POST on row INSERT/UPDATE/DELETE). |
| `nestcore_delete_webhook` | `webhooks.delete` | destructive (`confirm: true`) | Delete a database webhook by id. |
| `nestcore_test_webhook` | `webhooks.test` | write | Send a sample ping event to a webhook to verify the endpoint. |

### SMS — `sms` (3)

| Tool | Code Mode method | Class | Description |
|------|------------------|-------|-------------|
| `nestcore_get_sms_config` | `sms.getConfig` | read | Get a project's SMS (Twilio) configuration. |
| `nestcore_set_sms_config` | `sms.setConfig` | write | Create or update a project's Twilio SMS settings (auth token stored encrypted). |
| `nestcore_test_sms` | `sms.test` | write | Send a test SMS to verify the Twilio configuration. |

### Realtime — `realtime` (4)

| Tool | Code Mode method | Class | Description |
|------|------------------|-------|-------------|
| `nestcore_list_realtime_tables` | `realtime.listTables` | read | List all database tables that have realtime (change streaming) enabled for a project. |
| `nestcore_enable_realtime` | `realtime.enable` | write | Enable realtime change streaming on a table. |
| `nestcore_disable_realtime` | `realtime.disable` | write | Disable realtime change streaming on a table. |
| `nestcore_broadcast` | `realtime.broadcast` | write | Fan out a broadcast message to every subscriber on the given channel. |

### AI credits — `credits` (3)

| Tool | Code Mode method | Class | Description |
|------|------------------|-------|-------------|
| `nestcore_get_credits` | `credits.get` | read | The workspace's AI credit: balance (USD), monthly cap (null = none), this month's spend, available (credit can pay for a call now),… |
| `nestcore_set_credit_cap` | `credits.setCap` | write | Set the workspace's monthly cap on AI credit spend in USD (0 to 100000), or pass null to remove the cap. |
| `nestcore_buy_credits` | `credits.buy` | destructive (`confirm: true`) | Create a Stripe Checkout link for an AI credit pack (one-time payment) for a HUMAN to open and pay in a browser. |

### Dashboard — `dashboard` (2)

| Tool | Code Mode method | Class | Description |
|------|------------------|-------|-------------|
| `nestcore_get_dashboard_stats` | `dashboard.getStats` | read | Get overall dashboard statistics including total projects, users, functions, and storage usage. |
| `nestcore_get_activity` | `dashboard.getActivity` | read | Get recent activity log from the dashboard. |

---

## Safety Features

### SQL Guard
- Detects and blocks SQL injection patterns (statement chaining, `UNION SELECT`, comments)
- Requires `confirmDestructive: true` for `DROP`, `TRUNCATE`, `DELETE`, `UPDATE`, `INSERT`, `ALTER`, `GRANT`, `REVOKE`
- Blocks mutations on `auth_*` tables (configurable via `BLOCK_AUTH_TABLE_MUTATIONS`)
- Also applied to the SQL `nestcore_create_table` generates, and to every pending
  migration before `nestcore_run_migrations` runs anything (migrations may chain
  statements and contain comments, but may not mutate `auth_*` tables)

### Code Mode sandbox
- `execute` snippets run in QuickJS (WebAssembly), a fresh runtime per run:
  no network, filesystem, `require`/`import`, `process` or timers
- Memory, stack, wall-clock (with a CPU interrupt), call-count and output limits
- Method calls go through the same tool handlers, so every guard in this section applies
- Destructive methods without a confirm flag need `confirm: true` or a user prompt

### Operation Guard
- Bulk operations affecting more than 1,000 rows require explicit confirmation
- Project deletion always requires `confirmDeletion: true`
- RLS cannot be disabled on auth tables

### Auth Table Protection
- Tables prefixed with `auth_` are read-only by default
- Schema changes and direct mutations are blocked

---

## Common Workflows

**Create a table with RLS:**
```
nestcore_create_table({
  tableName: "posts",
  columns: [
    { name: "id", type: "uuid", primaryKey: true, default: "gen_random_uuid()" },
    { name: "title", type: "text", nullable: false },
    { name: "body", type: "text" },
    { name: "created_at", type: "timestamptz", default: "now()" }
  ],
  enableRLS: true
})
```

**Execute a safe query:**
```
nestcore_execute_sql({ sql: "SELECT * FROM posts ORDER BY created_at DESC LIMIT 10" })
```

**Execute a destructive query (requires explicit confirmation):**
```
nestcore_execute_sql({
  sql: "DELETE FROM posts WHERE status = 'draft'",
  confirmDestructive: true
})
```

**Deploy an edge function:**
```
nestcore_create_function({
  name: "send-welcome",
  sourceCode: "export default async (req) => { return new Response('Hello!'); }"
})
```

---

## Development

```bash
npm install     # installs deps and runs `npm run build` automatically (prepare script)
npm run dev     # TypeScript watch mode (tsx)
npm run build   # Compile to dist/
npm start       # Run compiled server
npm test        # build + all test scripts (fake API on 127.0.0.1, no network)
```

`npm test` includes the Code Mode suites: `test/code-mode-unit.mjs` (catalog,
type generation, search), `test/code-mode-sandbox.mjs` (escape attempts and
limits) and `test/code-mode-guards.mjs` (SQL guard parity, confirmations,
read-only mode). `test/code-mode-e2e.mjs` runs against a local NestCore docker
stack and prints the code-mode vs tools-mode context comparison; it is opt-in:

```bash
NESTCORE_E2E=1 node test/code-mode-e2e.mjs                    # http://localhost:3002
NESTCORE_E2E=1 NESTCORE_E2E_API=http://localhost:3002 node test/code-mode-e2e.mjs
```

Logs are written to **stderr** (MCP protocol uses stdout for communication), so they do not interfere with the MCP message stream.

---

## Workspace Auto-Detection

If your project root contains `.nestcore/config.json`, the MCP server automatically loads the project context on startup:

```json
{
  "projectId": "proj_abc123",
  "projectSlug": "my-project",
  "name": "My Project",
  "apiUrl": "https://api.nestcore.io"
}
```

This is the same file `nestcore link` (the CLI) writes; older CLI versions wrote `slug` instead of `projectSlug`, which is still read. A pre-rename `.orbitnest/config.json` is read when a directory has no `.nestcore/config.json`; saving the active project then writes `.nestcore/config.json`. `nestcore_set_active_project` updates this file when one was found, and never creates one elsewhere.

---

## Credentials Storage

After signing in, tokens are persisted to `~/.nestcore/credentials.json` (mode `0600`) and automatically reloaded on the next server start. If that file doesn't exist yet, the pre-rename `~/.orbitnest/credentials.json` is used (and kept in sync while it exists, so older CLI/MCP versions sharing it stay signed in). Tokens are refreshed automatically when they are within 60 seconds of expiry.

---

## Troubleshooting

**Server fails to start**
- If using a local clone, run `npm run build` — the `dist/` directory must exist
- Check that Node.js v18+ is installed: `node --version`
- If using `npx github:Orbitnest/nestcore_mcp`, ensure you have GitHub access (SSH key or token)

**`Not authenticated` errors**
- Run `nestcore_admin_signin` to sign in
- Credentials are stored in `~/.nestcore/credentials.json`

**`No active project` errors**
- Run `nestcore_list_projects` then `nestcore_set_active_project`
- Or set `DEFAULT_PROJECT_ID` in your environment / MCP `env` block

**MCP server not appearing in VSCode**
- Ensure MCP support is enabled in the extension settings
- Confirm `npm run build` has been run if using a local clone
- Reload the VSCode window (`Ctrl+Shift+P` → `Developer: Reload Window`)
- When using `npx github:...`, the first start may take a few seconds while npm downloads the package

**MCP server not appearing in Claude Code**
- Run `claude mcp list` to see registered servers
- Re-register: `claude mcp remove nestcore && claude mcp add nestcore -- npx -y @nestcorehq/mcp-server`
- If using project-level `.mcp.json`, ensure you opened Claude Code from this project directory

**GitHub access errors during npx install**
- Add your SSH key: `ssh-add ~/.ssh/id_rsa`
- Or create a GitHub Personal Access Token with `repo` scope and set it in `~/.npmrc`:

---

## License

MIT — NestCore Team
