# AGENTS.md

Repository playbook for coding agents working in `D:\code\python_code\ContextFS`.
All commands and conventions below are evidence-based from current repo files.

## 1) Repository Map

- Core plugin runtime: `.opencode/plugins/contextfs/src/*.mjs`
- Plugin entry: `.opencode/plugins/contextfs.plugin.mjs`
- CLI entry: `.opencode/plugins/contextfs/cli.mjs`
- Tool bridge: `.opencode/tools/contextfs.ts`
- Plugin unit tests: `.opencode/plugins/contextfs/test/contextfs.test.mjs`
- Regression script: `scripts/regression-contextfs.mjs`
- Benchmark scripts: `bench/*.mjs`
- Benchmark tests: `bench/bench.test.mjs`

## 2) Module / Runtime Facts

- Plugin package is ESM (`"type": "module"` in `.opencode/plugins/contextfs/package.json`).
- Runtime code is plain JS `.mjs`; no compile/build step is required.
- TypeScript is only used in the tool bridge (`.opencode/tools/contextfs.ts`).

## 3) Authoritative Command Sources

- Root scripts: `package.json`
- Plugin scripts: `.opencode/plugins/contextfs/package.json`
- User docs: `README.md`, `.opencode/plugins/contextfs/README.md`

## 4) Build / Lint / Test / Benchmark Commands

### Install

- `npm install` (root)
- `npm install --prefix .opencode/plugins/contextfs` (plugin-local if needed)

### Build

- No build script exists in root `package.json`.
- No transpilation pipeline exists for plugin runtime.

### Lint / Format

- No lint script is defined.
- No ESLint/Prettier/Biome config is present.
- Follow existing in-file style; do not introduce a new formatter/linter setup unless requested.

### Tests (full)

- Root unit tests: `npm run test:contextfs:unit`
- Root regression tests: `npm run test:contextfs:regression`
- Plugin-local tests: `npm test --prefix .opencode/plugins/contextfs`
- Benchmark tests: `node --test bench/bench.test.mjs`

### Tests (single test)

- Single plugin test (from repo root):
  - `node --test --test-name-pattern="appendHistory handles 15 concurrent writes" ./.opencode/plugins/contextfs/test/contextfs.test.mjs`
- Single benchmark test (from repo root):
  - `node --test --test-name-pattern="timing fields are sane in jsonl outputs" ./bench/bench.test.mjs`
- Single plugin test (from plugin directory):
  - `node --test --test-name-pattern="writeText waits for lock release and retries" ./test/contextfs.test.mjs`

### Benchmark runs

- ContextFS E2E: `npm run bench:e2e -- --turns 3000 --avgChars 400 --variance 0.6 --seed 42`
- Naive baseline: `npm run bench:naive -- --turns 3000 --avgChars 400 --variance 0.6 --seed 42`
- Compare AB only: `npm run bench -- --turns 3000 --avgChars 400 --variance 0.6 --seed 42 --orders 1`
- Compare AB+BA: `npm run bench -- --turns 3000 --avgChars 400 --variance 0.6 --seed 42 --orders 2`

### CLI sanity checks

- `node .opencode/plugins/contextfs/cli.mjs ls`
- `node .opencode/plugins/contextfs/cli.mjs pin "must keep scope small"`
- `node .opencode/plugins/contextfs/cli.mjs compact`
- `node .opencode/plugins/contextfs/cli.mjs pack`

## 5) Cursor / Copilot Rules

- `.cursorrules`: not found
- `.cursor/rules/`: not found
- `.github/copilot-instructions.md`: not found

If any of these files are later added, treat them as higher-priority local policy and update this file.

## 6) Code Style Guidelines (Observed in Current Code)

### Imports

- Use ESM imports with double quotes.
- Import Node built-ins via `node:` specifiers.
- Keep imports grouped: built-ins first, then local modules, with a blank line between groups.

### Formatting

- Use semicolons.
- Use two-space indentation.
- Use trailing commas in multiline objects/arrays/calls.
- Prefer short helpers and early returns to reduce nesting.

### Naming

- Variables/functions: `camelCase` (`mergeConfig`, `maybeCompact`, `safeTrim`).
- Classes: `PascalCase` (`ContextFsStorage`).
- Constants: `UPPER_SNAKE_CASE` for module-level fixed values (`DEFAULT_CONFIG`, `FILES`).
- Tests: descriptive sentence-style names in `test("...", ...)`.

### Strings and output

- Prefer template literals for assembled text.
- Keep CLI/script output line-oriented and readable.
- For persisted markdown/json content, keep stable headers and newline conventions.

### Types and validation

- Runtime JS code normalizes inputs explicitly (`String(...)`, `Number(...)`, clamping helpers).
- In TS bridge, keep strict argument typing; avoid `any`-style escapes unless absolutely necessary.

### Async / concurrency / I/O

- Prefer `async/await` over promise chains.
- Storage writes are lock-aware (`acquireLock` / `releaseLock`).
- Use atomic write pattern (`write temp -> rename`) where implemented.
- History is NDJSON (`history.ndjson`), one JSON object per line.

### Error handling

- Throw explicit errors for hard failures (example: lock timeout).
- Use narrow `try/finally` for lock release and cleanup.
- Do not silently swallow non-optional errors.
- CLI entrypoints should print errors to stderr and set `process.exitCode = 1`.

### Test style

- Use Node test runner: `node:test` + `node:assert/strict`.
- Create temp dirs for filesystem tests and always clean up in `finally`.
- For concurrency tests, verify both success counts and file integrity/parsability.
- For schema tests, compare nested key/type parity and check timing invariants explicitly.

## 7) Agent Guardrails for This Repo

- Keep changes focused and minimal; avoid broad refactors unless requested.
- Match existing `.mjs` patterns before introducing new abstractions.
- If storage/compaction behavior changes, run both unit and regression tests.
- If benchmark behavior changes, run `node --test bench/bench.test.mjs` and at least one `npm run bench ...` command.
- Update `README.md` when user-facing commands/outputs change.

## 8) Quick Execution Checklist

1. Read `package.json` and `.opencode/plugins/contextfs/package.json` first.
2. Run `npm run test:contextfs:unit` before/after core changes.
3. Run `npm run test:contextfs:regression` after storage/compaction changes.
4. Run benchmark tests if touching `bench/*`.
5. Keep this `AGENTS.md` aligned with actual scripts and behavior.
