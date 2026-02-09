import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { estimateTokens } from "../src/token.mjs";
import { dedupePins } from "../src/pins.mjs";
import { mergeSummary } from "../src/summary.mjs";
import { buildContextPack } from "../src/packer.mjs";
import { maybeCompact } from "../src/compactor.mjs";
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

test("estimateTokens handles mixed ascii/cjk text with monotonic growth", () => {
  const ascii = estimateTokens("hello world");
  const cjk = estimateTokens("你好世界");
  const mixed = estimateTokens("hello 你好 world 世界");
  assert.ok(ascii > 0);
  assert.ok(cjk > 0);
  assert.ok(mixed >= ascii);
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

test("mergeConfig clamps invalid values and normalizes booleans", () => {
  const cfg = mergeConfig({
    recentTurns: -5,
    tokenThreshold: "oops",
    pinsMaxItems: 0,
    summaryMaxChars: 99,
    manifestMaxLines: 2,
    pinScanMaxChars: 12,
    lockStaleMs: 200,
    autoInject: "0",
    autoCompact: "1",
    debug: "true",
    packDelimiterStart: "XXX",
    packDelimiterEnd: "XXX",
  });
  assert.equal(cfg.recentTurns, 1);
  assert.equal(cfg.tokenThreshold, 8000);
  assert.equal(cfg.pinsMaxItems, 1);
  assert.equal(cfg.summaryMaxChars, 256);
  assert.equal(cfg.manifestMaxLines, 8);
  assert.equal(cfg.pinScanMaxChars, 256);
  assert.equal(cfg.lockStaleMs, 1000);
  assert.equal(cfg.autoInject, false);
  assert.equal(cfg.autoCompact, true);
  assert.equal(cfg.debug, true);
  assert.notEqual(cfg.packDelimiterStart, cfg.packDelimiterEnd);
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

test("buildContextPack sanitizes delimiters in pins/summary/manifest/turns", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const markerStart = config.packDelimiterStart;
    const markerEnd = config.packDelimiterEnd;

    await storage.writeText(
      "pins",
      `# Pins (short, one line each)\n\n- [P-11111111] pin contains ${markerStart} and ${markerEnd}\n`,
    );
    await storage.writeText("summary", `# Rolling Summary\n\n- summary ${markerStart} ${markerEnd}\n`);
    await storage.writeText("manifest", `- manifest ${markerStart} ${markerEnd}\n`);
    await storage.appendHistory({
      role: "assistant",
      text: `turn contains ${markerStart} and ${markerEnd}`,
      ts: new Date().toISOString(),
    });

    const pack = await buildContextPack(storage, config);
    const beginCount = (pack.block.match(new RegExp(markerStart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    const endCount = (pack.block.match(new RegExp(markerEnd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;

    assert.equal(beginCount, 1);
    assert.equal(endCount, 1);
    assert.ok(pack.block.includes("[[CONTEXTFS_BEGIN_ESCAPED]]"));
    assert.ok(pack.block.includes("[[CONTEXTFS_END_ESCAPED]]"));
  });
});

test("acquireLock removes stale lock and proceeds", async () => {
  await withTempStorage(async ({ storage, workspaceDir }) => {
    const lockPath = path.join(workspaceDir, ".contextfs", ".lock");
    await fs.writeFile(lockPath, "stale-lock", "utf8");
    const staleTime = new Date(Date.now() - 5000);
    await fs.utimes(lockPath, staleTime, staleTime);

    storage.config.lockStaleMs = 100;
    await storage.writeText("summary", "# Rolling Summary\n\n- stale lock recovered\n");
    const text = await storage.readText("summary");
    assert.ok(text.includes("stale lock recovered"));
  });
});

test("maybeCompact does not lose concurrent append", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const localConfig = { ...config, recentTurns: 2, tokenThreshold: 1, autoCompact: true };
    for (let i = 1; i <= 5; i += 1) {
      await storage.appendHistory({
        role: "user",
        text: `old-${i}`,
        ts: new Date().toISOString(),
      });
    }

    const originalWriteWithLock = storage.writeTextWithLock.bind(storage);
    storage.writeTextWithLock = async (name, content) => {
      if (name === "history") {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      return originalWriteWithLock(name, content);
    };

    const compactTask = maybeCompact(storage, localConfig, true);
    const appendTask = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await storage.appendHistory({
        role: "assistant",
        text: "NEW-APPEND",
        ts: new Date().toISOString(),
      });
    })();

    await Promise.all([compactTask, appendTask]);

    const history = await storage.readHistory();
    assert.ok(history.some((item) => item.text === "NEW-APPEND"));
  });
});
