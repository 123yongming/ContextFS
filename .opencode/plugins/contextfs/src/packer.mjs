import { estimateTokens } from "./token.mjs";
import { parsePinsMarkdown, dedupePins } from "./pins.mjs";

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

function renderTurns(turns) {
  const rows = turns.map((turn, i) => {
    const role = String(turn.role || "unknown");
    const text = String(turn.text || "").replace(/\s+/g, " ").trim();
    return `${i + 1}. [${role}] ${text}`;
  });
  return rows.join("\n");
}

export async function buildContextPack(storage, config) {
  const manifestRaw = await storage.readText("manifest");
  const summaryRaw = await storage.readText("summary");
  const pinsRaw = await storage.readText("pins");
  const history = await storage.readHistory();

  const manifest = capLines(manifestRaw, config.manifestMaxLines);
  const summary = capChars(summaryRaw, config.summaryMaxChars);
  const parsedPins = parsePinsMarkdown(pinsRaw);
  const dedupedPins = dedupePins(parsedPins, config.pinsMaxItems);
  const pinBody = dedupedPins.map((item) => `- [${item.id}] ${item.text}`).join("\n");
  const pins = `# Pins (short, one line each)\n\n${pinBody}${pinBody ? "\n" : ""}`;

  const recentTurns = history.slice(Math.max(0, history.length - config.recentTurns));
  const workset = renderTurns(recentTurns);

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
