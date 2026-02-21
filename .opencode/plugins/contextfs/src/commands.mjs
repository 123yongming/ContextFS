import crypto from "node:crypto";

import { fileMap } from "./storage.mjs";
import { addPin, parsePinsMarkdown } from "./pins.mjs";
import { maybeCompact } from "./compactor.mjs";
import { buildContextPack } from "./packer.mjs";
import { createEmbeddingProvider, embedTexts, hashEmbeddingText, normalizeEmbeddingText } from "./embedding.mjs";
import {
  rebuildSqliteIndexFromStorage,
  rebuildSqliteVectorIndexFromStorage,
  searchSqliteLexical,
  searchSqliteVectorAnn,
  searchSqliteVectorLinear,
  sqliteIndexDoctor,
} from "./index/sqlite_store.mjs";
import { estimateTokens } from "./token.mjs";

function parseArgs(raw) {
  const input = String(raw || "").trim();
  const parts = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(input))) {
    parts.push(m[1] ?? m[2] ?? m[3]);
  }
  return parts;
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.floor(Number(value) || 0)));
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function getFlagValue(args, flag, fallback) {
  const idx = args.indexOf(flag);
  if (idx < 0) {
    return fallback;
  }
  return args[idx + 1] ?? fallback;
}

function isMissingFlagValue(value) {
  const text = String(value ?? "").trim();
  return !text || text.startsWith("--");
}

function stripFlags(args, flagsWithValue = []) {
  const valueFlags = new Set(flagsWithValue);
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const part = args[i];
    if (valueFlags.has(part)) {
      i += 1;
      continue;
    }
    if (part === "--json") {
      continue;
    }
    out.push(part);
  }
  return out;
}

async function getSessionFilter(args, storage, usage) {
  const idx = args.indexOf("--session");
  if (idx < 0) {
    return { mode: "all", sessionId: null };
  }
  const raw = args[idx + 1];
  if (isMissingFlagValue(raw)) {
    return { error: `usage: ${usage}` };
  }
  const value = String(raw).trim();
  const lower = value.toLowerCase();
  if (lower === "all") {
    return { mode: "all", sessionId: null };
  }
  if (lower === "current") {
    const state = await storage.readState();
    const current = String(state.currentSessionId || "").trim();
    if (!current) {
      return {
        error: "no current session id in state. run the plugin once (or omit --session) to initialize a session.",
      };
    }
    return { mode: "id", sessionId: current };
  }
  return { mode: "id", sessionId: value };
}

async function getSessionForSave(args, storage, usage) {
  const idx = args.indexOf("--session");
  if (idx < 0) {
    return { sessionId: null };
  }
  const raw = args[idx + 1];
  if (isMissingFlagValue(raw)) {
    return { error: `usage: ${usage}` };
  }
  const value = String(raw).trim();
  const lower = value.toLowerCase();
  if (lower === "all") {
    return { error: "ctx save does not support --session all. use --session current or a specific session id." };
  }
  if (lower === "current") {
    const state = await storage.readState();
    const current = String(state.currentSessionId || "").trim();
    if (!current) {
      return {
        error: "no current session id in state. run the plugin once (or provide --session <id>) to initialize a session.",
      };
    }
    return { sessionId: current };
  }
  return { sessionId: value };
}

function normalizeSaveRole(input) {
  const raw = String(input ?? "").trim();
  if (!raw) {
    return "assistant";
  }
  const lower = raw.toLowerCase();
  if (lower === "human") {
    return "user";
  }
  if (lower === "ai") {
    return "assistant";
  }
  const allowed = new Set(["user", "assistant", "system", "tool", "note", "unknown"]);
  if (!allowed.has(lower)) {
    throw new Error("role must be one of: user|assistant|system|tool|note|unknown");
  }
  return lower;
}

function normalizeSaveType(input) {
  const raw = String(input ?? "").trim();
  if (!raw) {
    return "note";
  }
  const clean = raw.toLowerCase();
  if (!/^[a-z0-9_.:-]{1,64}$/.test(clean)) {
    throw new Error("type must match /^[a-z0-9_.:-]{1,64}$/");
  }
  return clean;
}

