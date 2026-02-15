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
import { runCtxCommand } from "../src/commands.mjs";

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
  const cjk = estimateTokens("\u4f60\u597d\u4e16\u754c");
  const mixed = estimateTokens(`hello ${"\u4f60\u597d"} world ${"\u4e16\u754c"}`);
  assert.ok(ascii > 0);
  assert.ok(cjk > 0);
  assert.ok(mixed >= ascii);
});

test("dedupePins removes exact and prefix-like duplicates", () => {
  const pins = [
    { text: "must not change OpenCode core architecture" },
    { text: "must not change OpenCode core architecture" },
    { text: "must not change OpenCode core architecture and contract" },
    { text: "do not introduce vector database" },
  ];
  const out = dedupePins(pins, 20);
  assert.ok(out.length <= 3);
  assert.ok(out.some((x) => x.text.includes("vector database")));
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
  const huge = mergeConfig({ packDelimiterStart: "S".repeat(400), packDelimiterEnd: "E".repeat(400) });
  assert.ok(huge.packDelimiterStart.length <= 128);
  assert.ok(huge.packDelimiterEnd.length <= 128);
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

test("updateHistoryEntryById keeps concurrent append and updates target atomically", async () => {
  await withTempStorage(async ({ storage }) => {
    await storage.appendHistory({
      role: "user",
      text: "seed-user",
      ts: "2026-02-12T00:00:00.000Z",
    });
    const target = await storage.appendHistory({
      role: "assistant",
      text: "seed-assistant",
      ts: "2026-02-12T00:00:01.000Z",
    });

    const originalWriteWithLock = storage.writeTextWithLock.bind(storage);
    storage.writeTextWithLock = async (name, content) => {
      if (name === "history") {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      return originalWriteWithLock(name, content);
    };

    const updateTask = storage.updateHistoryEntryById(target.id, {
      text: "updated-assistant",
      role: "assistant",
    });
    const appendTask = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await storage.appendHistory({
        role: "user",
        text: "concurrent-append",
        ts: "2026-02-12T00:00:02.000Z",
      });
    })();

    const [updated] = await Promise.all([updateTask, appendTask]);
    assert.ok(updated);
    assert.equal(updated.id, target.id);
    assert.equal(updated.text, "updated-assistant");

    const history = await storage.readHistory();
    assert.equal(history.length, 3);
    assert.equal(history.some((item) => item.id === target.id && item.text === "updated-assistant"), true);
    assert.equal(history.some((item) => item.text === "concurrent-append"), true);
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

test("compacted turns remain retrievable via archive fallback", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const localConfig = {
      ...config,
      recentTurns: 2,
      tokenThreshold: 1,
      autoCompact: true,
    };
    for (let i = 1; i <= 6; i += 1) {
      await storage.appendHistory({
        role: i % 2 ? "user" : "assistant",
        text: `archive-target-${i}`,
        ts: `2026-02-10T00:00:0${i}.000Z`,
      });
    }

    const before = await storage.readHistory();
    const archivedId = before[1].id;
    const result = await maybeCompact(storage, localConfig, true);
    assert.equal(result.compacted, true);

    const hot = await storage.readHistory();
    const archive = await storage.readHistoryArchive();
    const archiveIndex = await storage.readHistoryArchiveIndex();
    assert.equal(hot.some((item) => item.id === archivedId), false);
    assert.equal(archive.some((item) => item.id === archivedId), true);
    assert.equal(archiveIndex.some((item) => item.id === archivedId), true);

    const getOut = await runCtxCommand(`ctx get ${archivedId}`, storage, localConfig);
    assert.equal(getOut.ok, true);
    assert.ok(getOut.text.includes("\"source\": \"archive\""));
    assert.ok(getOut.text.includes("archive-target-2"));

    const timelineOut = await runCtxCommand(`ctx timeline ${archivedId} --before 1 --after 1`, storage, localConfig);
    assert.equal(timelineOut.ok, true);
    assert.ok(timelineOut.text.includes("archive |"));

    const searchOut = await runCtxCommand('ctx search "archive-target-2" --k 3 --scope all', storage, localConfig);
    assert.equal(searchOut.ok, true);
    assert.ok(searchOut.text.includes(archivedId));
    assert.ok(searchOut.text.includes("archive |"));

    const searchArchive = await runCtxCommand('ctx search "archive-target-2" --k 3 --scope archive', storage, localConfig);
    assert.equal(searchArchive.ok, true);
    assert.ok(searchArchive.text.includes(archivedId));
  });
});

test("ctx reindex rebuilds archive index and preserves archive search/timeline", async () => {
  await withTempStorage(async ({ storage, workspaceDir, config }) => {
    const localConfig = {
      ...config,
      recentTurns: 2,
      tokenThreshold: 1,
      autoCompact: true,
    };
    for (let i = 1; i <= 5; i += 1) {
      await storage.appendHistory({
        role: i % 2 ? "user" : "assistant",
        text: `reindex-target-${i}`,
        ts: `2026-02-10T01:00:0${i}.000Z`,
      });
    }
    await maybeCompact(storage, localConfig, true);

    const archive = await storage.readHistoryArchive();
    const targetId = archive[0].id;
    const indexPath = path.join(workspaceDir, ".contextfs", "history.archive.index.ndjson");
    await fs.writeFile(indexPath, "{\"id\":\"BROKEN\",\"summary\":\"bad\"}\n", "utf8");

    const reindexOut = await runCtxCommand("ctx reindex", storage, localConfig);
    assert.equal(reindexOut.ok, true);
    assert.ok(reindexOut.text.includes("reindex done"));

    const index = await storage.readHistoryArchiveIndex();
    assert.equal(index.some((item) => item.id === targetId), true);

    const searchOut = await runCtxCommand('ctx search "reindex-target-1" --k 3 --scope archive', storage, localConfig);
    assert.equal(searchOut.ok, true);
    assert.ok(searchOut.text.includes(targetId));

    const timelineOut = await runCtxCommand(`ctx timeline ${targetId} --before 0 --after 0`, storage, localConfig);
    assert.equal(timelineOut.ok, true);
    assert.ok(timelineOut.text.includes("archive |"));
  });
});

test("ctx reindex preserves raw duplicate archive ids for get/search consistency", async () => {
  await withTempStorage(async ({ storage, workspaceDir, config }) => {
    const archivePath = path.join(workspaceDir, ".contextfs", "history.archive.ndjson");
    const rowA = {
      id: "H-dup",
      ts: "2026-02-11T00:00:00.000Z",
      role: "user",
      type: "query",
      refs: [],
      text: "alpha duplicate",
    };
    const rowB = {
      id: "H-dup",
      ts: "2026-02-11T00:10:00.000Z",
      role: "assistant",
      type: "response",
      refs: [],
      text: "beta duplicate",
    };
    await fs.writeFile(archivePath, `${JSON.stringify(rowA)}\n${JSON.stringify(rowB)}\n`, "utf8");

    const reindexOut = await runCtxCommand("ctx reindex", storage, config);
    assert.equal(reindexOut.ok, true);

    const indexRaw = await storage.readText("historyArchiveIndex");
    assert.equal(indexRaw.includes("H-dup-1"), false);

    const search = await runCtxCommand('ctx search "duplicate" --scope archive --k 10 --json', storage, config);
    assert.equal(search.ok, true);
    const parsed = JSON.parse(search.text);
    assert.ok(parsed.results.every((item) => item.id === "H-dup"));

    const timeline = await runCtxCommand("ctx timeline H-dup --before 0 --after 0 --json", storage, config);
    assert.equal(timeline.ok, true);
    const timelineParsed = JSON.parse(timeline.text);
    assert.ok(Array.isArray(timelineParsed.results));
    assert.ok(timelineParsed.results.length >= 1);
    assert.ok(timelineParsed.results.every((item) => item.id === "H-dup"));

    const getRaw = await runCtxCommand("ctx get H-dup --json", storage, config);
    assert.equal(getRaw.ok, true);
    const getParsed = JSON.parse(getRaw.text);
    assert.equal(getParsed.record.id, "H-dup");
    assert.equal(getParsed.record.text, "beta duplicate");
  });
});

test("archive search finds semantically close cjk phrasing among many unrelated rows", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const localConfig = {
      ...config,
      recentTurns: 1,
      tokenThreshold: 1,
      autoCompact: true,
    };
    await storage.appendHistory({
      role: "user",
      text: "\u738b\u4fca\u51ef\u559c\u6b22\u6613\u70ca\u5343\u73ba",
      ts: "2026-02-11T03:00:00.000Z",
    });
    for (let i = 1; i <= 30; i += 1) {
      await storage.appendHistory({
        role: i % 2 ? "assistant" : "user",
        text: `unrelated-row-${i}`,
        ts: `2026-02-11T03:01:${String(i).padStart(2, "0")}.000Z`,
      });
    }
    await maybeCompact(storage, localConfig, true);

    const out = await runCtxCommand('ctx search "\u738b\u4fca\u51ef\u559c\u6b22\u8c01" --scope archive --k 5 --json', storage, localConfig);
    assert.equal(out.ok, true);
    const parsed = JSON.parse(out.text);
    assert.ok(parsed.hits >= 1);
    assert.ok(parsed.results.some((row) => String(row.summary || "").includes("\u738b\u4fca\u51ef\u559c\u6b22\u6613\u70ca\u5343\u73ba")));
  });
});

