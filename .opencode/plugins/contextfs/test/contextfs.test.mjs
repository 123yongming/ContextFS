import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { estimateTokens } from "../src/token.mjs";
import { dedupePins } from "../src/pins.mjs";
import { buildContextPack } from "../src/packer.mjs";
import { maybeCompact } from "../src/compactor.mjs";
import { mergeConfig } from "../src/config.mjs";
import { createEmbeddingProvider, hashEmbeddingText, normalizeEmbeddingText } from "../src/embedding.mjs";
import { loadContextFsEnv } from "../src/env.mjs";
import { ContextFsStorage } from "../src/storage.mjs";
import { runCtxCommand } from "../src/commands.mjs";
import { searchSqliteLexical, sqliteIndexDoctor, toSqliteTurnRow } from "../src/index/sqlite_store.mjs";
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
    retrievalMode: "bad",
    vectorEnabled: "0",
    vectorProvider: "unknown",
    vectorDim: 2,
    vectorTopN: 0,
    fusionRrfK: 9999,
    fusionCandidateMax: 0,
    embeddingTextMaxChars: 16,
    compactModel: "",
    compactTimeoutMs: 10,
    compactMaxRetries: 99,
    packDelimiterStart: "XXX",
    packDelimiterEnd: "XXX",
  });
  assert.equal(cfg.recentTurns, 1);
  assert.equal(cfg.tokenThreshold, 16000);
  assert.equal(cfg.pinsMaxItems, 1);
  assert.equal(cfg.summaryMaxChars, 256);
  assert.equal(cfg.manifestMaxLines, 8);
  assert.equal(cfg.pinScanMaxChars, 256);
  assert.equal(cfg.lockStaleMs, 1000);
  assert.equal(cfg.autoInject, false);
  assert.equal(cfg.autoCompact, true);
  assert.equal(cfg.debug, true);
  assert.equal(cfg.retrievalMode, "hybrid");
  assert.equal(cfg.vectorEnabled, false);
  assert.equal(cfg.vectorProvider, "fake");
  assert.equal(cfg.vectorDim, 8);
  assert.equal(cfg.vectorTopN, 1);
  assert.equal(cfg.fusionRrfK, 500);
  assert.equal(cfg.fusionCandidateMax, 1);
  assert.equal(cfg.embeddingTextMaxChars, 128);
  assert.equal(cfg.compactModel, "Pro/Qwen/Qwen2.5-7B-Instruct");
  assert.equal(cfg.compactTimeoutMs, 1000);
  assert.equal(cfg.compactMaxRetries, 10);
  assert.notEqual(cfg.packDelimiterStart, cfg.packDelimiterEnd);
  const huge = mergeConfig({ packDelimiterStart: "S".repeat(400), packDelimiterEnd: "E".repeat(400) });
  assert.ok(huge.packDelimiterStart.length <= 128);
  assert.ok(huge.packDelimiterEnd.length <= 128);
});

test("loadContextFsEnv reads .env style file and preserves existing vars", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextfs-env-test-"));
  const envPath = path.join(tmpDir, ".env");
  await fs.writeFile(envPath, [
    "CONTEXTFS_EMBEDDING_PROVIDER=siliconflow",
    "CONTEXTFS_EMBEDDING_MODEL=Pro/BAAI/bge-m3",
    "CONTEXTFS_EMBEDDING_BASE_URL=https://api.siliconflow.cn/v1",
    "CONTEXTFS_EMBEDDING_API_KEY=from_env_file",
    "CONTEXTFS_COMPACT_MODEL=Pro/Qwen/Qwen2.5-7B-Instruct",
  ].join("\n"), "utf8");
  const prevApiKey = process.env.CONTEXTFS_EMBEDDING_API_KEY;
  try {
    process.env.CONTEXTFS_EMBEDDING_API_KEY = "already_set";
    const loaded = await loadContextFsEnv({ path: envPath });
    assert.equal(loaded.loaded, true);
    assert.equal(process.env.CONTEXTFS_EMBEDDING_PROVIDER, "siliconflow");
    assert.equal(process.env.CONTEXTFS_EMBEDDING_MODEL, "Pro/BAAI/bge-m3");
    assert.equal(process.env.CONTEXTFS_EMBEDDING_API_KEY, "already_set");
    assert.equal(process.env.CONTEXTFS_COMPACT_MODEL, "Pro/Qwen/Qwen2.5-7B-Instruct");
  } finally {
    if (prevApiKey === undefined) {
      delete process.env.CONTEXTFS_EMBEDDING_API_KEY;
    } else {
      process.env.CONTEXTFS_EMBEDDING_API_KEY = prevApiKey;
    }
    delete process.env.CONTEXTFS_EMBEDDING_PROVIDER;
    delete process.env.CONTEXTFS_EMBEDDING_MODEL;
    delete process.env.CONTEXTFS_EMBEDDING_BASE_URL;
    delete process.env.CONTEXTFS_COMPACT_MODEL;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("siliconflow provider retries on 429 and returns normalized vectors", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        async text() {
          return "rate limited";
        },
      };
    }
    return {
      ok: true,
      async json() {
        return {
          model: "Pro/BAAI/bge-m3",
          data: [
            { embedding: [1, 0, 0] },
            { embedding: [0, 1, 0] },
          ],
        };
      },
    };
  };
  try {
    const cfg = mergeConfig({
      retrievalMode: "hybrid",
      vectorEnabled: true,
      vectorProvider: "siliconflow",
      embeddingApiKey: "test-key",
      embeddingModel: "Pro/BAAI/bge-m3",
      embeddingBatchSize: 8,
      embeddingMaxRetries: 2,
      embeddingTimeoutMs: 5000,
    });
    const provider = createEmbeddingProvider(cfg);
    const rows = await provider.embedTexts(["alpha", "beta"]);
    assert.equal(rows.length, 2);
    assert.equal(calls, 2);
    assert.ok(rows.every((row) => Array.isArray(row.vector) && row.vector.length === 3));
    assert.ok(rows.every((row) => String(row.embedding_version || "").startsWith("siliconflow:")));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("ctx search --mode lexical falls back gracefully when sqlite driver is unavailable", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const localConfig = mergeConfig({
      ...config,
      indexEnabled: true,
      retrievalMode: "lexical",
      vectorEnabled: false,
    });
    storage.config = localConfig;
    await storage.appendHistory({
      role: "user",
      text: "lexical sqlite fallback probe",
      ts: "2026-02-16T00:00:00.000Z",
    });
    const out = await runCtxCommand('ctx search "fallback probe" --k 3 --mode lexical --json', storage, localConfig);
    assert.equal(out.ok, true);
    const parsed = JSON.parse(out.text);
    assert.equal(parsed.retrieval.requested_mode, "lexical");
    assert.ok(Array.isArray(parsed.results));
    assert.ok(parsed.results.length >= 1);
    assert.ok(["legacy", "sqlite_fts5"].includes(String(parsed.retrieval.lexical_engine || "")));
  });
});

