# AGENTS.md
Agent playbook for `D:\code\python_code\ContextFS`.
Use this as the default operating guide for coding agents in this repo.

## 1) Repository Map
- Root scripts: `package.json`
- OpenCode package: `.opencode/package.json`
- Plugin package: `.opencode/plugins/contextfs/package.json`
- Plugin entry: `.opencode/plugins/contextfs.plugin.mjs`
- CLI entry: `.opencode/plugins/contextfs/cli.mjs`
- Runtime source: `.opencode/plugins/contextfs/src/*.mjs`
- SQLite/index code: `.opencode/plugins/contextfs/src/index/sqlite_store.mjs`
- Tool bridge (TypeScript): `.opencode/tools/contextfs.ts`
- Plugin tests: `.opencode/plugins/contextfs/test/*.mjs`
- Regression script: `scripts/regression-contextfs.mjs`
- Bench scripts/tests: `bench/*.mjs`
- Docs: `README.md`, `.opencode/plugins/contextfs/README.md`

## 2) Stack and Runtime Facts
- Node.js project; plugin is ESM (`"type": "module"`).
- Runtime is plain `.mjs` (no transpile/build pipeline).
- Tests use Node built-in test runner (`node --test`).
- SQLite support is via optional deps: `better-sqlite3` and `sqlite-vec`.
- If optional SQLite deps are unavailable, search paths degrade gracefully.

## 3) Cursor / Copilot Rules
Checked paths:
- `.cursorrules`
- `.cursor/rules/**`
- `.github/copilot-instructions.md`

Result:
- No Cursor or Copilot rule files were found in this repository.

## 4) Install / Build / Lint / Test Commands
### Install
- Root install: `npm install`
- Plugin-only install: `npm install --prefix .opencode/plugins/contextfs`

### Build
- No `build` script exists at root or plugin level.
- Treat this repo as no-compile runtime JS/TS tooling.

### Lint / Format
- No lint/format scripts are defined in package scripts.
- No ESLint/Prettier/Biome config detected.
- Follow existing style; avoid introducing new tooling unless requested.

### Test Suites (full)
- Plugin tests via root alias: `npm run test:contextfs:unit`
- Plugin tests direct: `npm test --prefix .opencode/plugins/contextfs`
- Regression tests: `npm run test:contextfs:regression`
- Bench tests: `node --test ./bench/bench.test.mjs`

Important:
- Plugin tests run with `--test-isolation=none`; preserve this for direct Node commands.

### Single-Test Commands
Use Node name filtering with `--test-name-pattern`:
- Plugin single test (direct):
  - `node --test --test-isolation=none --test-name-pattern="compacted turns remain retrievable via archive fallback" ./.opencode/plugins/contextfs/test/contextfs.test.mjs`
- Plugin single test (via npm):
  - `npm test --prefix .opencode/plugins/contextfs -- --test-name-pattern="estimateTokens is stable and monotonic"`
- MCP integration single test:
  - `node --test --test-isolation=none --test-name-pattern="save_memory returns WRITE payload" ./.opencode/plugins/contextfs/test/contextfs.mcp.test.mjs`
- Bench single test:
  - `node --test --test-name-pattern="timing fields are sane in jsonl outputs" ./bench/bench.test.mjs`

### Bench Run Examples
- `npm run bench -- --turns 3000 --avgChars 400 --variance 0.6 --seed 42 --orders 2`
- `npm run bench:e2e`
- `npm run bench:naive`

## 5) ContextFS CLI Sanity Commands
- `node .opencode/plugins/contextfs/cli.mjs ls`
- `node .opencode/plugins/contextfs/cli.mjs stats`
- `node .opencode/plugins/contextfs/cli.mjs search "lock timeout" --k 5 --scope all`
- `node .opencode/plugins/contextfs/cli.mjs timeline H-abc12345 --before 3 --after 3`
- `node .opencode/plugins/contextfs/cli.mjs get H-abc12345 --head 1200`
- `node .opencode/plugins/contextfs/cli.mjs doctor --json`
- `node .opencode/plugins/contextfs/cli.mjs reindex --full --vectors`

Preferred interactive mode (OpenCode chat): `/ctx ...`.

