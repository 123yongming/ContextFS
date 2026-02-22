#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

import ContextFSPlugin from "../.opencode/plugins/contextfs.plugin.mjs";
import { mergeConfig } from "../.opencode/plugins/contextfs/src/config.mjs";
import { ContextFsStorage } from "../.opencode/plugins/contextfs/src/storage.mjs";
import { runCtxCommand } from "../.opencode/plugins/contextfs/src/commands.mjs";
import { parsePinsMarkdown } from "../.opencode/plugins/contextfs/src/pins.mjs";
import { buildContextPack } from "../.opencode/plugins/contextfs/src/packer.mjs";

const root = process.cwd();
const TEST_COMPACT_MODEL = "Pro/Qwen/Qwen2.5-7B-Instruct";

function installCompactFetchMock() {
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
      const sample = prompt
        .split("\n")
        .find((line) => line.includes("[USER]") || line.includes("[ASSISTANT]") || line.includes("[SYSTEM]"));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: `# Rolling Summary\n\n- compacted by external model\n- ${sample || "regression summary"}\n`,
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
    throw new Error(`unexpected fetch in regression: ${target || "<empty>"}`);
  };
  return () => {
    globalThis.fetch = previousFetch;
  };
}

function parseTokens(text) {
  const before = Number((text.match(/before.tokens: (\d+)/) || [])[1] || 0);
  const after = Number((text.match(/after.tokens: (\d+)/) || [])[1] || 0);
  return { before, after };
}

async function resetRuntime(dir) {
  const full = path.join(root, dir);
  await fs.mkdir(full, { recursive: true });
  await fs.rm(path.join(full, ".contextfs"), { recursive: true, force: true });
  return full;
}

async function test1() {
  const workspace = await resetRuntime(".contextfs_rt_idempotent");
  const config = mergeConfig({
    contextfsDir: ".contextfs",
    recentTurns: 6,
    tokenThreshold: 16000,
    autoInject: true,
    autoCompact: true,
  });
  const storage = new ContextFsStorage(workspace, config);
  await storage.ensureInitialized();

  for (let i = 1; i <= 30; i += 1) {
    await storage.appendHistory({
      role: i % 2 ? "user" : "assistant",
      text: `turn-${String(i).padStart(2, "0")} short payload`,
      ts: new Date().toISOString(),
    });
  }

  const first = await runCtxCommand("ctx compact", storage, config);
  const second = await runCtxCommand("ctx compact", storage, config);
  const historyCount = (await storage.readHistory()).length;
  const summaryLength = (await storage.readText("summary")).length;
  const t1 = parseTokens(first.text);
  const t2 = parseTokens(second.text);

  return {
    id: "TEST-1",
    pass: historyCount === 6 && Math.abs(t2.after - t1.after) <= 5,
    metrics: {
      firstBefore: t1.before,
      firstAfter: t1.after,
      secondAfter: t2.after,
      historyCount,
      summaryLength,
    },
  };
}

async function test2() {
  const workspace = await resetRuntime(".contextfs_rt_pins_dedup");
  const config = mergeConfig({ contextfsDir: ".contextfs" });
  const storage = new ContextFsStorage(workspace, config);
  await storage.ensureInitialized();
  const variants = ["不要改架构", "不要改架构 ", " 不要改架构", "不要 改架构", "不要改架构。"];

  for (const text of variants) {
    await runCtxCommand(`ctx pin "${text}"`, storage, config);
  }

  const pins = parsePinsMarkdown(await storage.readText("pins"));
  return {
    id: "TEST-2",
    pass: pins.length <= 2,
    metrics: { pinsCount: pins.length, pins: pins.map((x) => x.text) },
  };
}