test("appendHistory writes normalized retrieval schema fields", async () => {
  await withTempStorage(async ({ storage }) => {
    await storage.appendHistory({
      role: "user",
      text: "open src/app.mjs and check https://example.com/issues/12 #42",
      ts: "2026-02-09T00:00:00.000Z",
    });

    const history = await storage.readHistory();
    assert.equal(history.length, 1);
    const row = history[0];
    assert.ok(typeof row.id === "string" && row.id.length >= 6);
    assert.equal(row.role, "user");
    assert.ok(typeof row.type === "string" && row.type.length > 0);
    assert.ok(Array.isArray(row.refs));
    assert.ok(row.refs.length >= 1);
    assert.equal(typeof row.text, "string");
  });
});

test("legacy history rows are normalized and retrievable via search/timeline/get", async () => {
  await withTempStorage(async ({ storage, workspaceDir, config }) => {
    const historyPath = path.join(workspaceDir, ".contextfs", "history.ndjson");
    const legacyRows = [
      JSON.stringify({ role: "user", text: "legacy alpha row", ts: "2026-02-09T00:00:01.000Z" }),
      JSON.stringify({ role: "assistant", text: "legacy beta row", ts: "2026-02-09T00:00:02.000Z" }),
      JSON.stringify({ text: "legacy gamma row without role", ts: "2026-02-09T00:00:03.000Z" }),
    ].join("\n");
    await fs.writeFile(historyPath, `${legacyRows}\n`, "utf8");

    const normalized = await storage.readHistory();
    assert.equal(normalized.length, 3);
    assert.ok(normalized.every((item) => typeof item.id === "string" && item.id));

    const anchorId = normalized[1].id;
    const search = await runCtxCommand('ctx search "legacy" --k 3', storage, config);
    assert.equal(search.ok, true);
    assert.ok(search.text.includes(anchorId));

    const timeline = await runCtxCommand(`ctx timeline ${anchorId} --before 1 --after 1`, storage, config);
    assert.equal(timeline.ok, true);
    assert.ok(timeline.text.includes(anchorId));

    const detail = await runCtxCommand(`ctx get ${anchorId}`, storage, config);
    assert.equal(detail.ok, true);
    assert.ok(detail.text.includes("legacy beta row"));
  });
});

