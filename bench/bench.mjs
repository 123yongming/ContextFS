#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

import { runContextFsBenchmark } from "./bench_e2e.mjs";
import { runNaiveBenchmark } from "./bench_naive.mjs";
import { parseBenchArgs } from "./lib/synth.mjs";
import { detectPlateauTurn, linearSlope, median, percentile, toFixed3 } from "./lib/stats.mjs";

function buildComparison(contextfs, naive) {
  const ctxSeries = contextfs.token_series_post_compact;
  const naiveSeries = naive.token_series_post_compact;
  const ctxSlope = linearSlope(ctxSeries);
  const naiveSlope = linearSlope(naiveSeries);
  const plateauTurn = detectPlateauTurn(ctxSeries);

  return {
    pack_tokens: {
      contextfs: {
        max: toFixed3(contextfs.pack_tokens.max),
        p95: toFixed3(percentile(ctxSeries, 95)),
      },
      naive: {
        max: toFixed3(naive.pack_tokens.max),
        p95: toFixed3(percentile(naiveSeries, 95)),
      },
    },
    turn_time: {
      contextfs_p95: toFixed3(contextfs.turn_time.p95),
      naive_p95: toFixed3(naive.turn_time.p95),
    },
    compact_count: {
      contextfs: contextfs.compact_count,
      naive: naive.compact_count,
    },
    total_elapsed_ms: {
      contextfs: toFixed3(contextfs.total_elapsed_ms),
      naive: toFixed3(naive.total_elapsed_ms),
      combined: toFixed3(contextfs.total_elapsed_ms + naive.total_elapsed_ms),
    },
    assertions: {
      naive_linear_growth: naiveSlope > 0,
      contextfs_plateau: plateauTurn > 0,
      slope_contextfs: toFixed3(ctxSlope),
      slope_naive: toFixed3(naiveSlope),
      plateau_turn: plateauTurn,
      no_lock_residue: !contextfs.lock_file_exists && !naive.lock_file_exists,
    },
  };
}

function medianComparison(comparisons) {
  const ctxPackMax = comparisons.map((x) => x.pack_tokens.contextfs.max);
  const naivePackMax = comparisons.map((x) => x.pack_tokens.naive.max);
  const ctxPackP95 = comparisons.map((x) => x.pack_tokens.contextfs.p95);
  const naivePackP95 = comparisons.map((x) => x.pack_tokens.naive.p95);
  const ctxTurnP95 = comparisons.map((x) => x.turn_time.contextfs_p95);
  const naiveTurnP95 = comparisons.map((x) => x.turn_time.naive_p95);
  const ctxCompactCount = comparisons.map((x) => x.compact_count.contextfs);
  const naiveCompactCount = comparisons.map((x) => x.compact_count.naive);
  const ctxElapsed = comparisons.map((x) => x.total_elapsed_ms.contextfs);
  const naiveElapsed = comparisons.map((x) => x.total_elapsed_ms.naive);
  const combinedElapsed = comparisons.map((x) => x.total_elapsed_ms.combined);
  const slopeCtx = comparisons.map((x) => x.assertions.slope_contextfs);
  const slopeNaive = comparisons.map((x) => x.assertions.slope_naive);
  const plateauTurn = comparisons.map((x) => x.assertions.plateau_turn).filter((x) => x > 0);

  return {
    pack_tokens: {
      contextfs: { max: toFixed3(median(ctxPackMax)), p95: toFixed3(median(ctxPackP95)) },
      naive: { max: toFixed3(median(naivePackMax)), p95: toFixed3(median(naivePackP95)) },
    },
    turn_time: {
      contextfs_p95: toFixed3(median(ctxTurnP95)),
      naive_p95: toFixed3(median(naiveTurnP95)),
    },
    compact_count: {
      contextfs: Math.round(median(ctxCompactCount)),
      naive: Math.round(median(naiveCompactCount)),
    },
    total_elapsed_ms: {
      contextfs: toFixed3(median(ctxElapsed)),
      naive: toFixed3(median(naiveElapsed)),
      combined: toFixed3(median(combinedElapsed)),
    },
    assertions: {
      naive_linear_growth: comparisons.every((x) => x.assertions.naive_linear_growth),
      contextfs_plateau: comparisons.every((x) => x.assertions.contextfs_plateau),
      slope_contextfs: toFixed3(median(slopeCtx)),
      slope_naive: toFixed3(median(slopeNaive)),
      plateau_turn: plateauTurn.length ? Math.round(median(plateauTurn)) : -1,
      no_lock_residue: comparisons.every((x) => x.assertions.no_lock_residue),
    },
  };
}