test("CONTEXT_LAYERS.md documents stable L0/L1/L2 contracts", async () => {
  const docUrl = new URL("../../../../CONTEXT_LAYERS.md", import.meta.url);
  const raw = await fs.readFile(docUrl, "utf8");
  assert.ok(raw.includes("L0"));
  assert.ok(raw.includes("L1"));
  assert.ok(raw.includes("L2"));
  assert.ok(raw.includes("L0 Row Schema"));
  assert.ok(raw.includes("Pack Section Order"));
  assert.ok(raw.includes("RETRIEVAL_INDEX"));
  assert.ok(raw.includes("ctx search --json"));
  assert.ok(raw.includes("ctx get --json"));
});

async function withTempStorage(run) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextfs-test-"));
  const config = mergeConfig({
    contextfsDir: ".contextfs",
    embeddingApiKey: "test-key",
    compactModel: "Pro/Qwen/Qwen2.5-7B-Instruct",
    compactTimeoutMs: 2000,
    compactMaxRetries: 0,
  });
  const storage = new ContextFsStorage(workspaceDir, config);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url || "");
    if (target.endsWith("/chat/completions")) {
      let prompt = "";
      try {
        const parsed = JSON.parse(String(init?.body || "{}"));
        prompt = String(parsed?.messages?.[1]?.content || "");
      } catch {
        prompt = "";
      }
      const compactLine = prompt
        .split("\n")
        .find((line) => line.includes("[USER]") || line.includes("[ASSISTANT]") || line.includes("[SYSTEM]"));
      const detail = compactLine ? compactLine.replace(/^\d+\.\s*/, "").trim() : "compacted by model";
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: `# Rolling Summary\n\n- compacted by external model\n- ${detail}\n`,
                },
              },
            ],
          };
        },
      };
    }
    if (typeof previousFetch === "function") {
      return previousFetch(url, init);
    }
    throw new Error(`unexpected fetch in test: ${target || "<empty>"}`);
  };
  await storage.ensureInitialized();
  try {
    await run({ storage, config, workspaceDir });
  } finally {
    globalThis.fetch = previousFetch;
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
}

async function hasSqliteDriver() {
  try {
    await import("better-sqlite3");
    return true;
  } catch {
    return false;
  }
}

test("toSqliteTurnRow keeps short summary but builds semantic-dense text_preview", () => {
  const longText = [
    "HEAD_MARKER",
    "A".repeat(480),
    "MIDDLE_MARKER",
    "B".repeat(480),
    "TAIL_MARKER",
  ].join(" ");

  const row = toSqliteTurnRow(
    {
      id: "H-preview-1",
      ts: "2026-02-22T00:00:00.000Z",
      role: "user",
      type: "query",
      text: longText,
    },
    "hot",
    {
      summaryMaxChars: 80,
      previewMaxChars: 220,
    },
  );

  assert.ok(row.summary.includes("HEAD_MARKER"));
  assert.equal(row.summary.includes("TAIL_MARKER"), false);
  assert.ok(row.text_preview.includes("HEAD_MARKER"));
  assert.ok(row.text_preview.includes("MIDDLE_MARKER"));
  assert.ok(row.text_preview.includes("TAIL_MARKER"));
  assert.ok(row.text_preview.length <= 223);
  assert.equal(row.text_preview.includes("\n"), false);
});

test("searchSqliteLexical can hit a tail token beyond preview head budget", async (t) => {
  if (!(await hasSqliteDriver())) {
    t.skip("better-sqlite3 unavailable in this environment");
    return;
  }
  await withTempStorage(async ({ storage, config, workspaceDir }) => {
    const localConfig = mergeConfig({
      ...config,
      embeddingTextMaxChars: 220,
      searchModeDefault: "lexical",
      retrievalMode: "lexical",
      vectorEnabled: false,
    });
    storage.config = localConfig;

    const uniqueTailToken = "UNIQUE_TAIL_TOKEN_9f7a1";
    const longText = [
      "HEAD_ALPHA",
      "X".repeat(900),
      "MIDDLE_BETA",
      "Y".repeat(900),
      uniqueTailToken,
    ].join(" ");

    const saved = await storage.appendHistory({
      role: "user",
      text: longText,
      ts: "2026-02-22T00:01:00.000Z",
    });

    const out = await searchSqliteLexical(workspaceDir, localConfig, {
      query: uniqueTailToken,
      k: 5,
      scope: "all",
    });
    if (!out.available) {
      t.skip(`sqlite lexical unavailable: ${String(out.reason || "unknown")}`);
      return;
    }
    assert.ok(out.rows.some((row) => String(row.id) === String(saved.id)));
  });
});

test("toSqliteTurnRow text_preview is deterministic and always within budget", () => {
  const src = `prefix ${"Z".repeat(3000)} suffix`;

  const rowA = toSqliteTurnRow(
    {
      id: "H-det-1",
      ts: "2026-02-22T00:02:00.000Z",
      role: "user",
      type: "query",
      text: src,
    },
    "hot",
    {
      summaryMaxChars: 100,
      previewMaxChars: 300,
    },
  );
  const rowB = toSqliteTurnRow(
    {
      id: "H-det-2",
      ts: "2026-02-22T00:02:01.000Z",
      role: "user",
      type: "query",
      text: src,
    },
    "hot",
    {
      summaryMaxChars: 100,
      previewMaxChars: 300,
    },
  );

  assert.equal(rowA.text_preview.length <= 303, true);
  assert.equal(rowA.text_preview.includes("\n"), false);
  assert.equal(rowA.text_preview, rowB.text_preview);
});

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

test("ensureInitialized creates index.sqlite when sqlite driver is available", async (t) => {
  if (!(await hasSqliteDriver())) {
    t.skip("better-sqlite3 unavailable in this environment");
    return;
  }
  await withTempStorage(async ({ workspaceDir }) => {
    const sqlitePath = path.join(workspaceDir, ".contextfs", "index.sqlite");
    assert.equal(await fileExists(sqlitePath), true);
  });
});

