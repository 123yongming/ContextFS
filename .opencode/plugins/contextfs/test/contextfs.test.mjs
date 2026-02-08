import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { estimateTokens } from "../src/token.mjs";
import { dedupePins } from "../src/pins.mjs";
import { mergeSummary } from "../src/summary.mjs";
import { mergeConfig } from "../src/config.mjs";
import { ContextFsStorage } from "../src/storage.mjs";

test("estimateTokens is stable and monotonic", () => {
  const a = estimateTokens("abcd");
  const b = estimateTokens("abcdefgh");
  const c = estimateTokens("abcdefgh1234");
  assert.equal(a, 1);
  assert.ok(b >= a);
  assert.ok(c >= b);
});

test("dedupePins removes exact and prefix-like duplicates", () => {
  const pins = [
    { text: "必须不改 OpenCode 核心架构" },
    { text: "必须不改 OpenCode 核心架构" },
    { text: "必须不改 OpenCode 核心架构和协议" },
    { text: "不要引入向量数据库" },
  ];
  const out = dedupePins(pins, 20);
  assert.ok(out.length <= 3);
  assert.ok(out.some((x) => x.text.includes("向量数据库")));
});

test("mergeSummary appends incrementally and stays bounded", () => {
  const oldSummary = "# Rolling Summary\n\n- [USER] first decision\n";
  const merged = mergeSummary(
    oldSummary,
    [
      "[USER] must keep plugin small",
      "[ASSISTANT] implemented compaction",
      "[USER] must keep plugin small",
    ],
    120,
  );
  assert.ok(merged.startsWith("# Rolling Summary"));
  assert.ok(merged.length <= 130);
  assert.ok(merged.includes("implemented compaction") || merged.includes("keep plugin small"));
});

async function withTempStorage(run) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextfs-test-"));
  const config = mergeConfig({ contextfsDir: ".contextfs" });
  const storage = new ContextFsStorage(workspaceDir, config);
  await storage.ensureInitialized();
  try {
    await run({ storage, config, workspaceDir });
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
}

test("appendHistory handles 15 concurrent writes without corrupting ndjson", async () => {
  await withTempStorage(async ({ storage, workspaceDir }) => {
    const writes = [];
    for (let i = 1; i <= 15; i += 1) {
      writes.push(
        storage.appendHistory({
          role: i % 2 ? "user" : "assistant",
          text: `concurrent-${i}`,
          ts: new Date().toISOString(),
        }),
      );
    }

    const settled = await Promise.allSettled(writes);
    const rejected = settled.filter((item) => item.status === "rejected").length;
    assert.equal(rejected, 0);

    const historyPath = path.join(workspaceDir, ".contextfs", "history.ndjson");
    const raw = await fs.readFile(historyPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    assert.equal(lines.length, 15);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  });
});

test("writeText replaces target atomically under concurrent writes", async () => {
  await withTempStorage(async ({ storage }) => {
    const payloadA = `BEGIN_A\n${"A".repeat(50000)}\nEND_A\n`;
    const payloadB = `BEGIN_B\n${"B".repeat(50000)}\nEND_B\n`;

    const writes = [];
    for (let i = 0; i < 12; i += 1) {
      writes.push(storage.writeText("summary", i % 2 === 0 ? payloadA : payloadB));
    }

    const settled = await Promise.allSettled(writes);
    const rejected = settled.filter((item) => item.status === "rejected").length;
    assert.equal(rejected, 0);

    const finalText = await storage.readText("summary");
    assert.ok(finalText === payloadA || finalText === payloadB);
  });
});

test("writeText waits for lock release and retries", async () => {
  await withTempStorage(async ({ storage, workspaceDir }) => {
    const lockPath = path.join(workspaceDir, ".contextfs", ".lock");
    await fs.writeFile(lockPath, "external-lock", "utf8");

    const started = Date.now();
    const pendingWrite = storage.writeText("summary", "# Rolling Summary\n\n- lock wait test\n");

    await new Promise((resolve) => setTimeout(resolve, 180));
    await fs.unlink(lockPath);

    await pendingWrite;
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 150);

    const text = await storage.readText("summary");
    assert.ok(text.includes("lock wait test"));
  });
});