test("legacy row without ts is stable across repeated reads and search->get", async () => {
  await withTempStorage(async ({ storage, workspaceDir, config }) => {
    const historyPath = path.join(workspaceDir, ".contextfs", "history.ndjson");
    const rows = [
      JSON.stringify({ role: "user", text: "no ts row A" }),
      JSON.stringify({ role: "assistant", text: "no ts row B" }),
    ].join("\n");
    await fs.writeFile(historyPath, `${rows}\n`, "utf8");

    const first = await storage.readHistory();
    const second = await storage.readHistory();
    assert.equal(first[0].id, second[0].id);
    assert.equal(first[0].ts, second[0].ts);

    const search = await runCtxCommand('ctx search "no ts row" --k 2', storage, config);
    assert.equal(search.ok, true);
    const hitLine = search.text.split("\n").find((line) => /^H-/.test(line));
    assert.ok(hitLine);
    const id = hitLine.split("|")[0].trim();
    const get = await runCtxCommand(`ctx get ${id}`, storage, config);
    assert.equal(get.ok, true);
  });
});

test("legacy row with bad ts is stable across repeated reads and search->get", async () => {
  await withTempStorage(async ({ storage, workspaceDir, config }) => {
    const historyPath = path.join(workspaceDir, ".contextfs", "history.ndjson");
    const rows = [
      JSON.stringify({ role: "user", text: "bad ts alpha", ts: "not-a-time" }),
      JSON.stringify({ role: "assistant", text: "bad ts beta", ts: "still-bad" }),
    ].join("\n");
    await fs.writeFile(historyPath, `${rows}\n`, "utf8");

    const first = await storage.readHistory();
    const second = await storage.readHistory();
    assert.equal(first[1].id, second[1].id);
    assert.equal(first[1].ts, second[1].ts);

    const search = await runCtxCommand('ctx search "bad ts beta" --k 1', storage, config);
    assert.equal(search.ok, true);
    const hitLine = search.text.split("\n").find((line) => /^H-/.test(line));
    assert.ok(hitLine);
    const id = hitLine.split("|")[0].trim();
    const get = await runCtxCommand(`ctx get ${id}`, storage, config);
    assert.equal(get.ok, true);
    assert.ok(get.text.includes("bad ts beta"));
  });
});

