#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseBenchArgs } from "./lib/synth.mjs";
import { runContextFsBenchmark } from "./bench_e2e.mjs";
import { runNaiveBenchmark } from "./bench_naive.mjs";
import { evaluateRetrieval } from "./eval_retrieval.mjs";
import { runTaskEval } from "./eval_task.mjs";

function parseArgs(argv = process.argv.slice(2)) {
  const base = parseBenchArgs(argv, {
    turns: 120,
    avgChars: 280,
    variance: 0.5,
    seed: 42,
    outDir: path.resolve("bench/results"),
  });
  const out = {
    ...base,
    judgeEnabled: true,
    judgeModel: "",
    judgeBaseUrl: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
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

async function runFullEval(params) {
  const outDir = path.resolve(params.outDir);
  await fs.mkdir(outDir, { recursive: true });
  const contextfs = await runContextFsBenchmark(params, { suffix: "_eval" });
  const naive = await runNaiveBenchmark(params, { suffix: "_eval" });
  const retrieval = await evaluateRetrieval(params);
  const task = await runTaskEval({
    ...params,
    judgeEnabled: params.judgeEnabled,
    judgeModel: params.judgeModel,
    judgeBaseUrl: params.judgeBaseUrl,
  });
  const summary = {
    generated_at: new Date().toISOString(),
    params,
    performance: {
      contextfs: contextfs.summary,
      naive: naive.summary,
    },
    retrieval: retrieval.summary,
    task: task.summary,
    artifacts: {
      contextfs: contextfs.resultsPath,
      naive: naive.resultsPath,
      retrieval_results: retrieval.artifacts.results,
      retrieval_summary: retrieval.artifacts.summary,
      task_results: task.artifacts.results,
      task_summary: task.artifacts.summary,
    },
  };
  const summaryPath = path.join(outDir, "final_eval_summary.json");
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return {
    summary,
    summaryPath,
  };
}

async function main() {
  const params = parseArgs(process.argv.slice(2));
  const output = await runFullEval(params);
  console.log("# Full Evaluation");
  console.log(JSON.stringify({
    summary: output.summary,
    summary_file: output.summaryPath,
  }, null, 2));
}

const isMain = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;

if (isMain) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exitCode = 1;
  });
}

export { runFullEval };