async function test3() {
  const workspace = await resetRuntime(".contextfs_rt_auto_off");
  globalThis.CONTEXTFS_CONFIG = {
    contextfsDir: ".contextfs",
    autoInject: false,
    autoCompact: false,
    recentTurns: 4,
    tokenThreshold: 200,
  };
  const plugin = await ContextFSPlugin({ directory: workspace });
  const config = mergeConfig(globalThis.CONTEXTFS_CONFIG);
  const storage = new ContextFsStorage(workspace, config);

  for (let i = 1; i <= 10; i += 1) {
    await storage.appendHistory({
      role: i % 2 ? "user" : "assistant",
      text: `auto-off turn-${i}`,
      ts: new Date().toISOString(),
    });
  }

  const output = { context: [] };
  await plugin["tui.prompt.append"]({}, output);
  const historyBefore = (await storage.readHistory()).length;
  const compactResult = await runCtxCommand("ctx compact", storage, config);
  const historyAfter = (await storage.readHistory()).length;

  return {
    id: "TEST-3",
    pass: output.context.length === 0 && historyBefore === 10 && historyAfter === 4,
    metrics: {
      autoInjected: output.context.length > 0,
      historyBefore,
      historyAfter,
      compacted: compactResult.text.includes("compacted: true"),
    },
  };
}

async function test8() {
  const workspace = await resetRuntime(".contextfs_rt_history_pairs");
  globalThis.CONTEXTFS_CONFIG = {
    contextfsDir: ".contextfs",
    autoInject: false,
    autoCompact: false,
    recentTurns: 6,
  };
  const plugin = await ContextFSPlugin({ directory: workspace });
  const config = mergeConfig(globalThis.CONTEXTFS_CONFIG);
  const storage = new ContextFsStorage(workspace, config);

  await plugin.event({
    event: {
      type: "tui.prompt.append",
      properties: {
        text: "interpret the current project plugin",
      },
    },
  });

  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: { id: "U-1", role: "user", summary: { title: "summary fallback should be ignored" } },
      },
    },
  });

  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: { id: "A-1", role: "assistant" },
        message: { id: "A-1", role: "assistant", text: "intermediate draft 1" },
      },
    },
  });

  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: { id: "A-1", role: "assistant" },
        message: { id: "A-1", role: "assistant", text: "intermediate draft 2" },
      },
    },
  });

  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: { id: "A-1", role: "assistant" },
        message: { id: "A-1", role: "assistant", text: "final answer only" },
      },
    },
  });

  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: { id: "A-1", role: "assistant" },
        message: { id: "A-1", role: "assistant", text: "final answer only" },
      },
    },
  });

  const history = await storage.readHistory();
  const roles = history.map((item) => item.role);
  const texts = history.map((item) => item.text);
  const pass =
    history.length === 2 &&
    roles[0] === "user" &&
    roles[1] === "assistant" &&
    texts[0] === "interpret the current project plugin" &&
    texts[1] === "final answer only" &&
    !texts.some((text) => text.includes("summary fallback")) &&
    !texts.some((text) => text.includes("intermediate draft"));

  return {
    id: "TEST-8",
    pass,
    metrics: {
      historyCount: history.length,
      roles: roles.join(","),
      assistantText: texts[1] || "",
    },
  };
}

async function test4() {
  const workspace = await resetRuntime(".contextfs_rt_autoinject");
  globalThis.CONTEXTFS_CONFIG = {
    contextfsDir: ".contextfs",
    autoInject: true,
    autoCompact: false,
    recentTurns: 6,
  };
  const plugin = await ContextFSPlugin({ directory: workspace });
  const config = mergeConfig(globalThis.CONTEXTFS_CONFIG);
  const storage = new ContextFsStorage(workspace, config);
  await runCtxCommand('ctx pin "必须不改 opencode 核心架构"', storage, config);

  for (let i = 1; i <= 12; i += 1) {
    await storage.appendHistory({
      role: i % 2 ? "user" : "assistant",
      text: `turn-${String(i).padStart(2, "0")} short`,
      ts: new Date().toISOString(),
    });
  }

  const output = { context: [] };
  await plugin["tui.prompt.append"]({}, output);
  const block = output.context.at(-1) || "";
  const hasSections =
    block.includes("### PINS") &&
    block.includes("### SUMMARY") &&
    block.includes("### MANIFEST") &&
    block.includes("### WORKSET_RECENT_TURNS");

  return {
    id: "TEST-4",
    pass:
      hasSections &&
      block.includes("必须不改 opencode 核心架构") &&
      !block.includes("turn-01") &&
      block.includes("turn-12"),
    metrics: {
      hasSections,
      containsTurn01: block.includes("turn-01"),
      containsTurn12: block.includes("turn-12"),
    },
  };
}