test("ensureInitialized backfills empty sqlite index from existing history without reindex", async (t) => {
  if (!(await hasSqliteDriver())) {
    t.skip("better-sqlite3 unavailable in this environment");
    return;
  }

  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextfs-bootstrap-test-"));
  const config = mergeConfig({
    contextfsDir: ".contextfs",
    indexEnabled: true,
    vectorEnabled: false,
  });
  const baseDir = path.join(workspaceDir, ".contextfs");
  const historyPath = path.join(baseDir, "history.ndjson");
  const archivePath = path.join(baseDir, "history.archive.ndjson");
  const storage = new ContextFsStorage(workspaceDir, config);

  try {
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(historyPath, [
      JSON.stringify({
        id: "H-hot-1",
        ts: "2026-02-20T00:00:00.000Z",
        role: "user",
        type: "query",
        refs: [],
        text: "hot turn before bootstrap",
      }),
      "",
    ].join("\n"), "utf8");
    await fs.writeFile(archivePath, [
      JSON.stringify({
        id: "H-archive-1",
        ts: "2026-02-19T23:59:59.000Z",
        role: "assistant",
        type: "response",
        refs: [],
        text: "archive turn before bootstrap",
      }),
      "",
    ].join("\n"), "utf8");

    await storage.ensureInitialized();
    const doctor = await sqliteIndexDoctor(workspaceDir, config);
    assert.equal(doctor.available, true);
    assert.ok(Number(doctor.turns || 0) >= 2);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test("appendHistory writes sqlite index incrementally without reindex", async (t) => {
  if (!(await hasSqliteDriver())) {
    t.skip("better-sqlite3 unavailable in this environment");
    return;
  }
  await withTempStorage(async ({ storage, workspaceDir, config }) => {
    await storage.appendHistory({
      role: "user",
      text: "incremental sqlite write one",
      ts: "2026-02-20T00:00:00.000Z",
    });
    await storage.appendHistory({
      role: "assistant",
      text: "incremental sqlite write two",
      ts: "2026-02-20T00:00:01.000Z",
    });
    const doctor = await sqliteIndexDoctor(workspaceDir, config);
    assert.equal(doctor.available, true);
    assert.ok(Number(doctor.turns || 0) >= 2);
  });
});

test("appendHistory keeps ndjson when sqlite upsert fails", async () => {
  await withTempStorage(async ({ storage }) => {
    const before = await storage.readHistory();
    const original = storage.tryUpsertSqliteRows;
    storage.tryUpsertSqliteRows = async () => {
      return { upserted: 0, available: false, reason: "forced_sqlite_failure" };
    };
    try {
      const saved = await storage.appendHistory({
        role: "user",
        text: "ndjson should persist on sqlite failure",
        ts: "2026-02-20T00:00:02.000Z",
      });
      assert.ok(saved);
    } finally {
      storage.tryUpsertSqliteRows = original;
    }
    const after = await storage.readHistory();
    assert.equal(after.length, before.length + 1);
    assert.equal(after.some((item) => String(item.text || "").includes("ndjson should persist on sqlite failure")), true);
  });
});

test("updateHistoryEntryById keeps ndjson update when sqlite upsert fails", async () => {
  await withTempStorage(async ({ storage }) => {
    await storage.appendHistory({
      role: "assistant",
      text: "original stable text",
      ts: "2026-02-20T00:00:03.000Z",
    });
    const history = await storage.readHistory();
    const target = history[0];
    const original = storage.tryUpsertSqliteRows;
    storage.tryUpsertSqliteRows = async () => {
      return { upserted: 0, available: false, reason: "forced_sqlite_failure" };
    };
    try {
      const updated = await storage.updateHistoryEntryById(target.id, {
        text: "mutated text should persist",
      });
      assert.ok(updated);
    } finally {
      storage.tryUpsertSqliteRows = original;
    }
    const after = await storage.readHistory();
    const persisted = after.find((item) => String(item.id) === String(target.id));
    assert.ok(persisted);
    assert.equal(persisted.text, "mutated text should persist");
  });
});

test("appendHistoryArchive keeps archive ndjson when sqlite upsert fails", async () => {
  await withTempStorage(async ({ storage }) => {
    const archiveBefore = await storage.readHistoryArchive();
    const original = storage.tryUpsertSqliteRows;
    storage.tryUpsertSqliteRows = async () => {
      return { upserted: 0, available: false, reason: "forced_sqlite_failure" };
    };
    try {
      const appended = await storage.appendHistoryArchive([
        {
          role: "user",
          text: "archive ndjson should persist on sqlite failure",
          ts: "2026-02-20T00:00:04.000Z",
        },
      ]);
      assert.equal(appended.length, 1);
    } finally {
      storage.tryUpsertSqliteRows = original;
    }
    const archiveAfter = await storage.readHistoryArchive();
    assert.equal(archiveAfter.length, archiveBefore.length + 1);
    assert.equal(archiveAfter.some((item) => String(item.text || "").includes("archive ndjson should persist on sqlite failure")), true);
  });
});

test("ensureInitialized auto-recovers sqlite vector table from embedding index without reindex", async (t) => {
  if (!(await hasSqliteDriver())) {
    t.skip("better-sqlite3 unavailable in this environment");
    return;
  }
  await withTempStorage(async ({ storage, workspaceDir, config }) => {
    const localConfig = mergeConfig({
      ...config,
      indexEnabled: true,
      retrievalMode: "hybrid",
      vectorEnabled: true,
      vectorProvider: "fake",
    });
    storage.config = localConfig;

    await storage.appendHistory({
      role: "user",
      text: "vector recover user",
      ts: "2026-02-20T00:00:00.000Z",
    });
    await storage.appendHistory({
      role: "assistant",
      text: "vector recover assistant",
      ts: "2026-02-20T00:00:01.000Z",
    });

    const before = await sqliteIndexDoctor(workspaceDir, localConfig);
    if (!before.vector?.available) {
      t.skip("sqlite-vec unavailable in this environment");
      return;
    }
    assert.ok(Number(before.vector.rows || 0) >= 2);

    const sqlitePath = path.join(workspaceDir, ".contextfs", "index.sqlite");
    const walPath = `${sqlitePath}-wal`;
    const shmPath = `${sqlitePath}-shm`;
    await fs.rm(sqlitePath, { force: true });
    await fs.rm(walPath, { force: true });
    await fs.rm(shmPath, { force: true });

    await storage.ensureInitialized();
    const after = await sqliteIndexDoctor(workspaceDir, localConfig);
    assert.equal(after.available, true);
    assert.equal(after.vector?.available, true);
    assert.ok(Number(after.vector?.rows || 0) >= 2);
  });
});

test("ensureInitialized backfills sqlite turns when index lags behind history", async (t) => {
  if (!(await hasSqliteDriver())) {
    t.skip("better-sqlite3 unavailable in this environment");
    return;
  }
  await withTempStorage(async ({ storage, workspaceDir, config }) => {
    const localConfig = mergeConfig({
      ...config,
      indexEnabled: true,
      retrievalMode: "hybrid",
      vectorEnabled: true,
      vectorProvider: "fake",
    });
    storage.config = localConfig;

    for (let i = 0; i < 5; i += 1) {
      await storage.appendHistory({
        role: i % 2 ? "assistant" : "user",
        text: `sqlite lag row ${i}`,
        ts: `2026-02-20T00:00:0${i}.000Z`,
      });
    }

    const before = await sqliteIndexDoctor(workspaceDir, localConfig);
    assert.equal(before.available, true);
    assert.ok(Number(before.turns || 0) >= 5);

    const mod = await import("better-sqlite3");
    const Driver = mod.default || mod;
    const db = new Driver(path.join(workspaceDir, ".contextfs", "index.sqlite"));
    try {
      db.exec("DELETE FROM turns WHERE id IN (SELECT id FROM turns ORDER BY ts DESC LIMIT 2)");
      db.exec("DELETE FROM turns_fts WHERE id NOT IN (SELECT id FROM turns)");
    } finally {
      db.close();
    }

    const lagged = await sqliteIndexDoctor(workspaceDir, localConfig);
    assert.equal(lagged.available, true);
    assert.ok(Number(lagged.turns || 0) < 5);

    await storage.ensureInitialized();
    const healed = await sqliteIndexDoctor(workspaceDir, localConfig);
    assert.equal(healed.available, true);
    assert.ok(Number(healed.turns || 0) >= 5);
    assert.equal(Number(healed.turns || 0), Number(healed.turns_fts || -1));
  });
});

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

test("appendHistory and compaction keep embedding hot/archive indexes deduped", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const localConfig = mergeConfig({
      ...config,
      recentTurns: 1,
      tokenThreshold: 1,
      autoCompact: true,
      vectorEnabled: true,
      vectorProvider: "fake",
      retrievalMode: "hybrid",
    });
    storage.config = localConfig;

    await storage.appendHistory({
      role: "user",
      text: "embedding row one",
      ts: "2026-02-12T00:00:00.000Z",
      session_id: "S-EMB",
    });
    await storage.appendHistory({
      role: "assistant",
      text: "embedding row two",
      ts: "2026-02-12T00:00:01.000Z",
      session_id: "S-EMB",
    });

    const hotBefore = await storage.readHistoryEmbeddingHot();
    const archiveBefore = await storage.readHistoryEmbeddingArchive();
    assert.ok(hotBefore.length >= 2);
    assert.equal(archiveBefore.length, 0);
    assert.ok(hotBefore.every((row) => Array.isArray(row.vec) && row.vec.length === row.dim));

    await maybeCompact(storage, localConfig, true);
    const hotAfter = await storage.readHistoryEmbeddingHot();
    const archiveAfter = await storage.readHistoryEmbeddingArchive();
    assert.ok(archiveAfter.length >= 1);
    const hotIds = new Set(hotAfter.map((row) => String(row.id)));
    const archiveIds = new Set(archiveAfter.map((row) => String(row.id)));
    assert.equal(Array.from(hotIds).some((id) => archiveIds.has(id)), false);

    await maybeCompact(storage, localConfig, true);
    const hotAfterSecondCompact = await storage.readHistoryEmbeddingHot();
    const archiveAfterSecondCompact = await storage.readHistoryEmbeddingArchive();
    assert.equal(hotAfterSecondCompact.length, hotAfter.length);
    assert.equal(archiveAfterSecondCompact.length, archiveAfter.length);
  });
});

