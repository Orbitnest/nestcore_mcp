# OrbitNest MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for [OrbitNest Studio](https://studio.orbitnest.io) that enables AI agents (Claude, etc.) to manage your OrbitNest projects, databases, edge functions, storage, and more through a structured tool interface.

## Architecture

```
Claude / AI Agent
        ↓  MCP Protocol (stdio)
OrbitNest MCP Server  ← this project
        ↓  REST API + JWT
OrbitNest Backend (https://api.orbitnest.io)
        ↓
PostgreSQL / Storage / Edge Functions
```

The MCP server **never accesses the database directly** — all operations are proxied through the OrbitNest backend API with full JWT authentication.

---

## Prerequisites

- **Node.js** v18 or later
- **npm** v9 or later
- Access to the private GitHub repository: `mahtab-ali/orbitnest_mcp`
- OrbitNest account — sign in at [studio.orbitnest.io](https://studio.orbitnest.io)

---

## Installation

### Option A — Install directly from GitHub (recommended for new devices)

No cloning required. `npm install` downloads the package from GitHub and automatically compiles it via the `prepare` script.

```bash
npm install -g github:mahtab-ali/orbitnest_mcp
```

After installation the `orbitnest-mcp` binary is available globally:

```bash
orbitnest-mcp   # starts the MCP server
```

To install a specific commit or tag:

```bash
npm install -g github:mahtab-ali/orbitnest_mcp#v1.0.0
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
git clone https://github.com/mahtab-ali/orbitnest_mcp.git
cd orbitnest_mcp
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
| `ORBITNEST_API_URL` | `https://api.orbitnest.io` | OrbitNest backend URL |
| `ORBITNEST_API_BASE_PATH` | `/api` | API base path |
| `MCP_SERVER_NAME` | `orbitnest-studio` | MCP server identifier |
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
claude mcp add orbitnest -- npx -y github:mahtab-ali/orbitnest_mcp
```

Or edit `~/.claude.json` manually:

```json
{
  "mcpServers": {
    "orbitnest": {
      "command": "npx",
      "args": ["-y", "github:mahtab-ali/orbitnest_mcp"],
      "env": {
        "ORBITNEST_API_URL": "https://api.orbitnest.io"
      }
    }
  }
}
```

### Option 2 — Via globally installed binary

If you installed with `npm install -g`:

```bash
claude mcp add orbitnest -- orbitnest-mcp
```

### Option 3 — Project-level from local clone

The repository's `.mcp.json` is picked up automatically when you open this directory in Claude Code:

```bash
npm run build   # only needed the first time if prepare didn't run
```

### Verifying the connection

```bash
claude mcp list
# Should show: orbitnest   connected
```

---

## Connecting to VSCode

The repository includes `.vscode/mcp.json` which is automatically picked up by the **GitHub Copilot / Claude VSCode extension** with MCP support enabled.

**Using a local clone (development):**

1. Open this folder in VSCode
2. The `orbitnest` server entry in `.vscode/mcp.json` points to `dist/index.js` and starts automatically

**Using GitHub install on any other machine:**

1. Create or edit `.vscode/mcp.json` in your project:

```jsonc
{
  "servers": {
    "orbitnest": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:mahtab-ali/orbitnest_mcp"],
      "env": {
        "ORBITNEST_API_URL": "https://api.orbitnest.io",
        "LOG_LEVEL": "info",
        "ENABLE_SQL_GUARD": "true",
        "BLOCK_AUTH_TABLE_MUTATIONS": "true"
      }
    }
  }
}
```

2. Reload the VSCode window (`Ctrl+Shift+P` → `Developer: Reload Window`) — the server starts automatically.

To point at a different backend URL, change `ORBITNEST_API_URL` in the `env` block.

---

## First-Time Setup

Once connected via Claude Code or VSCode, authenticate and set your project context:

**1. Sign in as admin:**

If your account has a password:
```
Use orbitnest_admin_signin with:
  email: "admin@example.com"
  password: "your-password"
```

If you signed up with **Google, GitHub, or Apple** (no password), use OAuth.
This opens your browser to complete sign-in and captures the session
automatically via a one-time localhost callback:
```
Use orbitnest_login with:
  provider: "google"   # or "github" / "apple"
```

Credentials are saved to `~/.orbitnest/credentials.json` and reloaded automatically on subsequent starts.

> `orbitnest_login` opens a browser, so run it on the machine where the MCP
> server runs. It requires `ORBITNEST_API_URL` to point at the OrbitNest API
> whose Studio hosts the OAuth callback page (default `https://api.orbitnest.io`).

**2. List your projects:**
```
Use orbitnest_list_projects
```

**3. Set active project:**
```
Use orbitnest_set_active_project with:
  projectId: "proj_abc123"
```

All subsequent tools automatically use the active project — you rarely need to specify `projectId` again.

---

## Available Tools

