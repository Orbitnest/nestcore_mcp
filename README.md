# NestCore MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for [NestCore](https://nestcore.io) that enables AI agents (Claude, etc.) to manage your NestCore projects, databases, edge functions, storage, and more through a structured tool interface.

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

- **Node.js** v18 or later
- **npm** v9 or later
- Access to the GitHub repository `Orbitnest/nestcore_mcp` (or install `@nestcore/mcp-server` from npm)
- NestCore account — sign in at [nestcore.io](https://nestcore.io)

---

## Installation

### Option A — Install directly from GitHub (recommended for new devices)

No cloning required. `npm install` downloads the package from GitHub and automatically compiles it via the `prepare` script.

```bash
npm install -g github:Orbitnest/nestcore_mcp
```

After installation the `nestcore-mcp` binary is available globally:

```bash
nestcore-mcp   # starts the MCP server
```

The pre-rename `orbitnest-mcp` command is installed too and starts the same server.

To install a specific commit or tag:

```bash
npm install -g github:Orbitnest/nestcore_mcp#v1.0.0
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

---

## Connecting to Claude Code

### Option 1 — Via GitHub (no local clone needed)

Add the server globally so it is available in any project. Claude Code will run it directly from the GitHub package:

```bash
claude mcp add nestcore -- npx -y github:Orbitnest/nestcore_mcp
```

Or edit `~/.claude.json` manually:

```json
{
  "mcpServers": {
    "nestcore": {
      "command": "npx",
      "args": ["-y", "github:Orbitnest/nestcore_mcp"],
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

The repository includes `.vscode/mcp.json` which is automatically picked up by the **GitHub Copilot / Claude VSCode extension** with MCP support enabled.

**Using a local clone (development):**

1. Open this folder in VSCode
2. The `nestcore` server entry in `.vscode/mcp.json` points to `dist/index.js` and starts automatically

**Using GitHub install on any other machine:**

1. Create or edit `.vscode/mcp.json` in your project:

```jsonc
{
  "servers": {
    "nestcore": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:Orbitnest/nestcore_mcp"],
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

Once connected via Claude Code or VSCode, authenticate and set your project context:

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

Every tool is named `nestcore_*`. Tools were called `orbitnest_*` before the
rename: `tools/list` only returns the new names, but a `tools/call` for an old
`orbitnest_*` name still runs the matching `nestcore_*` tool, so clients with a
cached tool list keep working.

### Authentication (8 tools)
| Tool | Description |
|------|-------------|
| `nestcore_admin_signin` | Sign in with email + password and save JWT credentials |
| `nestcore_login` | Sign in with Google / GitHub / Apple via browser (for password-less accounts) |
| `nestcore_admin_signup` | Create a new admin account |
| `nestcore_admin_signup_verified` | Signup with email verification |
| `nestcore_request_verification` | Request verification code |
| `nestcore_refresh_token` | Manually refresh JWT token |
| `nestcore_admin_signout` | Sign out and clear saved credentials |
| `nestcore_get_profile` | Get current admin profile |

### Projects (7 tools)
| Tool | Description |
|------|-------------|
| `nestcore_create_project` | Create project with dedicated database |
| `nestcore_list_projects` | List all projects |
| `nestcore_get_project` | Get project details |
| `nestcore_update_project` | Rename or update project settings |
| `nestcore_delete_project` | Delete project (requires `confirmDeletion: true`) |
| `nestcore_get_project_stats` | Get project statistics |
| `nestcore_get_project_health` | Check project health status |

### Database (12 tools)
| Tool | Description |
|------|-------------|
| `nestcore_get_schema` | Fetch full database schema (cached 5 min) |
| `nestcore_execute_sql` | Execute raw SQL with safety validation |
| `nestcore_create_table` | Create a table from a structured definition |
| `nestcore_list_tables` | List all tables |
| `nestcore_get_table_data` | Query table data with pagination and filtering |
| `nestcore_insert_row` | Insert a single row |
| `nestcore_update_row` | Update a row by ID |
| `nestcore_delete_row` | Delete a row by ID |
| `nestcore_bulk_insert` | Insert multiple rows |
| `nestcore_bulk_update` | Update multiple rows |
| `nestcore_bulk_delete` | Delete multiple rows |
| `nestcore_get_sql_history` | Retrieve SQL query history |

### Row-Level Security (6 tools)
| Tool | Description |
|------|-------------|
| `nestcore_get_rls_status` | Check RLS status on a table |
| `nestcore_enable_rls` | Enable RLS on a table |
| `nestcore_disable_rls` | Disable RLS on a table |
| `nestcore_list_policies` | List RLS policies |
| `nestcore_create_policy` | Create a new RLS policy |
| `nestcore_delete_policy` | Delete an RLS policy |

### Edge Functions (7 tools)
| Tool | Description |
|------|-------------|
| `nestcore_create_function` | Create an edge function |
| `nestcore_list_functions` | List all functions |
| `nestcore_get_function` | Get function details |
| `nestcore_update_function` | Update function source code |
| `nestcore_delete_function` | Delete a function |
| `nestcore_invoke_function` | Execute a function |
| `nestcore_get_function_logs` | Get function execution logs |

> **Function environment:** inside a function, read env vars with `Deno.env.get('NAME')`. Available by default: `NESTCORE_URL`, `NESTCORE_ANON_KEY` (public/RLS-protected), `PROJECT_ID`, `PROJECT_URL`, `FUNCTION_NAME`, plus any project env vars you add. **`NESTCORE_SERVICE_ROLE_KEY` (RLS-bypassing) is NOT provided by default** — if a function needs privileged DB access, add it as a project env var (copy the service_role key from the dashboard → API Keys, or use `nestcore_create_env_variable`). See `docs/known-issues.md` §7.

### Storage (9 tools)
| Tool | Description |
|------|-------------|
| `nestcore_list_buckets` | List storage buckets |
| `nestcore_create_bucket` | Create a new bucket |
| `nestcore_upload_file` | Upload a file to a bucket |
| `nestcore_download_file` | Download a file |
| `nestcore_list_files` | List files in a bucket |
| `nestcore_delete_files` | Delete files |
| `nestcore_delete_bucket` | Delete a bucket |
| `nestcore_get_bucket_size` | Get bucket storage usage |
| `nestcore_get_public_url` | Get a public file URL |

### Logging (6 tools)
| Tool | Description |
|------|-------------|
| `nestcore_get_logs` | Get general logs with filtering |
| `nestcore_get_database_logs` | Get database operation logs |
| `nestcore_get_slow_query_logs` | Get slow query logs |
| `nestcore_get_auth_logs` | Get authentication logs |
| `nestcore_get_edge_function_logs` | Get edge function logs |
| `nestcore_export_logs` | Export logs in a specified format |

### Admin Management (6 tools)
| Tool | Description |
|------|-------------|
| `nestcore_list_admins` | List all admin users |
| `nestcore_create_admin` | Create a new admin |
| `nestcore_get_admin` | Get admin details |
| `nestcore_update_admin` | Update admin settings |
| `nestcore_delete_admin` | Delete an admin user |
| `nestcore_update_admin_password` | Reset admin password |

### SMTP (4 tools)
| Tool | Description |
|------|-------------|
| `nestcore_get_smtp_settings` | Get SMTP configuration |
| `nestcore_update_smtp_settings` | Update SMTP settings |
| `nestcore_delete_smtp_settings` | Remove SMTP configuration |
| `nestcore_test_smtp_connection` | Test SMTP connectivity |

### Integrations (13 tools)
| Tool | Description |
|------|-------------|
| `nestcore_get_connection_string` | Get the direct Postgres connection string (when enabled) |
| `nestcore_get_auth_security` | End-user auth limits in force (code length, wrong codes, codes per hour, lockout) |
| `nestcore_set_auth_security` | Change those limits (admin) |
| `nestcore_get_ai_settings` | AI gateway keys (masked), default models and spend caps |
| `nestcore_ai_usage` | AI calls, tokens and cost per day, model and end user |
| `nestcore_list_webhooks` | List database webhooks |
| `nestcore_create_webhook` | Create a signed row-change webhook |
| `nestcore_delete_webhook` | Delete a webhook |
| `nestcore_test_webhook` | Send a test event to a webhook |
| `nestcore_get_sms_config` | Get the project's Twilio/SMS config |
| `nestcore_set_sms_config` | Configure Twilio (auth token stored encrypted) |
| `nestcore_test_sms` | Send a test SMS |
| `nestcore_enable_extension` | Enable a Postgres extension (e.g. `vector` for pgvector) |

### AI data (6 tools)
| Tool | Description |
|------|-------------|
| `nestcore_ai_overview` | Counts of memories, subjects, collections, documents, threads, messages, traces (24 h) and embedded columns |
| `nestcore_list_collections` | Vector collections with model, chunking and document counts |
| `nestcore_memory_subjects` | Subjects that have memories (`user:<id>`, `agent:support`, ...) with counts |
| `nestcore_list_embeddings` | Automatically embedded columns with progress (rows, embedded, pending, failed, last error) |
| `nestcore_ai_traces` | Recent AI calls: model, tokens, cost, latency, status (never prompt text) |
| `nestcore_enable_embeddings` | Embed a table's text columns into a `vector(768)` column kept up to date (admin; requires `confirmEnable: true`) |

### Dashboard (2 tools)
| Tool | Description |
|------|-------------|
| `nestcore_get_dashboard_stats` | Get overall statistics |
| `nestcore_get_dashboard_activity` | Get recent activity feed |

---

## Safety Features

### SQL Guard
- Detects and blocks SQL injection patterns
- Requires `confirmDestructive: true` for `DROP`, `TRUNCATE`, `DELETE` without `WHERE`
- Blocks mutations on `auth_*` tables (configurable via `BLOCK_AUTH_TABLE_MUTATIONS`)

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
- Re-register: `claude mcp remove nestcore && claude mcp add nestcore -- npx -y github:Orbitnest/nestcore_mcp`
- If using project-level `.mcp.json`, ensure you opened Claude Code from this project directory

**GitHub access errors during npx install**
- Add your SSH key: `ssh-add ~/.ssh/id_rsa`
- Or create a GitHub Personal Access Token with `repo` scope and set it in `~/.npmrc`:

---

## License

MIT — NestCore Team