test("embedding hot/archive readers ignore malformed rows and archive wins on same id", async () => {
  await withTempStorage(async ({ storage, workspaceDir }) => {
    const hotPath = path.join(workspaceDir, ".contextfs", "history.embedding.hot.ndjson");
    const archivePath = path.join(workspaceDir, ".contextfs", "history.embedding.archive.ndjson");
    const hotOld = {
      id: "H-dup",
      ts: "2026-02-12T00:00:00.000Z",
      source: "hot",
      model: "fake-hot-old",
      dim: 4,
      text_hash: "abc",
      vec: [1, 0, 0, 0],
    };
    const hotNew = {
      id: "H-dup",
      ts: "2026-02-12T00:00:01.000Z",
      source: "hot",
      model: "fake-hot-new",
      dim: 4,
      text_hash: "abc2",
      vec: [0, 0, 1, 0],
    };
    const archiveRow = {
      id: "H-dup",
      ts: "2026-02-12T00:00:02.000Z",
      source: "archive",
      model: "fake-archive",
      dim: 4,
      text_hash: "def",
      vec: [0, 1, 0, 0],
    };
    const archiveOnly = {
      id: "H-archive-only",
      ts: "2026-02-12T00:00:03.000Z",
      source: "archive",
      model: "fake-archive",
      dim: 4,
      text_hash: "ghi",
      vec: [0, 0, 0, 1],
    };
    await fs.writeFile(hotPath, `${JSON.stringify(hotOld)}\nNOT_JSON\n${JSON.stringify(hotNew)}\n`, "utf8");
    await fs.writeFile(archivePath, `${JSON.stringify(archiveRow)}\nNOT_JSON\n${JSON.stringify(archiveOnly)}\n`, "utf8");

    const hotRows = await storage.readHistoryEmbeddingHot();
    assert.equal(hotRows.length, 1);
    assert.equal(hotRows[0].id, "H-dup");
    assert.equal(hotRows[0].model, "fake-hot-new");
    assert.equal(hotRows[0].source, "hot");

    const rows = await storage.readHistoryEmbeddingView("all");
    assert.equal(rows.length, 2);
    const dedup = rows.find((item) => item.id === "H-dup");
    assert.equal(dedup?.model, "fake-archive");
    assert.equal(dedup?.source, "archive");
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

test("maybeCompact throws when external compact summary request fails", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const localConfig = { ...config, recentTurns: 1, tokenThreshold: 1, autoCompact: true };
    await storage.writeText("summary", "# Rolling Summary\n\n- keep-original-summary\n");
    for (let i = 1; i <= 3; i += 1) {
      await storage.appendHistory({
        role: i % 2 ? "user" : "assistant",
        text: `failure-case-${i}`,
        ts: new Date().toISOString(),
      });
    }

    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const target = String(url || "");
      if (target.endsWith("/chat/completions")) {
        return {
          ok: false,
          status: 500,
          async text() {
            return "compact endpoint down";
          },
        };
      }
      if (typeof previousFetch === "function") {
        return previousFetch(url, init);
      }
      throw new Error(`unexpected fetch in test: ${target || "<empty>"}`);
    };

    try {
      await assert.rejects(
        maybeCompact(storage, localConfig, true),
        /compact summary generation failed/i,
      );
    } finally {
      globalThis.fetch = previousFetch;
    }

    const summary = await storage.readText("summary");
    const archive = await storage.readHistoryArchive();
    const history = await storage.readHistory();
    assert.ok(summary.includes("keep-original-summary"));
    assert.equal(archive.length, 0);
    assert.equal(history.length, 3);
  });
});