### Authentication (8 tools)
| Tool | Description |
|------|-------------|
| `orbitnest_admin_signin` | Sign in with email + password and save JWT credentials |
| `orbitnest_login` | Sign in with Google / GitHub / Apple via browser (for password-less accounts) |
| `orbitnest_admin_signup` | Create a new admin account |
| `orbitnest_admin_signup_verified` | Signup with email verification |
| `orbitnest_request_verification` | Request verification code |
| `orbitnest_refresh_token` | Manually refresh JWT token |
| `orbitnest_admin_signout` | Sign out and clear saved credentials |
| `orbitnest_get_profile` | Get current admin profile |

### Projects (7 tools)
| Tool | Description |
|------|-------------|
| `orbitnest_create_project` | Create project with dedicated database |
| `orbitnest_list_projects` | List all projects |
| `orbitnest_get_project` | Get project details |
| `orbitnest_update_project` | Rename or update project settings |
| `orbitnest_delete_project` | Delete project (requires `confirmDeletion: true`) |
| `orbitnest_get_project_stats` | Get project statistics |
| `orbitnest_get_project_health` | Check project health status |

### Database (12 tools)
| Tool | Description |
|------|-------------|
| `orbitnest_get_schema` | Fetch full database schema (cached 5 min) |
| `orbitnest_execute_sql` | Execute raw SQL with safety validation |
| `orbitnest_create_table` | Create a table from a structured definition |
| `orbitnest_list_tables` | List all tables |
| `orbitnest_get_table_data` | Query table data with pagination and filtering |
| `orbitnest_insert_row` | Insert a single row |
| `orbitnest_update_row` | Update a row by ID |
| `orbitnest_delete_row` | Delete a row by ID |
| `orbitnest_bulk_insert` | Insert multiple rows |
| `orbitnest_bulk_update` | Update multiple rows |
| `orbitnest_bulk_delete` | Delete multiple rows |
| `orbitnest_get_sql_history` | Retrieve SQL query history |

### Row-Level Security (6 tools)
| Tool | Description |
|------|-------------|
| `orbitnest_get_rls_status` | Check RLS status on a table |
| `orbitnest_enable_rls` | Enable RLS on a table |
| `orbitnest_disable_rls` | Disable RLS on a table |
| `orbitnest_list_policies` | List RLS policies |
| `orbitnest_create_policy` | Create a new RLS policy |
| `orbitnest_delete_policy` | Delete an RLS policy |

### Edge Functions (7 tools)
| Tool | Description |
|------|-------------|
| `orbitnest_create_function` | Create an edge function |
| `orbitnest_list_functions` | List all functions |
| `orbitnest_get_function` | Get function details |
| `orbitnest_update_function` | Update function source code |
| `orbitnest_delete_function` | Delete a function |
| `orbitnest_invoke_function` | Execute a function |
| `orbitnest_get_function_logs` | Get function execution logs |

> **Function environment:** inside a function, read env vars with `Deno.env.get('NAME')`. Available by default: `ORBITNEST_URL`, `ORBITNEST_ANON_KEY` (public/RLS-protected), `PROJECT_ID`, `PROJECT_URL`, `FUNCTION_NAME`, plus any project env vars you add. **`ORBITNEST_SERVICE_ROLE_KEY` (RLS-bypassing) is NOT provided by default** — if a function needs privileged DB access, add it as a project env var (copy the service_role key from the dashboard → API Keys, or use `orbitnest_create_env_variable`). See `docs/known-issues.md` §7.

### Storage (9 tools)
| Tool | Description |
|------|-------------|
| `orbitnest_list_buckets` | List storage buckets |
| `orbitnest_create_bucket` | Create a new bucket |
| `orbitnest_upload_file` | Upload a file to a bucket |
| `orbitnest_download_file` | Download a file |
| `orbitnest_list_files` | List files in a bucket |
| `orbitnest_delete_files` | Delete files |
| `orbitnest_delete_bucket` | Delete a bucket |
| `orbitnest_get_bucket_size` | Get bucket storage usage |
| `orbitnest_get_public_url` | Get a public file URL |

### Logging (6 tools)
| Tool | Description |
|------|-------------|
| `orbitnest_get_logs` | Get general logs with filtering |
| `orbitnest_get_database_logs` | Get database operation logs |
| `orbitnest_get_slow_query_logs` | Get slow query logs |
| `orbitnest_get_auth_logs` | Get authentication logs |
| `orbitnest_get_edge_function_logs` | Get edge function logs |
| `orbitnest_export_logs` | Export logs in a specified format |

### Admin Management (6 tools)
| Tool | Description |
|------|-------------|
| `orbitnest_list_admins` | List all admin users |
| `orbitnest_create_admin` | Create a new admin |
| `orbitnest_get_admin` | Get admin details |
| `orbitnest_update_admin` | Update admin settings |
| `orbitnest_delete_admin` | Delete an admin user |
| `orbitnest_update_admin_password` | Reset admin password |

