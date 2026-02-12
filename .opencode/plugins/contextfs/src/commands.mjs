import { fileMap } from "./storage.mjs";
import { addPin, parsePinsMarkdown } from "./pins.mjs";
import { maybeCompact } from "./compactor.mjs";
import { buildContextPack } from "./packer.mjs";

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

function lineSummary(text, maxChars) {
  const oneLine = String(text || "").replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(0, maxChars - 3))}...`;
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
    refs: Array.isArray(item.refs) ? item.refs : [],
    text: String(item.summary || item.text || ""),
    source: "archive",
  }));
}

async function readHistoryByScope(storage, scope = "all") {
  const normalized = String(scope || "all").toLowerCase();
  if (normalized === "hot") {
    return { history: await storage.readHistory(), archive: [] };
  }
  if (normalized === "archive") {
    return { history: [], archive: asArchiveSearchRows(await storage.readHistoryArchiveIndex()) };
  }
  const history = await storage.readHistory();
  const archive = asArchiveSearchRows(await storage.readHistoryArchiveIndex());
  return { history, archive };
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
    "history.archive.index.ndjson",
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

export async function runCtxCommand(commandLine, storage, config) {
  const argv = parseArgs(commandLine);
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
        "  ctx compact",
        "  ctx search \"<query>\" [--k 5] [--scope all|hot|archive]",
        "  ctx timeline <id> [--before 3 --after 3]",
        "  ctx get <id> [--head 1200]",
        "  ctx stats",
        "  ctx gc",
        "  ctx reindex",
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
    const payload = {
      estimated_tokens: pack.details.estimatedTokens,
      threshold: config.tokenThreshold,
      compact_count: state.compactCount || 0,
      last_search_hits: state.lastSearchHits || 0,
      workset_used: pack.details.worksetUsed ?? pack.details.recentTurns,
      search_count: state.searchCount || 0,
      timeline_count: state.timelineCount || 0,
      get_count: state.getCount || 0,
      stats_count: state.statsCount || 0,
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
        `compact_count: ${payload.compact_count}`,
        `last_search_hits: ${payload.last_search_hits}`,
        `workset_used: ${payload.workset_used}`,
        `search_count: ${payload.search_count}`,
        `timeline_count: ${payload.timeline_count}`,
        `get_count: ${payload.get_count}`,
        `stats_count: ${payload.stats_count}`,
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

  if (cmd === "pin") {
    const text = args.join(" ").trim();
    if (!text) {
      return errorResult("usage: ctx pin \"<text>\"");
    }
    const merged = await addPin(storage, text, config);
    await storage.refreshManifest();
    return textResult(`pin added (deduped): count=${merged.length}`);
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
    const asJson = hasFlag(args, "--json");
    const cleanArgs = stripFlags(args, ["--k"]);
    const k = clampInt(toInt(getFlagValue(args, "--k", config.searchDefaultK), config.searchDefaultK), 1, 50);
    const scope = String(getFlagValue(args, "--scope", "all") || "all").toLowerCase();
    const query = stripFlags(cleanArgs, ["--scope"]).join(" ").trim();
    if (!query) {
      return errorResult('usage: ctx search "<query>" [--k 5]');
    }
    const queryTokens = tokenize(query);
    const { history, archive } = await readHistoryByScope(storage, scope);
    const pool = mergeUniqueHistory(history, archive);
    const hotIds = new Set(history.map((item) => String(item.id)));
    const newestTs = pool.length ? Date.parse(String(pool[pool.length - 1].ts || "")) : Date.now();
    const ranked = pool
      .map((entry) => ({
        entry,
        score: scoreEntry(entry, queryTokens, newestTs),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => (b.score - a.score) || String(b.entry.ts || "").localeCompare(String(a.entry.ts || "")))
      .slice(0, k);

    const rows = ranked.map(({ entry, score }) => ({
      id: entry.id,
      ts: isoMaybe(entry.ts),
      type: entry.type || "note",
      summary: lineSummary(entry.text, config.searchSummaryMaxChars),
      source: hotIds.has(String(entry.id)) ? "hot" : "archive",
      score: Number(score.toFixed(3)),
    }));

    await storage.updateState((cur) => ({
      lastSearchHits: rows.length,
      lastSearchQuery: query,
      lastSearchAt: new Date().toISOString(),
      lastSearchIndex: rows,
      searchCount: (cur.searchCount || 0) + 1,
    }));

    if (asJson) {
      return textResult(JSON.stringify({ query, k, scope, hits: rows.length, results: rows }, null, 2));
    }

    const lines = [
      `# search (${rows.length} hits, scope=${scope})`,
      "",
      ...rows.map((x) => `${x.id} | ${x.ts} | ${x.type} | ${x.source} | ${x.summary}`),
    ];
    return textResult(lines.join("\n"));
  }

  if (cmd === "timeline") {
    const asJson = hasFlag(args, "--json");
    const cleanArgs = stripFlags(args, ["--before", "--after"]);
    const anchorId = cleanArgs[0];
    if (!anchorId) {
      return errorResult("usage: ctx timeline <id> [--before 3 --after 3]");
    }
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
    const history = await storage.readHistory();
    const archive = asArchiveSearchRows(await storage.readHistoryArchiveIndex());
    const hotMatches = findIdMatches(history, anchorId);
    const archiveMatches = findIdMatches(archive, anchorId);
    const sourceList = hotMatches.length ? history : archive;
    const matches = hotMatches.length ? hotMatches : archiveMatches;
    if (!matches.length) {
      return errorResult(`id not found: ${anchorId}`);
    }
    if (matches.length > 1) {
      return errorResult(`id conflict: ${anchorId}. run ctx gc or migration to repair duplicate ids`);
    }
    const index = sourceList.findIndex((item) => String(item.id) === String(anchorId));
    const start = Math.max(0, index - before);
    const end = Math.min(sourceList.length, index + after + 1);
    const slice = sourceList.slice(start, end).map((entry) => ({
      id: entry.id,
      ts: isoMaybe(entry.ts),
      type: entry.type || "note",
      summary: lineSummary(entry.text, config.searchSummaryMaxChars),
      source: hotMatches.length ? "hot" : "archive",
    }));

    await storage.updateState((cur) => ({
      timelineCount: (cur.timelineCount || 0) + 1,
      lastTimelineAnchor: anchorId,
    }));

    if (asJson) {
      return textResult(JSON.stringify({ anchor: anchorId, before, after, source: hotMatches.length ? "hot" : "archive", results: slice }, null, 2));
    }
    const lines = [
      `# timeline ${anchorId}`,
      "",
      ...slice.map((x) => `${x.id} | ${x.ts} | ${x.type} | ${x.source} | ${x.summary}`),
    ];
    return textResult(lines.join("\n"));
  }

  if (cmd === "get") {
    const asJson = hasFlag(args, "--json");
    const cleanArgs = stripFlags(args, ["--head"]);
    const id = cleanArgs[0];
    if (!id) {
      return errorResult("usage: ctx get <id> [--head 1200]");
    }
    const head = clampInt(toInt(getFlagValue(args, "--head", config.getDefaultHead), config.getDefaultHead), 0, 200000);
    const history = await storage.readHistory();
    const hotMatches = findIdMatches(history, id);
    const archiveRow = await storage.findHistoryArchiveById(id);
    const matches = hotMatches.length ? hotMatches : (archiveRow ? [archiveRow] : []);
    if (!matches.length) {
      return errorResult(`id not found: ${id}`);
    }
    if (matches.length > 1) {
      return errorResult(`id conflict: ${id}. run ctx gc or migration to repair duplicate ids`);
    }
    const row = matches[0];
    const source = hotMatches.length ? "hot" : "archive";
    await storage.updateState((cur) => ({
      getCount: (cur.getCount || 0) + 1,
    }));
    if (asJson) {
      const jsonBudget = head > 0 ? head : config.getDefaultHead;
      const base = {
        record: row,
        source,
        head: jsonBudget,
        original_text_len: String(row.text || "").length,
      };
      let limited = applyJsonHeadLimit(base, jsonBudget, {
        headText: config.getDefaultHead,
      }).payload;
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
        } else if (tags.length > 0) {
          limited.record.tags = tags.slice(0, tags.length - 1);
          truncatedFields.add("tags");
        } else if (textValue.length > 4) {
          const next = Math.max(4, textValue.length - 32);
          limited.record.text = `${textValue.slice(0, Math.max(0, next - 3))}...`;
          truncatedFields.add("text");
        } else if (String(limited.record.id || "").length > 16) {
          limited.record.id = truncateValue(limited.record.id, 16, "id", truncatedFields);
        } else if (String(limited.record.type || "").length > 16) {
          limited.record.type = truncateValue(limited.record.type, 16, "type", truncatedFields);
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
        return textResult(tinyJson);
      }
      return textResult(json);
    }
    const full = JSON.stringify({ source, record: row }, null, 2);
    const clipped = head > 0 ? `${full.slice(0, head)}${full.length > head ? "\n..." : ""}` : full;
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
    const result = await storage.rebuildHistoryArchiveIndex();
    return textResult(
      [
        "reindex done",
        `- rebuilt: ${String(result.rebuilt)}`,
        `- archive_entries: ${result.archiveEntries}`,
        `- index_entries: ${result.indexEntries}`,
      ].join("\n"),
    );
  }

  return errorResult(`unknown ctx command: ${cmd}`);
}
