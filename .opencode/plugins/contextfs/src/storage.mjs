import fs from "node:fs/promises";
import path from "node:path";

import { createEmbeddingProvider, embedTexts, hashEmbeddingText, normalizeEmbeddingText } from "./embedding.mjs";
import {
  pruneSqliteVectorRowsByTurnIds,
  sqliteIndexDoctor,
  toSqliteTurnRow,
  upsertSqliteTurnRows,
  upsertSqliteVectorRows,
} from "./index/sqlite_store.mjs";

const FILES = {
  manifest: "manifest.md",
  pins: "pins.md",
  summary: "summary.md",
  history: "history.ndjson",
  historyArchive: "history.archive.ndjson",
  historyEmbeddingHot: "history.embedding.hot.ndjson",
  historyEmbeddingArchive: "history.embedding.archive.ndjson",
  historyBad: "history.bad.ndjson",
  retrievalTraces: "retrieval.traces.ndjson",
  state: "state.json",
};

const LEGACY_FALLBACK_EPOCH_MS = 0;
const RETRYABLE_LOCK_ERRORS = new Set(["EEXIST", "EBUSY"]);
const LOCK_PERMISSION_ERRORS = new Set(["EPERM", "EACCES"]);
const RETRYABLE_RENAME_ERRORS = new Set(["EBUSY", "EPERM", "EXDEV"]);
const RETRYABLE_UNLINK_ERRORS = new Set(["EBUSY", "EPERM"]);

function nowIso() {
  return new Date().toISOString();
}

function safeTrim(text) {
  return String(text || "").trim();
}

function stableFallbackTs(index) {
  const n = Number(index);
  const safeIndex = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  return new Date(LEGACY_FALLBACK_EPOCH_MS + safeIndex).toISOString();
}

function isValidTs(value) {
  const text = safeTrim(value);
  if (!text) {
    return false;
  }
  return Number.isFinite(Date.parse(text));
}

function shortHash(text) {
  const source = String(text || "");
  let h = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    h ^= source.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16).slice(0, 10);
}

function uniqList(items, max = 12) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const value = safeTrim(item);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

function normalizeTs(value, fallbackTs) {
  const text = safeTrim(value);
  if (text) {
    const t = Date.parse(text);
    if (!Number.isNaN(t)) {
      return new Date(t).toISOString();
    }
  }
  if (isValidTs(fallbackTs)) {
    return new Date(Date.parse(fallbackTs)).toISOString();
  }
  return stableFallbackTs(0);
}

function normalizeRole(value) {
  const role = safeTrim(value).toLowerCase();
  if (!role) {
    return "unknown";
  }
  if (role === "human") {
    return "user";
  }
  if (role === "ai") {
    return "assistant";
  }
  return role;
}

function inferType(role, text) {
  const body = String(text || "").toLowerCase();
  if (role === "tool") {
    return "tool_output";
  }
  if (/(http:\/\/|https:\/\/|error|stack|trace|exception|issue|fix|bug)/.test(body)) {
    return "artifact";
  }
  if (role === "assistant") {
    return "response";
  }
  if (role === "user") {
    return "query";
  }
  return "note";
}

function extractRefs(text) {
  const source = String(text || "");
  if (!source) {
    return [];
  }
  const refs = [];

  const urls = source.match(/https?:\/\/[^\s)\]}"'<>]+/g) || [];
  refs.push(...urls.map((u) => `url:${u}`));

  const unixPaths = source.match(/(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+\.(?:mjs|js|ts|tsx|md|json|yml|yaml|py|go|rs|java|cpp|c)/g) || [];
  refs.push(...unixPaths.map((p) => `file:${p}`));

  const windowsPaths = source.match(/[A-Za-z]:\\[\w .-]+(?:\\[\w .-]+)+\.(?:mjs|js|ts|tsx|md|json|py|go|rs|java|cpp|c)/g) || [];
  refs.push(...windowsPaths.map((p) => `file:${p}`));

  const funcs = source.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g) || [];
  refs.push(...funcs.map((f) => `fn:${f.replace(/\s*\($/, "")}`));

  const issues = source.match(/#\d+/g) || [];
  refs.push(...issues.map((i) => `issue:${i}`));

  return uniqList(refs, 10);
}

function normalizeSessionId(value) {
  const clean = safeTrim(value);
  if (!clean) {
    return undefined;
  }
  // Keep session ids small/stable; avoid bloating history/index rows.
  const maxLen = 96;
  return clean.length <= maxLen ? clean : clean.slice(0, maxLen);
}

function normalizeEntry(raw, fallbackTs = stableFallbackTs(0)) {
  const src = raw && typeof raw === "object" ? raw : {};
  const role = normalizeRole(src.role || src.author || src.messageRole);
  const text = String(src.text ?? src.content ?? src.message ?? "").trim();
  const ts = normalizeTs(src.ts || src.timestamp, fallbackTs);
  const refs = uniqList(Array.isArray(src.refs) ? src.refs : extractRefs(text), 12);
  const tags = Array.isArray(src.tags) ? uniqList(src.tags, 12) : undefined;
  const type = safeTrim(src.type) || inferType(role, text);
  const session_id = normalizeSessionId(src.session_id ?? src.sessionId ?? src.session);
  const idSeed = `${ts}|${role}|${text}`;
  const id = safeTrim(src.id) || `H-${shortHash(idSeed)}`;
  const base = {
    id,
    ts,
    role,
    type,
    refs,
    text,
  };
  if (tags && tags.length) {
    base.tags = tags;
  }
  if (session_id) {
    base.session_id = session_id;
  }
  return base;
}

