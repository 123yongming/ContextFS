# ContextFS Plugin (MVP)

Small, non-invasive OpenCode plugin to keep long sessions stable.

## What this MVP does

- Creates `.contextfs/` automatically on first run.
- Maintains short files:
  - `manifest.md`
  - `pins.md`
  - `summary.md`
  - `decisions.md`
  - `tasks/current.md`
- Builds fixed context pack each turn:
  - recent N turns (default 6)
  - pins (default max 20)
  - summary (bounded chars)
  - manifest (max lines)
- Auto compacts when estimated tokens exceed threshold (default 8000).
- Supports command mode:
  - `ctx ls`
  - `ctx cat <file> [--head 30]`
  - `ctx pin "..."`
  - `ctx compact`
  - `ctx gc`

## Non-goals (MVP guardrails)

- No vector DB
- No complex RAG
- No global memory service
- No UI panel

## Install / Enable in OpenCode

Based on OpenCode plugin docs: local plugin files can be loaded from `.opencode/plugins/`.

1) Create plugin link/copy file:

```bash
mkdir -p .opencode/plugins
cp plugins/contextfs/contextfs.plugin.mjs .opencode/plugins/contextfs.plugin.mjs
```

2) Restart OpenCode session.

Optional via config package load (npm plugin) is intentionally not used in this MVP.

## Configuration

Default config is in `plugins/contextfs/src/config.mjs`.

You can override by setting a global variable before plugin initialization:

```js
globalThis.CONTEXTFS_CONFIG = {
  enabled: true,
  autoInject: true,
  autoCompact: true,
  recentTurns: 6,
  tokenThreshold: 8000,
  pinsMaxItems: 20,
  summaryMaxChars: 3200,
  manifestMaxLines: 20,
}
```

Key knobs:

- `recentTurns` => N
- `tokenThreshold` => T
- `pinsMaxItems` => pins cap
- `summaryMaxChars` => summary cap
- `autoInject` / `autoCompact` => automatic mode switches

Notes:

- `tokenThreshold` is a **trigger threshold** for compaction. It does not guarantee post-compact tokens are `<= tokenThreshold`.
- Plugin runtime and standalone CLI read config differently:
  - Plugin (`contextfs.plugin.mjs`) reads `globalThis.CONTEXTFS_CONFIG` and merges it with defaults.
  - CLI (`cli.mjs`) uses defaults via `mergeConfig()` and does not read `globalThis.CONTEXTFS_CONFIG`.

## Context pack format

Pack is wrapped by hard delimiters:

- `<<<CONTEXTFS:BEGIN>>>`
- `<<<CONTEXTFS:END>>>`

Sections are fixed order:

1. `PINS`
2. `SUMMARY`
3. `MANIFEST`
4. `WORKSET_RECENT_TURNS`

## Manual validation (copy-paste)

Run from repo root.

### Step 1: bootstrap files

```bash
node plugins/contextfs/cli.mjs ls
```

Expected:

- `.contextfs/` exists
- `manifest.md/pins.md/summary.md` exist

### Step 2: pin operations

```bash
node plugins/contextfs/cli.mjs pin "必须不改 OpenCode 核心架构"
node plugins/contextfs/cli.mjs cat pins --head 30
```

Expected:

- pin line appended with `[P-xxxxxxxx]`
- duplicate pin should not increase count repeatedly

### Step 3: force compaction

Append fake history quickly:

```bash
for i in $(seq 1 30); do node plugins/contextfs/cli.mjs pin "constraint $i must keep scope small" >/dev/null; done
node plugins/contextfs/cli.mjs compact
node plugins/contextfs/cli.mjs cat summary --head 40
```

Expected:

- compaction output includes before/after token estimate
- summary updated and still bounded

### Step 4: verify pack structure

```bash
node plugins/contextfs/cli.mjs pack
```

Expected:

- contains begin/end delimiters
- contains all four sections in fixed order

### Step 5: realistic E2E run (30-50 turns)

Goal: simulate a longer task while keeping the packed context bounded.

```bash
# 1) start with clean runtime data
rm -rf .contextfs

# 2) add one hard constraint
node .opencode/plugins/contextfs/cli.mjs pin "必须不改 OpenCode 核心架构"

# 3) generate 40 turns (user/assistant alternating)
node --input-type=module -e "import { mergeConfig } from './.opencode/plugins/contextfs/src/config.mjs'; import { ContextFsStorage } from './.opencode/plugins/contextfs/src/storage.mjs'; const cfg = mergeConfig({ contextfsDir: '.contextfs', recentTurns: 6, tokenThreshold: 8000 }); const s = new ContextFsStorage(process.cwd(), cfg); await s.ensureInitialized(); for (let i = 1; i <= 40; i += 1) { await s.appendHistory({ role: i % 2 ? 'user' : 'assistant', text: 'turn-' + i + ' short payload', ts: new Date().toISOString() }); }"

# 4) inspect pack token estimate and working set
node .opencode/plugins/contextfs/cli.mjs ls
node .opencode/plugins/contextfs/cli.mjs compact
node .opencode/plugins/contextfs/cli.mjs ls
```

What to observe:

- `pack.tokens(est)` should remain in a controlled range after `compact`.
- `workset.turns` should stay near configured `recentTurns`.
- `summary.chars` should stay bounded by `summaryMaxChars`.

## Tests

```bash
cd plugins/contextfs
npm test
```

Includes 3 minimal tests:

- token estimate stability
- pin dedupe
- summary merge boundedness

## Notes on plugin API uncertainty

This repo currently does not include OpenCode core source/types.
Implementation follows published plugin docs and keeps integration isolated in `plugins/contextfs/`.
If your runtime exposes slightly different hook payload fields, adapt only in `contextfs.plugin.mjs` (input/output mapping), not in core logic modules.
