# Changelog

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
