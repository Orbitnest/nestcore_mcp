# Changelog

## 2.2.0 (2026-11-25)

Hardening against untrusted workspaces (security audit NV-20, NV-21).

### Changed (may affect setups)

- **`<cwd>/.env` is no longer loaded.** MCP hosts can start the server inside
  the repository you opened, so a `.env` shipped with that repo could pick the
  API host and base path (where your admin session and the `nestcore_login`
  handoff go) or switch off `ENABLE_SQL_GUARD`. Settings now come from the real
  environment (the MCP client's `env` block). If you relied on a `.env` file,
  set `NESTCORE_ENV_FILE=/path/to/.env` (or run `node --env-file=.env
  dist/index.js`); real env vars still win over the file.
- `nestcore_login` refuses an `NESTCORE_API_BASE_PATH` that is not a plain path
  (for example `.evil.example/x` or `:8080`, which changed the host the handoff
  went to), an API URL with credentials in it, and cleartext http to anything
  but localhost.

### Fixed

- The browser for `nestcore_login` is opened without a shell. On Windows it
  used `cmd /c start` with only `&` escaped, so `|` or `^` in a configured URL
  reached cmd.exe; it now uses `rundll32 url.dll,FileProtocolHandler` like the
  CLI. On every platform only http(s) URLs without whitespace, control
  characters or shell metacharacters are opened; otherwise the URL is only
  logged.

## 2.1.0 (2026-11-25)

Security hardening of the tool modules (admin, auth, credits, integrations,
rls, function, branches, background-jobs, logging, project-intelligence, smtp,
analytics, dashboard, realtime).

### Changed (may affect callers)

- **`.` / `..` / empty identifiers are refused** in every API path segment
  (`VALIDATION_ERROR`). Previously `functionName: ".."` could resolve
  `DELETE /projects/<id>/functions/..` to the delete-project route.
- **`nestcore_get_connection_string` masks the database password** (and the
  password inside each URL) by default. Pass `revealPassword: true` to get it;
  clients with elicitation ask the user first.
- **Human confirmation (elicitation)** when the client supports it, for:
  buy_credits, removing the credit cap, set_auth_security, reset_branch,
  promote_branch with `apply: true`, create/update/delete_admin, disable_rls,
  revealing the connection password, and delete_project. A declined prompt
  returns the new `CANCELLED` error code. Without elicitation, behaviour falls
  back to the tools' own confirm flags plus annotations.
- In Code Mode, `set_auth_security` needs `confirm: true` (or the user prompt).
- **Input bounds** on limits, ports, payload sizes, names, source code,
  policy SQL, memory records, URLs (webhooks must be http/https) and phone
  numbers; out-of-range values that used to pass are now rejected.

### Added

- Results that contain third-party text (logs, function/job source and logs,
  project memory, analytics names, activity, webhooks, RLS policies, branch
  diffs) carry a second content block marking the text as untrusted data, not
  instructions; Code Mode `execute` results get an `untrusted` field instead.
- Accurate tool annotations on every tool (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`).
- Secret redaction extended to SMTP, SMS (Twilio), webhook, admin and profile
  results.

## 2.0.0 (2026-11-23)

### Breaking

- **Code Mode is the default.** `tools/list` now returns three tools:
  `search` (find API methods, returns TypeScript declarations), `execute` (run a
  JavaScript snippet that calls them as `await nestcore.<namespace>.<method>(args)`
  in a QuickJS/WebAssembly sandbox) and `nestcore_login`. Set
  `NESTCORE_MCP_MODE=tools` for the 1.x tool list, or `both` for both. Scripts
  and permission rules that name individual `nestcore_*` tools need `tools` mode.
- **Failed tool calls return `isError: true`.** The text is unchanged (the
  `{ error, code, ... }` JSON); clients that branch on `isError` now see these
  calls as failures.
- **SQL guard on more paths.** `nestcore_create_table` validates the SQL it
  generates (statement chaining in a `DEFAULT`, auth tables) and
  `nestcore_run_migrations` validates every pending migration before running
  any; a migration that mutates `auth_*` tables is refused with `SAFETY_ERROR`.

### Added

- Code Mode settings: `NESTCORE_MCP_MODE`, `NESTCORE_MCP_ALLOW_WRITES` (read
  methods and read-only SQL only), `NESTCORE_MCP_EXEC_TIMEOUT_MS` (30000),
  `NESTCORE_MCP_EXEC_MEMORY_MB` (128), `NESTCORE_MCP_EXEC_MAX_CALLS` (50),
  `NESTCORE_MCP_EXEC_MAX_OUTPUT_BYTES` (100000).
- Destructive methods without their own confirm flag (`projects.setStatus`,
  `projects.createApiKeys`, `functions.deleteEnvVariable`, `webhooks.delete`,
  `migrations.run`, `credits.buy`) need `confirm: true` inside `execute`, or an
  elicitation prompt when the client supports it.
- MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) on
  every tool, from one classification table (read / write / destructive / session).
- Code-mode server instructions and `nestcore_load_project` prompt text.
- Tests: `code-mode-unit`, `code-mode-sandbox`, `code-mode-guards` (in
  `npm test`) and the opt-in `code-mode-e2e` context-cost comparison.
- Dependencies: `quickjs-emscripten-core` and `@jitl/quickjs-wasmfile-release-sync`
  (pure WebAssembly, no native build).

### Fixed

- README: tool list regenerated from the code (133 tools; it listed tools that
  no longer exist and missed jobs, analytics, migrations, branches, realtime and
  Project Intelligence).

## 1.9.0

- `nestcore_login` uses the PKCE sign-in handoff: the browser returns a
  one-time code that the server exchanges itself, so no token passes through a
  URL. Cancel in the browser stops the wait at once.
- Project tools never pass secret fields (JWT secret, database passwords, key
  hashes) to the model.
