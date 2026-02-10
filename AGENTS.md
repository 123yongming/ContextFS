# AGENTS.md

Repository playbook for coding agents working in `D:\code\python_code\ContextFS`.
All commands and conventions below are grounded in current repository files.

## 1) Repository Map

- Core plugin runtime: `.opencode/plugins/contextfs/src/*.mjs`
- Plugin entry: `.opencode/plugins/contextfs.plugin.mjs`
- CLI entry: `.opencode/plugins/contextfs/cli.mjs`
- Tool bridge (TS): `.opencode/tools/contextfs.ts`
- Plugin tests: `.opencode/plugins/contextfs/test/contextfs.test.mjs`
- Regression script: `scripts/regression-contextfs.mjs`
- Bench scripts: `bench/*.mjs`
- Bench tests: `bench/bench.test.mjs`
- Repo docs: `README.md`, `.opencode/plugins/contextfs/README.md`

## 2) Runtime / Stack Facts

- Plugin package is ESM (`"type": "module"` in `.opencode/plugins/contextfs/package.json`).
- Runtime implementation is plain `.mjs` (Node.js), no transpile/build pipeline.
- TypeScript is only used for the OpenCode tool bridge (`.opencode/tools/contextfs.ts`).
- Tests use Node's built-in test runner (`node --test`), not Jest/Vitest.

## 3) Authoritative Command Sources

- Root scripts: `package.json`
- Plugin scripts: `.opencode/plugins/contextfs/package.json`
- Command examples: `README.md`
- Test naming patterns: `.opencode/plugins/contextfs/test/contextfs.test.mjs`, `bench/bench.test.mjs`

## 4) Install / Build / Lint / Test Commands

### Install

- `npm install`
- `npm install --prefix .opencode/plugins/contextfs` (plugin-local install when needed)

### Build

- No `build` script in root `package.json`.
- No transpilation step for plugin runtime.

### Lint / Format

- No lint script defined in `package.json`.
- No ESLint / Prettier / Biome config detected.
- Follow existing file style; do not add new lint/format tooling unless requested.

### Tests (full)

- Unit (root entrypoint): `npm run test:contextfs:unit`
- Regression: `npm run test:contextfs:regression`
- Plugin-local unit: `npm test --prefix .opencode/plugins/contextfs`
- Bench test suite: `node --test bench/bench.test.mjs`

### Tests (single test)

- Single plugin test from repo root:
  - `node --test --test-name-pattern="appendHistory handles 15 concurrent writes" ./.opencode/plugins/contextfs/test/contextfs.test.mjs`
- Single bench test from repo root:
  - `node --test --test-name-pattern="timing fields are sane in jsonl outputs" ./bench/bench.test.mjs`
- Single plugin test from plugin dir:
  - `node --test --test-name-pattern="writeText waits for lock release and retries" ./test/contextfs.test.mjs`

### Bench runs

- ContextFS E2E: `npm run bench:e2e -- --turns 3000 --avgChars 400 --variance 0.6 --seed 42`
- Naive baseline: `npm run bench:naive -- --turns 3000 --avgChars 400 --variance 0.6 --seed 42`
- AB comparison: `npm run bench -- --turns 3000 --avgChars 400 --variance 0.6 --seed 42 --orders 1`
- AB+BA comparison: `npm run bench -- --turns 3000 --avgChars 400 --variance 0.6 --seed 42 --orders 2`

### CLI sanity checks

- `node .opencode/plugins/contextfs/cli.mjs ls`
- `node .opencode/plugins/contextfs/cli.mjs stats`
- `node .opencode/plugins/contextfs/cli.mjs search "lock timeout" --k 5`
- `node .opencode/plugins/contextfs/cli.mjs timeline H-abc12345 --before 3 --after 3`
- `node .opencode/plugins/contextfs/cli.mjs get H-abc12345 --head 1200`
- `node .opencode/plugins/contextfs/cli.mjs pack`

## 5) Cursor / Copilot Rules

- `.cursorrules`: not found
- `.cursor/rules/`: not found
- `.github/copilot-instructions.md`: not found

If these files are added later, treat them as higher-priority local policy and update this file.

## 6) Code Style (Observed Conventions)

### Imports

- Use ESM imports with double quotes.
- Import Node built-ins via `node:` specifiers.
- Group imports by origin (built-ins, then local), with a blank line between groups when both exist.

### Formatting

- Semicolons are used consistently.
- Two-space indentation.
- Trailing commas in multiline literals/calls.
- Prefer small helpers + early returns to keep nesting shallow.

### Naming

- Functions/variables: `camelCase` (examples: `mergeConfig`, `safeTrim`, `maybeCompact`).
- Classes: `PascalCase` (example: `ContextFsStorage`).
- Module constants: `UPPER_SNAKE_CASE` (examples: `DEFAULT_CONFIG`, `FILES`, `RETRYABLE_LOCK_ERRORS`).
- Tests: sentence-style names in `test("...", ...)`.

### Types and Validation

- Normalize user/runtime input explicitly (`String(...)`, `Number(...)`, boolean parsing).
- Clamp numeric config values at boundaries (`clampInt`).
- In `.opencode/tools/contextfs.ts`, keep typed function signatures; avoid `any` escape hatches.

### Async / Concurrency / I/O

- Prefer `async/await`.
- Storage writes are lock-aware (`acquireLock`, `releaseLock`).
- Atomic write pattern is used where needed (temp file then rename).
- History format is NDJSON (`history.ndjson`), one JSON object per line.

### Error Handling

- Throw explicit errors for hard failures (example: lock timeout path).
- Use narrow `try/finally` for lock release and temp file cleanup.
- CLI catches top-level errors, writes to stderr, and sets `process.exitCode = 1`.
- Do not silently swallow non-optional errors.

### Strings and Output

- Prefer template literals for composed output.
- Keep CLI output line-oriented and readable.
- Preserve stable markdown/json headers and trailing newline conventions in persisted files.

### Test Style

- Use `node:test` + `node:assert/strict`.
- Create temp directories and always clean up in `finally`.
- For concurrency tests, assert both operation success and file parse integrity.
- For schema/timing tests, validate nested key parity and timing invariants.

## 7) Agent Guardrails for This Repo

- Keep edits focused; avoid broad refactors unless requested.
- Match existing `.mjs` patterns before introducing new abstractions.
- If storage/compaction logic changes, run unit + regression suites.
- If bench logic changes, run `node --test bench/bench.test.mjs` and at least one `npm run bench ...` command.
- Update README docs when user-visible behavior or commands change.

## 8) Quick Execution Checklist

1. Read `package.json` and `.opencode/plugins/contextfs/package.json` first.
2. Run `npm run test:contextfs:unit` before/after core logic changes.
3. Run `npm run test:contextfs:regression` after storage/compaction/retrieval changes.
4. Run bench tests when touching `bench/*`.
5. Keep this `AGENTS.md` synchronized with actual scripts and behavior.