test("maybeCompact preserves turns appended during slow external API call", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const localConfig = { ...config, recentTurns: 2, tokenThreshold: 1, autoCompact: true };
    for (let i = 1; i <= 5; i += 1) {
      await storage.appendHistory({
        role: "user",
        text: `old-${i}`,
        ts: new Date().toISOString(),
      });
    }

    // Mock slow external API call
    const previousFetch = globalThis.fetch;
    let fetchStarted = false;
    globalThis.fetch = async (url, init) => {
      const target = String(url || "");
      if (target.endsWith("/chat/completions")) {
        fetchStarted = true;
        // Simulate slow API - 600ms delay
        await new Promise((resolve) => setTimeout(resolve, 600));
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              choices: [{ message: { content: "- compacted summary" } }],
            };
          },
        };
      }
      if (typeof previousFetch === "function") {
        return previousFetch(url, init);
      }
      throw new Error(`unexpected fetch in test: ${target || "<empty>"}`);
    };

    let compactPromise;
    try {
      compactPromise = maybeCompact(storage, localConfig, true);

      // Wait for fetch to start, then append during the slow API call
      await new Promise((resolve) => {
        const check = () => {
          if (fetchStarted) resolve();
          else setTimeout(check, 10);
        };
        check();
      });

      // Append a new turn while the external API is still processing
      await storage.appendHistory({
        role: "assistant",
        text: "NEW-DURING-FETCH",
        ts: new Date().toISOString(),
      });

      await compactPromise;
    } finally {
      globalThis.fetch = previousFetch;
    }

    const history = await storage.readHistory();
    const hasNewTurn = history.some((item) => item.text === "NEW-DURING-FETCH");
    assert.ok(hasNewTurn, "NEW-DURING-FETCH should be preserved after compaction");
  });
});


test("compacted turns remain retrievable via archive fallback", async () => {
  await withTempStorage(async ({ storage, config, workspaceDir }) => {
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
    const indexPath = path.join(workspaceDir, ".contextfs", "history.archive.index.ndjson");
    assert.equal(hot.some((item) => item.id === archivedId), false);
    assert.equal(archive.some((item) => item.id === archivedId), true);
    await assert.rejects(fs.access(indexPath));

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

test("ctx reindex skips archive index rebuild and archive search/timeline read archive rows", async () => {
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

    const reindexOut = await runCtxCommand("ctx reindex --full", storage, localConfig);
    assert.equal(reindexOut.ok, true);
    assert.ok(reindexOut.text.includes("reindex done"));
    assert.equal(reindexOut.text.includes("archive.rebuilt"), false);
    assert.equal(reindexOut.text.includes("archive.entries"), false);
    assert.equal(reindexOut.text.includes("archive.index_entries"), false);
    const poisoned = await fs.readFile(indexPath, "utf8");
    assert.ok(poisoned.includes("BROKEN"));

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

test("search refreshes stale embedding rows and prunes rows for empty updated text", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const localConfig = mergeConfig({
      ...config,
      vectorEnabled: true,
      vectorProvider: "fake",
      retrievalMode: "hybrid",
      vectorTopN: 10,
    });
    storage.config = localConfig;

    const seed = await storage.appendHistory({
      role: "assistant",
      text: "initial semantic text",
      ts: "2026-02-12T00:00:00.000Z",
      session_id: "S-STALE",
    });
    assert.ok(seed?.id);

    const originalTryUpsert = storage.tryUpsertEmbeddingRows.bind(storage);
    const disableUpsertOnce = async (run) => {
      storage.tryUpsertEmbeddingRows = async () => [];
      try {
        await run();
      } finally {
        storage.tryUpsertEmbeddingRows = originalTryUpsert;
      }
    };

    await disableUpsertOnce(async () => {
      await storage.updateHistoryEntryById(seed.id, {
        text: "  refreshed vector target  ",
      });
    });

    const expectedRefreshHash = hashEmbeddingText(
      normalizeEmbeddingText("  refreshed vector target  ", localConfig.embeddingTextMaxChars),
    );
    const staleBeforeSearch = (await storage.readHistoryEmbeddingView("all")).find((row) => row.id === seed.id);
    assert.ok(staleBeforeSearch);
    assert.notEqual(staleBeforeSearch?.text_hash, expectedRefreshHash);

    const refreshSearchOut = await runCtxCommand('ctx search "refreshed target" --k 3 --scope all', storage, localConfig);
    assert.equal(refreshSearchOut.ok, true);
    const refreshed = (await storage.readHistoryEmbeddingView("all")).find((row) => row.id === seed.id);
    assert.ok(refreshed);
    assert.equal(refreshed?.source, "hot");
    assert.equal(refreshed?.text_hash, expectedRefreshHash);

    await disableUpsertOnce(async () => {
      await storage.updateHistoryEntryById(seed.id, {
        text: "    ",
      });
    });

    const staleBeforePrune = (await storage.readHistoryEmbeddingView("all")).find((row) => row.id === seed.id);
    assert.equal(staleBeforePrune, undefined);

    const pruneSearchOut = await runCtxCommand('ctx search "any" --k 3 --scope all', storage, localConfig);
    assert.equal(pruneSearchOut.ok, true);
    const afterPrune = (await storage.readHistoryEmbeddingView("all")).find((row) => row.id === seed.id);
    assert.equal(afterPrune, undefined);
  });
});

test("ctx reindex --embedding returns lexical-only guidance error", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const out = await runCtxCommand("ctx reindex --embedding", storage, config);
    assert.equal(out.ok, false);
    assert.ok(out.text.includes("ctx reindex --vectors rebuilds SQLite vector index"));
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
    const created = await storage.appendHistory({
      role: "user",
      text: "open src/app.mjs and check https://example.com/issues/12 #42",
      ts: "2026-02-09T00:00:00.000Z",
      sessionId: "S-test-session",
    });
    assert.ok(created);
    assert.equal(created.session_id, "S-test-session");

    const history = await storage.readHistory();
    assert.equal(history.length, 1);
    const row = history[0];
    assert.ok(typeof row.id === "string" && row.id.length >= 6);
    assert.equal(row.role, "user");
    assert.ok(typeof row.type === "string" && row.type.length > 0);
    assert.ok(Array.isArray(row.refs));
    assert.ok(row.refs.length >= 1);
    assert.equal(typeof row.text, "string");
    assert.equal(row.session_id, "S-test-session");
  });
});

test("ctx search --session filters hot rows by session_id", async () => {
  await withTempStorage(async ({ storage, config }) => {
    await storage.appendHistory({ role: "user", text: "needle alpha", ts: "2026-02-12T00:00:00.000Z", session_id: "S-A" });
    await storage.appendHistory({ role: "assistant", text: "needle beta", ts: "2026-02-12T00:00:01.000Z", session_id: "S-B" });
    await storage.appendHistory({ role: "user", text: "unrelated", ts: "2026-02-12T00:00:02.000Z", session_id: "S-A" });

    const all = await runCtxCommand('ctx search "needle" --k 10 --json', storage, config);
    assert.equal(all.ok, true);
    const allParsed = JSON.parse(all.text);
    assert.ok(allParsed.hits >= 2);

    const outA = await runCtxCommand('ctx search "needle" --k 10 --session S-A --json', storage, config);
    assert.equal(outA.ok, true);
    const parsedA = JSON.parse(outA.text);
    assert.ok(parsedA.hits >= 1);
    const idsA = new Set(parsedA.results.map((r) => r.id));

    const outB = await runCtxCommand('ctx search "needle" --k 10 --session S-B --json', storage, config);
    assert.equal(outB.ok, true);
    const parsedB = JSON.parse(outB.text);
    assert.ok(parsedB.hits >= 1);
    const idsB = new Set(parsedB.results.map((r) => r.id));

    // Ensure isolation: A and B result sets should not be identical for this setup.
    assert.equal([...idsA].some((id) => idsB.has(id)), false);
  });
});

