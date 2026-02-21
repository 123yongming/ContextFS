# ContextFS Context Layers Contract (L0/L1/L2)

This document defines the **stable, user-facing contracts** for ContextFS retrieval and injection.

Goals:
- Keep retrieval token-efficient: cheap rows first, details on demand.
- Keep outputs stable: additive changes only; no breaking field removals/renames.
- Keep storage local and auditable: `.contextfs/` is the source of truth.

Non-goals:
- Defining a UI.
- Defining a source-of-truth vector DB. SQLite FTS/vec indexes are derived and rebuildable.

## Versioning Rules

- Schema is **additive**. New fields may be added, but existing fields must not be removed or renamed.
- Unknown fields must be ignored by consumers.
- When a field is present, its type must remain stable.

## L0: Index / Recall (Cheap Rows)

L0 is a bounded, single-line summary row used to decide whether to expand with `timeline` or `get`.

### L0 Row Schema (Stable)

An L0 row is an object with:

- `layer`: `"L0"` (string, required)
- `id`: string (required; stable id like `H-...`)
- `ts`: string (required; ISO8601 timestamp; may be `"n/a"` for legacy/bad timestamps)
- `type`: string (required; one of `query|response|artifact|tool_output|note` or other future types)
- `summary`: string (required; single-line; bounded length; must not contain `\n`)
- `source`: `"hot" | "archive"` (string, required)

Optional additive fields (may appear in some commands, absent in others):

- `score`: number (ranking score; currently emitted by `search`)
- `score_lex`: number (lexical channel score; emitted by `search` in hybrid-capable modes)
- `score_vec`: number (vector channel score; emitted by `search` in hybrid-capable modes)
- `score_final`: number (final fused/ranked score used for ordering)
- `expand`: object (hints/budgets for progressive retrieval; currently emitted by `search`)
  - `expand.timeline`:
    - `before`: number
    - `after`: number
    - `window`: number
    - `tokens_est`: number
    - `size`: `"small" | "medium" | "large"`
  - `expand.get`:
    - `head`: number
    - `tokens_est`: number
    - `size`: `"small" | "medium" | "large"`
    - `confidence`: `"low" | "medium" | "high"` (best-effort hint)

### `ctx search --json` Response Schema (Stable)

Top-level object:

- `layer`: `"L0"`
- `query`: string
- `k`: number
- `scope`: `"all" | "hot" | "archive"`
- `session`: `"all" | "<session-id>"`
- `hits`: number
- `results`: `L0Row[]`

Additive `retrieval` metadata may also appear, for example:

- `requested_mode`: `legacy|lexical|vector|hybrid|fallback`
- `mode`: actual mode used after fallback
- `lexical_engine`: `legacy|sqlite_fts5`
- `vector_engine`: `sqlite_vec_ann|sqlite_vec_linear|null`
- `lexical_hits`, `vector_hits`, `fused_hits`
- `latency_ms`: `{ lexical, vector, fusion, total }`
- `fallback_reason` / `vector_fallback_reason` / `lexical_fallback_reason` when degraded
- optional `ann_recall_probe`: `{ probe_k, overlap, recall }`

### `ctx timeline --json` Response Schema (Stable)

Top-level object:

- `layer`: `"L0"`
- `anchor`: string (resolved id)
- `before`: number
- `after`: number
- `source`: `"hot" | "archive"` (pool that produced the slice)
- `session`: `"all" | "<session-id>"`
- `results`: `L0Row[]`

## L1: Overview / Navigation (Injected Pack)

L1 is a **text block** injected into the model prompt each turn (when `autoInject=true`).
It is designed to be:
- deterministic-ish (bounded and ordered)
- auditable (stored in `.contextfs/`)
- hard-bounded by token threshold (best effort, with minimal/emergency fallback)

### Pack Delimiters (Stable)

The pack is wrapped by hard delimiters (configurable but sanitized):

- Start: `packDelimiterStart` (default `<<<CONTEXTFS:BEGIN>>>`)
- End: `packDelimiterEnd` (default `<<<CONTEXTFS:END>>>`)

### Pack Section Order (Stable)

Sections are emitted in this fixed order:

1. `### PINS`
2. `### SUMMARY`
3. `### MANIFEST`
4. `### RETRIEVAL_INDEX`
5. `### WORKSET_RECENT_TURNS`

Notes:
- `RETRIEVAL_INDEX` is populated from the last `ctx search` results (bounded).
- `WORKSET_RECENT_TURNS` is a **navigation preview** (one line per turn), not a full replay.
- When budgets are too tight, the pack may enter a minimal/emergency mode and emit `(trimmed)` placeholders.

## L2: Detail / Playback (On-Demand Record)

L2 returns a full normalized record for a single `id` with strict budgeting.

### Normalized Record Schema (Stable)

`record` is an object with at least:

- `id`: string
- `ts`: string (ISO8601)
- `role`: string (typically `user|assistant|tool|unknown`)
- `type`: string
- `refs`: string[]
- `text`: string

Optional additive fields:

- `tags`: string[]
- `session_id`: string

### `ctx get --json` Response Schema (Stable)

Top-level object:

- `layer`: `"L2"`
- `record`: `Record`
- `source`: `"hot" | "archive"`
- `head`: number (requested effective head budget)
- `original_text_len`: number

Truncation metadata (additive, always safe to ignore):

- `truncated`: boolean
- `truncated_fields`: string[]
- `original_sizes`: object (lengths/counts before truncation)

### Tiny Budget Fallback (Stable)

If `--head` is too small to fit the normal JSON envelope, a tiny JSON object may be returned:

- `id`: string (may be clipped to fit budget)
- `truncated`: `true`
- `effective_head`: number
- `note`: `"budget_too_small"`

## Compatibility Checklist (For Future Changes)

- Keep all documented fields stable.
- Add fields only (never remove/rename).
- Keep `L0` summaries single-line and bounded.
- Keep `L2` JSON always valid JSON under `--head` budgeting.
- Keep pack section order stable.
