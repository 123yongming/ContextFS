import { performance } from "node:perf_hooks";

import { loadContextFsEnv } from "../../.opencode/plugins/contextfs/src/env.mjs";
import { parseJudgePayload } from "./judge_schema.mjs";

const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = "Pro/Qwen/Qwen2.5-7B-Instruct";
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function safeTrim(value) {
  return String(value || "").trim();
}

function classifyHttpError(status) {
  if (status === 401 || status === 403) {
    return "auth_error";
  }
  if (status === 429) {
    return "rate_limit";
  }
  if (status >= 500) {
    return "server_error";
  }
  return "bad_request";
}

export async function resolveJudgeConfig(options = {}) {
  await loadContextFsEnv({ override: false });
  const baseUrl = safeTrim(options.baseUrl || process.env.CONTEXTFS_EMBEDDING_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiKey = safeTrim(options.apiKey || process.env.CONTEXTFS_EMBEDDING_API_KEY);
  const model = safeTrim(options.model || DEFAULT_MODEL);
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const maxRetries = Number.isFinite(Number(options.maxRetries)) ? Math.max(0, Math.floor(Number(options.maxRetries))) : DEFAULT_MAX_RETRIES;
  return {
    baseUrl,
    apiKey,
    model,
    timeoutMs,
    maxRetries,
  };
}

function buildJudgePrompt(sample) {
  const payload = {
    task_id: String(sample?.task_id || ""),
    user_task: String(sample?.user_task || ""),
    candidate_answer: String(sample?.candidate_answer || ""),
    evidence_ids: Array.isArray(sample?.evidence_ids) ? sample.evidence_ids.map((x) => String(x || "")) : [],
    required_facts: Array.isArray(sample?.required_facts) ? sample.required_facts.map((x) => String(x || "")) : [],
    rule_score: Number(sample?.rule_score || 0),
    rule_reasons: Array.isArray(sample?.rule_reasons) ? sample.rule_reasons.map((x) => String(x || "")) : [],
  };
  const evidence = new Set(payload.evidence_ids);
  const expectedMissing = payload.required_facts.filter((id) => !evidence.has(id));
  return [
    "You are an evaluation judge for retrieval-assisted task completion.",
    "Return STRICT JSON ONLY. No markdown, no prose outside JSON.",
    "Required keys: judge_score (number 0..1), verdict (pass|partial|fail), missing_facts (string[]), reasoning_brief (>=20 chars), confidence (number 0..1).",
    "Hard constraints:",
    "1) If verdict is partial or fail, missing_facts MUST be non-empty.",
    "2) missing_facts must be subset of required_facts.",
    "3) reasoning_brief must explain exactly what is missing and why score/verdict were assigned.",
    "4) If all required_facts are covered by evidence_ids, verdict should be pass.",
    "5) If only some required_facts are covered, verdict should be partial.",
    `Reference expected missing facts (computed): ${JSON.stringify(expectedMissing)}`,
    "",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

export async function judgeWithSiliconFlow(sample, options = {}) {
  const cfg = await resolveJudgeConfig(options);
  if (!cfg.apiKey) {
    return {
      ok: false,
      status: 0,
      error_type: "missing_api_key",
      error: "missing CONTEXTFS_EMBEDDING_API_KEY",
      latency_ms: 0,
      model: cfg.model,
      base_url: cfg.baseUrl,
    };
  }
  const url = `${cfg.baseUrl}/chat/completions`;
  const body = {
    model: cfg.model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: buildJudgePrompt(sample),
      },
    ],
  };

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt += 1) {
    const startedAt = performance.now();
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(new Error(`timeout ${cfg.timeoutMs}ms`)), cfg.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const latencyMs = performance.now() - startedAt;
      const text = await res.text();
      if (!res.ok) {
        const errorType = classifyHttpError(res.status);
        if ((res.status === 429 || res.status >= 500) && attempt < cfg.maxRetries) {
          await sleep(250 * (attempt + 1));
          continue;
        }
        return {
          ok: false,
          status: res.status,
          error_type: errorType,
          error: `http_${res.status}`,
          latency_ms: latencyMs,
          model: cfg.model,
          base_url: cfg.baseUrl,
        };
      }
      const parsed = JSON.parse(text);
      const content = String(parsed?.choices?.[0]?.message?.content || "");
      let judge;
      try {
        judge = parseJudgePayload(content, { minReasoningLength: 20, maxReasoningLength: 2000 });
      } catch (schemaErr) {
        if (attempt < cfg.maxRetries) {
          await sleep(250 * (attempt + 1));
          continue;
        }
        return {
          ok: false,
          status: res.status,
          error_type: "invalid_judge_output",
          error: String(schemaErr?.message || "invalid judge output").slice(0, 400),
          latency_ms: latencyMs,
          model: cfg.model,
          base_url: cfg.baseUrl,
        };
      }
      return {
        ok: true,
        status: res.status,
        latency_ms: latencyMs,
        model: cfg.model,
        base_url: cfg.baseUrl,
        judge,
      };
    } catch (err) {
      const latencyMs = performance.now() - startedAt;
      const message = String(err?.message || err || "request_failed");
      const errorType = message.toLowerCase().includes("timeout") ? "timeout" : "network_error";
      if (attempt < cfg.maxRetries) {
        await sleep(250 * (attempt + 1));
        continue;
      }
      return {
        ok: false,
        status: 0,
        error_type: errorType,
        error: message.slice(0, 400),
        latency_ms: latencyMs,
        model: cfg.model,
        base_url: cfg.baseUrl,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    ok: false,
    status: 0,
    error_type: "unknown_error",
    error: "judge failed after retries",
    latency_ms: 0,
    model: cfg.model,
    base_url: cfg.baseUrl,
  };
}
