import { estimateTokens, estimateBlockTokens } from "./token.mjs";
import { mergeSummary, summarizeTurns } from "./summary.mjs";

function turnToText(turn) {
  const role = String(turn.role || "unknown");
  const text = String(turn.text || "");
  return `${role}: ${text}`;
}

function countHistoryTokens(history) {
  return estimateBlockTokens(history.map(turnToText));
}

export async function maybeCompact(storage, config, force = false) {
  const history = await storage.readHistory();
  const pins = await storage.readText("pins");
  const summary = await storage.readText("summary");
  const total = countHistoryTokens(history) + estimateTokens(pins) + estimateTokens(summary);

  const threshold = config.tokenThreshold;
  const shouldCompact = force || (config.autoCompact && total > threshold);
  if (!shouldCompact) {
    return {
      compacted: false,
      beforeTokens: total,
      afterTokens: total,
      compactedTurns: 0,
    };
  }

  const keep = Math.max(1, Number(config.recentTurns || 6));
  const splitIndex = Math.max(0, history.length - keep);
  const oldTurns = history.slice(0, splitIndex);
  const recentTurns = history.slice(splitIndex);

  if (!oldTurns.length && !force) {
    return {
      compacted: false,
      beforeTokens: total,
      afterTokens: total,
      compactedTurns: 0,
    };
  }

  const bullets = summarizeTurns(oldTurns, 20);
  const merged = mergeSummary(summary, bullets, config.summaryMaxChars);
  await storage.writeText("summary", merged);
  await storage.writeHistory(recentTurns);

  const afterTotal = countHistoryTokens(recentTurns) + estimateTokens(pins) + estimateTokens(merged);
  await storage.updateState({
    lastCompactedAt: new Date().toISOString(),
    lastPackTokens: afterTotal,
  });
  await storage.refreshManifest();

  return {
    compacted: true,
    beforeTokens: total,
    afterTokens: afterTotal,
    compactedTurns: oldTurns.length,
    keptTurns: recentTurns.length,
  };
}
