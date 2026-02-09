#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { mergeConfig } from "../.opencode/plugins/contextfs/src/config.mjs";
import { ContextFsStorage } from "../.opencode/plugins/contextfs/src/storage.mjs";
import { buildContextPack } from "../.opencode/plugins/contextfs/src/packer.mjs";
import { maybeCompact } from "../.opencode/plugins/contextfs/src/compactor.mjs";
import { parseBenchArgs, createMulberry32, generateTurn } from "./lib/synth.mjs";
import { summarizeSeries, normalizeSummary } from "./lib/stats.mjs";

function buildSummary(params, metrics) {
  const packTokensPost = normalizeSummary({
    ...summarizeSeries(metrics.tokenSeriesPost),
    end: metrics.tokenSeriesPost[metrics.tokenSeriesPost.length - 1] || 0,
  });
  return {
    turns: params.turns,
    compact_count: metrics.compactCount,
    total_elapsed_ms: metrics.elapsedMs,
    lock_file_exists: metrics.lockExists,
    pack_tokens: packTokensPost,
    pack_tokens_pre: normalizeSummary({
      ...summarizeSeries(metrics.tokenSeriesPre),
      end: metrics.tokenSeriesPre[metrics.tokenSeriesPre.length - 1] || 0,
    }),
    pack_tokens_post: packTokensPost,
    turn_time: normalizeSummary(summarizeSeries(metrics.turnTimes)),
    pack_time: normalizeSummary(summarizeSeries(metrics.packTimes)),
    pack_build_time: normalizeSummary(summarizeSeries(metrics.packBuildTimes)),
    token_est_time: normalizeSummary(summarizeSeries(metrics.tokenEstTimes)),
    compact_time: normalizeSummary(summarizeSeries(metrics.compactTotalTimes)),
    compact_check_time: normalizeSummary(summarizeSeries(metrics.compactCheckTimes)),
    compact_total_time: normalizeSummary(summarizeSeries(metrics.compactTotalTimes)),
    io_time: normalizeSummary(summarizeSeries(metrics.ioTimes)),
    token_series_pre_compact: metrics.tokenSeriesPre,
    token_series_post_compact: metrics.tokenSeriesPost,
    token_series: metrics.tokenSeriesPost,
  };
}

export async function runContextFsBenchmark(params, options = {}) {
  const suffix = options.suffix || "";
  const outPath = path.join(params.outDir, `bench_results_contextfs${suffix}.jsonl`);
  await fs.mkdir(params.outDir, { recursive: true });

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "contextfs-bench-e2e-"));
  const configInput = {
    autoInject: true,
    autoCompact: true,
    contextfsDir: ".contextfs",
  };
  if (params.threshold != null) {
    configInput.tokenThreshold = params.threshold;
  }
  if (params.recentN != null) {
    configInput.recentTurns = params.recentN;
  }
  const config = mergeConfig(configInput);
  const storage = new ContextFsStorage(workspace, config);
  await storage.ensureInitialized();

  const rng = createMulberry32(params.seed);
  const lines = [];
  const turnTimes = [];
  const packTimes = [];
  const packBuildTimes = [];
  const tokenEstTimes = [];
  const ioTimes = [];
  const compactCheckTimes = [];
  const compactTotalTimes = [];
  const tokenSeriesPre = [];
  const tokenSeriesPost = [];
  let compactCount = 0;

  const startedAt = performance.now();
  try {
    for (let turn = 1; turn <= params.turns; turn += 1) {
      const turnStart = performance.now();
      const event = generateTurn(turn, rng, params.avgChars, params.variance, params.seed);

      const ioStart = performance.now();
      await storage.appendHistory(event);
      const ioMs = performance.now() - ioStart;

      const packBuildStart = performance.now();
      const pack = await buildContextPack(storage, config);
      const packBuildMs = performance.now() - packBuildStart;
      const tokenEstMs = 0;
      const preTokens = pack.details.estimatedTokens;

      const compactCheckStart = performance.now();
      const compactResult = await maybeCompact(storage, config, false);
      const compactCheckMs = performance.now() - compactCheckStart;

      const compacted = Boolean(compactResult?.compacted);
      const compactTotalMs = compactCheckMs;
      if (compacted) {
        compactCount += 1;
      }

      let postTokens = preTokens;
      if (compacted) {
        const postPack = await buildContextPack(storage, config);
        postTokens = postPack.details.estimatedTokens;
      }

      const packMs = packBuildMs + tokenEstMs;
      const turnMs = performance.now() - turnStart;

      lines.push(
        JSON.stringify({
          turn,
          pack_build_time_ms: packBuildMs,
          token_est_time_ms: tokenEstMs,
          pack_time_ms: packMs,
          compact_check_time_ms: compactCheckMs,
          compact_total_time_ms: compactTotalMs,
          compact_time_ms: compactTotalMs,
          io_time_ms: ioMs,
          turn_time_ms: turnMs,
          pack_est_tokens_pre_compact: preTokens,
          pack_est_tokens_post_compact: postTokens,
          pack_est_tokens: postTokens,
          compacted,
        }),
      );

      turnTimes.push(turnMs);
      packTimes.push(packMs);
      packBuildTimes.push(packBuildMs);
      tokenEstTimes.push(tokenEstMs);
      ioTimes.push(ioMs);
      compactCheckTimes.push(compactCheckMs);
      compactTotalTimes.push(compactTotalMs);
      tokenSeriesPre.push(preTokens);
      tokenSeriesPost.push(postTokens);
    }

    await fs.writeFile(outPath, `${lines.join("\n")}\n`, "utf8");

    const lockPath = path.join(workspace, config.contextfsDir, ".lock");
    let lockExists = false;
    try {
      await fs.access(lockPath);
      lockExists = true;
    } catch {
      lockExists = false;
    }

    const elapsedMs = performance.now() - startedAt;
    return {
      label: "contextfs",
      resultsPath: outPath,
      summary: buildSummary(params, {
        compactCount,
        elapsedMs,
        lockExists,
        turnTimes,
        packTimes,
        packBuildTimes,
        tokenEstTimes,
        ioTimes,
        compactCheckTimes,
        compactTotalTimes,
        tokenSeriesPre,
        tokenSeriesPost,
      }),
    };
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

async function main() {
  const params = parseBenchArgs(process.argv.slice(2));
  const result = await runContextFsBenchmark(params);
  console.log("# ContextFS E2E Benchmark Summary");
  console.log(JSON.stringify({ params, contextfs: result.summary, out: result.resultsPath }, null, 2));
}

const isMain = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;

if (isMain) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exitCode = 1;
  });
}
