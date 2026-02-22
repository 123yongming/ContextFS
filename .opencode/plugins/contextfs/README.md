# ContextFS Plugin (MVP)

Small, non-invasive OpenCode plugin to keep long sessions stable.

## Core Features

- **Context Management**: Maintains core files in `.contextfs/`
  - `manifest.md` - Project structure/status
  - `pins.md` - Key constraints/pins
  - `summary.md` - Rolling summary of compressed history
  - `history.ndjson` - Recent strict pairs only: original user prompt text + assistant final answer (NDJSON; no intermediate streaming/tool traces)
  - `history.archive.ndjson` - Archived compacted turns
  - `retrieval.traces.ndjson` - Retrieval trace log (derived, may rotate)

- **Context Pack**: Builds fixed pack each turn
  - PINS (max 20 items)
  - SUMMARY (max 3200 chars)
  - MANIFEST (max 20 lines)
  - RETRIEVAL_INDEX (max 8 items; derived from last search)
  - WORKSET (recent 6 turns)

- **Auto Compaction**: Triggers when tokens > threshold (default 16000)
  - Compresses old history into summary via external compact model API
  - Keeps recent N turns intact
  - Bounded context size
  - If compact summary API call fails, compaction fails (no local fallback)

- **Pins Management**: Manual pins with deduplication

## Installation

```bash
mkdir -p .opencode/plugins
cp <path-to-contextfs>/.opencode/plugins/contextfs.plugin.mjs .opencode/plugins/
cp -r <path-to-contextfs>/.opencode/plugins/contextfs .opencode/plugins/
```

Restart OpenCode session.

## CLI Commands

```bash
ctx ls              # Show status
ctx stats           # Show retrieval/pack metrics
ctx cat <file>      # View file content
ctx pin "..."       # Add a pin
ctx save "..." [--title "..."] [--role assistant] [--type note] [--session current|<id>] [--json]  # Persist explicit memory
ctx search "..." [--k 5]                 # Search lightweight index rows
ctx timeline <id> [--before 3 --after 3]  # Show context window around id
ctx get <id> [--head 1200]                # Fetch full row by id
ctx traces [--tail 20]                    # Read latest retrieval traces
ctx trace <trace_id>                      # Read a single trace by id
ctx compact         # Force compaction
ctx pack            # Show current pack
ctx gc              # Garbage collect
```

## MCP Server

ContextFS now includes a local MCP stdio server:

```bash
node ./mcp-server.mjs --workspace <workspace-path>
```

Exposed tools:
- `search(query, k?, scope?, session?|session_id?)`
- `timeline(anchor_id, before?, after?, session?|session_id?)`
- `get(id, head?, session?|session_id?)`
- `save_memory(text, title?, role?, type?, session?|session_id?)`
- `__IMPORTANT()`

Tool payloads follow the same JSON contracts as:
- `ctx search --json` / `ctx timeline --json` (L0 rows)
- `ctx get --json` (L2 record with budget-aware truncation)
- `ctx save --json` (WRITE ack with saved record metadata)

## Recommended Retrieval Workflow

Use progressive retrieval to stay token-efficient:

1. `ctx search "<query>"` to get compact index rows with stable IDs
2. `ctx timeline <id>` to inspect neighboring context
3. `ctx get <id>` only when full detail is required
4. `ctx save "<text>"` to persist explicit long-lived memory when needed

Pack remains reference-first: retrieval index rows are included, not full detail payloads.

## Configuration

Default config in `src/config.mjs`. Override via:

```js
globalThis.CONTEXTFS_CONFIG = {
  enabled: true,
  autoInject: true,
  autoCompact: true,
  recentTurns: 6,
  tokenThreshold: 16000,
  pinsMaxItems: 20,
  summaryMaxChars: 3200,
  manifestMaxLines: 20,
  compactModel: "Pro/Qwen/Qwen2.5-7B-Instruct",
  compactTimeoutMs: 20000,
  compactMaxRetries: 2,
}
```

Environment variables for compact summary model:

```bash
CONTEXTFS_EMBEDDING_BASE_URL=https://api.siliconflow.cn/v1
CONTEXTFS_EMBEDDING_API_KEY=<your_api_key>
CONTEXTFS_COMPACT_MODEL=Pro/Qwen/Qwen2.5-7B-Instruct
CONTEXTFS_COMPACT_TIMEOUT_MS=20000
CONTEXTFS_COMPACT_MAX_RETRIES=2
```

## Context Pack Format

Wrapped by hard delimiters:
- `<<<CONTEXTFS:BEGIN>>>`
- `<<<CONTEXTFS:END>>>`

Sections (fixed order):
1. PINS
2. SUMMARY
3. MANIFEST
4. RETRIEVAL_INDEX
5. WORKSET_RECENT_TURNS

## Testing

```bash
npm test                    # Unit tests (core + MCP)
node --test --test-isolation=none ./test/contextfs.mcp.test.mjs   # MCP integration tests only
npm run test:regression     # Regression tests (repo root)
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
