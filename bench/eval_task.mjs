#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { mergeConfig } from "../.opencode/plugins/contextfs/src/config.mjs";
import { runCtxCommandArgs } from "../.opencode/plugins/contextfs/src/commands.mjs";
import { loadContextFsEnv } from "../.opencode/plugins/contextfs/src/env.mjs";
import { ContextFsStorage } from "../.opencode/plugins/contextfs/src/storage.mjs";
import { judgeWithSiliconFlow } from "./lib/judge_client.mjs";
import { createMulberry32, deterministicTimestamp, parseBenchArgs } from "./lib/synth.mjs";
import { toFixed3 } from "./lib/stats.mjs";

function parseArgs(argv = process.argv.slice(2)) {
  const base = parseBenchArgs(argv, {
    turns: 120,
    avgChars: 260,
    variance: 0.4,
    seed: 42,
    outDir: path.resolve("bench/results"),
  });
  const out = {
    ...base,
    k: 3,
    judgeEnabled: true,
    judgeModel: "",
    judgeBaseUrl: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--k") {
      out.k = Math.max(1, Math.min(10, Math.floor(Number(value) || out.k)));
      i += 1;
      continue;
    }
    if (key === "--no-judge") {
      out.judgeEnabled = false;
      continue;
    }
    if (key === "--judge-model") {
      out.judgeModel = String(value || "").trim();
      i += 1;
      continue;
    }
    if (key === "--judge-base-url") {
      out.judgeBaseUrl = String(value || "").trim();
      i += 1;
    }
  }
  return out;
}

function buildTaskDataset(params) {
  const rng = createMulberry32(params.seed);
  const count = Math.max(10, Math.min(300, Math.floor(params.turns / 2)));
  const entries = [];
  const tasks = [];
  for (let i = 1; i <= count; i += 1) {
    const factA = `TFACT-${params.seed}-${i}-A`;
    const factB = `TFACT-${params.seed}-${i}-B`;
    const ts1 = deterministicTimestamp(params.seed, i * 2);
    const ts2 = deterministicTimestamp(params.seed, i * 2 + 1);
    const sessionId = `task-session-${1 + (i % 4)}`;
    entries.push({
      role: "assistant",
      type: "response",
      session_id: sessionId,
      text: `task_fact ${factA} context ${"alpha beta ".repeat(5 + Math.floor(rng() * 5))}`,
      ts: ts1,
    });
    entries.push({
      role: "assistant",
      type: "response",
      session_id: sessionId,
      text: `task_fact ${factB} context ${"gamma delta ".repeat(5 + Math.floor(rng() * 5))}`,
      ts: ts2,
    });
    tasks.push({
      id: `task-${i}`,
      user_task: `请总结 ${factA} 和 ${factB} 的要点`,
      query: `${factA} ${factB}`,
      required_fact_tokens: [factA, factB],
      required_facts: [],
      session_id: sessionId,
    });
  }
  return { entries, tasks };
}

function scoreRule(evidenceIds, requiredFacts) {
  const evidence = new Set((Array.isArray(evidenceIds) ? evidenceIds : []).map((x) => String(x || "")));
  const required = (Array.isArray(requiredFacts) ? requiredFacts : []).map((x) => String(x || ""));
  if (!required.length) {
    return {
      rule_score: 0,
      verdict: "fail",
      reasons: ["missing_required_facts"],
      missing_facts: [],
      needs_judge: false,
    };
  }
  let hit = 0;
  const missing = [];
  for (const id of required) {
    if (evidence.has(id)) {
      hit += 1;
    } else {
      missing.push(id);
    }
  }
  const ruleScore = hit / required.length;
  const verdict = ruleScore >= 0.99 ? "pass" : ruleScore > 0 ? "partial" : "fail";
  const needsJudge = ruleScore > 0 && ruleScore < 0.8;
  return {
    rule_score: toFixed3(ruleScore),
    verdict,
    reasons: [`rule_hit=${hit}/${required.length}`],
    missing_facts: missing,
    needs_judge: needsJudge,
  };
}

function finalizeScore(ruleResult, judgeResult) {
  if (!judgeResult?.ok || !judgeResult?.judge) {
    return {
      final_score: Number(ruleResult.rule_score || 0),
      final_verdict: ruleResult.verdict,
      judge_used: false,
    };
  }
  const score = 0.7 * Number(ruleResult.rule_score || 0) + 0.3 * Number(judgeResult.judge.judge_score || 0);
  const verdict = score >= 0.8 ? "pass" : score > 0.4 ? "partial" : "fail";
  return {
    final_score: toFixed3(score),
    final_verdict: verdict,
    judge_used: true,
  };
}

