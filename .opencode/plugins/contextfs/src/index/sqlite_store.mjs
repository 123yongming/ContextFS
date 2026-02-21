import fs from "node:fs/promises";
import path from "node:path";

import { cosineSimilarity } from "../embedding.mjs";

const VECTOR_META_KEYS = {
  schemaVersion: "vec_schema_version",
  provider: "vec_provider",
  model: "vec_model",
  dim: "vec_dim",
  embeddingVersion: "vec_embedding_version",
  updatedAt: "vec_updated_at",
};

function safeTrim(text) {
  return String(text || "").trim();
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function lineSummary(text, maxChars = 240) {
  const oneLine = String(text || "").replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(0, maxChars - 3))}...`;
}

function safeJsonStringify(value, fallback = "[]") {
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function parseRefsJson(raw) {
  const text = safeTrim(raw);
  if (!text) {
    return [];
  }
  try {
    const list = JSON.parse(text);
    return Array.isArray(list) ? list.map((item) => String(item || "")).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function normalizeScope(scope) {
  const clean = safeTrim(scope).toLowerCase();
  if (clean === "hot" || clean === "archive") {
    return clean;
  }
  return "all";
}

function clampFloat(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

function escapeFtsToken(token) {
  return String(token || "").replace(/"/g, "\"\"");
}

function buildFtsQuery(query) {
  const raw = String(query || "");
  const words = raw.toLowerCase().match(/[a-z0-9_\-]+/g) || [];
  const cjk = raw.match(/[\u3400-\u9fff]/g) || [];
  const tokens = Array.from(new Set([...words, ...cjk])).filter(Boolean);
  if (!tokens.length) {
    return `"${escapeFtsToken(raw.trim())}"`;
  }
  return tokens.map((token) => `"${escapeFtsToken(token)}"`).join(" OR ");
}

function resolveIndexPath(workspaceDir, config) {
  const baseDir = path.join(workspaceDir, config.contextfsDir || ".contextfs");
  const rawPath = safeTrim(config.indexPath || "index.sqlite");
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  return path.join(baseDir, rawPath || "index.sqlite");
}

function isModuleMissingError(err) {
  const code = String(err?.code || "").toUpperCase();
  const msg = String(err?.message || "");
  return (
    code === "MODULE_NOT_FOUND"
    || code === "ERR_MODULE_NOT_FOUND"
    || msg.includes("Cannot find module")
    || msg.includes("ERR_MODULE_NOT_FOUND")
  );
}

async function loadSqliteDriver() {
  if (globalThis.CONTEXTFS_SQLITE_DRIVER) {
    return globalThis.CONTEXTFS_SQLITE_DRIVER;
  }
  try {
    const mod = await import("better-sqlite3");
    const driver = mod?.default || mod;
    globalThis.CONTEXTFS_SQLITE_DRIVER = driver;
    return driver;
  } catch (err) {
    if (isModuleMissingError(err)) {
      globalThis.CONTEXTFS_SQLITE_DRIVER = null;
      return null;
    }
    throw err;
  }
}

async function loadSqliteVecModule() {
  if (Object.prototype.hasOwnProperty.call(globalThis, "CONTEXTFS_SQLITE_VEC_MODULE")) {
    return globalThis.CONTEXTFS_SQLITE_VEC_MODULE;
  }
  try {
    const mod = await import("sqlite-vec");
    const out = mod?.default || mod;
    globalThis.CONTEXTFS_SQLITE_VEC_MODULE = out;
    return out;
  } catch (err) {
    if (isModuleMissingError(err)) {
      globalThis.CONTEXTFS_SQLITE_VEC_MODULE = null;
      return null;
    }
    throw err;
  }
}

function tableExists(db, tableName) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(String(tableName || ""));
  return Boolean(row?.name);
}

function readMetaMap(db) {
  const rows = db.prepare("SELECT key, value FROM meta").all();
  const map = new Map();
  for (const row of rows) {
    map.set(String(row?.key || ""), String(row?.value || ""));
  }
  return map;
}

function readVectorMeta(db) {
  const meta = readMetaMap(db);
  const rawDim = Number(meta.get(VECTOR_META_KEYS.dim) || 0);
  const dim = Number.isFinite(rawDim) && rawDim > 0 ? Math.floor(rawDim) : 0;
  return {
    schema_version: safeTrim(meta.get(VECTOR_META_KEYS.schemaVersion)),
    provider: safeTrim(meta.get(VECTOR_META_KEYS.provider)),
    model: safeTrim(meta.get(VECTOR_META_KEYS.model)),
    dim,
    embedding_version: safeTrim(meta.get(VECTOR_META_KEYS.embeddingVersion)),
    updated_at: safeTrim(meta.get(VECTOR_META_KEYS.updatedAt)),
  };
}

function parseEmbeddingVersion(value) {
  const clean = safeTrim(value);
  if (!clean) {
    return null;
  }
  const parts = clean.split(":");
  if (parts.length < 4) {
    return null;
  }
  const provider = safeTrim(parts[0]);
  const normalize = safeTrim(parts[parts.length - 1]) || "unit";
  const dimRaw = Number(parts[parts.length - 2]);
  const dim = Number.isFinite(dimRaw) && dimRaw > 0 ? Math.floor(dimRaw) : 0;
  const model = safeTrim(parts.slice(1, parts.length - 2).join(":"));
  return {
    provider,
    model,
    dim,
    normalize,
  };
}

function normalizeVectorRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  for (const row of list) {
    const id = safeTrim(row?.id);
    const srcVec = Array.isArray(row?.vec) ? row.vec : [];
    if (!id || !srcVec.length) {
      continue;
    }
    const model = safeTrim(row?.model);
    const embeddingVersion = safeTrim(row?.embedding_version);
    const parsed = parseEmbeddingVersion(embeddingVersion);
    const targetDim = clampInt(row?.dim, srcVec.length || parsed?.dim || 0, 1, 4096);
    const vec = new Array(targetDim).fill(0);
    for (let i = 0; i < Math.min(targetDim, srcVec.length); i += 1) {
      const n = Number(srcVec[i]);
      vec[i] = Number.isFinite(n) ? n : 0;
    }
    out.push({
      id,
      vec,
      dim: targetDim,
      model: model || parsed?.model || "",
      embedding_version: embeddingVersion,
    });
  }
  return out;
}

function buildVectorMeta(rows, meta = {}) {
  const list = normalizeVectorRows(rows);
  const seed = list[0] || null;
  const rawVersion = safeTrim(meta?.embedding_version) || safeTrim(seed?.embedding_version);
  const parsed = parseEmbeddingVersion(rawVersion);
  const provider = safeTrim(meta?.provider) || safeTrim(parsed?.provider) || "unknown";
  const model = safeTrim(meta?.model) || safeTrim(parsed?.model) || safeTrim(seed?.model) || "unknown";
  const dim = clampInt(
    meta?.dim,
    seed?.dim || parsed?.dim || 0,
    1,
    4096,
  );
  if (!dim) {
    return null;
  }
  const embeddingVersion = rawVersion || `${provider}:${model}:${dim}:unit`;
  return {
    schema_version: "1",
    provider,
    model,
    dim,
    embedding_version: embeddingVersion,
    updated_at: new Date().toISOString(),
  };
}

function hasVectorMetaMismatch(currentMeta, nextMeta) {
  const cur = currentMeta || {};
  const next = nextMeta || {};
  if (safeTrim(cur.embedding_version) && safeTrim(next.embedding_version) && String(cur.embedding_version) !== String(next.embedding_version)) {
    return "version_mismatch";
  }
  if (Number(cur.dim || 0) > 0 && Number(next.dim || 0) > 0 && Number(cur.dim) !== Number(next.dim)) {
    return "dimension_mismatch";
  }
  if (safeTrim(cur.provider) && safeTrim(next.provider) && String(cur.provider) !== String(next.provider)) {
    return "provider_mismatch";
  }
  if (safeTrim(cur.model) && safeTrim(next.model) && String(cur.model) !== String(next.model)) {
    return "model_mismatch";
  }
  return "";
}

function vectorToBuffer(vec, dim) {
  const targetDim = clampInt(dim, Array.isArray(vec) ? vec.length : 0, 1, 4096);
  const typed = new Float32Array(targetDim);
  const list = Array.isArray(vec) ? vec : [];
  for (let i = 0; i < Math.min(targetDim, list.length); i += 1) {
    const n = Number(list[i]);
    typed[i] = Number.isFinite(n) ? n : 0;
  }
  return Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
}

function bufferToVector(blob, dim = 0) {
  if (!blob || typeof blob !== "object" || typeof blob.byteLength !== "number") {
    return [];
  }
  const byteLength = Number(blob.byteLength || 0);
  if (byteLength <= 0) {
    return [];
  }
  const total = Math.floor(byteLength / 4);
  if (!total) {
    return [];
  }
  const target = dim > 0 ? Math.min(dim, total) : total;
  const out = new Array(target).fill(0);
  const view = new Float32Array(blob.buffer, blob.byteOffset, total);
  for (let i = 0; i < target; i += 1) {
    out[i] = Number(view[i]) || 0;
  }
  return out;
}

function upsertMetaEntries(db, pairs) {
  const list = Array.isArray(pairs) ? pairs : [];
  if (!list.length) {
    return 0;
  }
  const stmt = db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  for (const [key, value] of list) {
    stmt.run(String(key), String(value));
  }
  return list.length;
}

function clearVectorMetaEntries(db) {
  db.prepare(`DELETE FROM meta WHERE key IN (
    ?, ?, ?, ?, ?, ?
  )`).run(
    VECTOR_META_KEYS.schemaVersion,
    VECTOR_META_KEYS.provider,
    VECTOR_META_KEYS.model,
    VECTOR_META_KEYS.dim,
    VECTOR_META_KEYS.embeddingVersion,
    VECTOR_META_KEYS.updatedAt,
  );
}

function buildTurnFilters(scope, sessionId) {
  const normalizedScope = normalizeScope(scope);
  const cleanSessionId = safeTrim(sessionId);
  const where = [];
  const params = [];
  if (normalizedScope === "hot" || normalizedScope === "archive") {
    where.push("t.source = ?");
    params.push(normalizedScope);
  }
  if (cleanSessionId) {
    where.push("t.session_id = ?");
    params.push(cleanSessionId);
  }
  return {
    whereSql: where.length ? ` AND ${where.join(" AND ")}` : "",
    params,
  };
}

function countRows(db, tableName) {
  if (!tableExists(db, tableName)) {
    return 0;
  }
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${tableName}`).get();
  return Number(row?.c || 0);
}

