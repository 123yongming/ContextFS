import { estimateTokens, estimateBlockTokens } from "./token.mjs";

const DEFAULT_COMPACT_MODEL = "Pro/Qwen/Qwen2.5-7B-Instruct";
const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1";

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function safeTrim(value) {
  return String(value || "").trim();
}

function normalizeBaseUrl(value, fallback = DEFAULT_BASE_URL) {
  const base = safeTrim(value) || fallback;
  return base.replace(/\/+$/, "");
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(code) {
  return code === 408 || code === 409 || code === 425 || code === 429 || (code >= 500 && code <= 599);
}

function isRetryableFetchError(err) {
  const name = String(err?.name || "").toLowerCase();
  const code = String(err?.code || "").toUpperCase();
  if (name === "aborterror") {
    return true;
  }
  return code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "EAI_AGAIN";
}

function sanitizeSummaryContent(text) {
  const source = String(text || "").trim();
  if (!source.startsWith("```")) {
    return source;
  }
  const withoutStart = source.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, "");
  return withoutStart.replace(/\n?```$/, "").trim();
}

function formatPromptTurn(turn, index) {
  const role = safeTrim(turn?.role || "unknown").toUpperCase() || "UNKNOWN";
  const text = String(turn?.text || "").replace(/\s+/g, " ").trim();
  const body = text.length <= 1200 ? text : `${text.slice(0, 1197)}...`;
  return `${index + 1}. [${role}] ${body}`;
}

function buildCompactPrompt(existingSummary, oldTurns, maxChars) {
  const turns = oldTurns.map((turn, idx) => formatPromptTurn(turn, idx)).join("\n");
  return [
    "You are a memory compaction assistant.",
    "Update the rolling summary by merging existing summary and newly archived conversation turns.",
    "Keep key facts, decisions, constraints, requirements, unresolved risks and todos.",
    "Deduplicate repeated points and keep concise wording.",
    `Output MUST be valid markdown summary no longer than ${maxChars} characters.`,
    "Output format:",
    "# Rolling Summary",
    "",
    "- bullet 1",
    "- bullet 2",
    "",
    "Do not output explanations, JSON, XML, or code fences.",
    "",
    "=== existing_summary ===",
    safeTrim(existingSummary) || "(empty)",
    "",
    "=== newly_archived_turns ===",
    turns || "(none)",
  ].join("\n");
}

function extractCompletionText(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const content = choice?.message?.content ?? choice?.text ?? "";
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

function normalizeSummaryFromModel(rawSummary, maxChars) {
  const safeMax = clampInt(maxChars, 3200, 256, 20000);
  const clean = sanitizeSummaryContent(rawSummary);
  if (!clean) {
    throw new Error("model returned empty summary");
  }

  const lines = clean
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const bullets = [];
  const seen = new Set();

  for (const line of lines) {
    if (/^#{1,6}\s+/i.test(line)) {
      continue;
    }
    const normalized = line
      .replace(/^[-*]\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    bullets.push(`- ${normalized}`);
  }

  const header = "# Rolling Summary\n\n";
  const body = bullets.join("\n") || "- init: no summary yet.";
  let summary = `${header}${body}\n`;
  if (summary.length <= safeMax) {
    return summary;
  }

  const bodyMax = Math.max(0, safeMax - header.length - 1);
  let clipped = body.slice(0, bodyMax).trim();
  if (clipped && !clipped.startsWith("- ")) {
    clipped = `- ${clipped.replace(/^-+\s*/, "")}`;
  }
  return `${header}${clipped || "- init: no summary yet."}\n`;
}

async function fetchCompactSummaryWithRetry({
  baseUrl,
  apiKey,
  model,
  prompt,
  timeoutMs,
  maxRetries,
}) {
  if (typeof fetch !== "function") {
    throw new Error("fetch is not available in this runtime");
  }
  const url = `${baseUrl}/chat/completions`;
  const body = JSON.stringify({
    model,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: "Generate concise rolling summaries for context compaction.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  let attempt = 0;
  while (attempt <= maxRetries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const text = safeTrim(await res.text());
        if (isRetryableStatus(res.status) && attempt < maxRetries) {
          await sleepMs(Math.min(3000, 250 * (2 ** attempt)));
          attempt += 1;
          continue;
        }
        throw new Error(`compact model request failed (${res.status}): ${text || "empty error body"}`);
      }
      return res.json();
    } catch (err) {
      clearTimeout(timer);
      if (attempt < maxRetries && isRetryableFetchError(err)) {
        await sleepMs(Math.min(3000, 250 * (2 ** attempt)));
        attempt += 1;
        continue;
      }
      const label = String(err?.name || "").toLowerCase() === "aborterror"
        ? `compact model request timeout after ${timeoutMs}ms`
        : String(err?.message || err);
      throw new Error(label);
    }
  }
  throw new Error("compact model request failed after retries");
}

async function buildCompactSummaryWithModel(existingSummary, oldTurns, config) {
  const model = safeTrim(config?.compactModel || process.env.CONTEXTFS_COMPACT_MODEL || DEFAULT_COMPACT_MODEL);
  const baseUrl = normalizeBaseUrl(config?.embeddingBaseUrl || process.env.CONTEXTFS_EMBEDDING_BASE_URL, DEFAULT_BASE_URL);
  const apiKey = safeTrim(config?.embeddingApiKey || process.env.CONTEXTFS_EMBEDDING_API_KEY);
  const timeoutMs = clampInt(config?.compactTimeoutMs, 20000, 1000, 120000);
  const maxRetries = clampInt(config?.compactMaxRetries, 2, 0, 10);

  if (!apiKey) {
    throw new Error("compact summary api key is missing (CONTEXTFS_EMBEDDING_API_KEY)");
  }
  if (!model) {
    throw new Error("compact summary model is missing (CONTEXTFS_COMPACT_MODEL)");
  }
  const prompt = buildCompactPrompt(existingSummary, oldTurns, config.summaryMaxChars);
  const payload = await fetchCompactSummaryWithRetry({
    baseUrl,
    apiKey,
    model,
    prompt,
    timeoutMs,
    maxRetries,
  });
  const content = extractCompletionText(payload);
  return normalizeSummaryFromModel(content, config.summaryMaxChars);
}

function turnToText(turn) {
  const role = String(turn.role || "unknown");
  const text = String(turn.text || "");
  return `${role}: ${text}`;
}

function countHistoryTokens(history) {
  return estimateBlockTokens(history.map(turnToText));
}

export async function maybeCompact(storage, config, force = false) {
  // Phase 1: Gather data and determine compaction need (under lock)
  let phase1Result;
  const lock1 = await storage.acquireLock();
  try {
    const history = await storage.readHistory({ migrate: false });
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
    const oldTurnIds = new Set(oldTurns.map((t) => t.id));
    phase1Result = {
      shouldCompact: true,
      total,
      oldTurns,
      recentTurns,
      oldTurnIds,
      summary,
      pins,
      keep,
    };

  } finally {
    await storage.releaseLock(lock1);
  }

  // Phase 2: External API call for summary generation (without lock)
  if (!phase1Result.oldTurns.length && !force) {
    return {
      compacted: false,
      beforeTokens: phase1Result.total,
      afterTokens: phase1Result.total,
      compactedTurns: 0,
    };
  }

  // Build merged summary outside of lock to avoid blocking concurrent writes
  let merged;
  if (phase1Result.oldTurns.length) {
    merged = await buildCompactSummaryWithModel(
      phase1Result.summary,
      phase1Result.oldTurns,
      config
    ).catch((err) => {
      throw new Error(`compact summary generation failed: ${String(err?.message || err)}`);
    });
  } else {
    merged = phase1Result.summary;
  }

  // Phase 3: Write results (under lock)
  const lock2 = await storage.acquireLock();
  try {
    // Re-read history to preserve any turns appended during Phase 2
    const currentHistory = await storage.readHistory({ migrate: false });
    const newTurnsDuringFetch = currentHistory.filter(
      (t) => !phase1Result.oldTurnIds.has(t.id)
    );

    const now = new Date().toISOString();
    const historyText = newTurnsDuringFetch.map((item) => JSON.stringify(item)).join("\n");

    await storage.appendHistoryArchive(phase1Result.oldTurns, { locked: true, archivedAt: now });
    await storage.writeTextWithLock("summary", merged);
    await storage.writeTextWithLock("history", historyText ? `${historyText}\n` : "");

    const currentPins = await storage.readText("pins");
    const currentState = await storage.readState();
    const nextState = {
      ...currentState,
      revision: (currentState.revision || 0) + 1,
      updatedAt: now,
      lastCompactedAt: now,
      compactCount: (currentState.compactCount || 0) + 1,
      lastPackTokens:
        countHistoryTokens(newTurnsDuringFetch) +
        estimateTokens(currentPins) +
        estimateTokens(merged),
    };
    await storage.writeTextWithLock("state", JSON.stringify(nextState, null, 2) + "\n");

    const result = {
      compacted: true,
      beforeTokens: phase1Result.total,
      afterTokens: nextState.lastPackTokens,
      compactedTurns: phase1Result.oldTurns.length,
      keptTurns: newTurnsDuringFetch.length,
    };

    return result;
  } finally {
    await storage.releaseLock(lock2);
  }
}