test("duplicate content rows produce unique ids after normalization", async () => {
  await withTempStorage(async ({ storage, workspaceDir }) => {
    const historyPath = path.join(workspaceDir, ".contextfs", "history.ndjson");
    const same = { role: "user", text: "duplicate row", ts: "2026-02-09T10:00:00.000Z" };
    await fs.writeFile(historyPath, `${JSON.stringify(same)}\n${JSON.stringify(same)}\n`, "utf8");

    const rows = await storage.readHistory();
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].id, rows[1].id);
    assert.ok(rows[1].id.startsWith(`${rows[0].id}-`) || rows[1].id.includes("-"));
  });
});

test("search and timeline outputs are bounded and do not dump full text", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const veryLong = `important-query ${"LONG".repeat(300)}`;
    await storage.appendHistory({ role: "user", text: veryLong, ts: "2026-02-09T00:01:00.000Z" });
    const row = (await storage.readHistory())[0];

    const search = await runCtxCommand('ctx search "important-query" --k 5', storage, config);
    assert.equal(search.ok, true);
    assert.ok(search.text.includes(row.id));
    assert.equal(search.text.includes("LONG".repeat(120)), false);

    const timeline = await runCtxCommand(`ctx timeline ${row.id} --before 0 --after 0`, storage, config);
    assert.equal(timeline.ok, true);
    assert.ok(timeline.text.includes(row.id));
    assert.equal(timeline.text.includes("LONG".repeat(120)), false);
  });
});

