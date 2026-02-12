# AGENTS.md
Agent playbook for `D:\code\python_code\ContextFS`.
Use this as the quick-start reference for coding agents working in this repo.

## 1) Repository Map
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

## 2) Stack and Runtime Facts
- Node.js project; plugin package is ESM (`"type": "module"`).
- Runtime code is plain `.mjs`; no transpile/build step.
- Test runner is Node built-in test (`node --test`).
- Workspace includes both plugin runtime and benchmark tooling.

## 3) Cursor / Copilot Rule Files
Checked and currently absent:
- `.cursorrules`: not found
- `.cursor/rules/`: not found
- `.github/copilot-instructions.md`: not found
If any are added later, treat them as higher-priority local instructions and update this file.

## 4) Install / Build / Lint / Test Commands
### Install
- Root install: `npm install`
- Plugin-only install: `npm install --prefix .opencode/plugins/contextfs`

### Build
- No `build` script in root `package.json`.
- No compile pipeline for runtime modules.

### Lint / Format
- No lint/format scripts in root or plugin `package.json`.
- No repo lint config detected (ESLint/Prettier/Biome).
- Match existing style; do not introduce new tooling unless requested.

### Tests (full suites)
- Plugin unit tests via root script: `npm run test:contextfs:unit`
- Plugin unit tests direct: `npm test --prefix .opencode/plugins/contextfs`
- Regression suite: `npm run test:contextfs:regression`
- Bench tests: `node --test ./bench/bench.test.mjs`

### Tests (single test)
Use Node test name filtering:
- Plugin single test:
  - `node --test --test-name-pattern="compacted turns remain retrievable via archive fallback" ./.opencode/plugins/contextfs/test/contextfs.test.mjs`
- Plugin single test (another example):
  - `node --test --test-name-pattern="ctx reindex preserves raw duplicate archive ids for get/search consistency" ./.opencode/plugins/contextfs/test/contextfs.test.mjs`
- Bench single test:
  - `node --test --test-name-pattern="timing fields are sane in jsonl outputs" ./bench/bench.test.mjs`

### Bench runs
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

## 6) Code Style and Implementation Conventions
### Imports
- Use ESM `import` syntax in `.mjs` and `.ts` files.
- Use `node:` specifiers for built-ins (`node:fs/promises`, `node:path`, etc.).
- Keep built-in imports above local imports.
- Separate import groups with one blank line.
- Use double quotes and semicolons.

### Formatting
- Two-space indentation.
- Semicolons enabled.
- Prefer trailing commas in multiline literals/calls.
- Favor small helpers and early returns over deep nesting.

### Naming
- Variables/functions: `camelCase`.
- Classes: `PascalCase` (example: `ContextFsStorage`).
- Constants: `UPPER_SNAKE_CASE` (`FILES`, `RETRYABLE_LOCK_ERRORS`).
- Tests use descriptive sentence-style names in `test("...", ...)`.

### Types and Input Normalization
- Normalize external input aggressively (`String(...)`, `Number(...)`, `.trim()`).
- Validate and clamp numeric config boundaries in one place.
- Keep retrieval/history row schemas explicit and stable (`id`, `ts`, `role`, `type`, `refs`, `text`).
- In TypeScript bridge code, avoid `any` unless there is clear justification.

### Async, I/O, and Concurrency
- Use `async/await` consistently.
- Preserve lock-aware writes for mutable files.
- Keep file writes atomic where consistency matters.
- Keep history files NDJSON (one JSON object per line).
- Preserve archive split contract:
  - `history.ndjson` = hot recent turns
  - `history.archive.ndjson` = compacted historical turns
  - `history.archive.index.ndjson` = archive retrieval index

### Error Handling
- Throw explicit errors for hard failures.
- Use narrow `try/finally` for lock cleanup and restoration flows.
- Avoid silent failure paths; if ignoring malformed lines, keep behavior deliberate and bounded.
- CLI should return structured errors and non-zero exit code on fatal failures.

### Output and UX Contracts
- Keep CLI output line-oriented and stable.
- Keep JSON output parseable and backward-safe.
- Do not break existing command names or output fields unless explicitly requested.

## 7) Test Scope by Change Type
- If touching storage/compaction/retrieval (`src/storage.mjs`, `src/compactor.mjs`, `src/commands.mjs`):
  - Run `npm run test:contextfs:unit`
  - Run `npm run test:contextfs:regression`
- If touching benchmark logic:
  - Run `node --test ./bench/bench.test.mjs`
  - Run at least one bench command from section 4
- If touching CLI behavior:
  - Run at least one CLI sanity command from section 5

## 8) Agent Guardrails
- Keep edits focused; avoid unrelated refactors.
- Preserve CLI compatibility unless a change is explicitly requested.
- Update `README.md` when user-visible command behavior/flags change.
- Never commit runtime state (`.contextfs/`) or lock artifacts.

## 9) Repo Notes
- `.contextfs/` contains runtime data and is ignored.
- `docs/` is ignored in `.gitignore`; use `git add -f` only when docs must be committed.
- For new commands/flags, update docs and tests in the same change.

## 10) Hand-off Checklist
1. Verify commands against actual `package.json` scripts.
2. Run relevant tests (full suite or targeted `--test-name-pattern`).
3. Update `README.md` and this file when workflows or behavior change.
