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
  const lock = await storage.acquireLock();
  let result;
  try {
    const history = await storage.readHistory({ migrate: false });
    const pins = await storage.readText("pins");
    const summary = await storage.readText("summary");
    const total = countHistoryTokens(history) + estimateTokens(pins) + estimateTokens(summary);

    const threshold = config.tokenThreshold;
    const shouldCompact = force || (config.autoCompact && total > threshold);
    if (!shouldCompact) {
      result = {
        compacted: false,
        beforeTokens: total,
        afterTokens: total,
        compactedTurns: 0,
      };
    } else {
      const keep = Math.max(1, Number(config.recentTurns || 6));
      const splitIndex = Math.max(0, history.length - keep);
      const oldTurns = history.slice(0, splitIndex);
      const recentTurns = history.slice(splitIndex);

      if (!oldTurns.length && !force) {
        result = {
          compacted: false,
          beforeTokens: total,
          afterTokens: total,
          compactedTurns: 0,
        };
      } else {
        const bullets = summarizeTurns(oldTurns, 20);
        const merged = mergeSummary(summary, bullets, config.summaryMaxChars);
        const now = new Date().toISOString();
        const historyText = recentTurns.map((item) => JSON.stringify(item)).join("\n");

        await storage.appendHistoryArchive(oldTurns, { locked: true, archivedAt: now });
        await storage.writeTextWithLock("summary", merged);
        await storage.writeTextWithLock("history", historyText ? `${historyText}\n` : "");

        const currentState = await storage.readState();
        const nextState = {
          ...currentState,
          revision: (currentState.revision || 0) + 1,
          updatedAt: now,
          lastCompactedAt: now,
          compactCount: (currentState.compactCount || 0) + 1,
          lastPackTokens: countHistoryTokens(recentTurns) + estimateTokens(pins) + estimateTokens(merged),
        };
        await storage.writeTextWithLock("state", JSON.stringify(nextState, null, 2) + "\n");

        result = {
          compacted: true,
          beforeTokens: total,
          afterTokens: nextState.lastPackTokens,
          compactedTurns: oldTurns.length,
          keptTurns: recentTurns.length,
        };
      }
    }
  } finally {
    await storage.releaseLock(lock);
  }

  if (result?.compacted) {
    await storage.refreshManifest();
  }
  return result;
}