test("ctx search --json emits stable L0 row shape with bounded single-line summaries", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const veryLong = `important-query ${"LONG".repeat(300)}`;
    await storage.appendHistory({ role: "user", text: veryLong, ts: "2026-02-09T00:01:00.000Z" });

    const out = await runCtxCommand('ctx search "important-query" --k 3 --json', storage, config);
    assert.equal(out.ok, true);
    const parsed = JSON.parse(out.text);
    assert.equal(parsed.layer, "L0");
    assert.ok(Array.isArray(parsed.results));
    assert.ok(parsed.results.length >= 1);

    for (const row of parsed.results) {
      assert.equal(row.layer, "L0");
      assert.equal(typeof row.id, "string");
      assert.equal(typeof row.ts, "string");
      assert.equal(typeof row.type, "string");
      assert.equal(typeof row.summary, "string");
      assert.equal(typeof row.source, "string");
      assert.equal(row.summary.includes("\n"), false);
      assert.ok(row.summary.length <= config.searchSummaryMaxChars + 3);

      assert.ok(row.expand);
      assert.equal(typeof row.expand, "object");
      assert.ok(row.expand.timeline);
      assert.ok(row.expand.get);
      assert.equal(typeof row.expand.timeline.tokens_est, "number");
      assert.equal(typeof row.expand.timeline.size, "string");
      assert.equal(typeof row.expand.get.tokens_est, "number");
      assert.equal(typeof row.expand.get.size, "string");
    }
  });
});

test("ctx timeline --json emits stable L0 row shape", async () => {
  await withTempStorage(async ({ storage, config }) => {
    for (let i = 1; i <= 5; i += 1) {
      await storage.appendHistory({
        role: i % 2 ? "user" : "assistant",
        text: `timeline-json-row-${i} ${"Z".repeat(500)}`,
        ts: `2026-02-09T00:02:0${i}.000Z`,
      });
    }
    const history = await storage.readHistory();
    const anchor = history[2];

    const out = await runCtxCommand(`ctx timeline ${anchor.id} --before 1 --after 1 --json`, storage, config);
    assert.equal(out.ok, true);
    const parsed = JSON.parse(out.text);
    assert.equal(parsed.layer, "L0");
    assert.ok(Array.isArray(parsed.results));
    assert.ok(parsed.results.length >= 1);
    assert.ok(parsed.results.every((row) => row.layer === "L0"));
    assert.ok(parsed.results.every((row) => typeof row.summary === "string" && !row.summary.includes("\n")));
    assert.ok(parsed.results.every((row) => row.summary.length <= config.searchSummaryMaxChars + 3));
  });
});

test("buildContextPack workset recent turns are structured and bounded (L1 preview)", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const long = `workset-preview ${"Q".repeat(3000)}`;
    await storage.appendHistory({ role: "user", text: long, ts: "2026-02-09T00:00:00.000Z" });
    const pack = await buildContextPack(storage, config);
    assert.ok(pack.block.includes("### WORKSET_RECENT_TURNS"));
    assert.ok(pack.block.includes("| user |"));
    assert.equal(pack.block.includes("Q".repeat(400)), false);
  });
});

test("timeline window returns exact before/after neighborhood", async () => {
  await withTempStorage(async ({ storage, config }) => {
    for (let i = 1; i <= 7; i += 1) {
      await storage.appendHistory({
        role: i % 2 ? "user" : "assistant",
        text: `timeline-row-${i}`,
        ts: `2026-02-09T00:02:0${i}.000Z`,
      });
    }
    const history = await storage.readHistory();
    const anchor = history[3];

    const timeline = await runCtxCommand(`ctx timeline ${anchor.id} --before 1 --after 2`, storage, config);
    assert.equal(timeline.ok, true);
    assert.ok(timeline.text.includes("timeline-row-3"));
    assert.ok(timeline.text.includes("timeline-row-4"));
    assert.ok(timeline.text.includes("timeline-row-5"));
    assert.ok(timeline.text.includes("timeline-row-6"));
    assert.equal(timeline.text.includes("timeline-row-2"), false);
    assert.equal(timeline.text.includes("timeline-row-7"), false);
  });
});

