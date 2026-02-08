console.error("[contextfs] loaded", { cwd: process.cwd() });

import fs from "node:fs";
import path from "node:path";

import { mergeConfig } from "./contextfs/src/config.mjs";
import { ContextFsStorage } from "./contextfs/src/storage.mjs";
import { maybeCompact } from "./contextfs/src/compactor.mjs";
import { buildContextPack } from "./contextfs/src/packer.mjs";
import { addPinsFromText } from "./contextfs/src/pins.mjs";
import { runCtxCommand } from "./contextfs/src/commands.mjs";

function dbg(workspaceDir, msg, obj) {
  try {
    const p = path.join(workspaceDir, ".contextfs", "debug.log");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const line =
      `[${new Date().toISOString()}] ${msg}` +
      (obj ? ` ${JSON.stringify(obj).slice(0, 4000)}` : "") +
      "\n";
    fs.appendFileSync(p, line, "utf8");
  } catch {}
}

function textFromMessage(payload) {
  if (!payload) {
    return "";
  }
  if (typeof payload === "string") {
    return payload;
  }
  if (typeof payload.text === "string") {
    return payload.text;
  }
  if (typeof payload.content === "string") {
    return payload.content;
  }
  if (Array.isArray(payload.parts)) {
    return payload.parts
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
}

function roleFromMessage(payload, fallback = "unknown") {
  return (
    payload?.role ||
    payload?.author ||
    payload?.message?.role ||
    fallback
  );
}

function appendPrompt(output, text) {
  if (!output || !text) {
    return;
  }
  if (Array.isArray(output.context)) {
    output.context.push(text);
    return;
  }
  if (typeof output.prompt === "string") {
    output.prompt = `${output.prompt}\n\n${text}`;
    return;
  }
  if (typeof output.append === "function") {
    output.append(text);
  }
}

function setCommandOutput(output, result) {
  if (!output) {
    return;
  }
  output.handled = true;
  output.stop = true;
  output.exitCode = result.exitCode;
  output.result = result.text;
  output.message = result.text;
  output.stdout = result.text;
}

async function recordTurn(storage, role, text) {
  const clean = String(text || "").trim();
  if (!clean) {
    return;
  }
  await storage.appendHistory({
    role: role || "unknown",
    text: clean,
    ts: new Date().toISOString(),
  });
}

export const ContextFSPlugin = async ({ directory }) => {
  console.error("[contextfs] init", { directory, cwd: process.cwd() });
  const config = mergeConfig(globalThis.CONTEXTFS_CONFIG || {});
  const workspaceDir = directory || process.cwd();
  dbg(workspaceDir, "init", { directory, cwd: process.cwd(), url: import.meta.url });
  const storage = new ContextFsStorage(workspaceDir, config);
  await storage.ensureInitialized();

  // Buffer streaming deltas by message id to avoid writing every chunk
  const streamBuf = new Map(); // msgId -> { text, updatedAt }
  let partEventCount = 0;

  function getMsgIdFromInfo(info) {
    return info?.id || info?.messageID || info?.messageId || info?.message_id || null;
  }

  function extractDeltaText(delta) {
    if (!delta) return "";
    if (typeof delta === "string") return delta;
    if (typeof delta.text === "string") return delta.text;
    if (typeof delta.content === "string") return delta.content;
    if (Array.isArray(delta.parts)) {
      return delta
        .parts
        .map((p) => (typeof p === "string" ? p : p?.text || p?.content || ""))
        .join("");
    }
    return "";
  }

  async function autoCompactIfNeeded() {
    if (!config.autoCompact) {
      return;
    }
    await maybeCompact(storage, config, false);
  }

  return {
event: async (payload) => {
  const evt = payload?.event || payload || {};
  const type = evt.type || evt.name || payload?.type || payload?.name || "unknown";
  const props = evt.properties || evt.props || payload?.properties || {};

  // Streaming delta updates: accumulate and flush on message.updated when completed
  if (type === "message.part.updated") {
    const part = props.part || {};
    const delta = props.delta;

    const msgId =
      part.messageID ||
      part.messageId ||
      part.id ||
      delta?.messageID ||
      delta?.messageId ||
      null;

    const deltaText = extractDeltaText(delta);

    if (msgId && deltaText) {
      const prev = streamBuf.get(msgId) || { text: "", updatedAt: Date.now() };
      prev.text += deltaText;
      prev.updatedAt = Date.now();
      streamBuf.set(msgId, prev);
    } else {
      partEventCount += 1;
      if (partEventCount % 100 === 0) {
        dbg(workspaceDir, "message.part.updated missing", {
          msgId,
          partKeys: part ? Object.keys(part) : [],
          deltaKeys: delta && typeof delta === "object" ? Object.keys(delta) : [],
          deltaSample: JSON.stringify(delta).slice(0, 400),
        });
      }
    }
    return;
  }

  // Log non-stream events (keeps debug.log readable)
  dbg(workspaceDir, "event", { type, propKeys: Object.keys(props || {}) });

  if (type === "session.created") {
    await storage.ensureInitialized();
    await storage.refreshManifest();
    return;
  }

  if (type === "session.diff") {
    // Often contains tool calls and message content; log a small sample for inspection
    const diff = props.diff;
    dbg(workspaceDir, "session.diff sample", {
      diffKeys: diff && typeof diff === "object" ? Object.keys(diff) : [],
      sample: JSON.stringify(diff).slice(0, 1200),
    });
    return;
  }

  if (type === "message.updated") {
    // In opencode 1.1.53, message.updated often contains only metadata under properties.info.
    const info = props.info || props.message?.info || props;
    const msgId = getMsgIdFromInfo(info);
    const role = info?.role || "unknown";
    const finished = info?.finish === "stop" || Boolean(info?.time?.completed);

    if (finished && msgId && streamBuf.has(msgId)) {
      const buf = streamBuf.get(msgId);
      streamBuf.delete(msgId);

      const text = String(buf?.text || "").trim();
      if (!text) {
        dbg(workspaceDir, "message.updated flush EMPTY", { msgId, role });
        return;
      }

      await recordTurn(storage, role, text);
      await addPinsFromText(storage, text, config);
      await autoCompactIfNeeded();
      await storage.refreshManifest();
      return;
    }

    // Fallback: some user messages only provide summary.title
    const title = info?.summary?.title;
    if (role === "user" && title) {
      const fallback = `[user-summary] ${title}`;
      await recordTurn(storage, "user", fallback);
      await autoCompactIfNeeded();
      await storage.refreshManifest();
      return;
    }

    dbg(workspaceDir, "message.updated no-text", {
      msgId,
      role,
      finished,
      infoKeys: info ? Object.keys(info) : [],
      sample: JSON.stringify(info).slice(0, 800),
    });
    return;
  }

  // Tool events vary by version; log their shapes for later parsing.
  if (String(type).includes("tool") || String(type).startsWith("bash")) {
    dbg(workspaceDir, "tool-like event", {
      type,
      sample: JSON.stringify(props).slice(0, 1200),
    });
  }
},
    "session.created": async () => {
      await storage.ensureInitialized();
      await storage.refreshManifest();
    },

    "message.updated": async (input) => {
      const evt = input?.event || input || {};
      const props = evt.properties || evt.props || input?.properties || {};
      const msg = props.message || props.msg || props.data || (evt.type ? props : evt);
      const role = roleFromMessage(msg, "message");
      const text = textFromMessage(msg);
      await recordTurn(storage, role, text);
      await addPinsFromText(storage, text, config);
      await autoCompactIfNeeded();
      await storage.refreshManifest();
    },

    "tool.execute.after": async (input, output) => {
      const commandText = textFromMessage(input?.args || input);
      const resultText = textFromMessage(output);
      const merged = [commandText, resultText].filter(Boolean).join("\n");
      if (merged) {
        await recordTurn(storage, "tool", merged);
        await addPinsFromText(storage, merged, config);
      }
      await autoCompactIfNeeded();
      await storage.refreshManifest();
    },

    "tui.prompt.append": async (_input, output) => {
      if (!config.autoInject) {
        return;
      }
      const pack = await buildContextPack(storage, config);
      appendPrompt(output, pack.block);
      await storage.refreshManifest();
    },

    "tui.command.execute": async (input, output) => {
      const raw =
        input?.command ||
        input?.text ||
        (typeof input === "string" ? input : "");
      if (!String(raw).trim().startsWith("ctx")) {
        return;
      }
      const result = await runCtxCommand(raw, storage, config);
      setCommandOutput(output, result);
    },
  };
};

export default ContextFSPlugin;