function makeUniqueId(baseId, usedIds) {
  const cleanBase = safeTrim(baseId) || `H-${shortHash(baseId)}`;
  if (!usedIds.has(cleanBase)) {
    usedIds.add(cleanBase);
    return cleanBase;
  }
  let suffix = 1;
  let candidate = `${cleanBase}-${suffix}`;
  while (usedIds.has(candidate)) {
    suffix += 1;
    candidate = `${cleanBase}-${suffix}`;
  }
  usedIds.add(candidate);
  return candidate;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableSqliteWriteError(err) {
  const msg = String(err?.message || "").toUpperCase();
  return msg.includes("SQLITE_BUSY") || msg.includes("SQLITE_LOCKED");
}

function makeTmpPath(target) {
  const rand = Math.random().toString(16).slice(2, 10);
  return `${target}.${process.pid}.${Date.now()}.${rand}.tmp`;
}

async function renameWithRetry(fromPath, toPath, maxRetries = 6) {
  for (let i = 0; i <= maxRetries; i += 1) {
    try {
      await fs.rename(fromPath, toPath);
      return true;
    } catch (err) {
      if (!RETRYABLE_RENAME_ERRORS.has(err?.code) || i === maxRetries) {
        throw err;
      }
      await sleepMs(Math.min(80, 10 + i * 10));
    }
  }
  return false;
}

async function unlinkWithRetry(targetPath, maxRetries = 6) {
  for (let i = 0; i <= maxRetries; i += 1) {
    try {
      await fs.unlink(targetPath);
      return true;
    } catch (err) {
      if (err?.code === "ENOENT") {
        return false;
      }
      if (!RETRYABLE_UNLINK_ERRORS.has(err?.code) || i === maxRetries) {
        throw err;
      }
      await sleepMs(Math.min(80, 10 + i * 10));
    }
  }
  return false;
}

function serializeHistoryEntries(entries) {
  if (!entries.length) {
    return "";
  }
  return `${entries.map((item) => JSON.stringify(item)).join("\n")}\n`;
}

function serializeEmbeddingEntries(entries) {
  if (!entries.length) {
    return "";
  }
  return `${entries.map((item) => JSON.stringify(item)).join("\n")}\n`;
}

function embeddingStatsFromRaw(rawText) {
  const lines = String(rawText || "").split("\n").filter((line) => safeTrim(line)).length;
  return {
    lines,
    bytes: Buffer.byteLength(String(rawText || ""), "utf8"),
  };
}

function normalizeEmbeddingSource(value, fallback = "hot") {
  const clean = safeTrim(value).toLowerCase();
  if (clean === "archive") {
    return "archive";
  }
  return fallback === "archive" ? "archive" : "hot";
}

function normalizeEmbeddingDim(value, fallback = 64) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  const dim = Math.floor(n);
  return Math.max(8, Math.min(4096, dim));
}

function normalizeEmbeddingVector(value, dim) {
  const targetDim = normalizeEmbeddingDim(dim, 64);
  const src = Array.isArray(value) ? value : [];
  const out = new Array(targetDim).fill(0);
  for (let i = 0; i < Math.min(targetDim, src.length); i += 1) {
    const n = Number(src[i]);
    out[i] = Number.isFinite(n) ? n : 0;
  }
  return out;
}

function normalizeEmbeddingIndexEntry(raw, fallbackTs = stableFallbackTs(0), sourceFallback = "hot") {
  const src = raw && typeof raw === "object" ? raw : {};
  const id = safeTrim(src.id);
  if (!id) {
    return null;
  }
  const ts = normalizeTs(src.ts, fallbackTs);
  const dim = normalizeEmbeddingDim(src.dim, Array.isArray(src.vec) ? src.vec.length : 64);
  const vec = normalizeEmbeddingVector(src.vec, dim);
  if (!vec.length) {
    return null;
  }
  const model = safeTrim(src.model) || "unknown";
  const session_id = normalizeSessionId(src.session_id ?? src.sessionId ?? src.session);
  const text_hash = safeTrim(src.text_hash ?? src.textHash);
  const embedding_version = safeTrim(src.embedding_version ?? src.embeddingVersion);
  return {
    id,
    ts,
    session_id,
    source: normalizeEmbeddingSource(src.source, sourceFallback),
    model,
    dim: vec.length,
    text_hash,
    embedding_version,
    vec,
  };
}

function parseEmbeddingIndexText(rawText, sourceFallback = "hot") {
  const lines = String(rawText || "").split("\n");
  const byId = new Map();
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = safeTrim(lines[idx]);
    if (!line) {
      continue;
    }
    try {
      const parsed = normalizeEmbeddingIndexEntry(JSON.parse(line), stableFallbackTs(idx), sourceFallback);
      if (!parsed) {
        continue;
      }
      byId.set(String(parsed.id), parsed);
    } catch {
      // ignore bad embedding index lines.
    }
  }
  return Array.from(byId.values()).sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
}

function parseArchiveTextPreserveIds(rawText) {
  const lines = String(rawText || "").split("\n");
  const entries = [];
  const badLines = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = safeTrim(lines[idx]);
    if (!line) {
      continue;
    }
    try {
      const normalized = normalizeEntry(JSON.parse(line), stableFallbackTs(idx));
      entries.push(normalized);
    } catch {
      badLines.push(line);
    }
  }
  return {
    entries,
    badLines,
  };
}

function parseHistoryText(rawText) {
  const lines = String(rawText || "").split("\n");

  const entries = [];
  const usedIds = new Set();
  const badLines = [];
  let needsRewrite = false;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    const trimmed = safeTrim(line);
    if (!trimmed) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      needsRewrite = true;
      badLines.push(line);
      continue;
    }
    const normalized = normalizeEntry(parsed, stableFallbackTs(idx));
    const uniqueId = makeUniqueId(normalized.id, usedIds);
    if (uniqueId !== normalized.id) {
      needsRewrite = true;
    }
    normalized.id = uniqueId;
    if (JSON.stringify(normalized) !== trimmed) {
      needsRewrite = true;
    }
    entries.push(normalized);
  }

  return {
    entries,
    badLines,
    needsRewrite,
  };
}

function parseHistoryBadHashes(rawText) {
  const hashes = new Set();
  const lines = String(rawText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const hash = safeTrim(parsed.hash) || shortHash(String(parsed.line || ""));
      if (hash) {
        hashes.add(hash);
      }
    } catch {
      hashes.add(shortHash(line));
    }
  }
  return hashes;
}

function mergeStateWithMigration(current, badLineInc, historyBadUniqueCount) {
  return {
    ...current,
    badLineCount: Math.max(current.badLineCount || 0, historyBadUniqueCount),
    lastMigrationBadLines: badLineInc,
    lastMigrationAt: nowIso(),
    revision: (current.revision || 0) + 1,
    updatedAt: nowIso(),
  };
}

function normalizeHistoryItems(items) {
  const usedIds = new Set();
  return items.map((item, idx) => {
    const normalized = normalizeEntry(item, stableFallbackTs(idx));
    normalized.id = makeUniqueId(normalized.id, usedIds);
    return normalized;
  });
}

