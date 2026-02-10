# ContextFS Plugin (MVP)

Small, non-invasive OpenCode plugin to keep long sessions stable.

## Core Features

- **Context Management**: Maintains 4 types of files in `.contextfs/`
  - `manifest.md` - Project structure
  - `pins.md` - Key constraints/pins
  - `summary.md` - Rolling summary of compressed history
  - `history.ndjson` - Recent N turns (NDJSON format)

- **Context Pack**: Builds fixed pack each turn
  - PINS (max 20 items)
  - SUMMARY (max 3200 chars)
  - MANIFEST (max 20 lines)
  - WORKSET (recent 6 turns)

- **Auto Compaction**: Triggers when tokens > threshold (default 8000)
  - Compresses old history into summary
  - Keeps recent N turns intact
  - Bounded context size

- **Pins Management**: Manual pins with deduplication

## Installation

```bash
mkdir -p .opencode/plugins
cp plugins/contextfs/contextfs.plugin.mjs .opencode/plugins/
cp -r plugins/contextfs .opencode/plugins/
```

Restart OpenCode session.

## CLI Commands

```bash
ctx ls              # Show status
ctx stats           # Show retrieval/pack metrics
ctx cat <file>      # View file content
ctx pin "..."       # Add a pin
ctx search "..." [--k 5]                 # Search lightweight index rows
ctx timeline <id> [--before 3 --after 3]  # Show context window around id
ctx get <id> [--head 1200]                # Fetch full row by id
ctx compact         # Force compaction
ctx pack            # Show current pack
ctx gc              # Garbage collect
```

## Recommended Retrieval Workflow

Use progressive retrieval to stay token-efficient:

1. `ctx search "<query>"` to get compact index rows with stable IDs
2. `ctx timeline <id>` to inspect neighboring context
3. `ctx get <id>` only when full detail is required

Pack remains reference-first: retrieval index rows are included, not full detail payloads.

## Configuration

Default config in `src/config.mjs`. Override via:

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

## Context Pack Format

Wrapped by hard delimiters:
- `<<<CONTEXTFS:BEGIN>>>`
- `<<<CONTEXTFS:END>>>`

Sections (fixed order):
1. PINS
2. SUMMARY
3. MANIFEST
4. WORKSET_RECENT_TURNS

## Testing

```bash
npm test                    # Unit tests
npm run test:regression     # Regression tests
```

## Architecture

```
┌─────────────────────────────────────┐
│  contextfs.plugin.mjs (entry)       │
├─────────────────────────────────────┤
│  src/                               │
│   ├─ config.mjs    (config mgmt)    │
│   ├─ storage.mjs   (file ops + lock)│
│   ├─ compactor.mjs (compression)    │
│   ├─ packer.mjs    (pack builder)   │
│   ├─ pins.mjs      (pin dedupe)     │
│   ├─ summary.mjs   (summary merge)  │
│   ├─ token.mjs     (token estimate) │
│   └─ commands.mjs  (CLI impl)       │
└─────────────────────────────────────┘
```

## Non-goals (MVP guardrails)

- No vector DB
- No complex RAG
- No global memory service
- No UI panel

## Compliance Note

- This plugin only borrows high-level retrieval workflow ideas from external projects.
- No code, prompt text, or concrete database schema naming is copied from claude-mem.
- claude-mem includes AGPL-3.0 and additional noncommercial constraints in parts; review license compatibility before reusing its implementation artifacts.

## License

MIT
