# AGENTS.md

Agent playbook for `D:\code\python_code\ContextFS`.
Use this as the authoritative quick-start for coding, testing, and style in this repo.

## 1) Repo Layout

- Root scripts: `package.json`
- Plugin package: `.opencode/plugins/contextfs/package.json`
- Plugin entry: `.opencode/plugins/contextfs.plugin.mjs`
- CLI entry: `.opencode/plugins/contextfs/cli.mjs`
- Runtime source: `.opencode/plugins/contextfs/src/*.mjs`
- Tool bridge (TypeScript): `.opencode/tools/contextfs.ts`
- Unit tests: `.opencode/plugins/contextfs/test/contextfs.test.mjs`
- Regression script: `scripts/regression-contextfs.mjs`
- Bench scripts/tests: `bench/*.mjs`
- User docs: `README.md`

## 2) Stack Facts

- Node.js project, plugin is ESM (`"type": "module"`).
- Runtime logic is plain `.mjs`; no transpile/build pipeline.
- Tests use Node built-in test runner (`node --test`).

## 3) Rule Files (Cursor / Copilot)

Checked paths:

- `.cursorrules`: not found
- `.cursor/rules/`: not found
- `.github/copilot-instructions.md`: not found

If any of these appear later, treat them as higher-priority local instructions and update this file.

## 4) Install / Build / Lint / Test

### Install

- Root install: `npm install`
- Plugin-only install (if needed): `npm install --prefix .opencode/plugins/contextfs`

### Build

- No build script exists in root `package.json`.
- No compile step required for plugin runtime.

### Lint / Format

- No lint script exists in root or plugin `package.json`.
- No ESLint/Prettier/Biome config detected.
- Follow existing style exactly; do not introduce new tooling unless requested.

### Test (full suites)

- Root unit entry: `npm run test:contextfs:unit`
- Root regression entry: `npm run test:contextfs:regression`
- Plugin unit direct: `npm test --prefix .opencode/plugins/contextfs`
- Bench tests: `node --test bench/bench.test.mjs`

### Test (single test)

Run one test by name pattern:

- Plugin test from repo root:
  - `node --test --test-name-pattern="compacted turns remain retrievable via archive fallback" ./.opencode/plugins/contextfs/test/contextfs.test.mjs`
- Another plugin example:
  - `node --test --test-name-pattern="ctx reindex preserves raw duplicate archive ids for get/search consistency" ./.opencode/plugins/contextfs/test/contextfs.test.mjs`
- Bench single test:
  - `node --test --test-name-pattern="timing fields are sane in jsonl outputs" ./bench/bench.test.mjs`

### Bench commands

- `npm run bench:e2e -- --turns 3000 --avgChars 400 --variance 0.6 --seed 42`
- `npm run bench:naive -- --turns 3000 --avgChars 400 --variance 0.6 --seed 42`
- `npm run bench -- --turns 3000 --avgChars 400 --variance 0.6 --seed 42 --orders 2`

## 5) ContextFS CLI Sanity Commands

- `node .opencode/plugins/contextfs/cli.mjs ls`
- `node .opencode/plugins/contextfs/cli.mjs stats`
- `node .opencode/plugins/contextfs/cli.mjs search "lock timeout" --k 5 --scope all`
- `node .opencode/plugins/contextfs/cli.mjs timeline H-abc12345 --before 3 --after 3`
- `node .opencode/plugins/contextfs/cli.mjs get H-abc12345 --head 1200`
- `node .opencode/plugins/contextfs/cli.mjs reindex`

## 6) Coding Conventions (Observed)

### Imports

- Use ESM imports.
- Use `node:` specifiers for Node built-ins.
- Keep built-in imports before local imports, separated by one blank line.
- Use double quotes and trailing semicolons.

### Formatting

- Two-space indentation.
- Semicolons enabled.
- Prefer trailing commas in multiline arrays/objects/calls.
- Prefer early returns and small helpers over deep nesting.

### Naming

- Variables/functions: `camelCase`.
- Classes: `PascalCase` (example: `ContextFsStorage`).
- Constants: `UPPER_SNAKE_CASE` (`FILES`, `RETRYABLE_LOCK_ERRORS`).
- Test names: descriptive sentence-style strings in `test("...", ...)`.

### Types and Input Handling

- Normalize all external input (`String(...)`, `Number(...)`, trim, guards).
- Validate and clamp config values at boundaries.
- Avoid `any` in TypeScript bridge code unless explicitly justified.
- Keep runtime schemas stable (history/index rows have explicit fields).

### Async, I/O, and Concurrency

- Use `async/await` consistently.
- Use lock-aware writes via storage helpers.
- Keep atomic write behavior for files requiring consistency.
- History files are NDJSON (one JSON object per line).
- Archive behavior:
  - `history.ndjson` = hot recent turns
  - `history.archive.ndjson` = compacted historical rows
  - `history.archive.index.ndjson` = retrieval index for archive rows

### Error Handling

- Throw explicit errors for hard failures.
- Use narrow `try/finally` blocks for lock release/cleanup.
- Do not silently swallow unexpected errors.
- CLI layer should return structured error results and non-zero exit on fatal failure.

### Output and UX

- Keep CLI output stable and line-oriented.
- JSON output must remain parseable and backward-safe where possible.


## 7) Testing Expectations by Change Type

- If changing `src/storage.mjs`, `src/compactor.mjs`, or retrieval logic:
  - Run `npm run test:contextfs:unit`
  - Run `npm run test:contextfs:regression`
- If changing bench code:
  - Run `node --test bench/bench.test.mjs`
  - Run at least one bench command
- If changing CLI behavior:
  - Run at least one `cli.mjs` sanity command from section 5

## 8) Agent Guardrails

- Keep edits focused; do not refactor unrelated modules.
- Preserve existing CLI contract unless change is explicitly requested.
- Update `README.md` when user-visible behavior/flags change.
- Never commit secrets or generated runtime state (`.contextfs/`, lock files).

## 9) Repo-Specific Notes

- `.contextfs/` is runtime data and ignored.
- `docs/` is currently ignored in `.gitignore`; use `git add -f` only when docs must be committed.
- When adding new commands/flags, update both docs and tests in the same change.

## 10) Quick Checklist Before Hand-off

1. Commands verified from `package.json` files (root + plugin).
2. Relevant tests run (full or single-target with `--test-name-pattern`).
3. README/AGENTS updated if behavior or workflow changed.