export class ContextFsStorage {
  constructor(workspaceDir, config) {
    this.workspaceDir = workspaceDir;
    this.config = config;
    this.baseDir = path.join(workspaceDir, config.contextfsDir);
    this.lockPath = path.join(this.baseDir, ".lock");
    this.sqliteBootstrapDone = false;
    this.sqliteVectorBootstrapDone = false;
  }

  resolve(name) {
    return path.join(this.baseDir, FILES[name] || name);
  }

  async ensureInitialized() {
    await fs.mkdir(this.baseDir, { recursive: true });

    await this.ensureFile("manifest", this.defaultManifest());
    await this.ensureFile("pins", this.defaultPins());
    await this.ensureFile("summary", this.defaultSummary());
    await this.ensureFile("history", "");
    await this.ensureFile("historyArchive", "");
    await this.ensureFile("historyEmbeddingHot", "");
    await this.ensureFile("historyEmbeddingArchive", "");
    await this.ensureFile("retrievalTraces", "");
    await this.ensureFile("state", JSON.stringify(this.defaultState(), null, 2) + "\n");

    if (this.config?.indexEnabled) {
      const indexPath = this.resolveIndexPath();
      try {
        await fs.access(indexPath);
      } catch {
        this.sqliteBootstrapDone = false;
        this.sqliteVectorBootstrapDone = false;
      }
    }

    await this.ensureSqliteInitialized();
    await this.ensureSqliteVectorInitialized();
    await this.refreshManifest();
  }