test("ctx search --session excludes legacy rows without session_id", async () => {
  await withTempStorage(async ({ storage, workspaceDir, config }) => {
    const historyPath = path.join(workspaceDir, ".contextfs", "history.ndjson");
    const rows = [
      JSON.stringify({ role: "user", text: "legacy needle without session", ts: "2026-02-13T00:00:00.000Z" }),
      JSON.stringify({ role: "assistant", text: "needle with session", ts: "2026-02-13T00:00:01.000Z", session_id: "S-A" }),
    ].join("\n");
    await fs.writeFile(historyPath, `${rows}\n`, "utf8");

    const all = await runCtxCommand('ctx search "needle" --k 10 --json', storage, config);
    assert.equal(all.ok, true);
    const allParsed = JSON.parse(all.text);
    assert.ok(allParsed.hits >= 2);

    const filtered = await runCtxCommand('ctx search "needle" --k 10 --session S-A --json', storage, config);
    assert.equal(filtered.ok, true);
    const filteredParsed = JSON.parse(filtered.text);
    assert.ok(filteredParsed.hits >= 1);
    assert.equal(filteredParsed.results.some((r) => String(r.summary || "").includes("legacy needle")), false);
  });
});

test("archive search --session filters archive rows by session_id", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const localConfig = {
      ...config,
      recentTurns: 1,
      tokenThreshold: 1,
      autoCompact: true,
    };
    await storage.appendHistory({ role: "user", text: "archive needle A", ts: "2026-02-14T00:00:00.000Z", session_id: "S-A" });
    await storage.appendHistory({ role: "assistant", text: "archive needle B", ts: "2026-02-14T00:00:01.000Z", session_id: "S-B" });
    await storage.appendHistory({ role: "user", text: "filler", ts: "2026-02-14T00:00:02.000Z", session_id: "S-A" });

    await maybeCompact(storage, localConfig, true);

    const outA = await runCtxCommand('ctx search "archive needle" --scope archive --k 10 --session S-A --json', storage, localConfig);
    assert.equal(outA.ok, true);
    const parsedA = JSON.parse(outA.text);
    assert.ok(parsedA.hits >= 1);
    assert.ok(parsedA.results.every((r) => String(r.summary || "").includes("archive needle A") || String(r.summary || "").includes("archive needle")));

    const outB = await runCtxCommand('ctx search "archive needle" --scope archive --k 10 --session S-B --json', storage, localConfig);
    assert.equal(outB.ok, true);
    const parsedB = JSON.parse(outB.text);
    assert.ok(parsedB.hits >= 1);
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

test("ctx search --json exposes retrieval metadata and match in hybrid mode", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const localConfig = mergeConfig({
      ...config,
      retrievalMode: "hybrid",
      vectorEnabled: true,
      vectorProvider: "fake",
      vectorTopN: 10,
    });
    storage.config = localConfig;

    await storage.appendHistory({
      role: "user",
      text: "hybrid retrieval alpha target",
      ts: "2026-02-09T00:00:01.000Z",
      session_id: "S-HYBRID",
    });

    const out = await runCtxCommand('ctx search "hybrid retrieval alpha target" --k 3 --json --session S-HYBRID', storage, localConfig);
    assert.equal(out.ok, true);
    const parsed = JSON.parse(out.text);
    assert.equal(parsed.layer, "L0");
    assert.ok(parsed.retrieval);
    assert.equal(parsed.retrieval.mode, "hybrid");
    assert.equal(typeof parsed.retrieval.lexical_hits, "number");
    assert.equal(typeof parsed.retrieval.vector_hits, "number");
    assert.ok(Array.isArray(parsed.results));
    assert.ok(parsed.results.length >= 1);
    assert.ok(parsed.results.every((row) => ["lexical", "vector", "hybrid"].includes(String(row.match || ""))));
  });
});

test("ctx search can return vector-only hits with custom embedding provider", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const localConfig = mergeConfig({
      ...config,
      retrievalMode: "hybrid",
      vectorEnabled: true,
      vectorProvider: "custom",
      vectorDim: 8,
      vectorTopN: 5,
    });
    storage.config = localConfig;
    const prevProvider = globalThis.CONTEXTFS_EMBEDDING_PROVIDER;
    globalThis.CONTEXTFS_EMBEDDING_PROVIDER = {
      async embedText() {
        return {
          model: "custom-test",
          dim: 8,
          vector: [1, 0, 0, 0, 0, 0, 0, 0],
        };
      },
    };
    try {
      await storage.appendHistory({
        role: "assistant",
        text: "record text without keyword overlap",
        ts: "2026-02-09T00:00:02.000Z",
        session_id: "S-VEC",
      });

      const out = await runCtxCommand('ctx search "non-overlap-query-token" --k 3 --json --session S-VEC', storage, localConfig);
      assert.equal(out.ok, true);
      const parsed = JSON.parse(out.text);
      assert.ok(["hybrid", "vector"].includes(String(parsed.retrieval.mode || "")));
      assert.equal(parsed.retrieval.lexical_hits, 0);
      assert.ok(parsed.retrieval.vector_hits >= 1);
      assert.ok(["sqlite_vec_ann", "sqlite_vec_linear"].includes(String(parsed.retrieval.vector_engine || "")));
      assert.ok(parsed.results.length >= 1);
      assert.ok(parsed.results.some((row) => row.match === "vector" || row.match === "hybrid"));
    } finally {
      globalThis.CONTEXTFS_EMBEDDING_PROVIDER = prevProvider;
    }
  });
});

test("ctx search uses sqlite linear vector path when ANN is disabled", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const localConfig = mergeConfig({
      ...config,
      retrievalMode: "hybrid",
      vectorEnabled: true,
      vectorProvider: "custom",
      vectorDim: 8,
      vectorTopN: 5,
      annEnabled: false,
    });
    storage.config = localConfig;
    const prevProvider = globalThis.CONTEXTFS_EMBEDDING_PROVIDER;
    globalThis.CONTEXTFS_EMBEDDING_PROVIDER = {
      async embedText() {
        return {
          model: "custom-test",
          dim: 8,
          vector: [1, 0, 0, 0, 0, 0, 0, 0],
        };
      },
    };
    try {
      await storage.appendHistory({
        role: "assistant",
        text: "linear fallback anchor",
        ts: "2026-02-09T00:00:02.000Z",
        session_id: "S-LINEAR",
      });
      const out = await runCtxCommand('ctx search "completely different lexical query" --k 3 --json --session S-LINEAR', storage, localConfig);
      assert.equal(out.ok, true);
      const parsed = JSON.parse(out.text);
      assert.ok(parsed.retrieval.vector_hits >= 1);
      assert.equal(parsed.retrieval.vector_engine, "sqlite_vec_linear");
      assert.ok(["hybrid", "vector"].includes(String(parsed.retrieval.mode || "")));
    } finally {
      globalThis.CONTEXTFS_EMBEDDING_PROVIDER = prevProvider;
    }
  });
});

