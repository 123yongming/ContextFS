import fs from "node:fs/promises";
import path from "node:path";

const FILES = {
  manifest: "manifest.md",
  pins: "pins.md",
  summary: "summary.md",
  history: "history.ndjson",
  historyArchive: "history.archive.ndjson",
  historyArchiveIndex: "history.archive.index.ndjson",
  historyBad: "history.bad.ndjson",
  state: "state.json",
};

const LEGACY_FALLBACK_EPOCH_MS = 0;
const RETRYABLE_LOCK_ERRORS = new Set(["EEXIST", "EBUSY"]);
const LOCK_PERMISSION_ERRORS = new Set(["EPERM", "EACCES"]);
const RETRYABLE_RENAME_ERRORS = new Set(["EBUSY", "EPERM", "EXDEV"]);

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

function normalizeEntry(raw, fallbackTs = stableFallbackTs(0)) {
  const src = raw && typeof raw === "object" ? raw : {};
  const role = normalizeRole(src.role || src.author || src.messageRole);
  const text = String(src.text ?? src.content ?? src.message ?? "").trim();
  const ts = normalizeTs(src.ts || src.timestamp, fallbackTs);
  const refs = uniqList(Array.isArray(src.refs) ? src.refs : extractRefs(text), 12);
  const tags = Array.isArray(src.tags) ? uniqList(src.tags, 12) : undefined;
  const type = safeTrim(src.type) || inferType(role, text);
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

function makeTmpPath(target) {
  const rand = Math.random().toString(16).slice(2, 10);
  return `${target}.${process.pid}.${Date.now()}.${rand}.tmp`;
}

function serializeHistoryEntries(entries) {
  if (!entries.length) {
    return "";
  }
  return `${entries.map((item) => JSON.stringify(item)).join("\n")}\n`;
}

function summarizeText(text, maxChars = 240) {
  const oneLine = String(text || "").replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(0, maxChars - 3))}...`;
}

function toArchiveIndexEntry(entry, archivedAt) {
  return {
    id: String(entry.id || ""),
    ts: normalizeTs(entry.ts, stableFallbackTs(0)),
    type: safeTrim(entry.type) || "note",
    refs: uniqList(Array.isArray(entry.refs) ? entry.refs : [], 12),
    summary: summarizeText(entry.text, 240),
    archivedAt: normalizeTs(archivedAt, nowIso()),
    source: "archive",
  };
}

function parseArchiveIndexText(rawText) {
  const lines = String(rawText || "").split("\n");
  const byId = new Map();
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    const trimmed = safeTrim(line);
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      const id = safeTrim(parsed.id);
      if (!id) {
        continue;
      }
      byId.set(id, {
        id,
        ts: normalizeTs(parsed.ts, stableFallbackTs(idx)),
        type: safeTrim(parsed.type) || "note",
        refs: uniqList(Array.isArray(parsed.refs) ? parsed.refs : [], 12),
        summary: summarizeText(parsed.summary ?? parsed.text ?? "", 240),
        archivedAt: normalizeTs(parsed.archivedAt, stableFallbackTs(idx)),
        source: "archive",
      });
    } catch {
      // ignore bad archive index lines
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
    await this.ensureFile("historyArchiveIndex", "");
    await this.ensureFile("state", JSON.stringify(this.defaultState(), null, 2) + "\n");

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

  async acquireLock(maxRetries = 20) {
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
            if (statErr?.code === "ENOENT") {
              throw err;
            }
            shouldRetry = false;
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

  async readHistoryArchiveIndex() {
    const raw = await this.readText("historyArchiveIndex");
    if (!safeTrim(raw)) {
      return [];
    }
    return parseArchiveIndexText(raw);
  }

  async rebuildHistoryArchiveIndex(options = {}) {
    const lock = options.locked ? null : await this.acquireLock();
    try {
      const rawArchive = await this.readText("historyArchive");
      const parsed = parseArchiveTextPreserveIds(rawArchive);
      const entries = parsed.entries;
      const archivedAt = options.archivedAt || nowIso();
      const indexEntries = entries.map((entry) => toArchiveIndexEntry(entry, archivedAt));
      const payload = serializeHistoryEntries(indexEntries);
      await this.writeTextWithLock("historyArchiveIndex", payload);
      return {
        rebuilt: true,
        archiveEntries: entries.length,
        indexEntries: indexEntries.length,
      };
    } finally {
      if (lock) {
        await this.releaseLock(lock);
      }
    }
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

  async writeHistory(items) {
    const normalized = normalizeHistoryItems(items);
    await this.writeText("history", serializeHistoryEntries(normalized));
  }

  async appendHistory(entry) {
    const lock = await this.acquireLock();
    try {
      const raw = await this.readText("history");
      const parsed = parseHistoryText(raw);
      const usedIds = new Set(parsed.entries.map((item) => item.id));
      const normalized = normalizeEntry(entry, nowIso());
      normalized.id = makeUniqueId(normalized.id, usedIds);
      await fs.appendFile(this.resolve("history"), `${JSON.stringify(normalized)}\n`, "utf8");
      return normalized;
    } finally {
      await this.releaseLock(lock);
    }
  }

  async appendHistoryArchive(entries, options = {}) {
    const list = Array.isArray(entries) ? entries : [];
    if (!list.length) {
      return [];
    }
    const normalized = normalizeHistoryItems(list);
    const archivedAt = options.archivedAt || nowIso();
    const payload = `${normalized.map((item) => JSON.stringify(item)).join("\n")}\n`;
    const indexPayload = `${normalized
      .map((item) => JSON.stringify(toArchiveIndexEntry(item, archivedAt)))
      .join("\n")}\n`;
    const write = async () => {
      await fs.appendFile(this.resolve("historyArchive"), payload, "utf8");
      await fs.appendFile(this.resolve("historyArchiveIndex"), indexPayload, "utf8");
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
      "- history.archive.index.ndjson | archive retrieval index | tags: runtime,index",
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
