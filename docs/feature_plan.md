# ContextFS Feature Plan

This document captures near-term feature work for ContextFS (this repository).

## Done

### Feature 2: Session Isolation & Session-Aware Retrieval

Implemented:
- History entry optional field: `session_id`
- Plugin-generated session ids (`S-<uuid>`) persisted in `.contextfs/state.json`
- Retrieval filtering: `ctx search --session all|current|<id>` (default `all`)
- Optional narrowing: `ctx timeline/get --session ...` (used to disambiguate id conflicts)
- Observability: `ctx ls` and `ctx stats --json` expose current `session_id`

Notes:
- Backwards compatible: old rows without `session_id` remain readable.
- No automatic backfill/migration is performed.

## Next Up (Recommended Order)

1. Feature 5: Observable Retrieval (Retrieval Trace)
2. Feature 3: MCP Server for ContextFS Retrieval Tools
3. Feature 6: Vector Index & Hybrid Search (SQLite)

Rationale:
- Feature 5 provides the debugging and regression foundation for any retrieval changes (including MCP and hybrid search).
- Feature 3 benefits from a stable, traceable retrieval core and can reuse existing CLI JSON contracts.
- Feature 6 is high value but higher complexity and benefits directly from Feature 5 traces.

---

## Feature 5: Observable Retrieval (Retrieval Trace)

### Title
Make retrieval debuggable with an on-disk trace.

### What We Want To Add
Add a small, stable retrieval trace log so users can understand and debug retrieval decisions:
- what query ran (and args)
- which pool(s) were searched (hot/archive/all)
- why the top results won (IDs + bounded summaries)
- whether budgets/truncation affected output
- which `session_id` filter was applied (if any)

### Detailed Description
1. Add a dedicated trace store under `.contextfs/`
- Recommended: append-only NDJSON: `.contextfs/retrieval.traces.ndjson`

2. Define a minimum stable trace schema
- `trace_id`: stable id (e.g. `T-<hash>`)
- `ts`: ISO8601
- `command`: `search|timeline|get|pack|compact|reindex|gc`
- `args`: normalized args (e.g. `k`, `scope`, `before`, `after`, `head`, `session`)
- `query`: for search only
- `inputs`: searched pool sizes/counts
- `ranking`: top-k results (id/source/score/summary)
- `budgets`: caps used (k cap, summary cap, pack threshold, json head)
- `truncation`: what was truncated (if any)
- `state_revision`: correlates to `.contextfs/state.json`
- optional: `duration_ms`

3. Keep traces safe by default
- store IDs + short summaries only
- do not store full L2 turn text in traces by default

4. Add minimal CLI for reading traces
- `ctx traces [--tail N] [--json]`
- `ctx trace <trace_id> [--json]`

### Where This Fits In Our Repo
- Storage I/O + lock-aware writes: `.opencode/plugins/contextfs/src/storage.mjs`
- CLI: `.opencode/plugins/contextfs/src/commands.mjs`

### Acceptance Criteria
- Traces are written for `search/timeline/get` (and meaningful errors) with stable schema
- Trace writes are atomic/append-only and lock-aware
- Growth is bounded deterministically (rotation or max entries, covered by tests)

### Borrowed From
- Project: `volcengine/OpenViking`

---

## Feature 3: MCP Server for ContextFS Retrieval Tools

### Title
Expose ContextFS retrieval as MCP tools (search/timeline/get).

### What We Want To Add
Provide an MCP server that exposes ContextFS retrieval primitives as tools, enabling other clients to query ContextFS using the same progressive workflow.

### Detailed Description
1. Add an MCP server entry that launches a small Node stdio server
- Wrap existing ContextFS primitives rather than re-implementing logic
- Prefer a thin adapter over new storage layers

2. Expose a minimal tool surface that matches our stable workflow
- `search(query, k, scope, session?)` -> compact index rows (IDs + summaries)
- `timeline(anchor_id, before, after, session?)` -> chronological window around anchor
- `get(id, head, session?)` -> full record detail for a single ID
- `__IMPORTANT` -> returns workflow documentation for the agent (how to use the 3-layer workflow efficiently)

3. Keep payload contracts stable and line-oriented
- Prefer JSON responses matching our `ctx ... --json` shapes
- Avoid returning massive strings by default; always support budgeting (`head`)