function chunkList(items, chunkSize = 300) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.floor(Number(chunkSize) || 300));
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

function lookupTurnRowIds(db, ids) {
  const out = new Map();
  const unique = Array.from(new Set((Array.isArray(ids) ? ids : []).map((id) => safeTrim(id)).filter(Boolean)));
  if (!unique.length) {
    return out;
  }
  for (const batch of chunkList(unique, 300)) {
    const placeholders = batch.map(() => "?").join(", ");
    const stmt = db.prepare(`SELECT id, rowid AS rowid FROM turns WHERE id IN (${placeholders})`);
    const rows = stmt.all(...batch);
    for (const row of rows) {
      const id = safeTrim(row?.id);
      const rowid = Number(row?.rowid);
      if (!id || !Number.isFinite(rowid) || rowid <= 0) {
        continue;
      }
      out.set(id, rowid);
    }
  }
  return out;
}

function toBigIntRowid(rowid) {
  if (typeof rowid === "bigint") {
    return rowid > 0n ? rowid : null;
  }
  const n = Number(rowid);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return BigInt(Math.floor(n));
}

function ensureVectorTable(db, dim, options = {}) {
  const targetDim = clampInt(dim, 0, 1, 4096);
  if (!targetDim) {
    throw new Error("invalid vector dimension");
  }
  if (options.recreate) {
    if (tableExists(db, "turns_vec")) {
      db.exec("DROP TABLE IF EXISTS turns_vec");
    }
  }
  if (!tableExists(db, "turns_vec")) {
    db.exec(`CREATE VIRTUAL TABLE turns_vec USING vec0(embedding float[${targetDim}]);`);
  }
}

