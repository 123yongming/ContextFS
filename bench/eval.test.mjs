import assert from "node:assert/strict";
import test from "node:test";

import { aggregateModeRows, evaluateRanking } from "./lib/eval_metrics.mjs";
import { parseJudgePayload } from "./lib/judge_schema.mjs";

test("evaluateRanking computes recall/mrr/ndcg for binary relevance", () => {
  const out = evaluateRanking(["a", "b", "c"], ["b", "x"], 3);
  assert.equal(out.recall, 1);
  assert.equal(out.first_hit_rank, 2);
  assert.equal(out.mrr, 0.5);
  assert.ok(out.ndcg > 0 && out.ndcg <= 1);
});

test("aggregateModeRows summarizes latency and metrics", () => {
  const out = aggregateModeRows([
    { ok: true, latency_ms: 10, metrics: { recall: 1, mrr: 1, ndcg: 1 } },
    { ok: false, latency_ms: 20, metrics: { recall: 0, mrr: 0, ndcg: 0 } },
  ]);
  assert.equal(out.samples, 2);
  assert.equal(out.errors, 1);
  assert.equal(out.recall_at_k, 0.5);
  assert.equal(out.p95_latency_ms, 20);
});

test("parseJudgePayload accepts fenced json payload", () => {
  const raw = [
    "```json",
    "{\"judge_score\":0.8,\"verdict\":\"pass\",\"missing_facts\":[],\"reasoning_brief\":\"Coverage is complete and evidence aligns with required facts.\",\"confidence\":0.9}",
    "```",
  ].join("\n");
  const out = parseJudgePayload(raw);
  assert.equal(out.verdict, "pass");
  assert.equal(out.judge_score, 0.8);
  assert.equal(out.confidence, 0.9);
});

test("parseJudgePayload rejects partial verdict without missing facts", () => {
  const raw = JSON.stringify({
    judge_score: 0.5,
    verdict: "partial",
    missing_facts: [],
    reasoning_brief: "Some required facts are not covered, so score stays partial.",
    confidence: 0.7,
  });
  assert.throws(() => parseJudgePayload(raw), /missing_facts must be non-empty/i);
});
