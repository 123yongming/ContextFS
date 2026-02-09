import { estimateTokens } from "./token.mjs";
import { parsePinsMarkdown, dedupePins } from "./pins.mjs";

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
  const rows = turns.map((turn, i) => {
    const role = String(turn.role || "unknown");
    const text = sanitizeForPack(String(turn.text || "").replace(/\s+/g, " ").trim(), config);
    return `${i + 1}. [${role}] ${text}`;
  });
  return rows.join("\n");
}

export async function buildContextPack(storage, config) {
  const manifestRaw = await storage.readText("manifest");
  const summaryRaw = await storage.readText("summary");
  const pinsRaw = await storage.readText("pins");
  const history = await storage.readHistory();

  const manifest = sanitizeForPack(capLines(manifestRaw, config.manifestMaxLines), config);
  const summary = sanitizeForPack(capChars(summaryRaw, config.summaryMaxChars), config);
  const parsedPins = parsePinsMarkdown(pinsRaw);
  const dedupedPins = dedupePins(parsedPins, config.pinsMaxItems);
  const pinBody = dedupedPins
    .map((item) => `- [${item.id}] ${sanitizeForPack(item.text, config)}`)
    .join("\n");
  const pins = `# Pins (short, one line each)\n\n${pinBody}${pinBody ? "\n" : ""}`;

  const recentTurns = history.slice(Math.max(0, history.length - config.recentTurns));
  const workset = renderTurns(recentTurns, config);

  const block = [
    config.packDelimiterStart,
    "## ContextFS Pack",
    "",
    "### PINS",
    pins.trimEnd(),
    "",
    "### SUMMARY",
    summary.trimEnd(),
    "",
    "### MANIFEST",
    manifest.trimEnd(),
    "",
    "### WORKSET_RECENT_TURNS",
    workset || "(no turns yet)",
    config.packDelimiterEnd,
  ].join("\n");

  const details = {
    pinsCount: dedupedPins.length,
    summaryChars: summary.length,
    manifestLines: manifest.split("\n").filter(Boolean).length,
    recentTurns: recentTurns.length,
    estimatedTokens: estimateTokens(block),
  };

  await storage.updateState({ lastPackTokens: details.estimatedTokens });

  return {
    block,
    details,
  };
}