async function test5() {
  const workspace = await resetRuntime(".contextfs_rt_atomic");
  const config = mergeConfig({ contextfsDir: ".contextfs" });
  const storage = new ContextFsStorage(workspace, config);
  await storage.ensureInitialized();

  const writes = [];
  for (let i = 1; i <= 15; i += 1) {
    writes.push(
      storage.appendHistory({
        role: i % 2 ? "user" : "assistant",
        text: `atomic-msg-${i}`,
        ts: new Date().toISOString(),
      }),
    );
  }

  const settled = await Promise.allSettled(writes);
  const historyRaw = await fs.readFile(path.join(workspace, ".contextfs", "history.ndjson"), "utf8");
  const stateRaw = await fs.readFile(path.join(workspace, ".contextfs", "state.json"), "utf8");
  const lines = historyRaw.split("\n").filter(Boolean);
  const rejectedWrites = settled.filter((x) => x.status === "rejected").length;
  const parseOk = lines.every((line) => {
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  });
  let stateOk = true;
  try {
    JSON.parse(stateRaw);
  } catch {
    stateOk = false;
  }
  const entries = (await storage.readHistory()).length;

  return {
    id: "TEST-5",
    pass: rejectedWrites === 0 && parseOk && stateOk && lines.length === 15 && entries === 15,
    metrics: { rejectedWrites, historyLines: lines.length, parseOk, stateOk, entries },
  };
}

async function test6() {
  const workspace = await resetRuntime(".contextfs_rt_pack_bounds");
  globalThis.CONTEXTFS_CONFIG = {
    contextfsDir: ".contextfs",
    autoInject: true,
    autoCompact: false,
    recentTurns: 6,
  };
  const plugin = await ContextFSPlugin({ directory: workspace });
  const config = mergeConfig(globalThis.CONTEXTFS_CONFIG);
  const storage = new ContextFsStorage(workspace, config);
  await storage.ensureInitialized();

  const manifestRaw = Array.from({ length: 45 }, (_, i) => `- manifest-line-${String(i + 1).padStart(2, "0")}`).join("\n") + "\n";
  const summaryRaw = "# Rolling Summary\n\n" + "S".repeat(4100) + "\n";
  const pinsRaw =
    "# Pins (short, one line each)\n\n" +
    Array.from({ length: 25 }, (_, i) => `- [P-${String(i + 1).padStart(8, "0")}] pin-${i + 1}`).join("\n") +
    "\n";

  await storage.writeText("manifest", manifestRaw);
  await storage.writeText("summary", summaryRaw);
  await storage.writeText("pins", pinsRaw);
  for (let i = 1; i <= 8; i += 1) {
    await storage.appendHistory({
      role: i % 2 ? "user" : "assistant",
      text: `bounds-turn-${i}`,
      ts: new Date().toISOString(),
    });
  }

  const output = { context: [] };
  await plugin["tui.prompt.append"]({}, output);
  const block = output.context.at(-1) || "";
  const pack = await buildContextPack(storage, config);

  return {
    id: "TEST-6",
    pass:
      block.includes("### PINS") &&
      block.includes("### SUMMARY") &&
      block.includes("### MANIFEST") &&
      block.includes("### WORKSET_RECENT_TURNS") &&
      pack.details.summaryChars <= config.summaryMaxChars &&
      pack.details.manifestLines <= config.manifestMaxLines &&
      pack.details.pinsCount <= config.pinsMaxItems,
    metrics: {
      summaryChars: pack.details.summaryChars,
      manifestLines: pack.details.manifestLines,
      pinsCount: pack.details.pinsCount,
    },
  };
}

