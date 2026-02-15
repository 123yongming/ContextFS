import { estimateTokens } from "./token.mjs";
import { parsePinsMarkdown, dedupePins } from "./pins.mjs";

const SAFE_DELIMITER_START = "<<<CONTEXTFS:BEGIN>>>";
const SAFE_DELIMITER_END = "<<<CONTEXTFS:END>>>";

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeForPack(content, config) {
  const value = String(content || "");
  const begin = String(config.packDelimiterStart || "");
  const end = String(config.packDelimiterEnd || "");
  let out = value;
  if (begin) {
    out = out.replace(new RegExp(escapeRegExp(begin), "g"), "[[CONTEXTFS_BEGIN_ESCAPED]]");
  }
  if (end) {
    out = out.replace(new RegExp(escapeRegExp(end), "g"), "[[CONTEXTFS_END_ESCAPED]]");
  }
  return out;
}

function capLines(content, maxLines) {
  const lines = String(content || "").split("\n");
  return lines.slice(0, maxLines).join("\n").trimEnd() + "\n";
}

function capChars(content, maxChars) {
  const value = String(content || "");
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 4))}\n...`;
}

function renderTurns(turns, config) {
  // L1 navigation preview. Not a full replay: one line per turn, bounded.
  const rows = turns.map((turn, i) => {
    const id = String(turn.id || "no-id");
    const role = String(turn.role || "unknown");
    const type = String(turn.type || "note");
    const text = sanitizeForPack(String(turn.text || "").replace(/\s+/g, " ").trim(), config);
    const bounded = text.length > 160 ? `${text.slice(0, 157)}...` : text;
    return `${i + 1}. ${id} | ${role} | ${type} | ${bounded}`;
  });
  return rows.join("\n");
}

function renderRetrievalIndex(rows, config) {
  if (!rows.length) {
    return "(no retrieval index yet)";
  }
  return rows
    .map((row) => {
      const id = String(row.id || "no-id");
      const ts = String(row.ts || "n/a");
      const type = String(row.type || "note");
      const source = String(row.source || "n/a");
      const summary = sanitizeForPack(String(row.summary || "").replace(/\s+/g, " ").trim(), config);
      const bounded = summary.length > config.searchSummaryMaxChars ? `${summary.slice(0, config.searchSummaryMaxChars - 3)}...` : summary;
      return `${id} | ${ts} | ${type} | ${source} | ${bounded}`;
    })
    .join("\n");
}

function normalizeRetrievalRows(rows, config) {
  const list = Array.isArray(rows) ? rows : [];
  return list
    .map((row) => {
      const src = row && typeof row === "object" ? row : {};
      const summaryRaw = String(src.summary ?? src.text ?? "");
      const oneLine = summaryRaw.replace(/\s+/g, " ").trim();
      const bounded = oneLine.length > config.searchSummaryMaxChars
        ? `${oneLine.slice(0, Math.max(0, config.searchSummaryMaxChars - 3))}...`
        : oneLine;
      return {
        id: String(src.id || ""),
        ts: String(src.ts || ""),
        type: String(src.type || "note"),
        source: String(src.source || ""),
        summary: bounded,
        layer: String(src.layer || "L0"),
      };
    })
    .filter((row) => row.id);
}

function makeBlock(parts, config) {
  return [
    config.packDelimiterStart,
    "## ContextFS Pack",
    "",
    "### PINS",
    parts.pins.trimEnd(),
    "",
    "### SUMMARY",
    parts.summary.trimEnd(),
    "",
    "### MANIFEST",
    parts.manifest.trimEnd(),
    "",
    "### RETRIEVAL_INDEX",
    parts.retrievalIndex.trimEnd(),
    "",
    "### WORKSET_RECENT_TURNS",
    parts.workset || "(no turns yet)",
    config.packDelimiterEnd,
  ].join("\n");
}

export async function buildContextPack(storage, config) {
  const manifestRaw = await storage.readText("manifest");
  const summaryRaw = await storage.readText("summary");
  const pinsRaw = await storage.readText("pins");
  const history = await storage.readHistory();

  const state = await storage.readState();
  let manifest = sanitizeForPack(capLines(manifestRaw, config.manifestMaxLines), config);
  let summaryLimit = config.summaryMaxChars;
  let summary = sanitizeForPack(capChars(summaryRaw, summaryLimit), config);
  const parsedPins = parsePinsMarkdown(pinsRaw);
  const dedupedPins = dedupePins(parsedPins, config.pinsMaxItems);
  const pinBody = dedupedPins
    .map((item) => `- [${item.id}] ${sanitizeForPack(item.text, config)}`)
    .join("\n");
  let pins = `# Pins (short, one line each)\n\n${pinBody}${pinBody ? "\n" : ""}`;

  let turnKeep = config.recentTurns;
  let recentTurns = history.slice(Math.max(0, history.length - turnKeep));
  let workset = renderTurns(recentTurns, config);

  const searchIndexRaw = Array.isArray(state.lastSearchIndex) ? state.lastSearchIndex : [];
  let retrievalRows = normalizeRetrievalRows(searchIndexRaw, config).slice(0, config.retrievalIndexMaxItems);
  let retrievalIndex = renderRetrievalIndex(retrievalRows, config);

  let block = makeBlock(
    {
      pins,
      summary,
      manifest,
      retrievalIndex,
      workset,
    },
    config,
  );

  let tokens = estimateTokens(block);
  const threshold = config.tokenThreshold;
  let usedMinimal = false;
  let usedEmergency = false;

  while (tokens > threshold && turnKeep > 1) {
    turnKeep -= 1;
    recentTurns = history.slice(Math.max(0, history.length - turnKeep));
    workset = renderTurns(recentTurns, config);
    block = makeBlock({ pins, summary, manifest, retrievalIndex, workset }, config);
    tokens = estimateTokens(block);
  }

  while (tokens > threshold && retrievalRows.length > 0) {
    retrievalRows = retrievalRows.slice(0, retrievalRows.length - 1);
    retrievalIndex = renderRetrievalIndex(retrievalRows, config);
    block = makeBlock({ pins, summary, manifest, retrievalIndex, workset }, config);
    tokens = estimateTokens(block);
  }

  while (tokens > threshold && summaryLimit > config.packSummaryMinChars) {
    summaryLimit = Math.max(config.packSummaryMinChars, summaryLimit - 128);
    summary = sanitizeForPack(capChars(summaryRaw, summaryLimit), config);
    block = makeBlock({ pins, summary, manifest, retrievalIndex, workset }, config);
    tokens = estimateTokens(block);
  }

  if (tokens > threshold) {
    let fallbackManifestLines = config.manifestMaxLines;
    while (tokens > threshold && fallbackManifestLines > 4) {
      fallbackManifestLines -= 1;
      const fallbackManifest = sanitizeForPack(capLines(manifestRaw, fallbackManifestLines), config);
      block = makeBlock({ pins, summary, manifest: fallbackManifest, retrievalIndex, workset }, config);
      tokens = estimateTokens(block);
      if (tokens <= threshold) {
        manifest = fallbackManifest;
        break;
      }
    }
  }

  if (tokens > threshold) {
    let fallbackPinsCount = dedupedPins.length;
    while (tokens > threshold && fallbackPinsCount > 1) {
      fallbackPinsCount -= 1;
      const fallbackPinsBody = dedupedPins
        .slice(0, fallbackPinsCount)
        .map((item) => `- [${item.id}] ${sanitizeForPack(item.text, config)}`)
        .join("\n");
      const fallbackPins = `# Pins (short, one line each)\n\n${fallbackPinsBody}${fallbackPinsBody ? "\n" : ""}`;
      block = makeBlock({ pins: fallbackPins, summary, manifest, retrievalIndex, workset }, config);
      tokens = estimateTokens(block);
      if (tokens <= threshold) {
        pins = fallbackPins;
        break;
      }
    }
  }

  if (tokens > threshold) {
    usedMinimal = true;
    const minimalSummary = sanitizeForPack(capChars(summaryRaw, 64), config);
    const minimalManifest = sanitizeForPack(capLines(manifestRaw, 4), config);
    const minimal = makeBlock(
      {
        pins: "# Pins (short, one line each)\n\n- [P-min] minimal\n",
        summary: minimalSummary,
        manifest: minimalManifest,
        retrievalIndex: "(trimmed)",
        workset: "(trimmed)",
      },
      config,
    );
    block = minimal;
    tokens = estimateTokens(block);
    recentTurns = [];
    retrievalRows = [];
    manifest = minimalManifest;
    pins = "# Pins (short, one line each)\n\n- [P-min] minimal\n";
    summary = minimalSummary;
  }

  if (tokens > threshold) {
    usedEmergency = true;
    const emergencyConfig = {
      ...config,
      packDelimiterStart: SAFE_DELIMITER_START,
      packDelimiterEnd: SAFE_DELIMITER_END,
    };
    let emergencySummary = "(trimmed)";
    let emergencyManifest = "(trimmed)\n";
    const emergencyPins = "# Pins (short, one line each)\n\n- [P-err] minimal\n";
    block = makeBlock(
      {
        pins: emergencyPins,
        summary: emergencySummary,
        manifest: emergencyManifest,
        retrievalIndex: "(trimmed)",
        workset: "(trimmed)",
      },
      emergencyConfig,
    );
    tokens = estimateTokens(block);
    while (tokens > threshold && emergencySummary.length > 4) {
      emergencySummary = emergencySummary.slice(0, Math.max(4, emergencySummary.length - 2));
      block = makeBlock(
        {
          pins: emergencyPins,
          summary: emergencySummary,
          manifest: emergencyManifest,
          retrievalIndex: "(trimmed)",
          workset: "(trimmed)",
        },
        emergencyConfig,
      );
      tokens = estimateTokens(block);
      if (tokens <= threshold) {
        break;
      }
      emergencyManifest = emergencyManifest.length > 4 ? emergencyManifest.slice(0, Math.max(4, emergencyManifest.length - 2)) : emergencyManifest;
      block = makeBlock(
        {
          pins: emergencyPins,
          summary: emergencySummary,
          manifest: emergencyManifest,
          retrievalIndex: "(trimmed)",
          workset: "(trimmed)",
        },
        emergencyConfig,
      );
      tokens = estimateTokens(block);
    }
    if (tokens > threshold) {
      const maxChars = Math.max(16, Math.floor(threshold * 2));
      block = block.slice(0, maxChars);
      tokens = estimateTokens(block);
    }
    recentTurns = [];
    retrievalRows = [];
    pins = emergencyPins;
    manifest = emergencyManifest;
    summary = emergencySummary;
  }

  const pinsCountActual = (pins.match(/^- \[/gm) || []).length;
  const manifestLinesActual = manifest.split("\n").filter(Boolean).length;

  const pinsTokens = estimateTokens(pins);
  const summaryTokens = estimateTokens(summary);
  const manifestTokens = estimateTokens(manifest);
  const retrievalIndexTokens = estimateTokens(retrievalIndex);
  const worksetRecentTurnsTokens = estimateTokens(workset);
  const sumPartsTokens =
    pinsTokens
    + summaryTokens
    + manifestTokens
    + retrievalIndexTokens
    + worksetRecentTurnsTokens;
  const overheadTokens = Math.max(0, tokens - sumPartsTokens);

  const details = {
    pinsCount: pinsCountActual,
    summaryChars: summary.length,
    manifestLines: manifestLinesActual,
    recentTurns: recentTurns.length,
    retrievalIndexItems: retrievalRows.length,
    worksetUsed: recentTurns.length,
    minimalMode: usedMinimal,
    emergencyMode: usedEmergency,
    estimatedTokens: tokens,
    packBreakdown: {
      pins_tokens: pinsTokens,
      summary_tokens: summaryTokens,
      manifest_tokens: manifestTokens,
      retrieval_index_tokens: retrievalIndexTokens,
      workset_recent_turns_tokens: worksetRecentTurnsTokens,
      overhead_tokens: overheadTokens,
      total_tokens: tokens,
    },
  };

  await storage.updateState({
    lastPackTokens: details.estimatedTokens,
    worksetUsed: details.worksetUsed,
  });

  return {
    block,
    details,
  };
}