async function runTaskEval(params) {
  await loadContextFsEnv({ override: false });
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "contextfs-eval-task-"));
  const outDir = path.resolve(params.outDir);
  await fs.mkdir(outDir, { recursive: true });
  const config = mergeConfig({
    autoInject: true,
    autoCompact: false,
    contextfsDir: ".contextfs",
    retrievalMode: "hybrid",
    vectorEnabled: true,
  });
  const storage = new ContextFsStorage(workspace, config);
  const dataset = buildTaskDataset(params);
  const rows = [];
  const judgeStats = {
    total_calls: 0,
    success: 0,
    failures_by_type: {},
    latencies: [],
    model: "",
    base_url: "",
  };
  try {
    await storage.ensureInitialized();
    const idByToken = new Map();
    for (const entry of dataset.entries) {
      const saved = await storage.appendHistory(entry);
      const tokenMatch = String(entry.text || "").match(/TFACT-[^ ]+/g) || [];
      for (const token of tokenMatch) {
        if (saved?.id) {
          idByToken.set(token, saved.id);
        }
      }
    }
    for (const task of dataset.tasks) {
      task.required_facts = task.required_fact_tokens.map((token) => idByToken.get(token)).filter(Boolean);
      const result = await runCtxCommandArgs(
        ["ctx", "search", task.query, "--k", String(params.k), "--mode", "hybrid", "--session", task.session_id, "--json"],
        storage,
        config,
      );
      const parsed = result?.ok ? JSON.parse(String(result.text || "{}")) : {};
      const evidenceIds = Array.isArray(parsed?.results)
        ? parsed.results.map((x) => String(x?.id || "")).filter(Boolean)
        : [];
      const rule = scoreRule(evidenceIds, task.required_facts);
      let judge = null;
      if (params.judgeEnabled && rule.needs_judge) {
        judgeStats.total_calls += 1;
        judge = await judgeWithSiliconFlow(
          {
            task_id: task.id,
            user_task: task.user_task,
            candidate_answer: `Evidence IDs: ${evidenceIds.join(", ")}`,
            evidence_ids: evidenceIds,
            required_facts: task.required_facts,
            rule_score: rule.rule_score,
            rule_reasons: rule.reasons,
          },
          {
            model: params.judgeModel || undefined,
            baseUrl: params.judgeBaseUrl || undefined,
          },
        );
        judgeStats.model = judge?.model || judgeStats.model;
        judgeStats.base_url = judge?.base_url || judgeStats.base_url;
        if (judge?.ok) {
          judgeStats.success += 1;
          judgeStats.latencies.push(Number(judge.latency_ms || 0));
        } else {
          const errorType = String(judge?.error_type || "unknown_error");
          judgeStats.failures_by_type[errorType] = (judgeStats.failures_by_type[errorType] || 0) + 1;
        }
      }
      const final = finalizeScore(rule, judge);
      rows.push({
        task_id: task.id,
        user_task: task.user_task,
        query: task.query,
        required_facts: task.required_facts,
        evidence_ids: evidenceIds,
        rule,
        judge,
        final,
      });
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }

  const successCount = rows.filter((row) => String(row?.final?.final_verdict || "") === "pass").length;
  const partialCount = rows.filter((row) => String(row?.final?.final_verdict || "") === "partial").length;
  const missRate = rows.length
    ? rows.reduce((acc, row) => acc + (Array.isArray(row?.rule?.missing_facts) ? row.rule.missing_facts.length : 0), 0)
      / (rows.length * 2)
    : 0;
  judgeStats.latencies.sort((a, b) => a - b);
  const p95Idx = Math.min(judgeStats.latencies.length - 1, Math.max(0, Math.ceil(0.95 * judgeStats.latencies.length) - 1));
  const summary = {
    generated_at: new Date().toISOString(),
    params,
    tasks: rows.length,
    task_success_rate: toFixed3(successCount / Math.max(1, rows.length)),
    task_partial_rate: toFixed3(partialCount / Math.max(1, rows.length)),
    critical_fact_miss_rate: toFixed3(missRate),
    judge: {
      total_calls: judgeStats.total_calls,
      success_rate: toFixed3(judgeStats.success / Math.max(1, judgeStats.total_calls)),
      p95_latency_ms: toFixed3(judgeStats.latencies[p95Idx] || 0),
      failures_by_type: judgeStats.failures_by_type,
      model: judgeStats.model,
      base_url: judgeStats.base_url,
    },
  };

  const resultsPath = path.join(outDir, "task_eval_results.jsonl");
  const summaryPath = path.join(outDir, "task_eval_summary.json");
  await fs.writeFile(resultsPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return {
    rows,
    summary,
    artifacts: {
      results: resultsPath,
      summary: summaryPath,
    },
  };
}

async function main() {
  const params = parseArgs(process.argv.slice(2));
  const output = await runTaskEval(params);
  console.log("# Task Evaluation");
  console.log(JSON.stringify({
    summary: output.summary,
    artifacts: output.artifacts,
  }, null, 2));
}

const isMain = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;

if (isMain) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exitCode = 1;
  });
}

export { runTaskEval };