async function runPair(order, params, suffix) {
  if (order === "contextfs->naive") {
    const contextfs = await runContextFsBenchmark(params, { suffix });
    const naive = await runNaiveBenchmark(params, { suffix });
    return { order, contextfs, naive };
  }
  const naive = await runNaiveBenchmark(params, { suffix });
  const contextfs = await runContextFsBenchmark(params, { suffix });
  return { order, contextfs, naive };
}

function printCompare(params, comparison, runOrders) {
  const strategy = runOrders.length > 1 ? `median(${runOrders.join(", ")})` : runOrders[0];
  console.log("\n# ContextFS vs Naive\n");
  console.log(`- turns: ${params.turns}`);
  console.log(`- avgChars: ${params.avgChars}`);
  console.log(`- variance: ${params.variance}`);
  console.log(`- seed: ${params.seed}`);
  console.log(`- order_strategy: ${strategy}`);
  console.log("");
  console.log("| Metric | ContextFS | Naive |");
  console.log("|---|---:|---:|");
  console.log(`| pack_tokens max | ${comparison.pack_tokens.contextfs.max} | ${comparison.pack_tokens.naive.max} |`);
  console.log(`| pack_tokens p95 | ${comparison.pack_tokens.contextfs.p95} | ${comparison.pack_tokens.naive.p95} |`);
  console.log(`| turn_time p95(ms) | ${comparison.turn_time.contextfs_p95} | ${comparison.turn_time.naive_p95} |`);
  console.log(`| compact_count | ${comparison.compact_count.contextfs} | ${comparison.compact_count.naive} |`);
  console.log(`| total_elapsed_ms | ${comparison.total_elapsed_ms.contextfs} | ${comparison.total_elapsed_ms.naive} |`);
  console.log("");
  console.log(`- combined_elapsed_ms: ${comparison.total_elapsed_ms.combined}`);
  console.log(`- naive_linear_growth: ${comparison.assertions.naive_linear_growth}`);
  console.log(`- contextfs_plateau: ${comparison.assertions.contextfs_plateau}`);
  console.log(`- slope_naive: ${comparison.assertions.slope_naive}`);
  console.log(`- slope_contextfs: ${comparison.assertions.slope_contextfs}`);
  console.log(`- plateau_turn: ${comparison.assertions.plateau_turn}`);
  console.log(`- no_lock_residue: ${comparison.assertions.no_lock_residue}`);
}

async function main() {
  const params = parseBenchArgs(process.argv.slice(2));
  await fs.mkdir(params.outDir, { recursive: true });

  const runAB = await runPair("contextfs->naive", params, "_ab");
  const comparisonAB = buildComparison(runAB.contextfs.summary, runAB.naive.summary);
  let runBA = null;
  let comparisonBA = null;

  if (params.orders > 1) {
    runBA = await runPair("naive->contextfs", params, "_ba");
    comparisonBA = buildComparison(runBA.contextfs.summary, runBA.naive.summary);
  }

  const comparisons = [comparisonAB, ...(comparisonBA ? [comparisonBA] : [])];
  const comparison = {
    median_of_orders: medianComparison(comparisons),
  };

  const summaryPath = path.join(params.outDir, "bench_summary.json");
  const summary = {
    params,
    orders: {
      ab: {
        order: runAB.order,
        contextfs: runAB.contextfs.summary,
        naive: runAB.naive.summary,
        comparison: comparisonAB,
      },
      ba: runBA
        ? {
            order: runBA.order,
            contextfs: runBA.contextfs.summary,
            naive: runBA.naive.summary,
            comparison: comparisonBA,
          }
        : null,
    },
    comparison,
    artifacts: {
      contextfs_ab: path.join(params.outDir, "bench_results_contextfs_ab.jsonl"),
      naive_ab: path.join(params.outDir, "bench_results_naive_ab.jsonl"),
      contextfs_ba: runBA ? path.join(params.outDir, "bench_results_contextfs_ba.jsonl") : null,
      naive_ba: runBA ? path.join(params.outDir, "bench_results_naive_ba.jsonl") : null,
      summary: summaryPath,
    },
  };

  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  printCompare(params, comparison.median_of_orders, runBA ? [runAB.order, runBA.order] : [runAB.order]);
  console.log(`\n- summary_file: ${summaryPath}`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