function lineSummary(text, maxChars) {
  const oneLine = String(text || "").replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(0, maxChars - 3))}...`;
}

function safeOneLine(text, maxChars, truncatedFields, fieldName) {
  const oneLine = String(text || "").replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) {
    return oneLine;
  }
  if (truncatedFields && fieldName) {
    truncatedFields.add(fieldName);
  }
  return `${oneLine.slice(0, Math.max(0, maxChars - 3))}...`;
}

function makeTraceId(seed) {
  const hash = crypto.createHash("sha256").update(String(seed || ""), "utf8").digest("hex").slice(0, 10);
  return `T-${hash}`;
}

function sessionLabel(session) {
  if (session?.mode === "id") {
    return session.sessionId;
  }
  return "all";
}

function sizeBucket(tokens) {
  const n = Number(tokens);
  const safe = Number.isFinite(n) ? n : 0;
  if (safe <= 220) return "small";
  if (safe <= 520) return "medium";
  return "large";
}

function toL0Row(entry, config, source, extras = {}) {
  const e = entry && typeof entry === "object" ? entry : {};
  const row = {
    id: String(e.id || ""),
    ts: isoMaybe(e.ts),
    type: String(e.type || "note"),
    summary: lineSummary(e.text, config.searchSummaryMaxChars),
    source: String(source || "hot"),
    layer: "L0",
    ...extras,
  };
  // Guarantee a bounded, single-line summary even if callers pass a bad entry.
  row.summary = lineSummary(row.summary, config.searchSummaryMaxChars);
  return row;
}

function tokenize(text) {
  const input = String(text || "").toLowerCase();
  const tokens = new Set(
    input
      .split(/[^a-z0-9_\-]+/)
      .map((x) => x.trim())
      .filter(Boolean),
  );
  const cjkSegments = input.match(/[\u3400-\u9fff]+/g) || [];
  for (const segment of cjkSegments) {
    const chars = Array.from(segment);
    if (!chars.length) {
      continue;
    }
    tokens.add(segment);
    if (chars.length === 1) {
      tokens.add(chars[0]);
      continue;
    }
    for (let i = 0; i < chars.length - 1; i += 1) {
      tokens.add(chars.slice(i, i + 2).join(""));
    }
    if (chars.length >= 3) {
      for (let i = 0; i < chars.length - 2; i += 1) {
        tokens.add(chars.slice(i, i + 3).join(""));
      }
    }
  }
  return Array.from(tokens);
}

function scoreEntry(entry, queryTokens, newestTs) {
  const text = String(entry.text || "").toLowerCase();
  const refs = Array.isArray(entry.refs) ? entry.refs.map((x) => String(x || "").toLowerCase()) : [];
  let score = 0;
  for (const token of queryTokens) {
    if (!token) {
      continue;
    }
    if (text.includes(token)) {
      score += 3;
    }
    if (refs.some((ref) => ref.includes(token))) {
      score += 4;
    }
  }
  if (score <= 0) {
    return 0;
  }
  if (entry.type === "query") {
    score += 0.5;
  }
  if (entry.type === "response") {
    score += 0.2;
  }
  const ts = Date.parse(String(entry.ts || ""));
  if (Number.isFinite(ts) && Number.isFinite(newestTs) && newestTs >= ts) {
    const ageHours = (newestTs - ts) / 3600000;
    score += 0.2 / (1 + ageHours);
  }
  return score;
}

function isoMaybe(text) {
  const ts = Date.parse(String(text || ""));
  if (!Number.isFinite(ts)) {
    return "n/a";
  }
  return new Date(ts).toISOString();
}

function jsonOrText(payload, asJson) {
  if (asJson) {
    return textResult(JSON.stringify(payload, null, 2));
  }
  return null;
}

function truncateValue(value, maxLen, fieldName, truncatedFields) {
  const text = String(value || "");
  if (text.length <= maxLen) {
    return text;
  }
  truncatedFields.add(fieldName);
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}

function trimStringArray(values, maxItems, itemMaxLen, fieldName, truncatedFields) {
  const source = Array.isArray(values) ? values.map((item) => String(item || "")) : [];
  const out = [];
  if (source.length > maxItems) {
    truncatedFields.add(fieldName);
  }
  for (let i = 0; i < Math.min(maxItems, source.length); i += 1) {
    const item = source[i];
    if (item.length > itemMaxLen) {
      truncatedFields.add(fieldName);
      out.push(`${item.slice(0, Math.max(0, itemMaxLen - 3))}...`);
    } else {
      out.push(item);
    }
  }
  return out;
}

function applyJsonHeadLimit(payload, head, limits = {}) {
  const cfg = {
    idMaxLen: 128,
    typeMaxLen: 128,
    arrayMaxItems: 20,
    arrayItemMaxLen: 256,
    headText: 1200,
    ...limits,
  };
  const effectiveHead = Number(head) > 0 ? Number(head) : cfg.headText;
  const textMax = Math.max(4, Math.min(cfg.headText, effectiveHead));
  const truncatedFields = new Set();
  const record = payload?.record || {};

  const textValue = String(record.text || "");
  const textOut = textValue.length > textMax
    ? `${textValue.slice(0, Math.max(0, textMax - 3))}...`
    : textValue;
  if (textOut !== textValue) {
    truncatedFields.add("text");
  }

  const trimmedRecord = {
    ...record,
    id: truncateValue(record.id, cfg.idMaxLen, "id", truncatedFields),
    type: truncateValue(record.type, cfg.typeMaxLen, "type", truncatedFields),
    refs: trimStringArray(record.refs, cfg.arrayMaxItems, cfg.arrayItemMaxLen, "refs", truncatedFields),
    tags: trimStringArray(record.tags, cfg.arrayMaxItems, cfg.arrayItemMaxLen, "tags", truncatedFields),
    text: textOut,
  };

  const outputPayload = {
    ...payload,
    record: trimmedRecord,
    truncated_fields: Array.from(truncatedFields),
    truncated: truncatedFields.size > 0,
    original_sizes: {
      id: String(record.id || "").length,
      type: String(record.type || "").length,
      refs: Array.isArray(record.refs) ? record.refs.length : 0,
      tags: Array.isArray(record.tags) ? record.tags.length : 0,
      text: textValue.length,
    },
  };
  return {
    payload: outputPayload,
    truncated_fields: outputPayload.truncated_fields,
    truncated: outputPayload.truncated,
    original_sizes: outputPayload.original_sizes,
  };
}

function findIdMatches(history, id) {
  return history.filter((item) => String(item.id) === String(id));
}

function mergeUniqueHistory(history, archive) {
  const byId = new Map();
  for (const item of archive) {
    byId.set(String(item.id), item);
  }
  for (const item of history) {
    byId.set(String(item.id), item);
  }
  return Array.from(byId.values()).sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
}

function asArchiveSearchRows(items) {
  const list = Array.isArray(items) ? items : [];
  return list.map((item) => ({
    id: item.id,
    ts: item.ts,
    type: item.type || "note",
    session_id: item.session_id,
    refs: Array.isArray(item.refs) ? item.refs : [],
    text: String(item.text || item.summary || ""),
    source: "archive",
  }));
}

async function readHistoryByScope(storage, scope = "all") {
  const normalized = String(scope || "all").toLowerCase();
  if (normalized === "hot") {
    return { history: await storage.readHistory(), archive: [] };
  }
  if (normalized === "archive") {
    return { history: [], archive: asArchiveSearchRows(await storage.readHistoryArchive()) };
  }
  const history = await storage.readHistory();
  const archive = asArchiveSearchRows(await storage.readHistoryArchive());
  return { history, archive };
}

function normalizeRetrievalMode(config) {
  const mode = String(config?.retrievalMode || "hybrid").trim().toLowerCase();
  if (mode === "lexical" || mode === "hybrid") {
    return mode;
  }
  return "hybrid";
}

function shouldUseHybridRetrieval(config) {
  return normalizeRetrievalMode(config) === "hybrid" && Boolean(config?.vectorEnabled);
}

function normalizeSearchMode(input, fallback = "fallback") {
  const mode = String(input || "").trim().toLowerCase();
  if (mode === "legacy" || mode === "lexical" || mode === "vector" || mode === "hybrid" || mode === "fallback") {
    return mode;
  }
  return fallback;
}

function rrfScore(rank, k) {
  const safeRank = Number(rank);
  if (!Number.isFinite(safeRank) || safeRank <= 0) {
    return 0;
  }
  return 1 / (k + safeRank);
}

function sourceForId(id, hotIds) {
  return hotIds.has(String(id)) ? "hot" : "archive";
}

function parseEmbeddingVersion(value) {
  const clean = String(value || "").trim();
  if (!clean) {
    return null;
  }
  const parts = clean.split(":");
  if (parts.length < 4) {
    return null;
  }
  const provider = String(parts[0] || "").trim();
  const normalize = String(parts[parts.length - 1] || "").trim() || "unit";
  const dimRaw = Number(parts[parts.length - 2]);
  const dim = Number.isFinite(dimRaw) && dimRaw > 0 ? Math.floor(dimRaw) : 0;
  const model = String(parts.slice(1, parts.length - 2).join(":") || "").trim();
  return {
    provider,
    model,
    dim,
    normalize,
  };
}

function buildVectorMetaFromRows(rows, fallback = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const first = list.find((row) => Array.isArray(row?.vec) && row.vec.length) || null;
  if (!first) {
    return null;
  }
  const embeddedVersion = String(first.embedding_version || "").trim();
  const parsed = parseEmbeddingVersion(embeddedVersion);
  const provider = String(parsed?.provider || fallback.provider || "").trim();
  const model = String(parsed?.model || first.model || fallback.model || "").trim();
  const dim = Number(fallback.dim) > 0
    ? Math.floor(Number(fallback.dim))
    : (Number(parsed?.dim) > 0 ? Number(parsed.dim) : Number(first.dim || first.vec.length || 0));
  if (!dim) {
    return null;
  }
  return {
    provider: provider || "unknown",
    model: model || "unknown",
    dim,
    embedding_version: embeddedVersion || `${provider || "unknown"}:${model || "unknown"}:${dim}:unit`,
  };
}

async function ensureVectorRows(storage, provider, entries, hotIds, config) {
  const vectorRows = await storage.readHistoryEmbeddingView("all");
  const byId = new Map(vectorRows.map((row) => [String(row.id), row]));
  const staleIds = new Set();
  const missingEntries = [];
  for (const entry of entries) {
    const id = String(entry?.id || "");
    if (!id) {
      continue;
    }
    const text = normalizeEmbeddingText(entry?.text || "", config.embeddingTextMaxChars);
    if (!text) {
      if (byId.has(id)) {
        staleIds.add(id);
        byId.delete(id);
      }
      continue;
    }
    const expectedHash = hashEmbeddingText(text);
    const expectedSource = sourceForId(entry.id, hotIds);
    const existing = byId.get(id);
    const hasVector = Boolean(existing && Array.isArray(existing.vec) && existing.vec.length);
    const hashMatches = String(existing?.text_hash || "") === expectedHash;
    const sourceMatches = String(existing?.source || "") === expectedSource;
    const providerDim = Number(provider?.dim || 0);
    const dimMatches = Boolean(provider?.dynamicDim) || providerDim <= 0 || Number(existing?.dim || 0) === providerDim;
    const providerName = String(provider?.name || "unknown");
    const providerModel = String(provider?.model || "");
    const modelMatches = String(existing?.model || "") === providerModel;
    const existingVersion = String(existing?.embedding_version || "");
    const parsedVersion = parseEmbeddingVersion(existingVersion);
    const versionMatches = !existingVersion.trim()
      || (
        parsedVersion
        && String(parsedVersion.provider || "") === providerName
        && String(parsedVersion.model || "") === providerModel
        && (Boolean(provider?.dynamicDim) || providerDim <= 0 || Number(parsedVersion.dim || 0) === providerDim)
      );
    if (!hasVector || !hashMatches || !sourceMatches || !dimMatches || !modelMatches || !versionMatches) {
      staleIds.add(id);
      byId.delete(id);
      missingEntries.push({
        entry,
        text,
        source: expectedSource,
      });
    }
  }
  if (staleIds.size) {
    const staleList = Array.from(staleIds);
    await storage.pruneHistoryEmbeddingByIds(staleList);
    await storage.tryPruneSqliteVectorRowsByIds(staleList);
  }
  if (!missingEntries.length) {
    return byId;
  }
  const embeddedRows = await embedTexts(provider, missingEntries.map((item) => String(item.text || "")), {
    batchSize: config.embeddingBatchSize,
  });
  const appended = [];
  for (let i = 0; i < missingEntries.length; i += 1) {
    const item = missingEntries[i];
    const entry = item.entry;
    const text = String(item.text || "");
    const expectedHash = hashEmbeddingText(text);
    const embedded = embeddedRows[i];
    const vector = Array.isArray(embedded?.vector) ? embedded.vector : [];
    if (!vector.length) {
      continue;
    }
    appended.push({
      id: String(entry.id),
      ts: String(entry.ts || ""),
      session_id: entry.session_id,
      source: item.source,
      model: String(embedded.model || provider.model || "unknown"),
      dim: Number(embedded.dim) || vector.length,
      text_hash: String(embedded.text_hash || expectedHash),
      embedding_version: String(embedded.embedding_version || `${provider?.name || "unknown"}:${embedded?.model || provider?.model || "unknown"}:${Number(embedded?.dim || vector.length) || 0}:unit`),
      vec: vector,
    });
  }
  if (!appended.length) {
    return byId;
  }
  const written = await storage.appendHistoryEmbeddingRows(appended);
  await storage.tryUpsertSqliteVectorRows(written, buildVectorMetaFromRows(written, {
    provider: provider?.name,
    model: provider?.model,
  }) || {});
  for (const row of written) {
    byId.set(String(row.id), row);
  }
  return byId;
}

async function rebuildVectorRows(storage, config, modelOverride = "") {
  const localConfig = {
    ...config,
    retrievalMode: "hybrid",
    vectorEnabled: true,
    ...(modelOverride
      ? {
        embeddingModel: String(modelOverride || "").trim(),
      }
      : {}),
  };
  const provider = createEmbeddingProvider(localConfig);
  if (!provider.enabled) {
    return {
      rebuilt: false,
      reason: "vector retrieval disabled",
      provider: provider.name,
      model: provider.model,
      vectors: 0,
    };
  }
  const history = await storage.readHistory();
  const archiveRows = await storage.readHistoryArchive();
  const merged = mergeUniqueHistory(history, archiveRows);
  const hotIds = new Set(history.map((item) => String(item.id)));
  const existing = await storage.readHistoryEmbeddingView("all");
  if (existing.length) {
    await storage.pruneHistoryEmbeddingByIds(existing.map((row) => String(row.id)));
    await storage.tryPruneSqliteVectorRowsByIds(existing.map((row) => String(row.id)));
  }
  const byId = await ensureVectorRows(storage, provider, merged, hotIds, localConfig);
  const vectorRows = Array.from(byId.values());
  const sqliteResult = await rebuildSqliteVectorIndexFromStorage(storage, localConfig, {
    rows: vectorRows,
    provider: provider.name,
    model: provider.model,
    embedding_version: buildVectorMetaFromRows(vectorRows, {
      provider: provider.name,
      model: provider.model,
    })?.embedding_version || "",
  });
  return {
    rebuilt: Boolean(sqliteResult?.rebuilt),
    reason: String(sqliteResult?.reason || ""),
    provider: provider.name,
    model: provider.model,
    vectors: Number(sqliteResult?.vectors || sqliteResult?.upserted || byId.size),
    entries: merged.length,
    sqlite_available: Boolean(sqliteResult?.available),
    sqlite_reason: String(sqliteResult?.reason || ""),
    dim: Number(sqliteResult?.dim || 0),
    embedding_version: String(sqliteResult?.embedding_version || ""),
  };
}

function safeFileName(name) {
  const map = fileMap();
  const target = String(name || "").toLowerCase();
  const allowed = new Set([
    "manifest",
    "manifest.md",
    "pins",
    "pins.md",
    "summary",
    "summary.md",
    "history",
    "history.ndjson",
    "history.archive.ndjson",
    "history.embedding.hot.ndjson",
    "history.embedding.archive.ndjson",
  ]);
  if (!allowed.has(target)) {
    return null;
  }
  if (target.endsWith(".md") || target.endsWith(".ndjson")) {
    return target;
  }
  return map[target];
}

function textResult(text) {
  return { ok: true, text, exitCode: 0 };
}

function errorResult(text) {
  return { ok: false, text, exitCode: 1 };
}

export async function runCtxCommandArgs(rawArgv, storage, config) {
  const argv = Array.isArray(rawArgv) ? rawArgv.map((part) => String(part ?? "")) : [];
  const cleaned = argv[0] === "ctx" ? argv.slice(1) : argv;
  const cmd = cleaned[0];
  const args = cleaned.slice(1);

  if (!cmd || cmd === "help") {
    return textResult(
      [
        "ctx commands:",
        "  ctx ls",
        "  ctx cat <file> [--head 30]",
        "  ctx pin \"<text>\"",
        "  ctx save \"<text>\" [--title \"...\"] [--role user|assistant|system|tool|note|unknown] [--type note] [--session current|<id>] [--json]",
        "  ctx compact",
        "  ctx search \"<query>\" [--k 5] [--scope all|hot|archive] [--mode legacy|lexical|vector|hybrid|fallback] [--session all|current|<id>]",
        "  ctx timeline <id> [--before 3 --after 3] [--session all|current|<id>]",
        "  ctx get <id> [--head 1200] [--session all|current|<id>]",
        "  ctx traces [--tail 20] [--json]",
        "  ctx trace <trace_id> [--json]",
        "  ctx stats",
        "  ctx metrics [--json]",
        "  ctx doctor [--json]",
        "  ctx gc",
        "  ctx reindex [--full] [--vectors] [--model <name>]",
      ].join("\n"),
    );
  }

  if (cmd === "ls") {
    const manifest = await storage.readText("manifest");
    const pins = await storage.readText("pins");
    const summary = await storage.readText("summary");
    const pack = await buildContextPack(storage, config);
    const pinsCount = parsePinsMarkdown(pins).length;
    const state = await storage.readState();
    const lines = [
      "# ctx ls",
      "",
      "## manifest",
      ...manifest.split("\n").slice(0, 8),
      "",
      "## overview",
      `- session_id: ${state.currentSessionId || "none"}`,
      `- pins.count: ${pinsCount}`,
      `- summary.chars: ${summary.length}`,
      `- pack.tokens(est): ${pack.details.estimatedTokens}`,
      `- threshold: ${config.tokenThreshold}`,
      `- compact_count: ${state.compactCount || 0}`,
      `- last_search_hits: ${state.lastSearchHits || 0}`,
      `- workset.turns: ${pack.details.recentTurns}`,
      `- workset_used: ${pack.details.worksetUsed ?? pack.details.recentTurns}`,
    ];
    return textResult(lines.join("\n"));
  }

  if (cmd === "stats") {
    const state = await storage.updateState((cur) => ({
      statsCount: (cur.statsCount || 0) + 1,
    }));
    const pack = await buildContextPack(storage, config);
    const breakdown = pack.details.packBreakdown || {};
    const payload = {
      estimated_tokens: pack.details.estimatedTokens,
      threshold: config.tokenThreshold,
      session_id: state.currentSessionId || null,
      compact_count: state.compactCount || 0,
      last_search_hits: state.lastSearchHits || 0,
      workset_used: pack.details.worksetUsed ?? pack.details.recentTurns,
      search_count: state.searchCount || 0,
      timeline_count: state.timelineCount || 0,
      get_count: state.getCount || 0,
      stats_count: state.statsCount || 0,
      pack_breakdown: breakdown,
    };
    const jsonOut = jsonOrText(payload, hasFlag(args, "--json"));
    if (jsonOut) {
      return jsonOut;
    }
    return textResult(
      [
        "# ctx stats",
        `estimated_tokens: ${payload.estimated_tokens}`,
        `threshold: ${payload.threshold}`,
        `session_id: ${payload.session_id || "none"}`,
        `compact_count: ${payload.compact_count}`,
        `last_search_hits: ${payload.last_search_hits}`,
        `workset_used: ${payload.workset_used}`,
        "",
        "pack_breakdown_tokens(est):",
        `pins: ${Number(breakdown.pins_tokens ?? 0)}`,
        `summary: ${Number(breakdown.summary_tokens ?? 0)}`,
        `manifest: ${Number(breakdown.manifest_tokens ?? 0)}`,
        `retrieval_index: ${Number(breakdown.retrieval_index_tokens ?? 0)}`,
        `workset_recent_turns: ${Number(breakdown.workset_recent_turns_tokens ?? 0)}`,
        `overhead: ${Number(breakdown.overhead_tokens ?? 0)}`,
        `total: ${Number(breakdown.total_tokens ?? payload.estimated_tokens ?? 0)}`,
        "",
        `search_count: ${payload.search_count}`,
        `timeline_count: ${payload.timeline_count}`,
        `get_count: ${payload.get_count}`,
        `stats_count: ${payload.stats_count}`,
      ].join("\n"),
    );
  }

  if (cmd === "metrics") {
    const asJson = hasFlag(args, "--json");
    const state = await storage.readState();
    const traces = await storage.readRetrievalTraces({ tail: 1, config });
    const latestTrace = traces.length ? traces[traces.length - 1] : null;
    const retrieval = latestTrace?.inputs?.retrieval || null;
    const payload = {
      layer: "METRICS",
      counters: {
        search_count: state.searchCount || 0,
        timeline_count: state.timelineCount || 0,
        get_count: state.getCount || 0,
        stats_count: state.statsCount || 0,
      },
      last_search: {
        hits: state.lastSearchHits || 0,
        query: String(state.lastSearchQuery || ""),
        at: state.lastSearchAt || null,
      },
      retrieval_latency_ms: retrieval?.latency_ms || null,
      retrieval_mode: retrieval?.mode || null,
      vector_hits: Number(retrieval?.vector_hits || 0),
      vector_engine: retrieval?.vector_engine || null,
      fallback_reason: String(
        retrieval?.vector_fallback_reason
        || retrieval?.fallback_reason
        || retrieval?.lexical_fallback_reason
        || "",
      ),
      ann_recall_probe: retrieval?.ann_recall_probe || null,
    };
    const jsonOut = jsonOrText(payload, asJson);
    if (jsonOut) {
      return jsonOut;
    }
    return textResult(
      [
        "# ctx metrics",
        `search_count: ${payload.counters.search_count}`,
        `timeline_count: ${payload.counters.timeline_count}`,
        `get_count: ${payload.counters.get_count}`,
        `last_search_hits: ${payload.last_search.hits}`,
        `last_search_query: ${payload.last_search.query || "none"}`,
        `retrieval_mode: ${payload.retrieval_mode || "n/a"}`,
        `vector_hits: ${payload.vector_hits}`,
        `vector_engine: ${payload.vector_engine || "n/a"}`,
        `fallback_reason: ${payload.fallback_reason || "none"}`,
        `ann_recall_probe: ${payload.ann_recall_probe ? JSON.stringify(payload.ann_recall_probe) : "n/a"}`,
      ].join("\n"),
    );
  }

  if (cmd === "doctor") {
    const asJson = hasFlag(args, "--json");
    const state = await storage.readState();
    const sqlite = await sqliteIndexDoctor(storage.workspaceDir, config);
    const embeddingHot = await storage.readHistoryEmbeddingHot();
    const embeddingArchive = await storage.readHistoryEmbeddingArchive();
    const embeddingDims = new Set([
      ...embeddingHot.map((row) => Number(row.dim || 0)),
      ...embeddingArchive.map((row) => Number(row.dim || 0)),
    ].filter((n) => Number.isFinite(n) && n > 0));
    const payload = {
      layer: "DOCTOR",
      sqlite_index: sqlite,
      embedding: {
        provider: String(config.vectorProvider || "none"),
        model: String(config.embeddingModel || ""),
        hot_rows: embeddingHot.length,
        archive_rows: embeddingArchive.length,
        dims: Array.from(embeddingDims).sort((a, b) => a - b),
        dims_consistent: embeddingDims.size <= 1,
      },
      history: {
        bad_line_count: Number(state.badLineCount || 0),
      },
    };
    const jsonOut = jsonOrText(payload, asJson);
    if (jsonOut) {
      return jsonOut;
    }
    return textResult(
      [
        "# ctx doctor",
        `sqlite.available: ${String(Boolean(sqlite?.available))}`,
        `sqlite.reason: ${String(sqlite?.reason || "ok")}`,
        `sqlite.turns: ${Number(sqlite?.turns || 0)}`,
        `sqlite.turns_fts: ${Number(sqlite?.turns_fts || 0)}`,
        `sqlite.vector.available: ${String(Boolean(sqlite?.vector?.available))}`,
        `sqlite.vector.engine: ${String(sqlite?.vector?.engine || "sqlite_vec")}`,
        `sqlite.vector.rows: ${Number(sqlite?.vector?.rows || 0)}`,
        `sqlite.vector.dim: ${Number(sqlite?.vector?.dim || 0)}`,
        `sqlite.vector.embedding_version: ${String(sqlite?.vector?.embedding_version || "") || "n/a"}`,
        `sqlite.vector.reason: ${String(sqlite?.vector?.reason || "ok")}`,
        `embedding.provider: ${payload.embedding.provider}`,
        `embedding.model: ${payload.embedding.model || "n/a"}`,
        `embedding.hot_rows: ${payload.embedding.hot_rows}`,
        `embedding.archive_rows: ${payload.embedding.archive_rows}`,
        `embedding.dims: ${payload.embedding.dims.join(",") || "n/a"}`,
        `embedding.dims_consistent: ${String(payload.embedding.dims_consistent)}`,
        `history.bad_line_count: ${payload.history.bad_line_count}`,
      ].join("\n"),
    );
  }

  if (cmd === "cat") {
    const target = safeFileName(args[0]);
    if (!target) {
      return errorResult("unknown file. use manifest|pins|summary|history");
    }
    const headIndex = args.indexOf("--head");
    const head = headIndex >= 0 ? toInt(args[headIndex + 1], 30) : null;
    const text = await storage.readText(target);
    const lines = text.split("\n");
    const out = head ? lines.slice(0, head).join("\n") : text;
    return textResult(out);
  }

  if (cmd === "traces") {
    const asJson = hasFlag(args, "--json");
    const tail = clampInt(toInt(getFlagValue(args, "--tail", config.tracesTailDefault), config.tracesTailDefault), 1, 200);
    const traces = await storage.readRetrievalTraces({ tail, config });

    if (asJson) {
      return textResult(JSON.stringify({
        layer: "TRACE",
        tail,
        hits: traces.length,
        traces,
      }, null, 2));
    }

    const lines = [
      `# traces (tail=${tail}, hits=${traces.length})`,
      "",
      ...traces.map((t) => {
        const id = String(t?.trace_id || "n/a");
        const ts = String(t?.ts || "n/a");
        const command = String(t?.command || "n/a");
        const ok = String(Boolean(t?.ok));
        const hint = safeTrim(t?.query) || safeTrim(t?.args?.id) || safeTrim(t?.args?.anchor) || "";
        return `${id} | ${ts} | ${command} | ok=${ok}${hint ? ` | ${hint}` : ""}`;
      }),
    ];
    return textResult(lines.join("\n"));
  }

  if (cmd === "trace") {
    const asJson = hasFlag(args, "--json");
    const cleanArgs = stripFlags(args, []);
    const traceId = cleanArgs[0];
    if (!traceId) {
      return errorResult("usage: ctx trace <trace_id> [--json]");
    }
    const trace = await storage.findRetrievalTraceById(traceId, { config });
    if (!trace) {
      return errorResult(`trace not found: ${traceId}`);
    }
    if (asJson) {
      return textResult(JSON.stringify({
        layer: "TRACE",
        trace,
      }, null, 2));
    }
    return textResult(JSON.stringify(trace, null, 2));
  }

  if (cmd === "pin") {
    const text = args.join(" ").trim();
    if (!text) {
      return errorResult("usage: ctx pin \"<text>\"");
    }
    const merged = await addPin(storage, text, config);
    await storage.refreshManifest();
    return textResult(`pin added (deduped): count=${merged.length}`);
  }

  if (cmd === "save") {
    const asJson = hasFlag(args, "--json");
    const usage = "ctx save \"<text>\" [--title \"...\"] [--role user|assistant|system|tool|note|unknown] [--type note] [--session current|<id>] [--json]";
    const session = await getSessionForSave(args, storage, usage);
    if (session.error) {
      return errorResult(session.error);
    }
    const titleRaw = getFlagValue(args, "--title", "");
    const roleRaw = getFlagValue(args, "--role", "");
    const typeRaw = getFlagValue(args, "--type", "");
    if (args.includes("--title") && isMissingFlagValue(titleRaw)) {
      return errorResult(`usage: ${usage}`);
    }
    if (args.includes("--role") && isMissingFlagValue(roleRaw)) {
      return errorResult(`usage: ${usage}`);
    }
    if (args.includes("--type") && isMissingFlagValue(typeRaw)) {
      return errorResult(`usage: ${usage}`);
    }
    const cleanArgs = stripFlags(args, ["--title", "--role", "--type", "--session"]);
    const text = cleanArgs.join(" ").trim();
    if (!text) {
      return errorResult(`usage: ${usage}`);
    }
    let role;
    let type;
    try {
      role = normalizeSaveRole(roleRaw);
      type = normalizeSaveType(typeRaw);
    } catch (err) {
      return errorResult(String(err?.message || err || "invalid save arguments"));
    }
    const title = String(titleRaw || "").trim();
    const storedText = title ? `[title] ${title}\n${text}` : text;
    const record = await storage.appendHistory({
      role,
      type,
      text: storedText,
      ...(title ? { tags: [`title:${title}`] } : {}),
      ...(session.sessionId ? { session_id: session.sessionId } : {}),
      ts: new Date().toISOString(),
    });
    await storage.refreshManifest();
    const payload = {
      layer: "WRITE",
      action: "save_memory",
      record: {
        id: record.id,
        ts: record.ts,
        role: record.role,
        type: record.type,
        session_id: record.session_id || null,
        title: title || null,
        text_preview: lineSummary(record.text, config.searchSummaryMaxChars),
        text_len: String(record.text || "").length,
      },
    };
    const jsonOut = jsonOrText(payload, asJson);
    if (jsonOut) {
      return jsonOut;
    }
    return textResult(
      [
        `saved memory: ${payload.record.id}`,
        `- ts: ${payload.record.ts}`,
        `- role: ${payload.record.role}`,
        `- type: ${payload.record.type}`,
        `- session: ${payload.record.session_id || "none"}`,
        `- preview: ${payload.record.text_preview}`,
      ].join("\n"),
    );
  }

  if (cmd === "compact") {
    const result = await maybeCompact(storage, config, true);
    await storage.refreshManifest();
    return textResult(
      [
        "compaction done",
        `- compacted: ${String(result.compacted)}`,
        `- before.tokens: ${result.beforeTokens}`,
        `- after.tokens: ${result.afterTokens}`,
        `- compacted.turns: ${result.compactedTurns}`,
      ].join("\n"),
    );
  }

  if (cmd === "search") {
    const startedAt = Date.now();
    const traceTs = new Date().toISOString();
    const asJson = hasFlag(args, "--json");
    const k = clampInt(toInt(getFlagValue(args, "--k", config.searchDefaultK), config.searchDefaultK), 1, 50);
    const scope = String(getFlagValue(args, "--scope", "all") || "all").toLowerCase();
    const requestedMode = normalizeSearchMode(
      getFlagValue(args, "--mode", config.searchModeDefault || "fallback"),
      normalizeSearchMode(config.searchModeDefault || "fallback", "fallback"),
    );
    const session = await getSessionFilter(args, storage, 'ctx search "<query>" [--k 5] [--scope all|hot|archive] [--mode legacy|lexical|vector|hybrid|fallback] [--session all|current|<id>]');

    const traceArgs = {
      k,
      scope,
      mode: requestedMode,
      session: sessionLabel(session),
    };
    const traceBudgets = {
      k,
      summaryMaxChars: config.searchSummaryMaxChars,
    };

    const writeTraceError = async (message) => {
      const state = await storage.readState();
      await storage.appendRetrievalTrace({
        trace_id: makeTraceId(`${traceTs}|search|${scope}|${k}|${String(session.sessionId || "")}|${state.revision || 0}`),
        ts: traceTs,
        ok: false,
        command: "search",
        args: traceArgs,
        query: "",
        inputs: {
          scope,
          session_mode: session.mode || "all",
        },
        ranking: [],
        budgets: traceBudgets,
        state_revision: state.revision || 0,
        duration_ms: Date.now() - startedAt,
        error: safeOneLine(message, 400),
      }, { config });
    };

    if (session.error) {
      await writeTraceError(session.error);
      return errorResult(session.error);
    }

    const cleanArgs = stripFlags(args, ["--k", "--scope", "--session", "--mode"]);
    const query = cleanArgs.join(" ").trim();
    if (!query) {
      await writeTraceError('usage: ctx search "<query>" [--k 5] [--scope all|hot|archive] [--mode legacy|lexical|vector|hybrid|fallback] [--session all|current|<id>]');
      return errorResult('usage: ctx search "<query>" [--k 5] [--scope all|hot|archive] [--mode legacy|lexical|vector|hybrid|fallback] [--session all|current|<id>]');
    }

    const truncatedFields = new Set();
    const queryTrace = safeOneLine(query, config.traceQueryMaxChars, truncatedFields, "query");

    const queryTokens = tokenize(query);
    const { history, archive } = await readHistoryByScope(storage, scope);
    const pool = mergeUniqueHistory(history, archive);
    const hotIds = new Set(history.map((item) => String(item.id)));
    const sessionPool =
      session.mode === "all"
        ? pool
        : pool.filter((item) => String(item?.session_id || "") === String(session.sessionId || ""));
    const newestTs = sessionPool.length ? Date.parse(String(sessionPool[sessionPool.length - 1].ts || "")) : Date.now();
    const candidateMax = clampInt(
      toInt(config.fusionCandidateMax, Math.max(k, config.vectorTopN || 20)),
      k,
      500,
    );
    const latency = {
      lexical: 0,
      vector: 0,
      fusion: 0,
      total: 0,
    };

    const lexicalStartedAt = Date.now();
    let lexicalEngineUsed = "legacy";
    let lexicalFallbackReason = "";
    let lexicalRanked = [];
    const sqlitePreferred = requestedMode === "lexical" || requestedMode === "hybrid" || requestedMode === "fallback";
    if (sqlitePreferred) {
      try {
        const sqliteResult = await searchSqliteLexical(storage.workspaceDir, config, {
          query,
          k: Math.max(k, candidateMax),
          scope,
          sessionId: session.mode === "all" ? "" : String(session.sessionId || ""),
        });
        if (sqliteResult?.available) {
          lexicalEngineUsed = "sqlite_fts5";
          lexicalRanked = (Array.isArray(sqliteResult.rows) ? sqliteResult.rows : [])
            .map((entry) => ({
              entry,
              score: Number(entry.score || 0),
            }))
            .filter((item) => item.score > 0)
            .slice(0, candidateMax);
        } else {
          lexicalFallbackReason = safeOneLine(String(sqliteResult?.reason || "sqlite lexical unavailable"), 220);
        }
      } catch (err) {
        lexicalFallbackReason = safeOneLine(String(err?.message || err), 220);
      }
    }
    if (requestedMode === "legacy" || (!lexicalRanked.length && lexicalEngineUsed !== "sqlite_fts5")) {
      lexicalEngineUsed = "legacy";
      lexicalRanked = sessionPool
        .map((entry) => ({
          entry,
          score: scoreEntry(entry, queryTokens, newestTs),
        }))
        .filter((item) => item.score > 0)
        .sort((a, b) => (b.score - a.score) || String(b.entry.ts || "").localeCompare(String(a.entry.ts || "")))
        .slice(0, candidateMax);
    }
    latency.lexical = Date.now() - lexicalStartedAt;
    const lexicalRankById = new Map();
    for (let i = 0; i < lexicalRanked.length; i += 1) {
      const item = lexicalRanked[i];
      lexicalRankById.set(String(item.entry.id), {
        rank: i + 1,
        score: item.score,
        entry: item.entry,
      });
    }

    const retrievalModeConfigured = normalizeRetrievalMode(config);
    let retrievalModeUsed = "lexical";
    let vectorFallbackReason = "";
    let vectorEngineUsed = "";
    let annRecallProbe = null;
    let vectorRanked = [];
    const vectorStartedAt = Date.now();
    const vectorWanted =
      requestedMode === "vector"
      || requestedMode === "hybrid"
      || (requestedMode === "fallback" && shouldUseHybridRetrieval(config));
    if (vectorWanted) {
      retrievalModeUsed = requestedMode === "vector" ? "vector" : "hybrid";
      try {
        const providerConfig = {
          ...config,
          retrievalMode: "hybrid",
          vectorEnabled: true,
        };
        const provider = createEmbeddingProvider(providerConfig);
        const embeddedQuery = await embedTexts(provider, [query], { batchSize: 1 });
        const queryEmbedding = embeddedQuery[0];
        const queryVector = Array.isArray(queryEmbedding?.vector) ? queryEmbedding.vector : [];
        if (!queryVector.length) {
          throw new Error("query embedding is empty");
        }
        await ensureVectorRows(storage, provider, sessionPool, hotIds, providerConfig);
        const vectorLimit = clampInt(toInt(config.vectorTopN, 20), 1, 200);
        const vectorCandidateK = Math.max(k, vectorLimit, candidateMax);
        const sessionId = session.mode === "all" ? "" : String(session.sessionId || "");
        const annEnabled = providerConfig.annEnabled !== false;
        const annResult = annEnabled
          ? await searchSqliteVectorAnn(
            storage.workspaceDir,
            providerConfig,
            queryVector,
            {
              k: vectorCandidateK,
              scope,
              sessionId,
              annTopN: Math.max(vectorCandidateK, clampInt(toInt(config.annTopN, vectorCandidateK), vectorCandidateK, 5000)),
              embeddingVersion: String(queryEmbedding?.embedding_version || ""),
            },
          )
          : {
            available: false,
            reason: "ann_disabled",
            rows: [],
          };
        const annRows = annResult?.available ? (Array.isArray(annResult.rows) ? annResult.rows : []) : [];
        let linearResult = null;
        if (!annRows.length) {
          linearResult = await searchSqliteVectorLinear(
            storage.workspaceDir,
            providerConfig,
            queryVector,
            {
              k: vectorCandidateK,
              scope,
              sessionId,
              minSimilarity: Number(config.vectorMinSimilarity ?? 0.35),
              linearLimit: Math.max(
                vectorCandidateK,
                clampInt(toInt(config.annProbeTopN, vectorCandidateK), vectorCandidateK, 100000),
              ),
              embeddingVersion: String(queryEmbedding?.embedding_version || ""),
            },
          );
        }
        let vectorRows = [];
        if (annRows.length) {
          vectorEngineUsed = "sqlite_vec_ann";
          vectorRows = annRows;
        } else if (linearResult?.available) {
          vectorEngineUsed = "sqlite_vec_linear";
          vectorRows = Array.isArray(linearResult.rows) ? linearResult.rows : [];
          if (!vectorRows.length) {
            const annReason = String(annResult?.reason || "ann_no_hits");
            const linearReason = String(linearResult?.reason || "linear_no_hits");
            vectorFallbackReason = safeOneLine(`${annReason}; ${linearReason}`, 220);
          }
        } else {
          retrievalModeUsed = "lexical";
          const annReason = String(annResult?.reason || "ann_unavailable");
          const linearReason = String(linearResult?.reason || "linear_unavailable");
          vectorFallbackReason = safeOneLine(`${annReason}; ${linearReason}`, 220);
        }
        if (vectorRows.length && vectorEngineUsed === "sqlite_vec_ann") {
          const probeN = clampInt(toInt(config.annProbeTopN, 0), 0, 5000);
          if (probeN > 0 && Math.random() < 0.1) {
            const probeLinear = await searchSqliteVectorLinear(
              storage.workspaceDir,
              providerConfig,
              queryVector,
              {
                k: probeN,
                scope,
                sessionId,
                minSimilarity: -1,
                linearLimit: Math.max(probeN, vectorCandidateK),
                embeddingVersion: String(queryEmbedding?.embedding_version || ""),
              },
            );
            if (probeLinear?.available) {
              const annTop = vectorRows.slice(0, probeN).map((row) => String(row?.id || ""));
              const linearTop = (Array.isArray(probeLinear.rows) ? probeLinear.rows : [])
                .slice(0, probeN)
                .map((row) => String(row?.id || ""));
              const annSet = new Set(annTop.filter(Boolean));
              let overlap = 0;
              for (const id of linearTop) {
                if (annSet.has(id)) {
                  overlap += 1;
                }
              }
              const denom = Math.max(1, Math.min(probeN, linearTop.length));
              annRecallProbe = {
                probe_k: probeN,
                overlap,
                recall: Number((overlap / denom).toFixed(4)),
              };
            }
          }
        }
        vectorRanked = vectorRows
          .map((entry) => ({
            entry,
            score: Number(entry?.score || 0),
          }))
          .filter((row) => Number.isFinite(row.score) && row.score > 0)
          .slice(0, vectorCandidateK);
        if (!vectorRanked.length) {
          retrievalModeUsed = "lexical";
          if (!vectorFallbackReason) {
            vectorFallbackReason = "vector_no_hits";
          }
        }
      } catch (err) {
        retrievalModeUsed = "lexical";
        vectorFallbackReason = safeOneLine(String(err?.message || err), 220);
      }
    }
    latency.vector = Date.now() - vectorStartedAt;
    const vectorRankById = new Map();
    for (let i = 0; i < vectorRanked.length; i += 1) {
      const item = vectorRanked[i];
      vectorRankById.set(String(item.entry.id), {
        rank: i + 1,
        score: item.score,
        entry: item.entry,
      });
    }
    const fusedRanked = [];
    const fusionStartedAt = Date.now();
    if (retrievalModeUsed === "hybrid" && vectorRankById.size > 0) {
      const rrfK = clampInt(toInt(config.fusionRrfK, 60), 1, 500);
      const merged = new Map();
      for (const [id, lexical] of lexicalRankById) {
        merged.set(id, {
          entry: lexical.entry,
          lexicalRank: lexical.rank,
          lexicalScore: lexical.score,
          vectorRank: null,
          vectorScore: 0,
        });
      }
      for (const [id, vector] of vectorRankById) {
        if (!merged.has(id)) {
          merged.set(id, {
            entry: vector.entry,
            lexicalRank: null,
            lexicalScore: 0,
            vectorRank: vector.rank,
            vectorScore: vector.score,
          });
          continue;
        }
        const cur = merged.get(id);
        cur.vectorRank = vector.rank;
        cur.vectorScore = vector.score;
      }
      for (const item of merged.values()) {
        fusedRanked.push({
          ...item,
          score: rrfScore(item.lexicalRank, rrfK) + rrfScore(item.vectorRank, rrfK),
          match: item.lexicalRank && item.vectorRank ? "hybrid" : (item.vectorRank ? "vector" : "lexical"),
        });
      }
      fusedRanked.sort((a, b) => (b.score - a.score) || String(b.entry.ts || "").localeCompare(String(a.entry.ts || "")));
    }
    latency.fusion = Date.now() - fusionStartedAt;
    let finalRanked = [];
    if (retrievalModeUsed === "vector") {
      finalRanked = vectorRanked.map((item, idx) => ({
        entry: item.entry,
        lexicalRank: null,
        lexicalScore: 0,
        vectorRank: idx + 1,
        vectorScore: item.score,
        score: item.score,
        match: "vector",
      })).slice(0, k);
    } else if (retrievalModeUsed === "hybrid" && fusedRanked.length > 0) {
      finalRanked = fusedRanked.slice(0, k);
    } else {
      finalRanked = lexicalRanked.slice(0, k).map((item, idx) => ({
        entry: item.entry,
        lexicalRank: idx + 1,
        lexicalScore: item.score,
        vectorRank: null,
        vectorScore: 0,
        score: item.score,
        match: "lexical",
      }));
    }
    if (!finalRanked.length && requestedMode !== "legacy" && lexicalEngineUsed === "sqlite_fts5" && sessionPool.length > 0) {
      const fallbackLegacy = sessionPool
        .map((entry) => ({
          entry,
          score: scoreEntry(entry, queryTokens, newestTs),
        }))
        .filter((item) => item.score > 0)
        .sort((a, b) => (b.score - a.score) || String(b.entry.ts || "").localeCompare(String(a.entry.ts || "")))
        .slice(0, k)
        .map((item, idx) => ({
          entry: item.entry,
          lexicalRank: idx + 1,
          lexicalScore: item.score,
          vectorRank: null,
          vectorScore: 0,
          score: item.score,
          match: "lexical",
        }));
      if (fallbackLegacy.length) {
        finalRanked = fallbackLegacy;
        retrievalModeUsed = "lexical";
        lexicalEngineUsed = "legacy";
        lexicalFallbackReason = lexicalFallbackReason || "sqlite lexical returned no hits; fallback to legacy lexical";
      }
    }
    const rows = finalRanked.map((item) => ({
      ...(() => {
        const entry = item.entry;
        const source = String(entry?.source || sourceForId(entry.id, hotIds));
        const row = toL0Row(entry, config, source, {
          score: Number(item.score.toFixed(3)),
          match: item.match,
          score_lex: Number((item.lexicalScore || 0).toFixed(6)),
          score_vec: Number((item.vectorScore || 0).toFixed(6)),
          score_final: Number((item.score || 0).toFixed(6)),
        });

        const beforeDefault = config.timelineBeforeDefault;
        const afterDefault = config.timelineAfterDefault;
        const window = beforeDefault + afterDefault + 1;
        const timelineTokensEst = estimateTokens(row.summary) * Math.max(1, window);

        const headDefault = config.getDefaultHead;
        const entryText = String(entry?.text || "");
        const getPreview = headDefault > 0 ? entryText.slice(0, headDefault) : entryText;
        const getTokensEst = estimateTokens(getPreview) + 80; // fixed overhead for JSON fields, ids, refs/tags, etc.

        row.expand = {
          timeline: {
            before: beforeDefault,
            after: afterDefault,
            window,
            tokens_est: timelineTokensEst,
            size: sizeBucket(timelineTokensEst),
          },
          get: {
            head: headDefault,
            tokens_est: getTokensEst,
            size: sizeBucket(getTokensEst),
            confidence: source === "hot" ? "medium" : "low",
          },
        };
        return row;
      })(),
    }));
    latency.total = Date.now() - startedAt;
    const retrievalStats = {
      configured_mode: retrievalModeConfigured,
      requested_mode: requestedMode,
      mode: retrievalModeUsed,
      lexical_engine: lexicalEngineUsed,
      vector_engine: vectorEngineUsed || null,
      lexical_hits: lexicalRanked.length,
      vector_hits: vectorRanked.length,
      fused_hits: fusedRanked.length || rows.length,
      latency_ms: latency,
      ...(lexicalFallbackReason ? { lexical_fallback_reason: lexicalFallbackReason } : {}),
      ...(vectorFallbackReason ? { vector_fallback_reason: vectorFallbackReason, fallback_reason: vectorFallbackReason } : {}),
      ...(annRecallProbe ? { ann_recall_probe: annRecallProbe } : {}),
    };

    const state = await storage.updateState((cur) => ({
      lastSearchHits: rows.length,
      lastSearchQuery: query,
      lastSearchAt: new Date().toISOString(),
      lastSearchIndex: rows,
      searchCount: (cur.searchCount || 0) + 1,
    }));

    await storage.appendRetrievalTrace({
      trace_id: makeTraceId(`${traceTs}|search|${queryTrace}|${k}|${scope}|${session.mode}|${String(session.sessionId || "")}|${state.revision || 0}`),
      ts: traceTs,
      ok: true,
      command: "search",
      args: traceArgs,
      query: queryTrace,
      inputs: {
        pool: {
          hot: history.length,
          archive: archive.length,
          merged_unique: pool.length,
          session_filtered: sessionPool.length,
        },
        scope,
        session_mode: session.mode,
        retrieval: retrievalStats,
      },
      ranking: rows.slice(0, config.traceRankingMaxItems).map((row) => ({
        id: row.id,
        ts: row.ts,
        type: row.type,
        source: row.source,
        summary: row.summary,
        score: row.score,
        match: row.match,
      })),
      budgets: traceBudgets,
      ...(truncatedFields.size ? { truncation: { truncated: true, fields: Array.from(truncatedFields) } } : {}),
      state_revision: state.revision || 0,
      duration_ms: Date.now() - startedAt,
    }, { config });

    if (asJson) {
      return textResult(JSON.stringify({
        layer: "L0",
        query,
        k,
        scope,
        session: session.mode === "all" ? "all" : session.sessionId,
        hits: rows.length,
        retrieval: retrievalStats,
        results: rows,
      }, null, 2));
    }

    const lines = [
      `# search (${rows.length} hits, scope=${scope}, session=${session.mode === "all" ? "all" : session.sessionId}, mode=${retrievalStats.mode})`,
      "",
      ...rows.map((x) => `${x.id} | ${x.ts} | ${x.type} | ${x.source} | ${x.summary}`),
    ];
    return textResult(lines.join("\n"));
  }

  if (cmd === "timeline") {
    const startedAt = Date.now();
    const traceTs = new Date().toISOString();
    const asJson = hasFlag(args, "--json");
    const session = await getSessionFilter(args, storage, "ctx timeline <id> [--before 3 --after 3] [--session all|current|<id>]");
    const cleanArgs = stripFlags(args, ["--before", "--after", "--session"]);
    const anchorId = cleanArgs[0];
    const before = clampInt(
      toInt(getFlagValue(args, "--before", config.timelineBeforeDefault), config.timelineBeforeDefault),
      0,
      20,
    );
    const after = clampInt(
      toInt(getFlagValue(args, "--after", config.timelineAfterDefault), config.timelineAfterDefault),
      0,
      20,
    );

    const traceArgs = {
      anchor: anchorId || "",
      before,
      after,
      session: sessionLabel(session),
    };
    const traceBudgets = {
      before,
      after,
      summaryMaxChars: config.searchSummaryMaxChars,
    };

    const writeTraceError = async (message) => {
      const state = await storage.readState();
      await storage.appendRetrievalTrace({
        trace_id: makeTraceId(`${traceTs}|timeline|${String(anchorId || "")}|${before}|${after}|${String(session.sessionId || "")}|${state.revision || 0}`),
        ts: traceTs,
        ok: false,
        command: "timeline",
        args: traceArgs,
        inputs: {
          session_mode: session.mode || "all",
        },
        ranking: [],
        budgets: traceBudgets,
        state_revision: state.revision || 0,
        duration_ms: Date.now() - startedAt,
        error: safeOneLine(message, 400),
      }, { config });
    };

    if (session.error) {
      await writeTraceError(session.error);
      return errorResult(session.error);
    }

    if (!anchorId) {
      await writeTraceError("usage: ctx timeline <id> [--before 3 --after 3] [--session all|current|<id>]");
      return errorResult("usage: ctx timeline <id> [--before 3 --after 3] [--session all|current|<id>]");
    }

    const history = await storage.readHistory();
    const archive = mergeUniqueHistory([], asArchiveSearchRows(await storage.readHistoryArchive()));
    const hotMatches = findIdMatches(history, anchorId);
    const archiveMatches = findIdMatches(archive, anchorId);
    const sourceList = hotMatches.length ? history : archive;
    let matches = hotMatches.length ? hotMatches : archiveMatches;
    if (!matches.length) {
      await writeTraceError(`id not found: ${anchorId}`);
      return errorResult(`id not found: ${anchorId}`);
    }
    if (matches.length > 1) {
      if (session.mode !== "all") {
        const filtered = matches.filter((item) => String(item?.session_id || "") === String(session.sessionId || ""));
        if (filtered.length === 1) {
          matches = filtered;
        } else if (!filtered.length) {
          await writeTraceError(`id conflict: ${anchorId} (no match for session ${session.sessionId}). run ctx gc or migration to repair duplicate ids`);
          return errorResult(`id conflict: ${anchorId} (no match for session ${session.sessionId}). run ctx gc or migration to repair duplicate ids`);
        } else {
          await writeTraceError(`id conflict: ${anchorId} (multiple matches in session ${session.sessionId}). run ctx gc or migration to repair duplicate ids`);
          return errorResult(`id conflict: ${anchorId} (multiple matches in session ${session.sessionId}). run ctx gc or migration to repair duplicate ids`);
        }
      } else {
        await writeTraceError(`id conflict: ${anchorId}. run ctx gc or migration to repair duplicate ids`);
        return errorResult(`id conflict: ${anchorId}. run ctx gc or migration to repair duplicate ids`);
      }
    }
    const resolvedId = matches[0].id;
    const index = sourceList.findIndex((item) => String(item.id) === String(resolvedId));
    const start = Math.max(0, index - before);
    const end = Math.min(sourceList.length, index + after + 1);
    const sliceSource = hotMatches.length ? "hot" : "archive";
    const slice = sourceList.slice(start, end).map((entry) => toL0Row(entry, config, sliceSource));

    const state = await storage.updateState((cur) => ({
      timelineCount: (cur.timelineCount || 0) + 1,
      lastTimelineAnchor: resolvedId,
    }));

    await storage.appendRetrievalTrace({
      trace_id: makeTraceId(`${traceTs}|timeline|${resolvedId}|${before}|${after}|${sliceSource}|${String(session.sessionId || "")}|${state.revision || 0}`),
      ts: traceTs,
      ok: true,
      command: "timeline",
      args: {
        ...traceArgs,
        anchor: resolvedId,
      },
      inputs: {
        source: sliceSource,
        list_size: sourceList.length,
        session_mode: session.mode,
      },
      ranking: slice.slice(0, config.traceRankingMaxItems).map((row) => ({
        id: row.id,
        ts: row.ts,
        type: row.type,
        source: row.source,
        summary: row.summary,
      })),
      budgets: traceBudgets,
      state_revision: state.revision || 0,
      duration_ms: Date.now() - startedAt,
    }, { config });

    if (asJson) {
      return textResult(JSON.stringify({
        layer: "L0",
        anchor: resolvedId,
        before,
        after,
        source: sliceSource,
        session: session.mode === "all" ? "all" : session.sessionId,
        results: slice,
      }, null, 2));
    }
    const lines = [
      `# timeline ${resolvedId} (session=${session.mode === "all" ? "all" : session.sessionId})`,
      "",
      ...slice.map((x) => `${x.id} | ${x.ts} | ${x.type} | ${x.source} | ${x.summary}`),
    ];
    return textResult(lines.join("\n"));
  }

  if (cmd === "get") {
    const startedAt = Date.now();
    const traceTs = new Date().toISOString();
    const asJson = hasFlag(args, "--json");
    const session = await getSessionFilter(args, storage, "ctx get <id> [--head 1200] [--session all|current|<id>]");
    const headRequested = clampInt(toInt(getFlagValue(args, "--head", config.getDefaultHead), config.getDefaultHead), 0, 200000);

    const writeTraceError = async (idValue, message) => {
      const state = await storage.readState();
      await storage.appendRetrievalTrace({
        trace_id: makeTraceId(`${traceTs}|get|${String(idValue || "")}|${headRequested}|${String(session.sessionId || "")}|${state.revision || 0}`),
        ts: traceTs,
        ok: false,
        command: "get",
        args: {
          id: String(idValue || ""),
          head: headRequested,
          session: sessionLabel(session),
        },
        inputs: {
          session_mode: session.mode || "all",
        },
        ranking: [],
        budgets: {
          head: headRequested,
        },
        state_revision: state.revision || 0,
        duration_ms: Date.now() - startedAt,
        error: safeOneLine(message, 400),
      }, { config });
    };

    if (session.error) {
      await writeTraceError("", session.error);
      return errorResult(session.error);
    }

    const cleanArgs = stripFlags(args, ["--head", "--session"]);
    const id = cleanArgs[0];
    if (!id) {
      await writeTraceError("", "usage: ctx get <id> [--head 1200] [--session all|current|<id>]");
      return errorResult("usage: ctx get <id> [--head 1200] [--session all|current|<id>]");
    }

    const head = headRequested;
    const history = await storage.readHistory();
    const hotMatches = findIdMatches(history, id);
    const archiveRow = await storage.findHistoryArchiveById(id);
    let matches = hotMatches.length ? hotMatches : (archiveRow ? [archiveRow] : []);
    if (!matches.length) {
      await writeTraceError(id, `id not found: ${id}`);
      return errorResult(`id not found: ${id}`);
    }
    if (matches.length > 1) {
      if (session.mode !== "all") {
        const filtered = matches.filter((item) => String(item?.session_id || "") === String(session.sessionId || ""));
        if (filtered.length === 1) {
          matches = filtered;
        } else if (!filtered.length) {
          const message = `id conflict: ${id} (no match for session ${session.sessionId}). run ctx gc or migration to repair duplicate ids`;
          await writeTraceError(id, message);
          return errorResult(message);
        } else {
          const message = `id conflict: ${id} (multiple matches in session ${session.sessionId}). run ctx gc or migration to repair duplicate ids`;
          await writeTraceError(id, message);
          return errorResult(message);
        }
      } else {
        const message = `id conflict: ${id}. run ctx gc or migration to repair duplicate ids`;
        await writeTraceError(id, message);
        return errorResult(message);
      }
    }

    const row = matches[0];
    const source = hotMatches.length ? "hot" : "archive";
    const ranking = [toL0Row(row, config, source)].slice(0, config.traceRankingMaxItems).map((r) => ({
      id: r.id,
      ts: r.ts,
      type: r.type,
      source: r.source,
      summary: r.summary,
    }));

    const state = await storage.updateState((cur) => ({
      getCount: (cur.getCount || 0) + 1,
    }));

    if (asJson) {
      const jsonBudget = head > 0 ? head : config.getDefaultHead;
      const truncationFields = new Set();
      const base = {
        layer: "L2",
        record: row,
        source,
        head: jsonBudget,
        original_text_len: String(row.text || "").length,
      };
      let limited = applyJsonHeadLimit(base, jsonBudget, {
        headText: config.getDefaultHead,
      }).payload;
      if (limited.truncated) {
        truncationFields.add("text");
        for (const field of Array.isArray(limited.truncated_fields) ? limited.truncated_fields : []) {
          truncationFields.add(field);
        }
      }
      let json = JSON.stringify(limited, null, 2);
      let bytes = Buffer.byteLength(json, "utf8");
      let guard = 0;
      const truncatedFields = new Set(limited.truncated_fields || []);
      while (bytes > jsonBudget && guard < 500) {
        guard += 1;
        const refs = Array.isArray(limited.record.refs) ? limited.record.refs : [];
        const tags = Array.isArray(limited.record.tags) ? limited.record.tags : [];
        const textValue = String(limited.record.text || "");
        if (refs.length > 0) {
          limited.record.refs = refs.slice(0, refs.length - 1);
          truncatedFields.add("refs");
          truncationFields.add("refs");
        } else if (tags.length > 0) {
          limited.record.tags = tags.slice(0, tags.length - 1);
          truncatedFields.add("tags");
          truncationFields.add("tags");
        } else if (textValue.length > 4) {
          const next = Math.max(4, textValue.length - 32);
          limited.record.text = `${textValue.slice(0, Math.max(0, next - 3))}...`;
          truncatedFields.add("text");
          truncationFields.add("text");
        } else if (String(limited.record.id || "").length > 16) {
          limited.record.id = truncateValue(limited.record.id, 16, "id", truncatedFields);
          truncationFields.add("id");
        } else if (String(limited.record.type || "").length > 16) {
          limited.record.type = truncateValue(limited.record.type, 16, "type", truncatedFields);
          truncationFields.add("type");
        } else {
          break;
        }
        limited.truncated = true;
        limited.truncated_fields = Array.from(truncatedFields);
        json = JSON.stringify(limited, null, 2);
        bytes = Buffer.byteLength(json, "utf8");
      }

      if (bytes > jsonBudget) {
        limited = {
          record: {
            id: truncateValue(limited.record.id, 16, "id", truncatedFields),
            type: truncateValue(limited.record.type, 16, "type", truncatedFields),
            refs: [],
            tags: [],
            text: "...",
          },
          head: jsonBudget,
          original_text_len: base.original_text_len,
          truncated: true,
          truncated_fields: Array.from(new Set([...truncatedFields, "refs", "tags", "text"])),
          original_sizes: limited.original_sizes,
        };
        truncationFields.add("text");
        truncationFields.add("refs");
        truncationFields.add("tags");
        json = JSON.stringify(limited, null, 2);
      }
      if (Buffer.byteLength(json, "utf8") > jsonBudget) {
        const originalId = String(row.id || "");
        const tiny = {
          id: originalId,
          truncated: true,
          effective_head: jsonBudget,
          note: "budget_too_small",
        };
        truncationFields.add("text");
        let tinyJson = JSON.stringify(tiny);
        while (Buffer.byteLength(tinyJson, "utf8") > jsonBudget && tiny.id.length > 0) {
          tiny.id = tiny.id.slice(0, Math.max(0, tiny.id.length - 1));
          tinyJson = JSON.stringify(tiny);
        }
        while (Buffer.byteLength(tinyJson, "utf8") > jsonBudget && tiny.note.length > 0) {
          tiny.note = tiny.note.slice(0, Math.max(0, tiny.note.length - 1));
          tinyJson = JSON.stringify(tiny);
        }
        if (Buffer.byteLength(tinyJson, "utf8") > jsonBudget) {
          tinyJson = JSON.stringify({ truncated: true });
        }
        if (Buffer.byteLength(tinyJson, "utf8") > jsonBudget) {
          tinyJson = "{}";
        }

        await storage.appendRetrievalTrace({
          trace_id: makeTraceId(`${traceTs}|get|${id}|${jsonBudget}|${source}|${String(session.sessionId || "")}|${state.revision || 0}`),
          ts: traceTs,
          ok: true,
          command: "get",
          args: {
            id,
            head: jsonBudget,
            session: sessionLabel(session),
          },
          inputs: {
            source,
            session_mode: session.mode,
          },
          ranking,
          budgets: {
            head: jsonBudget,
          },
          truncation: {
            truncated: true,
            fields: Array.from(truncationFields),
          },
          state_revision: state.revision || 0,
          duration_ms: Date.now() - startedAt,
        }, { config });

        return textResult(tinyJson);
      }

      await storage.appendRetrievalTrace({
        trace_id: makeTraceId(`${traceTs}|get|${id}|${jsonBudget}|${source}|${String(session.sessionId || "")}|${state.revision || 0}`),
        ts: traceTs,
        ok: true,
        command: "get",
        args: {
          id,
          head: jsonBudget,
          session: sessionLabel(session),
        },
        inputs: {
          source,
          session_mode: session.mode,
        },
        ranking,
        budgets: {
          head: jsonBudget,
        },
        ...(truncationFields.size ? { truncation: { truncated: true, fields: Array.from(truncationFields) } } : {}),
        state_revision: state.revision || 0,
        duration_ms: Date.now() - startedAt,
      }, { config });

      return textResult(json);
    }

    const full = JSON.stringify({ source, record: row }, null, 2);
    const clipped = head > 0 ? `${full.slice(0, head)}${full.length > head ? "\n..." : ""}` : full;

    await storage.appendRetrievalTrace({
      trace_id: makeTraceId(`${traceTs}|get|${id}|${head}|${source}|${String(session.sessionId || "")}|${state.revision || 0}`),
      ts: traceTs,
      ok: true,
      command: "get",
      args: {
        id,
        head,
        session: sessionLabel(session),
      },
      inputs: {
        source,
        session_mode: session.mode,
      },
      ranking,
      budgets: {
        head,
      },
      state_revision: state.revision || 0,
      duration_ms: Date.now() - startedAt,
    }, { config });

    return textResult(clipped);
  }

  if (cmd === "gc") {
    const compact = await maybeCompact(storage, config, true);
    const pins = await storage.readText("pins");
    const deduped = parsePinsMarkdown(pins).slice(0, config.pinsMaxItems);
    await storage.writeText(
      "pins",
      `# Pins (short, one line each)\n\n${deduped.map((x) => `- [${x.id}] ${x.text}`).join("\n")}${deduped.length ? "\n" : ""}`,
    );
    await storage.refreshManifest();
    return textResult(`gc done; compacted=${String(compact.compacted)}; pins=${deduped.length}`);
  }

  if (cmd === "reindex") {
    const full = hasFlag(args, "--full");
    if (hasFlag(args, "--embedding") || hasFlag(args, "--embeddings")) {
      return errorResult(
        "ctx reindex --vectors rebuilds SQLite vector index; use --full for lexical sqlite rebuild",
      );
    }
    const vectors = hasFlag(args, "--vectors");
    const modelRaw = getFlagValue(args, "--model", "");
    if (args.includes("--model") && isMissingFlagValue(modelRaw)) {
      return errorResult("usage: ctx reindex [--full] [--vectors] [--model <name>]");
    }
    const model = String(modelRaw || "").trim();
    let sqliteResult = { rebuilt: false, reason: "skip (use --full)" };
    if (full) {
      sqliteResult = await rebuildSqliteIndexFromStorage(storage, config);
    }
    let vectorResult = { rebuilt: false, reason: "skip (use --vectors)" };
    if (vectors) {
      vectorResult = await rebuildVectorRows(storage, config, model);
    }
    return textResult(
      [
        "reindex done",
        `- sqlite.rebuilt: ${String(Boolean(sqliteResult?.rebuilt))}`,
        `- sqlite.available: ${String(Boolean(sqliteResult?.available))}`,
        `- sqlite.rows: ${Number(sqliteResult?.rows || 0)}`,
        `- sqlite.reason: ${String(sqliteResult?.reason || "ok")}`,
        `- vectors.rebuilt: ${String(Boolean(vectorResult?.rebuilt))}`,
        `- vectors.count: ${Number(vectorResult?.vectors || 0)}`,
        `- vectors.provider: ${String(vectorResult?.provider || "n/a")}`,
        `- vectors.model: ${String(vectorResult?.model || "n/a")}`,
        `- vectors.dim: ${Number(vectorResult?.dim || 0)}`,
        `- vectors.embedding_version: ${String(vectorResult?.embedding_version || "") || "n/a"}`,
        `- vectors.sqlite_available: ${String(Boolean(vectorResult?.sqlite_available ?? vectorResult?.available))}`,
        `- vectors.reason: ${String(vectorResult?.reason || "ok")}`,
      ].join("\n"),
    );
  }

  return errorResult(`unknown ctx command: ${cmd}`);
}

export async function runCtxCommand(commandLine, storage, config) {
  return runCtxCommandArgs(parseArgs(commandLine), storage, config);
}