## 6) Code Style and Implementation Conventions
### Imports
- Use ESM `import` syntax in `.mjs` and `.ts` files.
- Use `node:` specifiers for built-ins (`node:fs/promises`, `node:path`, etc.).
- Put built-in imports before local imports.
- Keep one blank line between import groups.
- Prefer double quotes.

### Formatting
- Two-space indentation.
- Prefer trailing commas in multiline arrays/objects/calls.
- Prefer small helpers and early returns over deep nesting.
- Keep semicolon style consistent with the touched file (mixed in repo).
- Do not reformat unrelated lines.

### Naming
- Variables/functions: `camelCase`
- Classes/types: `PascalCase`
- Constants: `UPPER_SNAKE_CASE`
- Test names: descriptive sentence-style `test("...", ...)`

### Types and Input Normalization
- Normalize external input with `String(...)`, `Number(...)`, `.trim()`.
- Clamp numeric config values in a single normalization path.
- Keep row shapes explicit and stable (`id`, `ts`, `role`, `type`, `session_id`, `refs`, `text`).
- In TypeScript bridge code, avoid `any` unless there is clear, local justification.

### Async / I/O / Concurrency
- Use `async/await` consistently.
- Preserve lock-aware writes and atomic write patterns.
- Keep history files in NDJSON format (one JSON object per line).
- Preserve history split contract:
  - `history.ndjson`: hot/recent turns
  - `history.archive.ndjson`: compacted historical turns
  - `history.embedding.hot.ndjson` and `.archive.ndjson`: vector source rows

### Error Handling
- Throw explicit errors for hard failures.
- Use narrow `try/finally` for lock cleanup/recovery.
- Avoid swallowing errors silently unless behavior is intentionally best-effort.
- Keep CLI failures structured with non-zero exit code on fatal errors.

### Configuration and Contracts
- Canonical defaults/clamping: `.opencode/plugins/contextfs/src/config.mjs`.
- Runtime overrides:
  - `globalThis.CONTEXTFS_CONFIG = { ... }`
  - `.opencode/plugins/contextfs/.env`
  - `CONTEXTFS_DEBUG=1` for debug logging
- Preserve JSON contracts:
  - `ctx search --json` / `ctx timeline --json` return L0 rows with `layer: "L0"`
  - `ctx get --json` returns L2 payload with `layer: "L2"`
  - `ctx save --json` returns WRITE payload

### Retrieval / Index Notes
- `history*.ndjson` is source-of-truth data.
- `index.sqlite` is derived index data for lexical/vector retrieval.
- Do not assume sqlite row count equality implies semantic parity; use `ctx doctor` and reindex paths where needed.

## 7) Test Scope by Change Type
- If touching storage/compaction/retrieval (`src/storage.mjs`, `src/compactor.mjs`, `src/commands.mjs`, `src/index/sqlite_store.mjs`):
  - Run `npm run test:contextfs:unit`
  - Run `npm run test:contextfs:regression`
- If touching MCP/tool bridge (`mcp-server.mjs`, `.opencode/tools/contextfs.ts`):
  - Run plugin tests including MCP coverage
  - Run at least one CLI sanity command
- If touching bench logic:
  - Run `node --test ./bench/bench.test.mjs`
  - Run one bench script (`bench` or `bench:e2e`)
- If touching CLI output/flags:
  - Run at least two CLI sanity commands, including one `--json` path

## 8) Agent Guardrails
- Keep edits focused; avoid unrelated refactors.
- Preserve CLI command names and output fields unless explicitly requested.
- Update user docs when behavior/flags/contracts change.
- Never commit runtime state (`.contextfs/`) or lock files.
- Do not hand-edit generated runtime artifacts except for debugging.

## 9) Repo Notes
- `.contextfs/` contains runtime data and should remain ignored.
- `docs/` is gitignored; force-add only when intentionally committing docs.
- Root `.opencode/package.json` only provides OpenCode plugin dependency.
- Plugin optional dependencies may fail to install in some environments; code should handle graceful fallback.

## 10) Handoff Checklist
1. Confirm commands against current `package.json` scripts.
2. Run relevant tests (full or targeted via `--test-name-pattern`).
3. Re-check CLI JSON/text output compatibility after changes.
4. Update `README.md` and `AGENTS.md` when user-visible behavior changed.