4. Security and safety constraints
- MCP server only reads/writes `.contextfs/` under a chosen workspace
- No arbitrary file reads
- Must support session filtering via `session_id` (same semantics as CLI `--session`)

### Where This Fits In Our Repo
- Command semantics: `.opencode/plugins/contextfs/src/commands.mjs`
- Storage layer: `.opencode/plugins/contextfs/src/storage.mjs`
- Config: `.opencode/plugins/contextfs/src/config.mjs`

Implementation options:
- Option A (recommended): implement MCP tools by calling the same underlying functions used by CLI command handlers (shared modules)
- Option B: shell out to `ctx` CLI (simple but less efficient and harder to test)

### Acceptance Criteria
- MCP server can be launched via a config entry and responds over stdio
- Tools exist for `search`, `timeline`, `get`, plus `__IMPORTANT`
- Results match CLI behavior closely (same ranking, same truncation rules, same session semantics)
- Tests validate parameter validation, truncation (`head`), and no path traversal

### Borrowed From
- Project: `thedotmack/claude-mem`

---

## Feature 6: Vector Index & Hybrid Search (SQLite)

### Title
Add optional vector storage and hybrid retrieval (lexical + vector).

### What We Want To Add
Introduce an optional on-disk vector index (local, rebuildable) and a hybrid `ctx search` path that combines:
- lexical retrieval (fast, explainable, deterministic)
- vector similarity retrieval (robust to paraphrases / low token overlap)

This must not replace the current file-based store. `.contextfs/history*.ndjson` and `.contextfs/*.md` remain the source of truth; the vector index is derived and safe to delete/rebuild.

### Detailed Description
1. Add an optional SQLite index under `.contextfs/`
- Proposed path: `.contextfs/index.sqlite`
- Goals: durable, local, no external services required
- Lock-aware writes (reuse `.contextfs/.lock`)
- Deterministic rebuild (`ctx reindex` can recreate it)

2. Strengthen lexical search using SQLite FTS5 (baseline for hybrid)
- Create an FTS5 table for stable fields we already emit in index rows:
  `id`, `ts`, `session_id`, `type`, `role`, `summary`, optional `text_preview`
- `ctx search` lexical mode should use:
  `bm25()` scoring plus small, bounded boosts (recency, source, session filter)

3. Add an embeddings provider interface (pluggable)
- Providers:
  `none` (default): lexical only
  `external`: compute embeddings via configured API (future)
  `local`: compute embeddings via a local model (future)
- Requirements:
  normalize inputs consistently; store `model` and `dim`
  compute embeddings for canonical text used by search (start with `summary`)

4. Store vectors as derived data
- Option A (simpler): store vectors as BLOB and do cosine similarity in JS with a bounded candidate pool
- Option B (faster): optional SQLite vector extension (future optimization; not required by contract)

5. Implement hybrid merge + rerank in `ctx search`
- Merge by `id`, keep best composite score
- Deterministic rerank:
  base score + bounded boosts
  stable tie-breakers: `ts` desc, then `id` asc
- Output contract:
  preserve existing rows; only add additive fields (`rank_source`, `score_lex`, `score_vec`, `score_final`)

6. Index lifecycle: deterministic rebuild
- `ctx reindex` rebuilds lexical tables from history + archive index
- Optional embeddings rebuild via `ctx reindex --vectors` (not default)
- GC removes embeddings for missing ids

7. Observability integration (Feature 5)
- Retrieval traces record branch usage (`lexical`, `vector`, `hybrid`), candidate counts, budgets, and top-k score fields

### Where This Fits In Our Repo
- CLI/search contracts: `.opencode/plugins/contextfs/src/commands.mjs`
- Storage + lock-aware I/O: `.opencode/plugins/contextfs/src/storage.mjs`
- Config: `.opencode/plugins/contextfs/src/config.mjs`
- New index module: `.opencode/plugins/contextfs/src/index_sqlite.mjs` (name TBD)

### Acceptance Criteria
- `ctx search` continues to work with no SQLite file present (fallback remains)
- When enabled, hybrid results are deterministic and additive fields are stable
- Index is rebuildable and safe to delete (no source-of-truth data stored in SQLite)
- Tests cover determinism, tie-breaking, and session filter interaction