test("buildContextPack enforces hard token threshold under extreme payloads", async () => {
  await withTempStorage(async ({ storage }) => {
    const config = mergeConfig({
      contextfsDir: ".contextfs",
      tokenThreshold: 380,
      recentTurns: 8,
      pinsMaxItems: 20,
      summaryMaxChars: 6000,
      manifestMaxLines: 60,
    });

    await storage.writeText(
      "pins",
      "# Pins (short, one line each)\n\n" +
        Array.from({ length: 16 }, (_, i) => `- [P-${String(i + 1).padStart(8, "0")}] pin-${"X".repeat(120)}`).join("\n") +
        "\n",
    );
    await storage.writeText("summary", `# Rolling Summary\n\n- ${"S".repeat(7000)}\n`);
    await storage.writeText(
      "manifest",
      Array.from({ length: 80 }, (_, i) => `- manifest-item-${i + 1}-${"M".repeat(50)}`).join("\n") + "\n",
    );
    for (let i = 1; i <= 12; i += 1) {
      await storage.appendHistory({
        role: i % 2 ? "user" : "assistant",
        text: `${"T".repeat(300)}-turn-${i}`,
        ts: `2026-02-09T00:03:${String(i).padStart(2, "0")}.000Z`,
      });
    }

    await storage.updateState({
      lastSearchIndex: Array.from({ length: 10 }, (_, i) => ({
        id: `H-dummy-${i + 1}`,
        ts: "2026-02-09T00:03:00.000Z",
        type: "query",
        summary: `dummy summary ${"Q".repeat(90)}`,
      })),
    });

    const pack = await buildContextPack(storage, config);
    assert.ok(pack.details.estimatedTokens <= config.tokenThreshold);
  });
});

test("ctx stats exposes retrieval and pack observability fields", async () => {
  await withTempStorage(async ({ storage, config }) => {
    await storage.appendHistory({ role: "user", text: "stats needle row", ts: "2026-02-09T00:04:00.000Z" });
    await runCtxCommand('ctx search "needle" --k 3', storage, config);
    const stats = await runCtxCommand("ctx stats", storage, config);
    assert.equal(stats.ok, true);
    assert.ok(stats.text.includes("estimated_tokens"));
    assert.ok(stats.text.includes("threshold"));
    assert.ok(stats.text.includes("compact_count"));
    assert.ok(stats.text.includes("last_search_hits"));
    assert.ok(stats.text.includes("workset_used"));
  });
});

test("ctx stats --json includes pack_breakdown with section token estimates", async () => {
  await withTempStorage(async ({ storage, config }) => {
    await storage.appendHistory({ role: "user", text: "stats breakdown row", ts: "2026-02-09T00:04:00.000Z" });
    const out = await runCtxCommand("ctx stats --json", storage, config);
    assert.equal(out.ok, true);
    const parsed = JSON.parse(out.text);
    assert.ok(parsed.pack_breakdown);
    const b = parsed.pack_breakdown;
    for (const key of [
      "pins_tokens",
      "summary_tokens",
      "manifest_tokens",
      "retrieval_index_tokens",
      "workset_recent_turns_tokens",
      "overhead_tokens",
      "total_tokens",
    ]) {
      assert.equal(typeof b[key], "number");
      assert.ok(Number.isFinite(b[key]));
      assert.ok(b[key] >= 0);
    }
    assert.equal(b.total_tokens, parsed.estimated_tokens);
  });
});