test("sqlite vector upsert reports version mismatch without crashing", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const localConfig = mergeConfig({
      ...config,
      retrievalMode: "hybrid",
      vectorEnabled: true,
      vectorProvider: "custom",
      vectorDim: 8,
    });
    storage.config = localConfig;
    const prevProvider = globalThis.CONTEXTFS_EMBEDDING_PROVIDER;
    globalThis.CONTEXTFS_EMBEDDING_PROVIDER = {
      async embedText() {
        return {
          model: "custom-test",
          dim: 8,
          vector: [1, 0, 0, 0, 0, 0, 0, 0],
        };
      },
    };
    try {
      await storage.appendHistory({
        role: "assistant",
        text: "mismatch probe row",
        ts: "2026-02-09T00:00:02.000Z",
      });
      const rows = await storage.readHistoryEmbeddingView("all");
      const mismatch = await storage.tryUpsertSqliteVectorRows(rows, {
        provider: "custom",
        model: "different-model",
        dim: 8,
        embedding_version: "custom:different-model:8:unit",
      });
      assert.equal(mismatch.available, true);
      assert.equal(mismatch.upserted, 0);
      assert.equal(mismatch.reason, "version_mismatch");
    } finally {
      globalThis.CONTEXTFS_EMBEDDING_PROVIDER = prevProvider;
    }
  });
});

test("ctx search falls back to lexical when custom provider is unavailable", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const localConfig = mergeConfig({
      ...config,
      retrievalMode: "hybrid",
      vectorEnabled: true,
      vectorProvider: "custom",
    });
    storage.config = localConfig;
    const prevProvider = globalThis.CONTEXTFS_EMBEDDING_PROVIDER;
    globalThis.CONTEXTFS_EMBEDDING_PROVIDER = undefined;
    try {
      await storage.appendHistory({
        role: "user",
        text: "lexical fallback needle",
        ts: "2026-02-09T00:00:03.000Z",
      });
      const out = await runCtxCommand('ctx search "lexical fallback needle" --k 3 --json', storage, localConfig);
      assert.equal(out.ok, true);
      const parsed = JSON.parse(out.text);
      assert.equal(parsed.retrieval.mode, "lexical");
      assert.ok(typeof parsed.retrieval.fallback_reason === "string");
      assert.ok(parsed.results.length >= 1);
    } finally {
      globalThis.CONTEXTFS_EMBEDDING_PROVIDER = prevProvider;
    }
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

test("ctx metrics and ctx doctor expose structured diagnostics", async () => {
  await withTempStorage(async ({ storage, config }) => {
    await storage.appendHistory({ role: "user", text: "metrics doctor sample", ts: "2026-02-09T00:04:10.000Z" });
    await runCtxCommand('ctx search "metrics doctor" --k 3 --json', storage, config);

    const metricsOut = await runCtxCommand("ctx metrics --json", storage, config);
    assert.equal(metricsOut.ok, true);
    const metrics = JSON.parse(metricsOut.text);
    assert.equal(metrics.layer, "METRICS");
    assert.equal(typeof metrics.counters.search_count, "number");
    assert.ok(Object.prototype.hasOwnProperty.call(metrics, "vector_engine"));

    const doctorOut = await runCtxCommand("ctx doctor --json", storage, config);
    assert.equal(doctorOut.ok, true);
    const doctor = JSON.parse(doctorOut.text);
    assert.equal(doctor.layer, "DOCTOR");
    assert.ok(doctor.sqlite_index);
    assert.ok(doctor.sqlite_index.vector);
    assert.equal(typeof doctor.sqlite_index.vector.rows, "number");
    assert.ok(doctor.embedding);
  });
});

test("ctx reindex supports --full and --vectors", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const localConfig = mergeConfig({
      ...config,
      indexEnabled: true,
      retrievalMode: "hybrid",
      vectorEnabled: true,
      vectorProvider: "fake",
    });
    storage.config = localConfig;
    await storage.appendHistory({ role: "user", text: "reindex sample one", ts: "2026-02-09T00:04:20.000Z" });
    await storage.appendHistory({ role: "assistant", text: "reindex sample two", ts: "2026-02-09T00:04:21.000Z" });

    const out = await runCtxCommand("ctx reindex --full --vectors", storage, localConfig);
    assert.equal(out.ok, true);
    assert.ok(out.text.includes("reindex done"));
    assert.equal(out.text.includes("archive.rebuilt"), false);
    assert.ok(out.text.includes("vectors.rebuilt"));
    assert.ok(out.text.includes("vectors.dim"));
    assert.ok(out.text.includes("vectors.sqlite_available"));
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

function readLastTraceLine(raw) {
  const lines = String(raw || "").split("\n").filter(Boolean);
  if (!lines.length) {
    return null;
  }
  return lines[lines.length - 1];
}

test("ctx search writes retrieval trace with stable schema", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const long = `needle alpha ${"A".repeat(600)} UNLIKELY_TOKEN ${"B".repeat(600)}`;
    await storage.appendHistory({ role: "user", text: long, ts: "2026-02-15T00:00:00.000Z" });

    const out = await runCtxCommand('ctx search "needle" --k 3 --json', storage, config);
    assert.equal(out.ok, true);

    const raw = await storage.readText("retrievalTraces");
    const lastLine = readLastTraceLine(raw);
    assert.ok(lastLine);
    assert.equal(lastLine.includes("UNLIKELY_TOKEN"), false);

    const trace = JSON.parse(lastLine);
    assert.equal(typeof trace.trace_id, "string");
    assert.ok(trace.trace_id.startsWith("T-"));
    assert.equal(trace.trace_id.length, 12);
    assert.equal(trace.command, "search");
    assert.equal(trace.ok, true);
    assert.equal(typeof trace.ts, "string");
    assert.equal(typeof trace.duration_ms, "number");
    assert.equal(typeof trace.state_revision, "number");

    assert.ok(trace.args);
    assert.equal(trace.args.k, 3);
    assert.equal(trace.args.scope, "all");

    assert.ok(Array.isArray(trace.ranking));
    assert.ok(trace.ranking.length >= 1);
    for (const row of trace.ranking) {
      assert.equal(typeof row.id, "string");
      assert.equal(typeof row.ts, "string");
      assert.equal(typeof row.type, "string");
      assert.equal(typeof row.source, "string");
      assert.equal(typeof row.summary, "string");
      assert.equal(row.summary.includes("\n"), false);
      assert.ok(row.summary.length <= config.searchSummaryMaxChars + 3);
    }
  });
});