async function test7() {
  const workspace = await resetRuntime(".contextfs_rt_retrieval_workflow");
  const config = mergeConfig({ contextfsDir: ".contextfs", tokenThreshold: 800 });
  const storage = new ContextFsStorage(workspace, config);
  await storage.ensureInitialized();

  const rows = [
    "investigate lock timeout in plugin",
    "check src/storage.mjs for lock handling",
    "captured fix details in summary",
    "issue #42 includes rollback note",
    "https://example.com/spec/contextfs-retrieval",
    "final validation done",
  ];
  for (let i = 0; i < rows.length; i += 1) {
    await storage.appendHistory({
      role: i % 2 ? "assistant" : "user",
      text: rows[i],
      ts: new Date(Date.now() + i * 1000).toISOString(),
    });
  }

  const search = await runCtxCommand('ctx search "lock" --k 3', storage, config);
  const searchLine = search.text
    .split("\n")
    .find((line) => /^H-[a-f0-9]+\s\|/.test(line));
  const anchorId = searchLine ? searchLine.split("|")[0].trim() : "";
  const timeline = anchorId ? await runCtxCommand(`ctx timeline ${anchorId} --before 1 --after 1`, storage, config) : { ok: false, text: "" };
  const detail = anchorId ? await runCtxCommand(`ctx get ${anchorId} --head 400`, storage, config) : { ok: false, text: "" };
  const stats = await runCtxCommand("ctx stats", storage, config);

  return {
    id: "TEST-7",
    pass:
      search.ok &&
      Boolean(anchorId) &&
      timeline.ok &&
      detail.ok &&
      stats.ok &&
      stats.text.includes("estimated_tokens") &&
      stats.text.includes("last_search_hits") &&
      timeline.text.includes(anchorId),
    metrics: {
      searchOk: search.ok,
      timelineOk: timeline.ok,
      detailOk: detail.ok,
      statsOk: stats.ok,
      anchorId,
    },
  };
}

function printTable(results) {
  console.log("\n# ContextFS Regression Results\n");
  console.log("| Test | Status | Key Metrics |");
  console.log("|---|---|---|");
  for (const row of results) {
    const status = row.pass ? "PASS" : "FAIL";
    const metrics = Object.entries(row.metrics)
      .slice(0, 4)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join(",")}]` : v}`)
      .join(", ");
    console.log(`| ${row.id} | ${status} | ${metrics} |`);
  }
}

async function main() {
  const previousCompactModel = process.env.CONTEXTFS_COMPACT_MODEL;
  const previousApiKey = process.env.CONTEXTFS_EMBEDDING_API_KEY;
  const previousBaseUrl = process.env.CONTEXTFS_EMBEDDING_BASE_URL;
  const restoreFetch = installCompactFetchMock();
  if (!String(process.env.CONTEXTFS_COMPACT_MODEL || "").trim()) {
    process.env.CONTEXTFS_COMPACT_MODEL = TEST_COMPACT_MODEL;
  }
  if (!String(process.env.CONTEXTFS_EMBEDDING_API_KEY || "").trim()) {
    process.env.CONTEXTFS_EMBEDDING_API_KEY = "test-key";
  }
  if (!String(process.env.CONTEXTFS_EMBEDDING_BASE_URL || "").trim()) {
    process.env.CONTEXTFS_EMBEDDING_BASE_URL = "https://api.siliconflow.cn/v1";
  }
  try {
    const results = [await test1(), await test2(), await test3(), await test4(), await test5(), await test6(), await test7(), await test8()];
    printTable(results);
    console.log("\n# JSON Summary\n");
    console.log(JSON.stringify({ allPass: results.every((x) => x.pass), results }, null, 2));
    process.exitCode = results.every((x) => x.pass) ? 0 : 1;
  } finally {
    restoreFetch();
    if (previousCompactModel === undefined) {
      delete process.env.CONTEXTFS_COMPACT_MODEL;
    } else {
      process.env.CONTEXTFS_COMPACT_MODEL = previousCompactModel;
    }
    if (previousApiKey === undefined) {
      delete process.env.CONTEXTFS_EMBEDDING_API_KEY;
    } else {
      process.env.CONTEXTFS_EMBEDDING_API_KEY = previousApiKey;
    }
    if (previousBaseUrl === undefined) {
      delete process.env.CONTEXTFS_EMBEDDING_BASE_URL;
    } else {
      process.env.CONTEXTFS_EMBEDDING_BASE_URL = previousBaseUrl;
    }
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
