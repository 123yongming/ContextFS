import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createMulberry32, generateTurn } from "./lib/synth.mjs";
import { runContextFsBenchmark } from "./bench_e2e.mjs";
import { runNaiveBenchmark } from "./bench_naive.mjs";

const execFileAsync = promisify(execFile);

function assertSameShape(a, b, prefix = "") {
  assert.equal(typeof a, typeof b, `type mismatch at ${prefix || "root"}`);
  if (a == null || b == null) {
    return;
  }
  if (Array.isArray(a)) {
    assert.ok(Array.isArray(b), `array mismatch at ${prefix || "root"}`);
    return;
  }
  if (typeof a === "object") {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    assert.deepEqual(aKeys, bKeys, `key mismatch at ${prefix || "root"}`);
    for (const key of aKeys) {
      assertSameShape(a[key], b[key], prefix ? `${prefix}.${key}` : key);
    }
  }
}

test("synth generation is deterministic for same seed", () => {
  const rngA = createMulberry32(42);
  const rngB = createMulberry32(42);
  const seqA = [];
  const seqB = [];
  for (let i = 1; i <= 5; i += 1) {
    seqA.push(generateTurn(i, rngA, 180, 0.4, 42));
    seqB.push(generateTurn(i, rngB, 180, 0.4, 42));
  }
  assert.deepEqual(seqA, seqB);
});

test("contextfs and naive summaries keep schema parity with nested keys/types", async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextfs-bench-test-parity-"));
  try {
    const params = {
      turns: 12,
      avgChars: 200,
      variance: 0.3,
      seed: 7,
      threshold: 900,
      recentN: 6,
      outDir,
    };
    const contextfs = await runContextFsBenchmark(params);
    const naive = await runNaiveBenchmark(params);
    assertSameShape(contextfs.summary, naive.summary);
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("timing fields are sane in jsonl outputs", async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextfs-bench-test-timing-"));
  try {
    const params = {
      turns: 10,
      avgChars: 220,
      variance: 0.35,
      seed: 11,
      threshold: 900,
      recentN: 6,
      outDir,
    };

    await runContextFsBenchmark(params);
    await runNaiveBenchmark(params);

    for (const fileName of ["bench_results_contextfs.jsonl", "bench_results_naive.jsonl"]) {
      const raw = await fs.readFile(path.join(outDir, fileName), "utf8");
      const lines = raw.trim().split("\n");
      assert.equal(lines.length, params.turns);
      for (const line of lines) {
        const row = JSON.parse(line);
        assert.ok(row.pack_build_time_ms >= 0);
        assert.ok(row.token_est_time_ms >= 0);
        assert.ok(row.pack_time_ms >= row.pack_build_time_ms);
        assert.ok(row.pack_time_ms >= row.token_est_time_ms);
        assert.ok(Math.abs(row.pack_time_ms - (row.pack_build_time_ms + row.token_est_time_ms)) < 1e-9);
        assert.ok(row.compact_check_time_ms >= row.compact_total_time_ms);
      }
    }
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("bench summary keeps orders blocks, median comparison, and row key parity", async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextfs-bench-test-orders-"));
  try {
    await execFileAsync("node", ["bench/bench.mjs", "--turns", "20", "--avgChars", "220", "--variance", "0.35", "--seed", "11", "--orders", "2", "--outDir", outDir], {
      cwd: path.join(process.cwd()),
    });

    const summary = JSON.parse(await fs.readFile(path.join(outDir, "bench_summary.json"), "utf8"));
    assert.ok(summary.orders?.ab);
    assert.ok(summary.orders?.ba);
    assert.ok(summary.comparison?.median_of_orders);
    assertSameShape(summary.orders.ab.comparison, summary.comparison.median_of_orders);
    assertSameShape(summary.orders.ba.comparison, summary.comparison.median_of_orders);

    const artifactKeys = Object.keys(summary.artifacts || {}).sort();
    assert.deepEqual(artifactKeys, [
      "contextfs_ab",
      "contextfs_ba",
      "naive_ab",
      "naive_ba",
      "summary",
    ]);

    const ctxLines = (await fs.readFile(summary.artifacts.contextfs_ab, "utf8")).trim().split("\n");
    const naiveLines = (await fs.readFile(summary.artifacts.naive_ab, "utf8")).trim().split("\n");
    const sample = Math.min(5, ctxLines.length, naiveLines.length);
    for (let i = 0; i < sample; i += 1) {
      const ctxKeys = Object.keys(JSON.parse(ctxLines[i])).sort();
      const naiveKeys = Object.keys(JSON.parse(naiveLines[i])).sort();
      assert.deepEqual(ctxKeys, naiveKeys);
    }
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
