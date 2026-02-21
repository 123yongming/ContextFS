import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { mergeConfig } from "./contextfs/src/config.mjs";
import { ContextFsStorage } from "./contextfs/src/storage.mjs";
import { maybeCompact } from "./contextfs/src/compactor.mjs";
import { buildContextPack } from "./contextfs/src/packer.mjs";
import { addPinsFromText } from "./contextfs/src/pins.mjs";
import { runCtxCommand } from "./contextfs/src/commands.mjs";
import { loadContextFsEnv } from "./contextfs/src/env.mjs";

function dbg(workspaceDir, enabled, msg, obj) {
  if (!enabled) {
    return;
  }
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

async function safeRun(workspaceDir, enabled, label, run) {
  try {
    return await run();
  } catch (err) {
    dbg(workspaceDir, enabled, `safeRun:${label}:error`, {
      message: String(err?.message || err),
      stack: String(err?.stack || ""),
    });
    return undefined;
  }
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

function normalizeMessageRole(value, fallback = "unknown") {
  const role = String(value || "").trim().toLowerCase();
  if (!role) {
    return fallback;
  }
  if (role === "human") {
    return "user";
  }
  if (role === "ai") {
    return "assistant";
  }
  return role;
}

function isSummaryFallbackText(text) {
  const clean = String(text || "").trim();
  if (!clean) {
    return false;
  }
  return /^\[user-summary\]/i.test(clean);
}

function extractUserTextFromParts(parts) {
  const list = Array.isArray(parts) ? parts : [];
  const rows = [];
  for (const part of list) {
    if (!part || typeof part !== "object") {
      continue;
    }
    if (part.type === "text" && typeof part.text === "string") {
      const text = part.text.trim();
      if (text) {
        rows.push(text);
      }
    }
    if (typeof part.prompt === "string") {
      const text = part.prompt.trim();
      if (text) {
        rows.push(text);
      }
    }
  }
  return rows.join("\n").trim();
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

function newSessionId() {
  return `S-${crypto.randomUUID()}`;
}

async function recordTurn(storage, role, text, sessionId) {
  const clean = String(text || "").trim();
  if (!clean) {
    return null;
  }
  const session_id = String(sessionId || "").trim();
  return storage.appendHistory({
    role: role || "unknown",
    text: clean,
    ts: new Date().toISOString(),
    ...(session_id ? { session_id } : {}),
  });
}

export const ContextFSPlugin = async ({ directory }) => {
  await loadContextFsEnv();
  const config = mergeConfig(globalThis.CONTEXTFS_CONFIG || {});
  const workspaceDir = directory || process.cwd();
  const debugEnabled = Boolean(config.debug) || process.env.CONTEXTFS_DEBUG === "1";
  const logDebug = (msg, obj) => dbg(workspaceDir, debugEnabled, msg, obj);
  logDebug("init", { directory, cwd: process.cwd(), url: import.meta.url });

  const storage = new ContextFsStorage(workspaceDir, config);
  await storage.ensureInitialized();

  let activeSessionId = null;
  let lastSessionRotateAtMs = 0;
  async function ensureActiveSession(reason = "unknown") {
    if (activeSessionId) {
      return activeSessionId;
    }
    const state = await storage.readState();
    const existing = String(state.currentSessionId || "").trim();
    if (existing) {
      activeSessionId = existing;
      return activeSessionId;
    }
    const id = newSessionId();
    const now = new Date().toISOString();
    await storage.updateState((cur) => ({
      currentSessionId: id,
      sessionCount: (cur.sessionCount || 0) + 1,
      lastSessionCreatedAt: now,
    }));
    activeSessionId = id;
    logDebug("session.created (init)", { reason, session_id: id });
    return activeSessionId;
  }

  async function rotateSession(reason = "unknown") {
    // Some OpenCode versions may emit both a generic event and a named hook for
    // `session.created`. Debounce to avoid double-rotating the session id.
    if (String(reason).includes("session.created")) {
      const nowMs = Date.now();
      if (nowMs - lastSessionRotateAtMs < 2000) {
        logDebug("session.created skipped (debounced)", { reason, session_id: activeSessionId || null });
        return activeSessionId || ensureActiveSession("session.rotate.debounce");
      }
      lastSessionRotateAtMs = nowMs;
    }
    const id = newSessionId();
    const now = new Date().toISOString();
    await storage.updateState((cur) => ({
      currentSessionId: id,
      sessionCount: (cur.sessionCount || 0) + 1,
      lastSessionCreatedAt: now,
    }));
    activeSessionId = id;
    logDebug("session.created", { reason, session_id: id });
    return activeSessionId;
  }

  await ensureActiveSession("plugin.init");

  // Buffer streaming deltas by message id to avoid writing every chunk
  const streamBuf = new Map(); // msgId -> { text, updatedAt }
  const assistantEventTextById = new Map();
  let activeTurnUserText = "";
  let activeTurnUserId = null;
  let activeTurnAssistantId = null;
  let activeTurnAssistantText = "";
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

  function extractMessageUpdatedMeta(payload) {
    const evt = payload?.event || payload || {};
    const props = evt.properties || evt.props || payload?.properties || {};
    const message = props.message || props.msg || props.data || (evt.type ? props : evt) || {};
    const info = props.info || message?.info || props.meta || {};
    const role = normalizeMessageRole(
      info?.role ||
      info?.author ||
      message?.role ||
      message?.author ||
      "unknown",
      "unknown",
    );
    const msgId =
      getMsgIdFromInfo(info) ||
      getMsgIdFromInfo(message) ||
      message?.id ||
      message?.messageID ||
      message?.messageId ||
      message?.message_id ||
      null;
    const finished =
      info?.finish === "stop" ||
      Boolean(info?.time?.completed) ||
      message?.finish === "stop" ||
      Boolean(message?.time?.completed);
    const title = String(info?.summary?.title || message?.summary?.title || "").trim();
    const text = String(
      textFromMessage(message) ||
      textFromMessage(props.delta) ||
      textFromMessage(info?.delta) ||
      "",
    ).trim();
    return { role, msgId, finished, title, text, info, props };
  }

  function extractPromptInputText(input) {
    const src = input && typeof input === "object" ? input : {};
    const candidates = [
      src.text,
      src.properties?.text,
      src.event?.properties?.text,
      src.prompt,
      src.query,
      src.input,
      src.value,
      src.message,
      src.message?.text,
      src.message?.content,
      src.prompt?.text,
      src.prompt?.content,
      src.prompt?.message,
      src.parts,
      src.output?.parts,
      src.event?.properties?.parts,
    ];
    for (const candidate of candidates) {
      const text =
        Array.isArray(candidate)
          ? extractUserTextFromParts(candidate)
          : String(textFromMessage(candidate) || "").trim();
      if (!text) {
        continue;
      }
      if (isSummaryFallbackText(text)) {
        continue;
      }
      if (text.includes(config.packDelimiterStart) || text.includes(config.packDelimiterEnd)) {
        continue;
      }
      return text;
    }
    return "";
  }

  function beginTurnWithUserText(text, source = "unknown") {
    const clean = String(text || "").trim();
    if (!clean) {
      return false;
    }
    if (isSummaryFallbackText(clean)) {
      return false;
    }
    if (clean.includes(config.packDelimiterStart) || clean.includes(config.packDelimiterEnd)) {
      return false;
    }
    if (clean === activeTurnUserText && !activeTurnAssistantId) {
      return false;
    }
    activeTurnUserText = clean;
    activeTurnUserId = null;
    activeTurnAssistantId = null;
    activeTurnAssistantText = "";
    logDebug("turn begin", { source, textLen: clean.length });
    return true;
  }

  function rememberAssistantEventText(msgId, text) {
    const cleanId = String(msgId || "").trim();
    if (!cleanId) {
      return false;
    }
    const cleanText = String(text || "").trim();
    if (assistantEventTextById.get(cleanId) === cleanText) {
      return true;
    }
    assistantEventTextById.set(cleanId, cleanText);
    if (assistantEventTextById.size > 4096) {
      const first = assistantEventTextById.keys().next().value;
      if (first) {
        assistantEventTextById.delete(first);
      }
    }
    return false;
  }

  async function replaceHistoryEntryText(entryId, role, text) {
    const targetId = String(entryId || "").trim();
    if (!targetId) {
      return null;
    }
    const cleanRole = normalizeMessageRole(role, "assistant");
    const cleanText = String(text || "").trim();
    if (!cleanText) {
      return null;
    }
    return storage.updateHistoryEntryById(targetId, {
      role: cleanRole,
      text: cleanText,
      ts: new Date().toISOString(),
    });
  }

  async function upsertTurnWithAssistant(assistantText, msgId) {
    const cleanAssistant = String(assistantText || "").trim();
    if (!cleanAssistant) {
      return false;
    }
    const sessionId = await ensureActiveSession("turn.upsert");
    if (!activeTurnUserText) {
      logDebug("assistant skipped without active user turn", {
        msgId,
        sample: cleanAssistant.slice(0, 240),
      });
      return false;
    }
    if (cleanAssistant === activeTurnAssistantText) {
      return false;
    }
    if (rememberAssistantEventText(msgId, cleanAssistant)) {
      return false;
    }

    if (!activeTurnAssistantId) {
      const userRow = await recordTurn(storage, "user", activeTurnUserText, sessionId);
      activeTurnUserId = userRow?.id || null;
      const assistantRow = await recordTurn(storage, "assistant", cleanAssistant, sessionId);
      activeTurnAssistantId = assistantRow?.id || null;
      await addPinsFromText(storage, activeTurnUserText, config);
    } else {
      const updated = await replaceHistoryEntryText(activeTurnAssistantId, "assistant", cleanAssistant);
      if (!updated) {
        const assistantRow = await recordTurn(storage, "assistant", cleanAssistant, sessionId);
        activeTurnAssistantId = assistantRow?.id || null;
      }
    }

    activeTurnAssistantText = cleanAssistant;
    await addPinsFromText(storage, cleanAssistant, config);
    await autoCompactIfNeeded();
    await storage.refreshManifest();
    return true;
  }

  async function autoCompactIfNeeded() {
    if (!config.autoCompact) {
      return;
    }
    await maybeCompact(storage, config, false);
  }

  async function handleMessageUpdated(payload) {
    const meta = extractMessageUpdatedMeta(payload);

    if (meta.role === "user") {
      if (beginTurnWithUserText(meta.text, "message.updated:user")) {
        logDebug("user queued", {
          msgId: meta.msgId,
          textLen: String(meta.text || "").trim().length,
        });
      }
      return;
    }

    if (meta.role !== "assistant") {
      return;
    }

    let assistantText = meta.text;
    if (meta.msgId && streamBuf.has(meta.msgId)) {
      const buf = streamBuf.get(meta.msgId);
      if (meta.finished) {
        streamBuf.delete(meta.msgId);
      }
      assistantText = String(buf?.text || "").trim() || assistantText;
    }

    const flushed = await upsertTurnWithAssistant(assistantText, meta.msgId);
    if (!flushed) {
      logDebug("assistant final not written", {
        msgId: meta.msgId,
        hasText: Boolean(String(assistantText || "").trim()),
        hasActiveUser: Boolean(activeTurnUserText),
      });
    }
  }

  async function handleEvent(payload) {
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
        part.message_id ||
        part.id ||
        delta?.messageID ||
        delta?.messageId ||
        delta?.message_id ||
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
          logDebug("message.part.updated missing", {
            msgId,
            partKeys: part ? Object.keys(part) : [],
            deltaKeys: delta && typeof delta === "object" ? Object.keys(delta) : [],
            deltaSample: JSON.stringify(delta).slice(0, 400),
          });
        }
      }
      return;
    }

    logDebug("event", { type, propKeys: Object.keys(props || {}) });

    if (type === "session.created") {
      await rotateSession("event:session.created");
      await storage.ensureInitialized();
      await storage.refreshManifest();
      return;
    }

    if (type === "session.diff") {
      const diff = props.diff;
      logDebug("session.diff sample", {
        diffKeys: diff && typeof diff === "object" ? Object.keys(diff) : [],
        sample: JSON.stringify(diff).slice(0, 1200),
      });
      return;
    }

    if (type === "tui.prompt.append") {
      const promptText = extractPromptInputText(payload) || String(props.text || "").trim();
      if (promptText) {
        beginTurnWithUserText(promptText, "event:tui.prompt.append");
      }
      return;
    }

    if (type === "message.updated") {
      await handleMessageUpdated(payload);
      return;
    }

    // Tool events vary by version; log their shapes for later parsing.
    if (String(type).includes("tool") || String(type).startsWith("bash")) {
      logDebug("tool-like event", {
        type,
        sample: JSON.stringify(props).slice(0, 1200),
      });
    }
  }

  return {
    event: async (payload) => safeRun(workspaceDir, debugEnabled, "event", async () => handleEvent(payload)),
    "chat.message": async (input, output) =>
      safeRun(workspaceDir, debugEnabled, "chat.message", async () => {
        const userText =
          extractPromptInputText(output) ||
          extractPromptInputText(input) ||
          extractUserTextFromParts(output?.parts);
        if (userText) {
          beginTurnWithUserText(userText, "chat.message");
        }
      }),
    "session.created": async () =>
      safeRun(workspaceDir, debugEnabled, "session.created", async () => {
        await rotateSession("hook:session.created");
        await storage.ensureInitialized();
        await storage.refreshManifest();
      }),
    "message.updated": async (input) =>
      safeRun(workspaceDir, debugEnabled, "message.updated", async () => {
        await handleMessageUpdated(input);
      }),
    "tool.execute.after": async (input, output) =>
      safeRun(workspaceDir, debugEnabled, "tool.execute.after", async () => {
        const commandText = textFromMessage(input?.args || input);
        const resultText = textFromMessage(output);
        logDebug("tool.execute.after ignored for history", {
          commandLen: commandText.length,
          resultLen: resultText.length,
        });
      }),
    "tui.prompt.append": async (input, output) =>
      safeRun(workspaceDir, debugEnabled, "tui.prompt.append", async () => {
        const userText = extractPromptInputText(input);
        if (userText) {
          beginTurnWithUserText(userText, "tui.prompt.append");
        }
        if (!config.autoInject) {
          return;
        }
        const pack = await buildContextPack(storage, config);
        appendPrompt(output, pack.block);
        await storage.refreshManifest();
      }),
    "tui.command.execute": async (input, output) =>
      safeRun(workspaceDir, debugEnabled, "tui.command.execute", async () => {
        const raw =
          input?.command ||
          input?.text ||
          (typeof input === "string" ? input : "");
        if (!String(raw).trim().startsWith("ctx")) {
          return;
        }
        const result = await runCtxCommand(raw, storage, config);
        setCommandOutput(output, result);
      }),
  };
};

export default ContextFSPlugin;
