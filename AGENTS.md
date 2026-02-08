# AGENTS.md

Repository playbook for agentic coding tools working in `ContextFS`.
This document is evidence-based from current repo files and scripts.

## Repository Scope

- Primary runtime code: `.opencode/plugins/contextfs/src/*.mjs`
- Plugin entry: `.opencode/plugins/contextfs.plugin.mjs`
- CLI entry: `.opencode/plugins/contextfs/cli.mjs`
- Tool bridge: `.opencode/tools/contextfs.ts`
- Unit tests: `.opencode/plugins/contextfs/test/contextfs.test.mjs`
- Regression suite: `scripts/regression-contextfs.mjs`

## Environment and Module System

- Node.js ESM is used for plugin/runtime JS (`"type": "module"` in `.opencode/plugins/contextfs/package.json`).
- Source files use `.mjs` modules with named exports.
- TypeScript appears only in the tool bridge (`.opencode/tools/contextfs.ts`).

## Source of Truth for Commands

- Root scripts: `package.json`
- Plugin scripts: `.opencode/plugins/contextfs/package.json`
- Command docs: `README.md` and `.opencode/plugins/contextfs/README.md`

## Build / Lint / Test Commands

### Install

- Root dependencies (if needed by your environment): `npm install`
- Plugin-local tests do not require a bundler.

### Build

- No dedicated build script exists in root `package.json`.
- No transpilation step is required for `.mjs` runtime code.

### Lint / Format

- No lint script is currently defined.
- No formatter config (Prettier/Biome/ESLint config) is present.
- Follow existing style in source files instead of introducing new style systems.

### Test (Full)

- Root unit entry: `npm run test:contextfs:unit`
- Root regression entry: `npm run test:contextfs:regression`
- Plugin-local unit entry: `npm test --prefix .opencode/plugins/contextfs`

### Test (Single Test)

- Single test by name (from repo root):
  - `node --test --test-name-pattern="appendHistory handles 15 concurrent writes" ./.opencode/plugins/contextfs/test/contextfs.test.mjs`
- Single test by name (from plugin dir):
  - `node --test --test-name-pattern="writeText waits for lock release and retries" ./test/contextfs.test.mjs`
- Note: there is no dedicated npm alias for single-test runs yet.

### Run Regression Script Directly

- `node scripts/regression-contextfs.mjs`
- This runs TEST-1..TEST-6 sequentially and prints table + JSON summary.

## Manual Runtime Validation Commands

- `node .opencode/plugins/contextfs/cli.mjs ls`
- `node .opencode/plugins/contextfs/cli.mjs pin "must keep scope small"`
- `node .opencode/plugins/contextfs/cli.mjs compact`
- `node .opencode/plugins/contextfs/cli.mjs pack`

## Cursor / Copilot Rules

- `.cursorrules`: not found.
- `.cursor/rules/`: not found.
- `.github/copilot-instructions.md`: not found.
- If these are added later, update this file and treat them as highest-priority local policy.

## Code Style Conventions (Observed)

### Imports and Modules

- Use ESM imports with double quotes.
- Node built-ins are imported via `node:` specifiers (for example `node:fs/promises`, `node:path`).
- Typical import order is:
  1) Node built-ins
  2) local project modules
  3) blank line between groups
- Prefer named imports for local modules; default imports used for Node APIs when appropriate.

### Naming

- Functions/variables: `camelCase` (`safeTrim`, `mergeConfig`, `maybeCompact`).
- Classes: `PascalCase` (`ContextFsStorage`).
- Constants: `UPPER_SNAKE_CASE` for module-level fixed values (`DEFAULT_CONFIG`, `FILES`, regex constants).
- Test names are descriptive sentence strings in `test("...", ...)`.

### Formatting

- Semicolons are used consistently.
- Two-space indentation.
- Trailing commas are used in multiline arrays/objects/args.
- Keep helpers small and focused.
- Prefer early returns to reduce nesting.

### Strings

- Prefer template literals for composed output.
- Keep user-facing command output human-readable and line-oriented.
- Use explicit section markers in generated context blocks.

### Types and Type Safety

- JS runtime code is untyped but intentionally strict about normalization (`String(...)`, `Number(...)`).
- TS bridge keeps explicit argument typing for subprocess wrappers.
- Do not add `any`-style escapes in TS unless absolutely unavoidable.

### Async and Concurrency

- Use `async/await` over raw promise chains.
- Critical storage writes are lock-protected (`acquireLock` / `releaseLock`).
- Atomic write pattern is `write temp -> rename`.
- For concurrent tests, use `Promise.allSettled` and assert `rejected === 0` plus file parse integrity.

### Error Handling

- Throw explicit errors for hard failures (for example lock timeout).
- Use narrow `try/catch` for best-effort cleanup (unlink temp files, lock release).
- Avoid swallowing errors unless operation is explicitly optional/cleanup-only.
- CLI/process entrypoints set `process.exitCode` and print stack/message to stderr on failure.

### Data and File IO

- Runtime state is under `.contextfs/` (or configured dir).
- History is NDJSON (`history.ndjson`), one JSON object per line.
- State file is formatted JSON with trailing newline.
- Manifest/pins/summary are markdown text files with stable headers.

### Testing Style

- Use Node built-in test runner (`node:test`) + `node:assert/strict`.
- Test behavior, not implementation details.
- For filesystem tests, create isolated temp directories and clean up in `finally`.
- Concurrency tests must validate:
  - rejected writes count
  - line count expectations
  - JSON parseability of each line

## Implementation Guardrails for Agents

- Keep changes minimal and local; avoid architecture rewrites.
- Match existing file layout and naming before introducing new modules.
- Prefer adding focused tests when changing storage/concurrency behavior.
- Do not silently change config semantics; document user-facing behavior in README.
- If changing command outputs, keep machine- and human-readable patterns stable.

## Known Gaps (Current Repo State)

- No linting pipeline configured.
- No formal CI workflow committed yet.
- No single-test npm convenience script (use `node --test --test-name-pattern`).

## Fast Path Checklist for Agents

1) Read `package.json` and `.opencode/plugins/contextfs/package.json` first.
2) Run `npm run test:contextfs:unit` before and after code edits.
3) If storage logic changed, run `npm run test:contextfs:regression`.
4) Update `README.md` and/or `.opencode/plugins/contextfs/README.md` when behavior changes.
5) Keep this `AGENTS.md` in sync with real commands and conventions.