function distanceToScore(distance) {
  const n = Number(distance);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Number((1 / (1 + Math.max(0, n))).toFixed(6));
}

function toSearchRow(row, score, extra = {}) {
  return {
    id: String(row?.id || ""),
    ts: String(row?.ts || ""),
    session_id: safeTrim(row?.session_id) || undefined,
    role: String(row?.role || "unknown"),
    type: String(row?.type || "note"),
    source: String(row?.source || "hot"),
    refs: parseRefsJson(row?.refs_json),
    text: String(row?.text_preview || ""),
    summary: String(row?.summary || ""),
    score: Number(score || 0),
    ...extra,
  };
}

export async function loadSqliteVecExtension(db, config = {}) {
  if (!db || typeof db.loadExtension !== "function") {
    return {
      available: false,
      reason: "sqlite_load_extension_unsupported",
      engine: "sqlite_vec",
    };
  }
  if (db.__contextfsVecLoaded) {
    return {
      available: true,
      reason: "ok",
      engine: "sqlite_vec",
    };
  }
  if (config?.vectorEnabled === false) {
    return {
      available: false,
      reason: "vector_disabled",
      engine: "sqlite_vec",
    };
  }
  const vecModule = await loadSqliteVecModule();
  if (!vecModule) {
    return {
      available: false,
      reason: "sqlite_vec_module_missing",
      engine: "sqlite_vec",
    };
  }
  try {
    if (typeof vecModule.load === "function") {
      vecModule.load(db);
    } else if (typeof vecModule?.default?.load === "function") {
      vecModule.default.load(db);
    } else if (typeof vecModule.getLoadablePath === "function") {
      db.loadExtension(vecModule.getLoadablePath());
    } else if (typeof vecModule?.default?.getLoadablePath === "function") {
      db.loadExtension(vecModule.default.getLoadablePath());
    } else {
      return {
        available: false,
        reason: "sqlite_vec_module_invalid",
        engine: "sqlite_vec",
      };
    }
    db.__contextfsVecLoaded = true;
    return {
      available: true,
      reason: "ok",
      engine: "sqlite_vec",
    };
  } catch (err) {
    return {
      available: false,
      reason: `sqlite_vec_load_failed:${safeTrim(err?.message || err) || "unknown"}`,
      engine: "sqlite_vec",
    };
  }
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      session_id TEXT,
      role TEXT NOT NULL,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      refs_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      text_preview TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_turns_ts ON turns(ts);
    CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
    CREATE INDEX IF NOT EXISTS idx_turns_source ON turns(source);

    CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
      id UNINDEXED,
      summary,
      text_preview,
      refs,
      tokenize='unicode61'
    );
  `);
}

async function withDb(workspaceDir, config, run) {
  if (!config?.indexEnabled) {
    return {
      enabled: false,
      available: false,
      reason: "index_disabled",
    };
  }
  const Driver = await loadSqliteDriver();
  if (!Driver) {
    return {
      enabled: true,
      available: false,
      reason: "sqlite_driver_missing",
      path: resolveIndexPath(workspaceDir, config),
    };
  }
  const indexPath = resolveIndexPath(workspaceDir, config);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  const db = new Driver(indexPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    ensureSchema(db);
    const payload = await run(db, indexPath);
    return {
      enabled: true,
      available: true,
      path: indexPath,
      ...payload,
    };
  } finally {
    try {
      db.close();
    } catch {
      // ignore close errors
    }
  }
}

export function toSqliteTurnRow(entry, source = "hot", options = {}) {
  const item = entry && typeof entry === "object" ? entry : {};
  const refs = Array.isArray(item.refs) ? item.refs.map((ref) => String(ref || "")).filter(Boolean) : [];
  const summaryMaxChars = clampInt(options.summaryMaxChars, 240, 40, 1000);
  const previewMaxChars = clampInt(options.previewMaxChars, 1200, 80, 12000);
  const textSource = String(item.text || item.summary || "");
  return {
    id: String(item.id || ""),
    ts: String(item.ts || ""),
    session_id: safeTrim(item.session_id ?? item.sessionId ?? item.session) || null,
    role: String(item.role || "unknown"),
    type: String(item.type || "note"),
    source: source === "archive" ? "archive" : "hot",
    refs_json: safeJsonStringify(refs),
    refs_fts: refs.join(" "),
    summary: lineSummary(item.summary ?? textSource, summaryMaxChars),
    text_preview: lineSummary(textSource, previewMaxChars),
  };
}

export async function upsertSqliteTurnRows(workspaceDir, config, rows, meta = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return withDb(workspaceDir, config, async () => ({
      upserted: 0,
      meta_updated: 0,
    }));
  }
  return withDb(workspaceDir, config, async (db) => {
    const upsertTurn = db.prepare(`
      INSERT INTO turns (id, ts, session_id, role, type, source, refs_json, summary, text_preview)
      VALUES (@id, @ts, @session_id, @role, @type, @source, @refs_json, @summary, @text_preview)
      ON CONFLICT(id) DO UPDATE SET
        ts = excluded.ts,
        session_id = excluded.session_id,
        role = excluded.role,
        type = excluded.type,
        source = excluded.source,
        refs_json = excluded.refs_json,
        summary = excluded.summary,
        text_preview = excluded.text_preview
    `);
    const deleteFts = db.prepare("DELETE FROM turns_fts WHERE id = ?");
    const insertFts = db.prepare("INSERT INTO turns_fts (id, summary, text_preview, refs) VALUES (?, ?, ?, ?)");
    const upsertMeta = db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    const tx = db.transaction((items, pairs) => {
      for (const row of items) {
        if (!safeTrim(row.id)) {
          continue;
        }
        upsertTurn.run(row);
        deleteFts.run(row.id);
        insertFts.run(row.id, row.summary, row.text_preview, row.refs_fts || "");
      }
      for (const [key, value] of pairs) {
        upsertMeta.run(String(key), String(value));
      }
    });
    const metaEntries = Object.entries(meta || {});
    tx(list, metaEntries);
    return {
      upserted: list.length,
      meta_updated: metaEntries.length,
    };
  });
}

export async function upsertSqliteVectorRows(workspaceDir, config, rows, meta = {}) {
  const list = normalizeVectorRows(rows);
  if (!list.length) {
    return withDb(workspaceDir, config, async () => ({
      engine: "sqlite_vec",
      upserted: 0,
      rows: 0,
      available: true,
      reason: "no_rows",
    }));
  }
  return withDb(workspaceDir, config, async (db) => {
    const ext = await loadSqliteVecExtension(db, config);
    if (!ext.available) {
      return {
        engine: "sqlite_vec",
        available: false,
        upserted: 0,
        rows: 0,
        reason: ext.reason,
      };
    }
    const nextMeta = buildVectorMeta(list, meta);
    if (!nextMeta?.dim) {
      return {
        engine: "sqlite_vec",
        available: true,
        upserted: 0,
        rows: 0,
        reason: "invalid_vector_dim",
      };
    }
    const currentMeta = readVectorMeta(db);
    const mismatchReason = hasVectorMetaMismatch(currentMeta, nextMeta);
    const forceRebuild = Boolean(meta?.forceRebuild || meta?.rebuild || meta?.fullRebuild);
    if (mismatchReason && !forceRebuild && (safeTrim(currentMeta.embedding_version) || Number(currentMeta.dim || 0) > 0)) {
      return {
        engine: "sqlite_vec",
        available: true,
        upserted: 0,
        rows: countRows(db, "turns_vec"),
        reason: "version_mismatch",
        mismatch_reason: mismatchReason,
        vector_meta: currentMeta,
        expected_vector_meta: nextMeta,
      };
    }
    ensureVectorTable(db, nextMeta.dim, {
      recreate: forceRebuild || Boolean(mismatchReason),
    });
    const rowidById = lookupTurnRowIds(db, list.map((row) => row.id));
    const mapped = list
      .map((row) => ({
        ...row,
        rowid: rowidById.get(row.id),
      }))
      .filter((row) => Number.isFinite(Number(row.rowid)) && Number(row.rowid) > 0);
    if (!mapped.length) {
      return {
        engine: "sqlite_vec",
        available: true,
        upserted: 0,
        rows: countRows(db, "turns_vec"),
        reason: "turn_rows_missing",
      };
    }
    const deleteStmt = db.prepare("DELETE FROM turns_vec WHERE rowid = ?");
    const insertStmt = db.prepare("INSERT INTO turns_vec (rowid, embedding) VALUES (?, ?)");
    const tx = db.transaction((items) => {
      for (const item of items) {
        const rowid = toBigIntRowid(item.rowid);
        if (rowid === null) {
          continue;
        }
        deleteStmt.run(rowid);
        insertStmt.run(rowid, vectorToBuffer(item.vec, nextMeta.dim));
      }
      upsertMetaEntries(db, [
        [VECTOR_META_KEYS.schemaVersion, nextMeta.schema_version],
        [VECTOR_META_KEYS.provider, nextMeta.provider],
        [VECTOR_META_KEYS.model, nextMeta.model],
        [VECTOR_META_KEYS.dim, String(nextMeta.dim)],
        [VECTOR_META_KEYS.embeddingVersion, nextMeta.embedding_version],
        [VECTOR_META_KEYS.updatedAt, nextMeta.updated_at],
      ]);
    });
    tx(mapped);
    return {
      engine: "sqlite_vec",
      available: true,
      upserted: mapped.length,
      rows: countRows(db, "turns_vec"),
      dim: nextMeta.dim,
      provider: nextMeta.provider,
      model: nextMeta.model,
      embedding_version: nextMeta.embedding_version,
      reason: "",
    };
  });
}

export async function pruneSqliteVectorRowsByTurnIds(workspaceDir, config, ids) {
  const list = Array.from(new Set((Array.isArray(ids) ? ids : []).map((id) => safeTrim(id)).filter(Boolean)));
  if (!list.length) {
    return withDb(workspaceDir, config, async () => ({
      engine: "sqlite_vec",
      available: true,
      removed: 0,
      reason: "no_ids",
    }));
  }
  return withDb(workspaceDir, config, async (db) => {
    const ext = await loadSqliteVecExtension(db, config);
    if (!ext.available) {
      return {
        engine: "sqlite_vec",
        available: false,
        removed: 0,
        reason: ext.reason,
      };
    }
    if (!tableExists(db, "turns_vec")) {
      return {
        engine: "sqlite_vec",
        available: true,
        removed: 0,
        reason: "vector_table_missing",
      };
    }
    const rowidById = lookupTurnRowIds(db, list);
    if (!rowidById.size) {
      return {
        engine: "sqlite_vec",
        available: true,
        removed: 0,
        reason: "turn_rows_missing",
      };
    }
    const stmt = db.prepare("DELETE FROM turns_vec WHERE rowid = ?");
    const tx = db.transaction((rows) => {
      for (const rowidRaw of rows) {
        const rowid = toBigIntRowid(rowidRaw);
        if (rowid === null) {
          continue;
        }
        stmt.run(rowid);
      }
    });
    const rowids = Array.from(rowidById.values());
    tx(rowids);
    return {
      engine: "sqlite_vec",
      available: true,
      removed: rowids.length,
      rows: countRows(db, "turns_vec"),
      reason: "",
    };
  });
}

export async function searchSqliteLexical(workspaceDir, config, options = {}) {
  const query = safeTrim(options.query);
  const topK = clampInt(options.k, 20, 1, 500);
  const scope = normalizeScope(options.scope);
  const sessionId = safeTrim(options.sessionId);
  if (!query) {
    return {
      enabled: Boolean(config?.indexEnabled),
      available: false,
      reason: "empty_query",
      engine: "sqlite_fts5",
      rows: [],
    };
  }
  return withDb(workspaceDir, config, async (db) => {
    const ftsQuery = buildFtsQuery(query);
    const where = ["turns_fts MATCH ?"];
    const params = [ftsQuery];
    if (scope === "hot" || scope === "archive") {
      where.push("t.source = ?");
      params.push(scope);
    }
    if (sessionId) {
      where.push("t.session_id = ?");
      params.push(sessionId);
    }
    params.push(topK);
    const stmt = db.prepare(`
      SELECT
        t.id,
        t.ts,
        t.session_id,
        t.role,
        t.type,
        t.source,
        t.refs_json,
        t.summary,
        t.text_preview,
        bm25(turns_fts, 1.2, 0.7, 0.3) AS bm25_score
      FROM turns_fts
      JOIN turns AS t ON t.id = turns_fts.id
      WHERE ${where.join(" AND ")}
      ORDER BY bm25_score ASC, t.ts DESC, t.id ASC
      LIMIT ?
    `);
    const rows = stmt.all(...params).map((row) => {
      const bm25Score = Number(row?.bm25_score);
      const lexicalScore = Number.isFinite(bm25Score)
        ? Number((1 / (1 + Math.max(0, bm25Score))).toFixed(6))
        : 0;
      return {
        id: String(row.id || ""),
        ts: String(row.ts || ""),
        session_id: safeTrim(row.session_id) || undefined,
        role: String(row.role || "unknown"),
        type: String(row.type || "note"),
        source: String(row.source || "hot"),
        refs: parseRefsJson(row.refs_json),
        text: String(row.text_preview || ""),
        summary: String(row.summary || ""),
        score: lexicalScore,
        bm25_score: Number.isFinite(bm25Score) ? bm25Score : null,
      };
    });
    return {
      engine: "sqlite_fts5",
      rows,
      query: ftsQuery,
    };
  });
}

export async function searchSqliteVectorAnn(workspaceDir, config, queryVector, options = {}) {
  const query = Array.isArray(queryVector) ? queryVector : [];
  const topK = clampInt(options.k, 20, 1, 500);
  const scope = normalizeScope(options.scope);
  const sessionId = safeTrim(options.sessionId);
  const expectedEmbeddingVersion = safeTrim(options.embeddingVersion ?? options.embedding_version);
  if (!query.length) {
    return {
      enabled: Boolean(config?.indexEnabled),
      available: false,
      engine: "sqlite_vec_ann",
      reason: "empty_query_vector",
      rows: [],
    };
  }
  return withDb(workspaceDir, config, async (db) => {
    const ext = await loadSqliteVecExtension(db, config);
    if (!ext.available) {
      return {
        engine: "sqlite_vec_ann",
        available: false,
        reason: ext.reason,
        rows: [],
      };
    }
    if (!tableExists(db, "turns_vec")) {
      return {
        engine: "sqlite_vec_ann",
        available: false,
        reason: "vector_table_missing",
        rows: [],
      };
    }
    const vectorMeta = readVectorMeta(db);
    if (Number(vectorMeta.dim || 0) > 0 && Number(vectorMeta.dim || 0) !== query.length) {
      return {
        engine: "sqlite_vec_ann",
        available: false,
        reason: "dimension_mismatch",
        rows: [],
        dim: Number(vectorMeta.dim || 0),
      };
    }
    if (
      expectedEmbeddingVersion
      && safeTrim(vectorMeta.embedding_version)
      && String(vectorMeta.embedding_version) !== expectedEmbeddingVersion
    ) {
      return {
        engine: "sqlite_vec_ann",
        available: false,
        reason: "version_mismatch",
        rows: [],
        embedding_version: vectorMeta.embedding_version,
      };
    }
    const annTopN = clampInt(
      options.annTopN ?? options.candidates ?? config?.annTopN ?? topK,
      topK,
      topK,
      5000,
    );
    const filter = buildTurnFilters(scope, sessionId);
    const stmt = db.prepare(`
      SELECT
        t.id,
        t.ts,
        t.session_id,
        t.role,
        t.type,
        t.source,
        t.refs_json,
        t.summary,
        t.text_preview,
        v.distance
      FROM turns_vec AS v
      JOIN turns AS t ON t.rowid = v.rowid
      WHERE v.embedding MATCH ?
        AND v.k = ?
        ${filter.whereSql}
      ORDER BY v.distance ASC, t.ts DESC, t.id ASC
      LIMIT ?
    `);
    const rows = stmt.all(
      vectorToBuffer(query, query.length),
      annTopN,
      ...filter.params,
      topK,
    ).map((row) => {
      const distance = Number(row?.distance);
      const score = distanceToScore(distance);
      return toSearchRow(row, score, {
        distance: Number.isFinite(distance) ? distance : null,
      });
    });
    return {
      engine: "sqlite_vec_ann",
      available: true,
      reason: "",
      rows,
      dim: Number(vectorMeta.dim || query.length),
      embedding_version: vectorMeta.embedding_version || "",
    };
  });
}

export async function searchSqliteVectorLinear(workspaceDir, config, queryVector, options = {}) {
  const query = Array.isArray(queryVector) ? queryVector : [];
  const topK = clampInt(options.k, 20, 1, 500);
  const scope = normalizeScope(options.scope);
  const sessionId = safeTrim(options.sessionId);
  const expectedEmbeddingVersion = safeTrim(options.embeddingVersion ?? options.embedding_version);
  if (!query.length) {
    return {
      enabled: Boolean(config?.indexEnabled),
      available: false,
      engine: "sqlite_vec_linear",
      reason: "empty_query_vector",
      rows: [],
    };
  }
  return withDb(workspaceDir, config, async (db) => {
    const ext = await loadSqliteVecExtension(db, config);
    if (!ext.available) {
      return {
        engine: "sqlite_vec_linear",
        available: false,
        reason: ext.reason,
        rows: [],
      };
    }
    if (!tableExists(db, "turns_vec")) {
      return {
        engine: "sqlite_vec_linear",
        available: false,
        reason: "vector_table_missing",
        rows: [],
      };
    }
    const vectorMeta = readVectorMeta(db);
    if (Number(vectorMeta.dim || 0) > 0 && Number(vectorMeta.dim || 0) !== query.length) {
      return {
        engine: "sqlite_vec_linear",
        available: false,
        reason: "dimension_mismatch",
        rows: [],
        dim: Number(vectorMeta.dim || 0),
      };
    }
    if (
      expectedEmbeddingVersion
      && safeTrim(vectorMeta.embedding_version)
      && String(vectorMeta.embedding_version) !== expectedEmbeddingVersion
    ) {
      return {
        engine: "sqlite_vec_linear",
        available: false,
        reason: "version_mismatch",
        rows: [],
        embedding_version: vectorMeta.embedding_version,
      };
    }
    const minSimilarity = clampFloat(options.minSimilarity ?? config?.vectorMinSimilarity ?? -1, -1, -1, 1);
    const linearLimit = clampInt(options.linearLimit ?? options.candidates ?? config?.annProbeTopN ?? 1000, 1000, topK, 100000);
    const filter = buildTurnFilters(scope, sessionId);
    const stmt = db.prepare(`
      SELECT
        t.id,
        t.ts,
        t.session_id,
        t.role,
        t.type,
        t.source,
        t.refs_json,
        t.summary,
        t.text_preview,
        v.embedding
      FROM turns_vec AS v
      JOIN turns AS t ON t.rowid = v.rowid
      WHERE 1 = 1
        ${filter.whereSql}
      LIMIT ?
    `);
    const scored = [];
    const rows = stmt.all(...filter.params, linearLimit);
    for (const row of rows) {
      const vec = bufferToVector(row?.embedding, query.length);
      if (!vec.length) {
        continue;
      }
      const score = Number(cosineSimilarity(query, vec));
      if (!Number.isFinite(score) || score < minSimilarity) {
        continue;
      }
      scored.push(toSearchRow(row, score, {
        distance: Number((1 - score).toFixed(6)),
      }));
    }
    scored.sort((a, b) => (b.score - a.score) || String(b.ts || "").localeCompare(String(a.ts || "")) || String(a.id || "").localeCompare(String(b.id || "")));
    return {
      engine: "sqlite_vec_linear",
      available: true,
      reason: "",
      rows: scored.slice(0, topK),
      dim: Number(vectorMeta.dim || query.length),
      embedding_version: vectorMeta.embedding_version || "",
    };
  });
}

export async function rebuildSqliteIndexFromStorage(storage, config) {
  const history = await storage.readHistory();
  const archive = await storage.readHistoryArchive();
  const byId = new Map();
  for (const row of archive) {
    const indexed = toSqliteTurnRow(row, "archive", {
      summaryMaxChars: config.searchSummaryMaxChars,
      previewMaxChars: config.embeddingTextMaxChars,
    });
    byId.set(indexed.id, indexed);
  }
  for (const row of history) {
    const indexed = toSqliteTurnRow(row, "hot", {
      summaryMaxChars: config.searchSummaryMaxChars,
      previewMaxChars: config.embeddingTextMaxChars,
    });
    byId.set(indexed.id, indexed);
  }
  const rows = Array.from(byId.values())
    .filter((row) => Boolean(safeTrim(row.id)))
    .sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")) || String(a.id || "").localeCompare(String(b.id || "")));
  return withDb(storage.workspaceDir, config, async (db) => {
    const upsertTurn = db.prepare(`
      INSERT INTO turns (id, ts, session_id, role, type, source, refs_json, summary, text_preview)
      VALUES (@id, @ts, @session_id, @role, @type, @source, @refs_json, @summary, @text_preview)
      ON CONFLICT(id) DO UPDATE SET
        ts = excluded.ts,
        session_id = excluded.session_id,
        role = excluded.role,
        type = excluded.type,
        source = excluded.source,
        refs_json = excluded.refs_json,
        summary = excluded.summary,
        text_preview = excluded.text_preview
    `);
    const deleteFts = db.prepare("DELETE FROM turns_fts WHERE id = ?");
    const insertFts = db.prepare("INSERT INTO turns_fts (id, summary, text_preview, refs) VALUES (?, ?, ?, ?)");
    const upsertMeta = db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    const tx = db.transaction((items) => {
      db.prepare("DELETE FROM turns").run();
      db.prepare("DELETE FROM turns_fts").run();
      if (tableExists(db, "turns_vec")) {
        try {
          db.exec("DROP TABLE IF EXISTS turns_vec");
        } catch {
          // Keep going. doctor/reindex --vectors will surface remaining vector issues.
        }
      }
      clearVectorMetaEntries(db);
      for (const row of items) {
        upsertTurn.run(row);
        deleteFts.run(row.id);
        insertFts.run(row.id, row.summary, row.text_preview, row.refs_fts || "");
      }
      upsertMeta.run("schema_version", "1");
      upsertMeta.run("built_at", new Date().toISOString());
      upsertMeta.run("row_count", String(items.length));
    });
    tx(rows);
    return {
      rebuilt: true,
      rows: rows.length,
      upserted: rows.length,
      vector_reset: true,
    };
  });
}

export async function rebuildSqliteVectorIndexFromStorage(storage, config, options = {}) {
  const modelOverride = safeTrim(options.model);
  const localConfig = modelOverride
    ? {
      ...config,
      embeddingModel: modelOverride,
    }
    : config;
  let rows = normalizeVectorRows(options.rows);
  if (!rows.length && typeof storage?.readHistoryEmbeddingView === "function") {
    rows = normalizeVectorRows(await storage.readHistoryEmbeddingView("all"));
  }
  if (!rows.length && typeof storage?.readHistory === "function" && typeof storage?.buildEmbeddingRowsForEntries === "function") {
    const history = await storage.readHistory();
    const archive = typeof storage.readHistoryArchive === "function"
      ? await storage.readHistoryArchive()
      : [];
    const hotRows = normalizeVectorRows(await storage.buildEmbeddingRowsForEntries(history, "hot"));
    const archiveRows = normalizeVectorRows(await storage.buildEmbeddingRowsForEntries(archive, "archive"));
    const byId = new Map();
    for (const row of archiveRows) {
      byId.set(String(row.id), row);
    }
    for (const row of hotRows) {
      byId.set(String(row.id), row);
    }
    rows = Array.from(byId.values());
    if (rows.length && typeof storage?.appendHistoryEmbeddingRows === "function") {
      const existing = typeof storage?.readHistoryEmbeddingView === "function"
        ? await storage.readHistoryEmbeddingView("all")
        : [];
      if (existing.length && typeof storage?.pruneHistoryEmbeddingByIds === "function") {
        await storage.pruneHistoryEmbeddingByIds(existing.map((row) => String(row?.id || "")));
      }
      await storage.appendHistoryEmbeddingRows(rows);
    }
  }
  if (!rows.length) {
    return {
      rebuilt: false,
      available: Boolean(localConfig?.indexEnabled),
      engine: "sqlite_vec",
      reason: "no_vector_rows",
      vectors: 0,
      provider: "unknown",
      model: modelOverride || safeTrim(localConfig?.embeddingModel) || "",
      dim: 0,
      embedding_version: "",
    };
  }
  const meta = buildVectorMeta(rows, {
    model: modelOverride || options.model,
    provider: options.provider,
    embedding_version: options.embedding_version,
  });
  const result = await upsertSqliteVectorRows(storage.workspaceDir, localConfig, rows, {
    ...meta,
    forceRebuild: true,
  });
  return {
    ...result,
    rebuilt: Boolean(result?.available),
    vectors: Number(result?.upserted || 0),
    provider: meta?.provider || "unknown",
    model: meta?.model || modelOverride || safeTrim(localConfig?.embeddingModel) || "",
    dim: Number(meta?.dim || 0),
    embedding_version: meta?.embedding_version || "",
  };
}

export async function sqliteIndexDoctor(workspaceDir, config) {
  return withDb(workspaceDir, config, async (db, dbPath) => {
    const turns = Number(db.prepare("SELECT COUNT(*) AS c FROM turns").get()?.c || 0);
    const turnsFts = Number(db.prepare("SELECT COUNT(*) AS c FROM turns_fts").get()?.c || 0);
    const vectorMeta = readVectorMeta(db);
    const vecExt = await loadSqliteVecExtension(db, config);
    let vectorRows = 0;
    let vectorReason = "";
    if (!tableExists(db, "turns_vec")) {
      vectorReason = "vector_table_missing";
    } else if (!vecExt.available) {
      vectorReason = vecExt.reason || "sqlite_vec_unavailable";
    } else {
      try {
        vectorRows = countRows(db, "turns_vec");
      } catch (err) {
        vectorReason = safeTrim(err?.message || err) || "vector_count_failed";
      }
    }
    return {
      engine: "sqlite_fts5",
      path: dbPath,
      turns,
      turns_fts: turnsFts,
      consistent: turns === turnsFts,
      vector: {
        available: Boolean(vecExt.available && tableExists(db, "turns_vec")),
        engine: "sqlite_vec",
        rows: vectorRows,
        dim: Number(vectorMeta.dim || 0),
        provider: vectorMeta.provider || "",
        model: vectorMeta.model || "",
        embedding_version: vectorMeta.embedding_version || "",
        schema_version: vectorMeta.schema_version || "",
        reason: vectorReason || (vecExt.available ? "" : vecExt.reason || ""),
      },
    };
  });
}