  async ensureFile(name, fallback) {
    const filePath = this.resolve(name);
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, fallback, "utf8");
    }
  }

  resolveIndexPath() {
    const rawPath = safeTrim(this.config?.indexPath || "index.sqlite");
    if (path.isAbsolute(rawPath)) {
      return rawPath;
    }
    return path.join(this.baseDir, rawPath || "index.sqlite");
  }

  async ensureSqliteInitialized() {
    if (!this.config?.indexEnabled) {
      return;
    }
    try {
      const indexPath = this.resolveIndexPath();
      let existed = true;
      try {
        await fs.access(indexPath);
      } catch {
        existed = false;
      }

      const warm = await upsertSqliteTurnRows(this.workspaceDir, this.config, [], {
        schema_version: "1",
        updated_at: nowIso(),
      });
      if (!warm?.available) {
        this.sqliteBootstrapDone = true;
        return;
      }

      const doctor = await sqliteIndexDoctor(this.workspaceDir, this.config);
      if (!doctor?.available) {
        this.sqliteBootstrapDone = true;
        return;
      }
      const currentTurns = Number(doctor.turns || 0);
      const archiveRows = await this.readHistoryArchive();
      const hotRows = await this.readHistory();
      const expectedTurns = archiveRows.length + hotRows.length;
      const shouldBackfill = !existed || currentTurns === 0 || (expectedTurns > 0 && currentTurns < expectedTurns);
      if (!shouldBackfill) {
        this.sqliteBootstrapDone = true;
        return;
      }

      if (archiveRows.length) {
        await this.tryUpsertSqliteRows(archiveRows, "archive");
      }
      if (hotRows.length) {
        await this.tryUpsertSqliteRows(hotRows, "hot");
      }
      this.sqliteBootstrapDone = true;
    } catch (err) {
      if (this.config?.debug) {
        console.error(`[contextfs] failed to ensure sqlite initialization: ${String(err?.message || err)}`);
      }
    }
  }

  async ensureSqliteVectorInitialized() {
    if (!this.config?.indexEnabled) {
      return;
    }
    if (!this.config?.vectorEnabled || String(this.config?.retrievalMode || "").toLowerCase() !== "hybrid") {
      this.sqliteVectorBootstrapDone = true;
      return;
    }
    try {
      const doctor = await sqliteIndexDoctor(this.workspaceDir, this.config);
      if (!doctor?.available) {
        return;
      }
      const turnCount = Number(doctor.turns || 0);
      if (turnCount <= 0) {
        return;
      }
      const vectorAvailable = Boolean(doctor.vector?.available);
      const vectorRows = Number(doctor.vector?.rows || 0);
      if (vectorAvailable && vectorRows >= turnCount) {
        this.sqliteVectorBootstrapDone = true;
        return;
      }

      const rows = await this.readHistoryEmbeddingView("all");
      if (!rows.length) {
        return;
      }
      const result = await this.tryUpsertSqliteVectorRows(rows);
      if (!result?.available) {
        return;
      }
      const after = await sqliteIndexDoctor(this.workspaceDir, this.config);
      if (after?.available && after.vector?.available) {
        this.sqliteVectorBootstrapDone = true;
      }
    } catch (err) {
      if (this.config?.debug) {
        console.error(`[contextfs] failed to ensure sqlite vector initialization: ${String(err?.message || err)}`);
      }
    }
  }

  async buildEmbeddingRowsForEntries(entries, source = "hot") {
    const provider = createEmbeddingProvider(this.config);
    if (!provider.enabled) {
      return [];
    }
    const list = Array.isArray(entries) ? entries : [];
    const normalizedRows = [];
    for (const entry of list) {
      const normalized = normalizeEntry(entry, nowIso());
      const text = normalizeEmbeddingText(normalized.text, this.config.embeddingTextMaxChars);
      if (!text) {
        continue;
      }
      normalizedRows.push({
        normalized,
        text,
      });
    }
    if (!normalizedRows.length) {
      return [];
    }
    const embeddedRows = await embedTexts(provider, normalizedRows.map((item) => item.text), {
      batchSize: this.config.embeddingBatchSize,
    });
    const rows = [];
    for (let i = 0; i < normalizedRows.length; i += 1) {
      const item = normalizedRows[i];
      const embedded = embeddedRows[i];
      if (!embedded) {
        continue;
      }
      const text = item.text;
      const vec = normalizeEmbeddingVector(embedded.vector, embedded.dim || provider.dim);
      if (!vec.length) {
        continue;
      }
      rows.push({
        id: String(item.normalized.id || ""),
        ts: normalizeTs(item.normalized.ts, nowIso()),
        session_id: normalizeSessionId(item.normalized.session_id),
        source: normalizeEmbeddingSource(source),
        model: safeTrim(embedded.model) || safeTrim(provider.model) || "unknown",
        dim: vec.length,
        text_hash: safeTrim(embedded.text_hash) || hashEmbeddingText(text),
        embedding_version: safeTrim(embedded.embedding_version),
        vec,
      });
    }
    return rows.filter((item) => Boolean(item.id));
  }

  async tryUpsertSqliteRows(entries, source = "hot") {
    try {
      const list = Array.isArray(entries) ? entries : [];
      if (!list.length) {
        return { upserted: 0, available: true, reason: "no_rows" };
      }
      const rows = list
        .map((entry) => toSqliteTurnRow(entry, source, {
          summaryMaxChars: this.config.searchSummaryMaxChars,
          previewMaxChars: this.config.embeddingTextMaxChars,
        }))
        .filter((row) => Boolean(safeTrim(row.id)));
      if (!rows.length) {
        return { upserted: 0, available: true, reason: "no_valid_rows" };
      }
      const maxRetries = 3;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          const result = await upsertSqliteTurnRows(this.workspaceDir, this.config, rows, {
            schema_version: "1",
            updated_at: nowIso(),
          });
          const payload = {
            upserted: Number(result?.upserted || 0),
            available: Boolean(result?.available),
            reason: String(result?.reason || ""),
          };
          return payload;
        } catch (err) {
          const retryable = isRetryableSqliteWriteError(err);
          const last = attempt >= maxRetries;
          if (!retryable || last) {
            throw err;
          }
          await sleepMs(10 + attempt * 15);
        }
      }
      return {
        upserted: 0,
        available: false,
        reason: "retry_exhausted",
      };
    } catch (err) {
      if (this.config?.debug) {
        console.error(`[contextfs] failed to upsert sqlite rows: ${String(err?.message || err)}`);
      }
      this.sqliteBootstrapDone = false;
      return {
        upserted: 0,
        available: false,
        reason: String(err?.message || err),
      };
    }
  }

  async tryUpsertSqliteVectorRows(rows, meta = {}) {
    try {
      const list = Array.isArray(rows) ? rows : [];
      if (!list.length) {
        return {
          upserted: 0,
          available: true,
          reason: "no_rows",
        };
      }
      const maxRetries = 3;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          const result = await upsertSqliteVectorRows(this.workspaceDir, this.config, list, meta);
          return {
            upserted: Number(result?.upserted || 0),
            available: Boolean(result?.available),
            reason: String(result?.reason || ""),
            dim: Number(result?.dim || 0),
            embedding_version: String(result?.embedding_version || ""),
          };
        } catch (err) {
          const retryable = isRetryableSqliteWriteError(err);
          const last = attempt >= maxRetries;
          if (!retryable || last) {
            throw err;
          }
          await sleepMs(10 + attempt * 15);
        }
      }
      return {
        upserted: 0,
        available: false,
        reason: "retry_exhausted",
      };
    } catch (err) {
      if (this.config?.debug) {
        console.error(`[contextfs] failed to upsert sqlite vectors: ${String(err?.message || err)}`);
      }
      return {
        upserted: 0,
        available: false,
        reason: String(err?.message || err),
      };
    }
  }

  async tryPruneSqliteVectorRowsByIds(ids) {
    try {
      const list = Array.isArray(ids) ? ids.map((id) => String(id || "")).filter(Boolean) : [];
      if (!list.length) {
        return {
          removed: 0,
          available: true,
          reason: "no_ids",
        };
      }
      const result = await pruneSqliteVectorRowsByTurnIds(this.workspaceDir, this.config, list);
      return {
        removed: Number(result?.removed || 0),
        available: Boolean(result?.available),
        reason: String(result?.reason || ""),
      };
    } catch (err) {
      if (this.config?.debug) {
        console.error(`[contextfs] failed to prune sqlite vectors: ${String(err?.message || err)}`);
      }
      return {
        removed: 0,
        available: false,
        reason: String(err?.message || err),
      };
    }
  }

  async tryUpsertEmbeddingRows(entries, source = "hot", options = {}) {
    try {
      const rows = await this.buildEmbeddingRowsForEntries(entries, source);
      if (!rows.length) {
        return 0;
      }
      await this.appendHistoryEmbeddingRows(rows, {
        locked: Boolean(options.locked),
      });
      if (!options.locked) {
        await this.compactEmbeddingIndexesIfNeeded();
      }
      await this.tryUpsertSqliteVectorRows(rows);
      return rows.length;
    } catch (err) {
      if (this.config?.debug) {
        console.error(`[contextfs] failed to upsert embedding rows: ${String(err?.message || err)}`);
      }
      return 0;
    }
  }

  async acquireLock(maxRetries = 80) {
    const staleMs = Math.max(1000, Number(this.config.lockStaleMs || 30000));
    for (let i = 0; i <= maxRetries; i += 1) {
      const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      try {
        await fs.writeFile(this.lockPath, stamp, { encoding: "utf8", flag: "wx" });
        return stamp;
      } catch (err) {
        const code = err?.code;
        let shouldRetry = RETRYABLE_LOCK_ERRORS.has(code);
        if (LOCK_PERMISSION_ERRORS.has(code)) {
          try {
            await fs.stat(this.lockPath);
            shouldRetry = true;
          } catch (statErr) {
            // On Windows, antivirus/indexers can cause transient EPERM/EACCES
            // even when the lock file does not exist yet. Treat as retryable.
            shouldRetry = statErr?.code === "ENOENT";
          }
        }
        if (!shouldRetry) {
          throw err;
        }
        try {
          const stat = await fs.stat(this.lockPath);
          if (Date.now() - stat.mtimeMs > staleMs) {
            try {
              await fs.unlink(this.lockPath);
            } catch (unlinkErr) {
              if (
                unlinkErr?.code !== "ENOENT"
                && !RETRYABLE_LOCK_ERRORS.has(unlinkErr?.code)
                && !LOCK_PERMISSION_ERRORS.has(unlinkErr?.code)
              ) {
                throw unlinkErr;
              }
            }
          }
        } catch {
          // ignore stale lock cleanup failures
        }
        if (i === maxRetries) {
          throw new Error(`contextfs lock timeout: ${this.lockPath}`);
        }
        const jitterMs = Math.min(50, 10 + i * 2) + Math.floor(Math.random() * 11);
        await sleepMs(jitterMs);
      }
    }
    throw new Error(`contextfs lock timeout: ${this.lockPath}`);
  }

  async releaseLock(stamp) {
    if (!stamp) {
      return;
    }
    try {
      const content = await fs.readFile(this.lockPath, "utf8");
      if (safeTrim(content) === stamp) {
        try {
          await fs.unlink(this.lockPath);
        } catch (err) {
          if (err?.code !== "ENOENT" && !RETRYABLE_LOCK_ERRORS.has(err?.code) && !LOCK_PERMISSION_ERRORS.has(err?.code)) {
            throw err;
          }
        }
      }
    } catch {
      // ignore
    }
  }

  async writeTextWithLock(name, content) {
    const target = this.resolve(name);
    const tmp = makeTmpPath(target);
    try {
      await fs.writeFile(tmp, content, "utf8");
      for (let i = 0; i <= 5; i += 1) {
        try {
          await fs.rename(tmp, target);
          break;
        } catch (err) {
          if (!RETRYABLE_RENAME_ERRORS.has(err?.code) || i === 5) {
            throw err;
          }
          await sleepMs(Math.min(50, 10 + i * 5));
        }
      }
    } finally {
      try {
        await fs.unlink(tmp);
      } catch {
        // ignore
      }
    }
  }

  async readText(name) {
    return fs.readFile(this.resolve(name), "utf8");
  }

  async rotateRetrievalTracesIfNeededLocked(cfg, incomingBytes = 0) {
    const config = cfg || this.config;
    const maxBytes = Math.max(1024, Number(config.tracesMaxBytes || 0) || 0);
    const maxFiles = Math.max(1, Math.min(10, Math.floor(Number(config.tracesMaxFiles || 0) || 0))) || 1;
    const mainPath = this.resolve("retrievalTraces");
    const incoming = Math.max(0, Number(incomingBytes) || 0);
    let size = 0;
    try {
      size = (await fs.stat(mainPath)).size;
    } catch (err) {
      if (err?.code !== "ENOENT") {
        throw err;
      }
      await fs.writeFile(mainPath, "", "utf8");
      size = 0;
    }
    if ((size + incoming) <= maxBytes) {
      return;
    }

    const rotated = (n) => path.join(this.baseDir, `retrieval.traces.${n}.ndjson`);

    if (maxFiles >= 1) {
      await unlinkWithRetry(rotated(maxFiles));
      for (let i = maxFiles - 1; i >= 1; i -= 1) {
        const from = rotated(i);
        const to = rotated(i + 1);
        try {
          await renameWithRetry(from, to);
        } catch (err) {
          if (err?.code !== "ENOENT") {
            throw err;
          }
        }
      }
      try {
        await renameWithRetry(mainPath, rotated(1));
      } catch (err) {
        if (err?.code !== "ENOENT") {
          throw err;
        }
      }
    }

    await fs.writeFile(mainPath, "", "utf8");
  }

  async appendRetrievalTrace(trace, options = {}) {
    const config = options.config || this.config;
    if (!config?.tracesEnabled) {
      return false;
    }
    let lock = null;
    try {
      if (!options.locked) {
        lock = await this.acquireLock();
      }
      const line = `${JSON.stringify(trace)}\n`;
      const lineBytes = Buffer.byteLength(line, "utf8");
      const maxBytes = Math.max(1024, Number(config.tracesMaxBytes || 0) || 0);

      await this.rotateRetrievalTracesIfNeededLocked(config, lineBytes <= maxBytes ? lineBytes : 0);
      await fs.appendFile(this.resolve("retrievalTraces"), line, "utf8");

      // If a single trace line is larger than the configured cap, rotate immediately
      // so retrieval.traces.ndjson remains bounded without waiting for another write.
      if (lineBytes > maxBytes) {
        await this.rotateRetrievalTracesIfNeededLocked(config, 0);
      }
      return true;
    } catch (err) {
      if (config?.debug) {
        console.error(`[contextfs] failed to append retrieval trace: ${String(err?.message || err)}`);
      }
      return false;
    } finally {
      if (lock) {
        await this.releaseLock(lock);
      }
    }
  }

  async readRetrievalTraces(options = {}) {
    const config = options.config || this.config;
    const tailRaw = Number(options.tail);
    const tail = Number.isFinite(tailRaw) ? Math.max(1, Math.min(200, Math.floor(tailRaw))) : Math.max(1, Math.min(200, Number(config.tracesTailDefault || 20) || 20));
    const maxFiles = Math.max(1, Math.min(10, Math.floor(Number(config.tracesMaxFiles || 0) || 0))) || 1;
    const paths = [this.resolve("retrievalTraces")];
    for (let i = 1; i <= maxFiles; i += 1) {
      paths.push(path.join(this.baseDir, `retrieval.traces.${i}.ndjson`));
    }

    const out = [];

    for (const p of paths) {
      let raw = "";
      try {
        raw = await fs.readFile(p, "utf8");
      } catch (err) {
        if (err?.code === "ENOENT") {
          continue;
        }
        throw err;
      }
      const lines = String(raw || "").split("\n");
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = safeTrim(lines[i]);
        if (!line) {
          continue;
        }
        try {
          const parsed = JSON.parse(line);
          out.push(parsed);
          if (out.length >= tail) {
            return out;
          }
        } catch {
          // ignore bad trace lines
        }
      }
    }

    return out;
  }

  async findRetrievalTraceById(traceId, options = {}) {
    const config = options.config || this.config;
    const target = safeTrim(traceId);
    if (!target) {
      return null;
    }
    const maxFiles = Math.max(1, Math.min(10, Math.floor(Number(config.tracesMaxFiles || 0) || 0))) || 1;
    const paths = [this.resolve("retrievalTraces")];
    for (let i = 1; i <= maxFiles; i += 1) {
      paths.push(path.join(this.baseDir, `retrieval.traces.${i}.ndjson`));
    }
    for (const p of paths) {
      let raw = "";
      try {
        raw = await fs.readFile(p, "utf8");
      } catch (err) {
        if (err?.code === "ENOENT") {
          continue;
        }
        throw err;
      }
      const lines = raw.split("\n");
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = safeTrim(lines[i]);
        if (!line) {
          continue;
        }
        try {
          const parsed = JSON.parse(line);
          if (safeTrim(parsed?.trace_id) === target) {
            return parsed;
          }
        } catch {
          // ignore bad trace lines
        }
      }
    }
    return null;
  }

  async writeText(name, content) {
    const lock = await this.acquireLock();
    try {
      await this.writeTextWithLock(name, content);
    } finally {
      await this.releaseLock(lock);
    }
  }

  async readState() {
    const raw = await this.readText("state");
    return {
      ...this.defaultState(),
      ...JSON.parse(raw),
    };
  }

  async updateState(patchOrFn) {
    const lock = await this.acquireLock();
    try {
      let current;
      try {
        current = JSON.parse(await fs.readFile(this.resolve("state"), "utf8"));
      } catch {
        current = this.defaultState();
      }
      const base = {
        ...this.defaultState(),
        ...current,
      };
      const patch = typeof patchOrFn === "function" ? (patchOrFn({ ...base }) || {}) : (patchOrFn || {});
      const next = {
        ...base,
        ...patch,
        revision: (base.revision || 0) + 1,
        updatedAt: nowIso(),
      };
      await this.writeTextWithLock("state", JSON.stringify(next, null, 2) + "\n");
      return next;
    } finally {
      await this.releaseLock(lock);
    }
  }

  async migrateHistoryIfNeeded() {
    const lock = await this.acquireLock();
    try {
      const raw = await this.readText("history");
      const parsed = parseHistoryText(raw);
      if (!parsed.needsRewrite) {
        return parsed.entries;
      }
      const badCount = parsed.badLines.length;
      let existingBadHashes = new Set();
      try {
        existingBadHashes = parseHistoryBadHashes(await fs.readFile(this.resolve("historyBad"), "utf8"));
      } catch (err) {
        if (err?.code !== "ENOENT") {
          throw err;
        }
      }
      let newlyAppendedCount = 0;
      if (badCount > 0) {
        const newBadEntries = [];
        for (const line of parsed.badLines) {
          const hash = shortHash(line);
          if (existingBadHashes.has(hash)) {
            continue;
          }
          existingBadHashes.add(hash);
          newBadEntries.push({
            hash,
            ts: nowIso(),
            line,
          });
        }
        newlyAppendedCount = newBadEntries.length;
        if (newlyAppendedCount > 0) {
          const payload = `${newBadEntries.map((item) => JSON.stringify(item)).join("\n")}\n`;
          await fs.appendFile(this.resolve("historyBad"), payload, "utf8");
        }
      }
      const historyBadUniqueCount = existingBadHashes.size;
      await this.writeTextWithLock("history", serializeHistoryEntries(parsed.entries));
      if (badCount > 0 || historyBadUniqueCount > 0) {
        let currentState;
        try {
          currentState = JSON.parse(await fs.readFile(this.resolve("state"), "utf8"));
        } catch {
          currentState = this.defaultState();
        }
        const nextState = mergeStateWithMigration(
          {
            ...this.defaultState(),
            ...currentState,
          },
          newlyAppendedCount,
          historyBadUniqueCount,
        );
        await this.writeTextWithLock("state", JSON.stringify(nextState, null, 2) + "\n");
        if (newlyAppendedCount > 0) {
          console.error(`[contextfs] migrated with bad lines saved to history.bad.ndjson (count=${newlyAppendedCount})`);
        }
      }
      return parsed.entries;
    } finally {
      await this.releaseLock(lock);
    }
  }

  async syncBadLineCountFromHistoryBad() {
    const lock = await this.acquireLock();
    try {
      let historyBadUniqueCount = 0;
      try {
        historyBadUniqueCount = parseHistoryBadHashes(await fs.readFile(this.resolve("historyBad"), "utf8")).size;
      } catch (err) {
        if (err?.code !== "ENOENT") {
          throw err;
        }
      }
      let currentState;
      try {
        currentState = JSON.parse(await fs.readFile(this.resolve("state"), "utf8"));
      } catch {
        currentState = this.defaultState();
      }
      const base = {
        ...this.defaultState(),
        ...currentState,
      };
      const syncedBadCount = Math.max(base.badLineCount || 0, historyBadUniqueCount);
      if ((base.badLineCount || 0) === syncedBadCount) {
        return;
      }
      const next = {
        ...base,
        badLineCount: syncedBadCount,
        revision: (base.revision || 0) + 1,
        updatedAt: nowIso(),
      };
      await this.writeTextWithLock("state", JSON.stringify(next, null, 2) + "\n");
    } finally {
      await this.releaseLock(lock);
    }
  }

  async readHistory(options = {}) {
    const raw = await this.readText("history");
    if (!safeTrim(raw)) {
      return [];
    }
    const parsed = parseHistoryText(raw);
    if (options.migrate === false) {
      return parsed.entries;
    }
    if (!parsed.needsRewrite) {
      await this.syncBadLineCountFromHistoryBad();
      return parsed.entries;
    }
    return this.migrateHistoryIfNeeded();
  }

  async readHistoryArchive(options = {}) {
    const raw = await this.readText("historyArchive");
    if (!safeTrim(raw)) {
      return [];
    }
    const parsed = parseArchiveTextPreserveIds(raw);
    return parsed.entries;
  }

  async readHistoryEmbeddingHot() {
    const raw = await this.readText("historyEmbeddingHot");
    if (!safeTrim(raw)) {
      return [];
    }
    return parseEmbeddingIndexText(raw, "hot");
  }

  async readHistoryEmbeddingArchive() {
    const raw = await this.readText("historyEmbeddingArchive");
    if (!safeTrim(raw)) {
      return [];
    }
    return parseEmbeddingIndexText(raw, "archive");
  }

  async readHistoryEmbeddingView(scope = "all") {
    const normalizedScope = String(scope || "all").toLowerCase();
    if (normalizedScope === "hot") {
      return this.readHistoryEmbeddingHot();
    }
    if (normalizedScope === "archive") {
      return this.readHistoryEmbeddingArchive();
    }
    const hot = await this.readHistoryEmbeddingHot();
    const archive = await this.readHistoryEmbeddingArchive();
    const byId = new Map();
    for (const row of hot) {
      byId.set(String(row.id), {
        ...row,
        source: "hot",
      });
    }
    for (const row of archive) {
      byId.set(String(row.id), {
        ...row,
        source: "archive",
      });
    }
    return Array.from(byId.values()).sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
  }

  async findHistoryArchiveById(id) {
    const target = safeTrim(id);
    if (!target) {
      return null;
    }
    const raw = await this.readText("historyArchive");
    if (!safeTrim(raw)) {
      return null;
    }
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = safeTrim(lines[i]);
      if (!line) {
        continue;
      }
      try {
        const normalized = normalizeEntry(JSON.parse(line), stableFallbackTs(i));
        if (String(normalized.id) === target) {
          return normalized;
        }
      } catch {
        // ignore bad line in archive
      }
    }
    return null;
  }

  async upsertHistoryEmbeddingRowsBySource(rows, source = "hot", options = {}) {
    const normalizedSource = normalizeEmbeddingSource(source);
    const list = Array.isArray(rows) ? rows : [];
    const normalized = [];
    for (let i = 0; i < list.length; i += 1) {
      const row = normalizeEmbeddingIndexEntry(list[i], nowIso(), normalizedSource);
      if (!row) {
        continue;
      }
      row.source = normalizedSource;
      normalized.push(row);
    }
    if (!normalized.length) {
      return [];
    }
    const lock = options.locked ? null : await this.acquireLock();
    try {
      const existing = normalizedSource === "archive"
        ? await this.readHistoryEmbeddingArchive()
        : await this.readHistoryEmbeddingHot();
      const byId = new Map(existing.map((item) => [String(item.id), item]));
      for (const row of normalized) {
        byId.set(String(row.id), row);
      }
      const nextRows = Array.from(byId.values())
        .map((item) => ({ ...item, source: normalizedSource }))
        .sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
      const target = normalizedSource === "archive" ? "historyEmbeddingArchive" : "historyEmbeddingHot";
      await this.writeTextWithLock(target, serializeEmbeddingEntries(nextRows));
      return normalized;
    } finally {
      if (lock) {
        await this.releaseLock(lock);
      }
    }
  }

  async upsertHistoryEmbeddingHot(rows, options = {}) {
    return this.upsertHistoryEmbeddingRowsBySource(rows, "hot", options);
  }

  async upsertHistoryEmbeddingArchive(rows, options = {}) {
    return this.upsertHistoryEmbeddingRowsBySource(rows, "archive", options);
  }

  async pruneHistoryEmbeddingHotByIds(ids, options = {}) {
    const set = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "")).filter(Boolean));
    if (!set.size) {
      return 0;
    }
    const lock = options.locked ? null : await this.acquireLock();
    try {
      const existing = await this.readHistoryEmbeddingHot();
      const filtered = existing.filter((row) => !set.has(String(row.id)));
      if (filtered.length === existing.length) {
        return 0;
      }
      await this.writeTextWithLock("historyEmbeddingHot", serializeEmbeddingEntries(filtered));
      return existing.length - filtered.length;
    } finally {
      if (lock) {
        await this.releaseLock(lock);
      }
    }
  }

  async pruneHistoryEmbeddingArchiveByIds(ids, options = {}) {
    const set = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "")).filter(Boolean));
    if (!set.size) {
      return 0;
    }
    const lock = options.locked ? null : await this.acquireLock();
    try {
      const existing = await this.readHistoryEmbeddingArchive();
      const filtered = existing.filter((row) => !set.has(String(row.id)));
      if (filtered.length === existing.length) {
        return 0;
      }
      await this.writeTextWithLock("historyEmbeddingArchive", serializeEmbeddingEntries(filtered));
      return existing.length - filtered.length;
    } finally {
      if (lock) {
        await this.releaseLock(lock);
      }
    }
  }

  async pruneHistoryEmbeddingByIds(ids, options = {}) {
    const list = Array.isArray(ids) ? ids : [];
    if (!list.length) {
      return { hot: 0, archive: 0, total: 0 };
    }
    const lock = options.locked ? null : await this.acquireLock();
    try {
      const hot = await this.pruneHistoryEmbeddingHotByIds(list, { locked: true });
      const archive = await this.pruneHistoryEmbeddingArchiveByIds(list, { locked: true });
      return {
        hot,
        archive,
        total: hot + archive,
      };
    } finally {
      if (lock) {
        await this.releaseLock(lock);
      }
    }
  }

  async appendHistoryEmbeddingRows(rows, options = {}) {
    const list = Array.isArray(rows) ? rows : [];
    const normalized = [];
    for (let i = 0; i < list.length; i += 1) {
      const row = normalizeEmbeddingIndexEntry(list[i], nowIso());
      if (!row) {
        continue;
      }
      normalized.push(row);
    }
    if (!normalized.length) {
      return [];
    }
    const lock = options.locked ? null : await this.acquireLock();
    try {
      const hotRows = normalized.filter((row) => row.source === "hot");
      const archiveRows = normalized.filter((row) => row.source === "archive");
      if (hotRows.length) {
        await this.upsertHistoryEmbeddingHot(hotRows, { locked: true });
      }
      if (archiveRows.length) {
        await this.upsertHistoryEmbeddingArchive(archiveRows, { locked: true });
        await this.pruneHistoryEmbeddingHotByIds(archiveRows.map((row) => row.id), { locked: true });
      }
      return normalized;
    } finally {
      if (lock) {
        await this.releaseLock(lock);
      }
    }
  }

  async upsertHistoryEmbeddingRow(row, options = {}) {
    const list = await this.appendHistoryEmbeddingRows([row], options);
    return list[0] || null;
  }

  async compactEmbeddingIndexesIfNeeded(options = {}) {
    const force = Boolean(options.force);
    if (!force && !this.config.embeddingAutoCompact) {
      return { compacted: false };
    }
    const lock = options.locked ? null : await this.acquireLock();
    try {
      const hotRaw = await this.readText("historyEmbeddingHot");
      const archiveRaw = await this.readText("historyEmbeddingArchive");
      const hotRows = parseEmbeddingIndexText(hotRaw, "hot");
      const archiveRows = parseEmbeddingIndexText(archiveRaw, "archive");
      const archiveIds = new Set(archiveRows.map((row) => String(row.id)));
      const hotFiltered = hotRows.filter((row) => !archiveIds.has(String(row.id)));

      const hotStats = embeddingStatsFromRaw(hotRaw);
      const archiveStats = embeddingStatsFromRaw(archiveRaw);
      const mergedById = new Map();
      for (const row of hotRows) {
        mergedById.set(String(row.id), row);
      }
      for (const row of archiveRows) {
        mergedById.set(String(row.id), row);
      }
      const totalLines = hotStats.lines + archiveStats.lines;
      const totalUnique = mergedById.size;
      const duplicateRatio = totalLines > 0 ? (totalLines - totalUnique) / totalLines : 0;
      const needsCompact = force
        || hotStats.bytes > Number(this.config.embeddingHotMaxBytes || 0)
        || archiveStats.bytes > Number(this.config.embeddingArchiveMaxBytes || 0)
        || duplicateRatio > Number(this.config.embeddingDupRatioThreshold || 0)
        || hotFiltered.length !== hotRows.length;
      if (!needsCompact) {
        return {
          compacted: false,
          hot_lines: hotStats.lines,
          archive_lines: archiveStats.lines,
          duplicate_ratio: Number(duplicateRatio.toFixed(4)),
        };
      }
      await this.writeTextWithLock("historyEmbeddingHot", serializeEmbeddingEntries(hotFiltered));
      await this.writeTextWithLock("historyEmbeddingArchive", serializeEmbeddingEntries(archiveRows));
      return {
        compacted: true,
        hot_lines: hotFiltered.length,
        archive_lines: archiveRows.length,
        duplicate_ratio: Number(duplicateRatio.toFixed(4)),
      };
    } finally {
      if (lock) {
        await this.releaseLock(lock);
      }
    }
  }

  async writeHistory(items) {
    const normalized = normalizeHistoryItems(items);
    await this.writeText("history", serializeHistoryEntries(normalized));
  }

  async updateHistoryEntryById(id, updaterOrPatch) {
    const targetId = safeTrim(id);
    if (!targetId) {
      return null;
    }
    const lock = await this.acquireLock();
    let updated = null;
    try {
      const raw = await this.readText("history");
      const parsed = parseHistoryText(raw);
      const idx = parsed.entries.findIndex((item) => String(item.id) === targetId);
      if (idx < 0) {
        return null;
      }

      const current = parsed.entries[idx];
      const patchRaw =
        typeof updaterOrPatch === "function"
          ? (updaterOrPatch({ ...current }) || {})
          : (updaterOrPatch || {});
      const patch = patchRaw && typeof patchRaw === "object" ? patchRaw : {};

      const nextEntryInput = {
        ...current,
        ...patch,
        id: current.id,
      };
      const normalized = normalizeEntry(nextEntryInput, current.ts);
      normalized.id = current.id;
      parsed.entries[idx] = normalized;

      await this.writeTextWithLock("history", serializeHistoryEntries(parsed.entries));
      updated = normalized;
    } finally {
      await this.releaseLock(lock);
    }
    if (!updated) {
      return null;
    }
    await this.tryUpsertSqliteRows([updated], "hot");
    const text = normalizeEmbeddingText(updated.text, this.config.embeddingTextMaxChars);
    if (!text) {
      await this.pruneHistoryEmbeddingByIds([updated.id]);
      await this.tryPruneSqliteVectorRowsByIds([updated.id]);
      return updated;
    }
    await this.tryUpsertEmbeddingRows([updated], "hot");
    return updated;
  }

  async appendHistory(entry) {
    const lock = await this.acquireLock();
    let normalized = null;
    try {
      const raw = await this.readText("history");
      const parsed = parseHistoryText(raw);
      const usedIds = new Set(parsed.entries.map((item) => item.id));
      normalized = normalizeEntry(entry, nowIso());
      normalized.id = makeUniqueId(normalized.id, usedIds);
      await fs.appendFile(this.resolve("history"), `${JSON.stringify(normalized)}\n`, "utf8");
    } finally {
      await this.releaseLock(lock);
    }
    if (!normalized) {
      return null;
    }
    await this.tryUpsertSqliteRows([normalized], "hot");
    await this.tryUpsertEmbeddingRows([normalized], "hot");
    return normalized;
  }

  async appendHistoryArchive(entries, options = {}) {
    const list = Array.isArray(entries) ? entries : [];
    if (!list.length) {
      return [];
    }
    const normalized = normalizeHistoryItems(list);
    const payload = `${normalized.map((item) => JSON.stringify(item)).join("\n")}\n`;
    const write = async () => {
      await fs.appendFile(this.resolve("historyArchive"), payload, "utf8");
      await this.tryUpsertSqliteRows(normalized, "archive");
      await this.tryUpsertEmbeddingRows(normalized, "archive", { locked: true });
      return normalized;
    };
    if (options.locked) {
      return write();
    }
    const lock = await this.acquireLock();
    try {
      return await write();
    } finally {
      await this.releaseLock(lock);
    }
  }

  async refreshManifest() {
    const now = nowIso();
    const state = await this.readState();
    const lines = [
      "# ContextFS Manifest",
      "",
      `- updated: ${now}`,
      `- revision: ${state.revision || 0}`,
      "",
      "## files",
      "- pins.md | key constraints and prohibitions | tags: pins,policy",
      "- summary.md | rolling compact summary | tags: memory,compact",
      "- history.ndjson | compactable turn history | tags: runtime,history",
      "- history.archive.ndjson | archived compacted turn history | tags: runtime,archive",
      "- history.embedding.hot.ndjson | hot retrieval embedding index | tags: runtime,vector,hot",
      "- history.embedding.archive.ndjson | archive retrieval embedding index | tags: runtime,vector,archive",
      "- index.sqlite | sqlite lexical/vector derived index | tags: runtime,index,derived",
      "- retrieval.traces.ndjson | retrieval trace log (derived) | tags: runtime,trace",
      "",
      "## mode",
      `- autoInject: ${String(this.config.autoInject)}`,
      `- autoCompact: ${String(this.config.autoCompact)}`,
      `- recentTurns: ${this.config.recentTurns}`,
      `- tokenThreshold: ${this.config.tokenThreshold}`,
      `- pinsMaxItems: ${this.config.pinsMaxItems}`,
      `- summaryMaxChars: ${this.config.summaryMaxChars}`,
    ];
    await this.writeText("manifest", lines.slice(0, this.config.manifestMaxLines).join("\n") + "\n");
  }

  defaultManifest() {
    return "# ContextFS Manifest\n\n- updated: pending\n- revision: 0\n\n## files\n- pins.md\n- summary.md\n";
  }

  defaultPins() {
    return "# Pins (short, one line each)\n\n";
  }

  defaultSummary() {
    return "# Rolling Summary\n\n- init: no summary yet.\n";
  }


  defaultState() {
    return {
      version: 1,
      revision: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      currentSessionId: null,
      sessionCount: 0,
      lastSessionCreatedAt: null,
      lastCompactedAt: null,
      compactCount: 0,
      lastPackTokens: 0,
      lastSearchHits: 0,
      lastSearchQuery: "",
      lastSearchAt: null,
      lastSearchIndex: [],
      searchCount: 0,
      timelineCount: 0,
      getCount: 0,
      statsCount: 0,
      lastTimelineAnchor: null,
      worksetUsed: 0,
      badLineCount: 0,
      lastMigrationBadLines: 0,
      lastMigrationAt: null,
    };
  }
}

export function fileMap() {
  return { ...FILES };
}
