function stripCodeFence(text) {
  const raw = String(text || "").trim();
  if (!raw.startsWith("```")) {
    return raw;
  }
  const lines = raw.split(/\r?\n/);
  if (lines.length < 2) {
    return raw.replace(/^```/, "").replace(/```$/, "").trim();
  }
  const body = lines.slice(1, lines[lines.length - 1] && lines[lines.length - 1].trim().startsWith("```") ? -1 : lines.length);
  return body.join("\n").trim();
}

function clamp01(value, fallback = NaN) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  if (n <= 0) {
    return 0;
  }
  if (n >= 1) {
    return 1;
  }
  return n;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeMissingFacts(value) {
  assert(Array.isArray(value), "missing_facts must be an array");
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const text = String(item || "").trim();
    if (!text) {
      continue;
    }
    if (!seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

export function parseJudgePayload(rawText, options = {}) {
  const text = stripCodeFence(rawText);
  const parsed = JSON.parse(text);
  const minReasoningLength = Math.max(1, Number(options.minReasoningLength) || 20);
  const maxReasoningLength = Math.max(minReasoningLength, Number(options.maxReasoningLength) || 2000);
  const verdictRaw = String(parsed?.verdict || "").toLowerCase();
  const verdict = verdictRaw === "pass" || verdictRaw === "partial" || verdictRaw === "fail" ? verdictRaw : "";
  assert(verdict, "verdict must be one of pass|partial|fail");
  const judgeScore = clamp01(parsed?.judge_score);
  assert(Number.isFinite(judgeScore), "judge_score must be number in [0,1]");
  const confidence = clamp01(parsed?.confidence);
  assert(Number.isFinite(confidence), "confidence must be number in [0,1]");
  const missingFacts = normalizeMissingFacts(parsed?.missing_facts);
  if (verdict !== "pass") {
    assert(missingFacts.length > 0, "missing_facts must be non-empty when verdict is partial/fail");
  }
  const reasoning = String(parsed?.reasoning_brief || "").trim();
  assert(reasoning.length >= minReasoningLength, `reasoning_brief must be at least ${minReasoningLength} chars`);
  return {
    judge_score: judgeScore,
    verdict,
    missing_facts: missingFacts,
    reasoning_brief: reasoning.slice(0, maxReasoningLength),
    confidence,
  };
}