test("ctx get trace records truncation fields under small head budget", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const long = `head-limit-${"Z".repeat(5000)}`;
    await storage.appendHistory({ role: "user", text: long, ts: "2026-02-15T00:01:00.000Z" });
    const id = (await storage.readHistory())[0].id;

    const out = await runCtxCommand(`ctx get ${id} --json --head 100`, storage, config);
    assert.equal(out.ok, true);
    assert.doesNotThrow(() => JSON.parse(out.text));

    const raw = await storage.readText("retrievalTraces");
    const lastLine = readLastTraceLine(raw);
    assert.ok(lastLine);
    const trace = JSON.parse(lastLine);
    assert.equal(trace.command, "get");
    assert.equal(trace.ok, true);
    assert.ok(trace.truncation);
    assert.equal(trace.truncation.truncated, true);
    assert.ok(Array.isArray(trace.truncation.fields));
    assert.ok(trace.truncation.fields.includes("text"));
  });
});

test("ctx traces and ctx trace commands can read traces", async () => {
  await withTempStorage(async ({ storage, config }) => {
    await storage.appendHistory({ role: "user", text: "needle one", ts: "2026-02-15T00:02:00.000Z" });
    await runCtxCommand('ctx search "needle" --k 1 --json', storage, config);

    const tracesOut = await runCtxCommand("ctx traces --tail 1 --json", storage, config);
    assert.equal(tracesOut.ok, true);
    const parsed = JSON.parse(tracesOut.text);
    assert.equal(parsed.layer, "TRACE");
    assert.equal(parsed.tail, 1);
    assert.ok(parsed.hits >= 1);
    assert.ok(Array.isArray(parsed.traces));
    assert.equal(parsed.traces.length, 1);
    const traceId = parsed.traces[0].trace_id;
    assert.ok(typeof traceId === "string" && traceId.startsWith("T-"));

    const traceOut = await runCtxCommand(`ctx trace ${traceId} --json`, storage, config);
    assert.equal(traceOut.ok, true);
    const traceParsed = JSON.parse(traceOut.text);
    assert.equal(traceParsed.layer, "TRACE");
    assert.ok(traceParsed.trace);
    assert.equal(traceParsed.trace.trace_id, traceId);
  });
});

test("trace rotation keeps size bounded and remains parseable", async () => {
  await withTempStorage(async ({ storage, workspaceDir }) => {
    const localConfig = mergeConfig({
      contextfsDir: ".contextfs",
      tracesMaxBytes: 600,
      tracesMaxFiles: 2,
      tracesTailDefault: 50,
    });

    await storage.appendHistory({ role: "user", text: `needle ${"X".repeat(3000)}`, ts: "2026-02-15T00:03:00.000Z" });

    for (let i = 0; i < 20; i += 1) {
      const out = await runCtxCommand('ctx search "needle" --k 1 --json', storage, localConfig);
      assert.equal(out.ok, true);
    }

    const rotatedPath = path.join(workspaceDir, ".contextfs", "retrieval.traces.1.ndjson");
    const stat = await fs.stat(rotatedPath);
    assert.ok(stat.size > 0);

    const tracesOut = await runCtxCommand("ctx traces --tail 50 --json", storage, localConfig);
    assert.equal(tracesOut.ok, true);
    const parsed = JSON.parse(tracesOut.text);
    assert.equal(parsed.layer, "TRACE");
    assert.ok(parsed.hits >= 2);
  });
});

test("single oversized trace write rotates immediately and keeps main trace file bounded", async () => {
  await withTempStorage(async ({ storage, workspaceDir }) => {
    const localConfig = mergeConfig({
      contextfsDir: ".contextfs",
      tracesMaxBytes: 600,
      tracesMaxFiles: 2,
      tracesTailDefault: 50,
    });

    for (let i = 0; i < 20; i += 1) {
      await storage.appendHistory({
        role: i % 2 ? "user" : "assistant",
        text: `needle oversized trace ${i} ${"X".repeat(800)}`,
        ts: `2026-02-15T00:04:${String(i).padStart(2, "0")}.000Z`,
      });
    }

    const out = await runCtxCommand('ctx search "needle oversized trace" --k 8 --json', storage, localConfig);
    assert.equal(out.ok, true);

    const mainPath = path.join(workspaceDir, ".contextfs", "retrieval.traces.ndjson");
    const mainStat = await fs.stat(mainPath);
    assert.ok(mainStat.size <= localConfig.tracesMaxBytes);

    const tracesOut = await runCtxCommand("ctx traces --tail 1 --json", storage, localConfig);
    assert.equal(tracesOut.ok, true);
    const parsed = JSON.parse(tracesOut.text);
    assert.equal(parsed.layer, "TRACE");
    assert.ok(parsed.hits >= 1);
  });
});

test("ctx save persists explicit memory and keeps it retrievable", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const saveOut = await runCtxCommand(
      'ctx save "Investigated auth token refresh path" --title "Auth Tokens" --role assistant --type decision --session S-SAVE --json',
      storage,
      config,
    );
    assert.equal(saveOut.ok, true);
    const savePayload = JSON.parse(saveOut.text);
    assert.equal(savePayload.layer, "WRITE");
    assert.equal(savePayload.action, "save_memory");
    assert.equal(typeof savePayload.record?.id, "string");
    assert.equal(savePayload.record?.session_id, "S-SAVE");
    const savedId = String(savePayload.record.id || "");
    assert.ok(savedId);

    const searchOut = await runCtxCommand(
      'ctx search "auth token refresh" --k 5 --scope all --session S-SAVE --json',
      storage,
      config,
    );
    assert.equal(searchOut.ok, true);
    const searchPayload = JSON.parse(searchOut.text);
    assert.equal(searchPayload.layer, "L0");
    assert.ok(Array.isArray(searchPayload.results));
    assert.ok(searchPayload.results.some((row) => String(row.id) === savedId));

    const getOut = await runCtxCommand(`ctx get ${savedId} --session S-SAVE --json`, storage, config);
    assert.equal(getOut.ok, true);
    const getPayload = JSON.parse(getOut.text);
    assert.equal(getPayload.layer, "L2");
    assert.equal(String(getPayload.record.id), savedId);
    assert.equal(String(getPayload.record.type), "decision");
    assert.ok(String(getPayload.record.text || "").includes("Investigated auth token refresh path"));
  });
});

test("ctx save validates required text, role, and session constraints", async () => {
  await withTempStorage(async ({ storage, config }) => {
    const missingText = await runCtxCommand("ctx save --json", storage, config);
    assert.equal(missingText.ok, false);
    assert.ok(missingText.text.includes("usage: ctx save"));

    const invalidSessionAll = await runCtxCommand('ctx save "hello" --session all', storage, config);
    assert.equal(invalidSessionAll.ok, false);
    assert.ok(invalidSessionAll.text.includes("does not support --session all"));

    const invalidRole = await runCtxCommand('ctx save "hello" --role nope', storage, config);
    assert.equal(invalidRole.ok, false);
    assert.ok(invalidRole.text.includes("role must be one of"));
  });
});
