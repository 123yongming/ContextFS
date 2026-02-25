#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { mergeConfig } from "../.opencode/plugins/contextfs/src/config.mjs";
import { runCtxCommandArgs } from "../.opencode/plugins/contextfs/src/commands.mjs";
import { loadContextFsEnv } from "../.opencode/plugins/contextfs/src/env.mjs";
import { ContextFsStorage } from "../.opencode/plugins/contextfs/src/storage.mjs";
import { aggregateModeRows, evaluateRanking } from "./lib/eval_metrics.mjs";
import { createMulberry32, deterministicTimestamp, parseBenchArgs } from "./lib/synth.mjs";

const MODES = ["legacy", "lexical", "vector", "hybrid", "fallback"];

function parseArgs(argv = process.argv.slice(2)) {
  const base = parseBenchArgs(argv, {
    turns: 150,
    avgChars: 280,
    variance: 0.5,
    seed: 42,
    outDir: path.resolve("bench/results"),
  });
  let k = 5;
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--k") {
      k = Math.max(1, Math.min(20, Math.floor(Number(value) || k)));
      i += 1;
    }
  }
  return {
    ...base,
    k,
  };
}

function pickModeRows(rows, mode) {
  return rows.filter((row) => String(row.mode || "") === String(mode));
}

function buildDataset(params) {
  const rng = createMulberry32(params.seed);
  const total = Math.max(20, Math.min(400, params.turns));
  const samples = [];
  const historyHot = [];
  const historyArchive = [];
  for (let i = 1; i <= total; i += 1) {
    const token = `RKEY-${params.seed}-${i}`;
    const text = [
      `retrieval_fact ${token}`,
      `topic=agent-memory`,
      `difficulty=${i % 5 === 0 ? "hard" : i % 3 === 0 ? "medium" : "easy"}`,
      `payload=${"alpha beta gamma ".repeat(8 + Math.floor(rng() * 4))}`,
    ].join(" ");
    const baseEntry = {
      role: i % 2 === 0 ? "assistant" : "user",
      type: i % 2 === 0 ? "response" : "query",
      text,
      ts: deterministicTimestamp(params.seed, i),
      session_id: `session-${1 + (i % 3)}`,
    };
    const sample = {
      id: `retrieval-${i}`,
      query: token,
      gold_ids: [],
      difficulty: i % 5 === 0 ? "hard" : i % 3 === 0 ? "medium" : "easy",
      session_id: baseEntry.session_id,
      source: i % 4 === 0 ? "archive" : "hot",
      seed_entry: baseEntry,
    };
    samples.push(sample);
    if (sample.source === "archive") {
      historyArchive.push(baseEntry);
    } else {
      historyHot.push(baseEntry);
    }
  }
  return {
    samples,
    historyHot,
    historyArchive,
  };
}

async function runMode(storage, config, mode, query, k) {
  const startedAt = performance.now();
  const result = await runCtxCommandArgs(["ctx", "search", query, "--k", String(k), "--mode", mode, "--json"], storage, config);
  const latencyMs = performance.now() - startedAt;
  if (!result?.ok) {
    return {
      ok: false,
      latency_ms: latencyMs,
      error: String(result?.text || "search_failed"),
      result_ids: [],
    };
  }
  const parsed = JSON.parse(String(result.text || "{}"));
  const ids = Array.isArray(parsed?.results) ? parsed.results.map((row) => String(row?.id || "")).filter(Boolean) : [];
  return {
    ok: true,
    latency_ms: latencyMs,
    error: "",
    result_ids: ids,
  };
}

async function evaluateRetrieval(params) {
  await loadContextFsEnv({ override: false });
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "contextfs-eval-retrieval-"));
  const outDir = path.resolve(params.outDir);
  await fs.mkdir(outDir, { recursive: true });
  const config = mergeConfig({
    autoInject: true,
    autoCompact: false,
    contextfsDir: ".contextfs",
    retrievalMode: "hybrid",
    vectorEnabled: true,
    vectorProvider: "siliconflow",
  });
  const storage = new ContextFsStorage(workspace, config);
  const dataset = buildDataset(params);
  const rows = [];
  try {
    await storage.ensureInitialized();
    for (const hot of dataset.historyHot) {
      const saved = await storage.appendHistory(hot);
      const sample = dataset.samples.find((item) => item.seed_entry === hot);
      if (sample && saved?.id) {
        sample.gold_ids = [saved.id];
      }
    }
    if (dataset.historyArchive.length) {
      const archived = await storage.appendHistoryArchive(dataset.historyArchive);
      for (let i = 0; i < archived.length; i += 1) {
        const source = dataset.historyArchive[i];
        const sample = dataset.samples.find((item) => item.seed_entry === source);
        if (sample && archived[i]?.id) {
          sample.gold_ids = [archived[i].id];
        }
      }
    }

    for (const sample of dataset.samples) {
      for (const mode of MODES) {
        const search = await runMode(storage, config, mode, sample.query, params.k);
        const metrics = evaluateRanking(search.result_ids, sample.gold_ids, params.k);
        rows.push({
          sample_id: sample.id,
          query: sample.query,
          mode,
          ok: search.ok,
          latency_ms: search.latency_ms,
          metrics,
          gold_ids: sample.gold_ids,
          result_ids: search.result_ids,
          error: search.error,
          source: sample.source,
          difficulty: sample.difficulty,
        });
      }
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }

  const summary = {
    generated_at: new Date().toISOString(),
    params: {
      ...params,
      modes: MODES,
    },
    dataset: {
      samples: dataset.samples.length,
      hot_samples: dataset.samples.filter((x) => x.source === "hot").length,
      archive_samples: dataset.samples.filter((x) => x.source === "archive").length,
    },
    modes: Object.fromEntries(MODES.map((mode) => [mode, aggregateModeRows(pickModeRows(rows, mode))])),
  };

  const resultsPath = path.join(outDir, "retrieval_eval_results.jsonl");
  const summaryPath = path.join(outDir, "retrieval_eval_summary.json");
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
  const output = await evaluateRetrieval(params);
  console.log("# Retrieval Evaluation");
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

export { evaluateRetrieval };