### SMTP (4 tools)
| Tool | Description |
|------|-------------|
| `orbitnest_get_smtp_settings` | Get SMTP configuration |
| `orbitnest_update_smtp_settings` | Update SMTP settings |
| `orbitnest_delete_smtp_settings` | Remove SMTP configuration |
| `orbitnest_test_smtp_connection` | Test SMTP connectivity |

### Integrations (13 tools)
| Tool | Description |
|------|-------------|
| `orbitnest_get_connection_string` | Get the direct Postgres connection string (when enabled) |
| `orbitnest_get_auth_security` | End-user auth limits in force (code length, wrong codes, codes per hour, lockout) |
| `orbitnest_set_auth_security` | Change those limits (admin) |
| `orbitnest_get_ai_settings` | AI gateway keys (masked), default models and spend caps |
| `orbitnest_ai_usage` | AI calls, tokens and cost per day, model and end user |
| `orbitnest_list_webhooks` | List database webhooks |
| `orbitnest_create_webhook` | Create a signed row-change webhook |
| `orbitnest_delete_webhook` | Delete a webhook |
| `orbitnest_test_webhook` | Send a test event to a webhook |
| `orbitnest_get_sms_config` | Get the project's Twilio/SMS config |
| `orbitnest_set_sms_config` | Configure Twilio (auth token stored encrypted) |
| `orbitnest_test_sms` | Send a test SMS |
| `orbitnest_enable_extension` | Enable a Postgres extension (e.g. `vector` for pgvector) |

### AI data (6 tools)
| Tool | Description |
|------|-------------|
| `orbitnest_ai_overview` | Counts of memories, subjects, collections, documents, threads, messages, traces (24 h) and embedded columns |
| `orbitnest_list_collections` | Vector collections with model, chunking and document counts |
| `orbitnest_memory_subjects` | Subjects that have memories (`user:<id>`, `agent:support`, ...) with counts |
| `orbitnest_list_embeddings` | Automatically embedded columns with progress (rows, embedded, pending, failed, last error) |
| `orbitnest_ai_traces` | Recent AI calls: model, tokens, cost, latency, status (never prompt text) |
| `orbitnest_enable_embeddings` | Embed a table's text columns into a `vector(768)` column kept up to date (admin; requires `confirmEnable: true`) |

### Dashboard (2 tools)
| Tool | Description |
|------|-------------|
| `orbitnest_get_dashboard_stats` | Get overall statistics |
| `orbitnest_get_dashboard_activity` | Get recent activity feed |

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
orbitnest_create_table({
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
orbitnest_execute_sql({ sql: "SELECT * FROM posts ORDER BY created_at DESC LIMIT 10" })
```

**Execute a destructive query (requires explicit confirmation):**
```
orbitnest_execute_sql({
  sql: "DELETE FROM posts WHERE status = 'draft'",
  confirmDestructive: true
})
```

**Deploy an edge function:**
```
orbitnest_create_function({
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

If your project root contains `.orbitnest/config.json`, the MCP server automatically loads the project context on startup:

```json
{
  "projectId": "proj_abc123",
  "projectSlug": "my-project",
  "name": "My Project",
  "apiUrl": "https://api.orbitnest.io"
}
```

This is the same file `orbitnest link` (the CLI) writes; older CLI versions wrote `slug` instead of `projectSlug`, which is still read. `orbitnest_set_active_project` updates this file when one was found, and never creates one elsewhere.

---

## Credentials Storage

After signing in, tokens are persisted to `~/.orbitnest/credentials.json` (mode `0600`) and automatically reloaded on the next server start. Tokens are refreshed automatically when they are within 60 seconds of expiry.

---

## Troubleshooting

**Server fails to start**
- If using a local clone, run `npm run build` — the `dist/` directory must exist
- Check that Node.js v18+ is installed: `node --version`
- If using `npx github:mahtab-ali/orbitnest_mcp`, ensure you have GitHub access (SSH key or token)

**`Not authenticated` errors**
- Run `orbitnest_admin_signin` to sign in
- Credentials are stored in `~/.orbitnest/credentials.json`

**`No active project` errors**
- Run `orbitnest_list_projects` then `orbitnest_set_active_project`
- Or set `DEFAULT_PROJECT_ID` in your environment / MCP `env` block

**MCP server not appearing in VSCode**
- Ensure MCP support is enabled in the extension settings
- Confirm `npm run build` has been run if using a local clone
- Reload the VSCode window (`Ctrl+Shift+P` → `Developer: Reload Window`)
- When using `npx github:...`, the first start may take a few seconds while npm downloads the package

**MCP server not appearing in Claude Code**
- Run `claude mcp list` to see registered servers
- Re-register: `claude mcp remove orbitnest && claude mcp add orbitnest -- npx -y github:mahtab-ali/orbitnest_mcp`
- If using project-level `.mcp.json`, ensure you opened Claude Code from this project directory

**GitHub access errors during npx install**
- Add your SSH key: `ssh-add ~/.ssh/id_rsa`
- Or create a GitHub Personal Access Token with `repo` scope and set it in `~/.npmrc`:

---

## License

MIT — OrbitNest Team
