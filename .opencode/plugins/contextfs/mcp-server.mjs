#!/usr/bin/env node
import path from "node:path";
import process from "node:process";

import { mergeConfig } from "./src/config.mjs";
import { ContextFsStorage } from "./src/storage.mjs";
import {
  getRecord,
  importantWorkflowText,
  saveMemory,
  searchRecords,
  timelineRecords,
} from "./src/retrieval_api.mjs";

const SERVER_NAME = "contextfs";
const SERVER_VERSION = "0.1.0";
const JSONRPC_VERSION = "2.0";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

const TOOL_DEFINITIONS = [
  {
    name: "search",
    description: "Search compact L0 rows by query with optional scope/session filters.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        k: { type: "integer", minimum: 1, maximum: 50 },
        scope: { type: "string", enum: ["all", "hot", "archive"] },
        session: { type: "string" },
        session_id: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "timeline",
    description: "Fetch L0 neighborhood rows around an anchor id.",
    inputSchema: {
      type: "object",
      properties: {
        anchor_id: { type: "string", minLength: 1 },
        before: { type: "integer", minimum: 0, maximum: 20 },
        after: { type: "integer", minimum: 0, maximum: 20 },
        session: { type: "string" },
        session_id: { type: "string" },
      },
      required: ["anchor_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get",
    description: "Fetch L2 detail for one id with optional head budget and session filter.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        head: { type: "integer", minimum: 0, maximum: 200000 },
        session: { type: "string" },
        session_id: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "save_memory",
    description: "Persist an explicit memory entry into history with optional metadata and session scope.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1 },
        title: { type: "string" },
        role: { type: "string", enum: ["user", "assistant", "system", "tool", "note", "unknown"] },
        type: { type: "string" },
        session: { type: "string" },
        session_id: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "__IMPORTANT",
    description: "Workflow guide for progressive retrieval usage (search -> timeline -> get).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

function parseServerArgs(argv) {
  let workspaceDir = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    const part = String(argv[i] || "");
    if (part === "--workspace") {
      const value = String(argv[i + 1] || "").trim();
      if (!value) {
        throw new Error("missing value for --workspace");
      }
      workspaceDir = path.resolve(value);
      i += 1;
    }
  }
  return workspaceDir;
}

function parseHeaders(raw) {
  const headers = {};
  const lines = String(raw || "").split(/\r?\n/);
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key) {
      headers[key] = value;
    }
  }
  return headers;
}

function indexOfHeaderEnd(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf < 0) {
    return lf;
  }
  if (lf < 0) {
    return crlf;
  }
  return Math.min(crlf, lf);
}

function looksLikeLineJson(buffer) {
  let i = 0;
  while (i < buffer.length) {
    const ch = buffer[i];
    if (ch === 13 || ch === 10 || ch === 32 || ch === 9) {
      i += 1;
      continue;
    }
    return ch === 123 || ch === 91;
  }
  return false;
}

function safeErrorText(err) {
  const text = String(err?.message || err || "unknown error").trim();
  return text || "unknown error";
}

function serializeToolPayload(payload) {
  if (typeof payload === "string") {
    return payload;
  }
  return JSON.stringify(payload, null, 2);
}

function makeTextContent(text) {
  return [{ type: "text", text: String(text || "") }];
}

const workspaceDir = parseServerArgs(process.argv.slice(2));
const config = mergeConfig({
  ...(globalThis.CONTEXTFS_CONFIG || {}),
  contextfsDir: ".contextfs",
});
const storage = new ContextFsStorage(workspaceDir, config);
await storage.ensureInitialized();

let stdoutWriteChain = Promise.resolve();
let inputBuffer = Buffer.alloc(0);
let shutdownRequested = false;