test("ctx get applies default head limit and json head keeps valid json", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const long = `head-limit-${"Z".repeat(5000)}`;
    await storage.appendHistory({ role: "user", text: long, ts: "2026-02-09T00:05:00.000Z" });
    const id = (await storage.readHistory())[0].id;

    const textGet = await runCtxCommand(`ctx get ${id}`, storage, config);
    assert.equal(textGet.ok, true);
    assert.ok(textGet.text.length <= config.getDefaultHead + 8);

    const jsonGet = await runCtxCommand(`ctx get ${id} --json --head 100`, storage, config);
    assert.equal(jsonGet.ok, true);
    const parsed = JSON.parse(jsonGet.text);
    assert.equal(parsed.truncated, true);
    if (parsed.record && typeof parsed.record.text === "string") {
      assert.ok(parsed.record.text.endsWith("..."));
      assert.ok(parsed.record.text.length <= 103);
      assert.ok(parsed.original_text_len > parsed.record.text.length);
    } else {
      assert.ok(parsed.note === "budget_too_small" || parsed.truncated === true);
    }
  });
});

test("concurrent searches keep accurate searchCount via atomic updateState", async () => {
  await withTempStorage(async ({ storage, config }) => {
    for (let i = 1; i <= 30; i += 1) {
      await storage.appendHistory({ role: "user", text: `needle-${i}`, ts: `2026-02-09T00:06:${String(i).padStart(2, "0")}.000Z` });
    }
    const runs = Array.from({ length: 20 }, () => runCtxCommand('ctx search "needle" --k 3', storage, config));
    const results = await Promise.all(runs);
    assert.ok(results.every((r) => r.ok));

    const state = await storage.readState();
    assert.equal(state.searchCount, 20);
  });
});

test("extreme delimiter with small threshold never exceeds token cap", async () => {
  await withTempStorage(async ({ storage }) => {
    const config = mergeConfig({
      contextfsDir: ".contextfs",
      tokenThreshold: 320,
      packDelimiterStart: "S".repeat(600),
      packDelimiterEnd: "E".repeat(600),
      summaryMaxChars: 5000,
      manifestMaxLines: 80,
      recentTurns: 10,
    });

    await storage.writeText("summary", `# Rolling Summary\n\n- ${"X".repeat(6000)}\n`);
    await storage.writeText("manifest", Array.from({ length: 120 }, (_, i) => `- item-${i}-${"Y".repeat(40)}`).join("\n") + "\n");
    for (let i = 0; i < 20; i += 1) {
      await storage.appendHistory({ role: "assistant", text: `${"T".repeat(180)}-${i}`, ts: `2026-02-09T00:07:${String(i).padStart(2, "0")}.000Z` });
    }

    const pack = await buildContextPack(storage, config);
    assert.ok(pack.details.estimatedTokens <= config.tokenThreshold);
  });
});

test("minimal mode sets workset_used to zero when workset is trimmed", async () => {
  await withTempStorage(async ({ storage }) => {
    const config = mergeConfig({
      contextfsDir: ".contextfs",
      tokenThreshold: 300,
      recentTurns: 10,
      summaryMaxChars: 7000,
      manifestMaxLines: 80,
    });

    await storage.writeText("summary", `# Rolling Summary\n\n- ${"S".repeat(9000)}\n`);
    await storage.writeText("manifest", Array.from({ length: 120 }, (_, i) => `- m-${i}-${"M".repeat(40)}`).join("\n") + "\n");
    for (let i = 1; i <= 25; i += 1) {
      await storage.appendHistory({ role: i % 2 ? "user" : "assistant", text: `${"W".repeat(220)}-${i}`, ts: `2026-02-09T00:08:${String(i).padStart(2, "0")}.000Z` });
    }

    const pack = await buildContextPack(storage, config);
    if (pack.block.includes("(trimmed)")) {
      assert.equal(pack.details.worksetUsed, 0);
      assert.equal(pack.details.recentTurns, 0);
      assert.equal(pack.details.retrievalIndexItems, 0);
    }
    assert.ok(pack.details.estimatedTokens <= config.tokenThreshold);
  });
});

test("ctx get --json --head tiny budgets (32/64) remain valid and bounded", async () => {
  await withTempStorage(async ({ storage, workspaceDir, config }) => {
    const historyPath = path.join(workspaceDir, ".contextfs", "history.ndjson");
    const hugeId = `H-${"ID".repeat(2500)}`;
    const hugeRefs = Array.from({ length: 200 }, (_, i) => `ref-${i}-${"R".repeat(500)}`);
    const hugeTags = Array.from({ length: 200 }, (_, i) => `tag-${i}-${"T".repeat(500)}`);
    const row = {
      id: hugeId,
      ts: "2026-02-09T10:00:00.000Z",
      role: "user",
      type: `type-${"X".repeat(2000)}`,
      refs: hugeRefs,
      tags: hugeTags,
      text: `body-${"Z".repeat(4000)}`,
    };
    await fs.writeFile(historyPath, `${JSON.stringify(row)}\n`, "utf8");

    for (const head of [32, 64]) {
      const out = await runCtxCommand(`ctx get ${hugeId} --json --head ${head}`, storage, config);
      assert.equal(out.ok, true);
      const parsed = JSON.parse(out.text);
      const bytes = Buffer.byteLength(out.text, "utf8");
      assert.ok(bytes <= head);
      if (parsed && parsed.note === "budget_too_small") {
        assert.ok(Object.hasOwn(parsed, "id"));
        assert.ok(Object.hasOwn(parsed, "truncated"));
        assert.ok(Object.hasOwn(parsed, "effective_head"));
        assert.ok(Object.hasOwn(parsed, "note"));
      }
    }
  });
});

test("readHistory migration bad-line quarantine is idempotent across repeated runs", async () => {
  await withTempStorage(async ({ storage, workspaceDir }) => {
    const contextDir = path.join(workspaceDir, ".contextfs");
    const historyPath = path.join(contextDir, "history.ndjson");
    const badPath = path.join(contextDir, "history.bad.ndjson");
    const good1 = JSON.stringify({ role: "user", text: "ok-1", ts: "2026-02-09T00:00:01.000Z" });
    const good2 = JSON.stringify({ role: "assistant", text: "ok-2", ts: "2026-02-09T00:00:02.000Z" });
    await fs.writeFile(historyPath, `${good1}\nNOT_JSON\n${good2}\n`, "utf8");

    const originalWriteTextWithLock = storage.writeTextWithLock.bind(storage);
    let injectedFailure = true;
    storage.writeTextWithLock = async (name, content) => {
      if (name === "state" && injectedFailure) {
        injectedFailure = false;
        const err = new Error("injected state write failure");
        err.code = "EIO";
        throw err;
      }
      return originalWriteTextWithLock(name, content);
    };

    const beforeState = await storage.readState();
    await assert.rejects(storage.readHistory());
    const rows1 = await storage.readHistory();
    const state1 = await storage.readState();
    const rows2 = await storage.readHistory();
    const state2 = await storage.readState();
    assert.equal(rows1.length, 2);
    assert.equal(rows2.length, 2);

    const badRaw = await fs.readFile(badPath, "utf8");
    const badEntries = badRaw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const matches = badEntries.filter((entry) => entry.line === "NOT_JSON");
    assert.equal(matches.length, 1);
    assert.equal(typeof matches[0].hash, "string");
    assert.ok(matches[0].hash.length > 0);
    const uniqueHashes = new Set(badEntries.map((entry) => entry.hash));
    assert.equal(uniqueHashes.size, badEntries.length);

    assert.equal((state1.badLineCount || 0), uniqueHashes.size);
    assert.equal((state2.badLineCount || 0), (state1.badLineCount || 0));
    assert.ok((state1.badLineCount || 0) >= (beforeState.badLineCount || 0));

    const rewritten = await fs.readFile(historyPath, "utf8");
    const rewrittenLines = rewritten.split("\n").filter(Boolean);
    assert.equal(rewrittenLines.length, 2);
  });
});