function makePacket(payload, framing = "content-length") {
  const json = JSON.stringify(payload);
  if (framing === "line-json") {
    return `${json}\n`;
  }
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

function queueWrite(payload, framing = "content-length") {
  const packet = makePacket(payload, framing);
  stdoutWriteChain = stdoutWriteChain.then(
    () =>
      new Promise((resolve, reject) => {
        process.stdout.write(packet, (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  );
  stdoutWriteChain.catch(() => {
    process.exitCode = 1;
  });
}

function sendResponse(id, result, framing = "content-length") {
  queueWrite({
    jsonrpc: JSONRPC_VERSION,
    id,
    result,
  }, framing);
}

function sendJsonRpcError(id, code, message, data, framing = "content-length") {
  queueWrite({
    jsonrpc: JSONRPC_VERSION,
    id: id ?? null,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  }, framing);
}

async function callTool(name, args) {
  if (name === "search") {
    const payload = await searchRecords(args || {}, storage, config);
    return {
      content: makeTextContent(serializeToolPayload(payload)),
      structuredContent: payload,
    };
  }
  if (name === "timeline") {
    const payload = await timelineRecords(args || {}, storage, config);
    return {
      content: makeTextContent(serializeToolPayload(payload)),
      structuredContent: payload,
    };
  }
  if (name === "get") {
    const payload = await getRecord(args || {}, storage, config);
    return {
      content: makeTextContent(serializeToolPayload(payload)),
      structuredContent: payload,
    };
  }
  if (name === "save_memory") {
    const payload = await saveMemory(args || {}, storage, config);
    return {
      content: makeTextContent(serializeToolPayload(payload)),
      structuredContent: payload,
    };
  }
  if (name === "__IMPORTANT") {
    return {
      content: makeTextContent(importantWorkflowText()),
    };
  }
  return {
    isError: true,
    content: makeTextContent(`unknown tool: ${String(name || "")}`),
  };
}

async function dispatchMessage(message, framing = "content-length") {
  if (!message || typeof message !== "object") {
    return;
  }
  const method = String(message.method || "");
  const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : undefined;
  const params = message.params && typeof message.params === "object" ? message.params : {};

  if (method === "initialize") {
    const protocolVersion = String(params.protocolVersion || DEFAULT_PROTOCOL_VERSION);
    sendResponse(id ?? null, {
      protocolVersion,
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      instructions: importantWorkflowText(),
    }, framing);
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "ping") {
    sendResponse(id ?? null, {}, framing);
    return;
  }

  if (method === "tools/list") {
    sendResponse(id ?? null, {
      tools: TOOL_DEFINITIONS,
    }, framing);
    return;
  }

  if (method === "tools/call") {
    const name = String(params.name || "").trim();
    const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
    try {
      const result = await callTool(name, args);
      sendResponse(id ?? null, result, framing);
    } catch (err) {
      sendResponse(id ?? null, {
        isError: true,
        content: makeTextContent(safeErrorText(err)),
      }, framing);
    }
    return;
  }

  if (method === "shutdown") {
    shutdownRequested = true;
    sendResponse(id ?? null, {}, framing);
    return;
  }

  if (method === "exit") {
    if (shutdownRequested) {
      process.exit(0);
    } else {
      process.exit(1);
    }
    return;
  }

  if (id !== undefined) {
    sendJsonRpcError(id, -32601, `method not found: ${method}`, undefined, framing);
  }
}

function processInputBuffer() {
  while (true) {
    if (looksLikeLineJson(inputBuffer)) {
      const lineEnd = inputBuffer.indexOf("\n");
      if (lineEnd < 0) {
        return;
      }
      const line = inputBuffer.slice(0, lineEnd).toString("utf8").trim();
      inputBuffer = inputBuffer.slice(lineEnd + 1);
      if (!line) {
        continue;
      }
      try {
        const message = JSON.parse(line);
        void dispatchMessage(message, "line-json");
      } catch (err) {
        sendJsonRpcError(null, -32700, "parse error", safeErrorText(err), "line-json");
      }
      continue;
    }

    const headerEnd = indexOfHeaderEnd(inputBuffer);
    if (headerEnd < 0) {
      return;
    }
    const sepLen = inputBuffer.slice(headerEnd, headerEnd + 4).toString("utf8") === "\r\n\r\n" ? 4 : 2;
    const headerText = inputBuffer.slice(0, headerEnd).toString("utf8");
    const headers = parseHeaders(headerText);
    const length = Number(headers["content-length"]);
    if (!Number.isFinite(length) || length < 0) {
      inputBuffer = Buffer.alloc(0);
      return;
    }
    const total = headerEnd + sepLen + length;
    if (inputBuffer.length < total) {
      return;
    }
    const body = inputBuffer.slice(headerEnd + sepLen, total).toString("utf8");
    inputBuffer = inputBuffer.slice(total);
    try {
      const message = JSON.parse(body);
      void dispatchMessage(message, "content-length");
    } catch (err) {
      sendJsonRpcError(null, -32700, "parse error", safeErrorText(err), "content-length");
    }
  }
}

process.stdin.on("data", (chunk) => {
  const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  inputBuffer = Buffer.concat([inputBuffer, part]);
  processInputBuffer();
});

process.stdin.on("error", () => {
  process.exitCode = 1;
});

process.stdin.on("end", () => {
  process.exit(0);
});

process.on("SIGINT", () => {
  process.exit(0);
});

process.on("SIGTERM", () => {
  process.exit(0);
});
