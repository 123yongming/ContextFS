import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { mergeConfig } from "../src/config.mjs";
import { ContextFsStorage } from "../src/storage.mjs";

function parseHeaders(raw) {
  const out = {};
  const lines = String(raw || "").split("\r\n");
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key) {
      out[key] = value;
    }
  }
  return out;
}

class StdioMcpClient {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.stderr = "";
    this.exited = false;
    this.exitCode = null;
    this.exitSignal = null;

    proc.stdout.on("data", (chunk) => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.buffer = Buffer.concat([this.buffer, part]);
      this.processBuffer();
    });

    proc.stderr.on("data", (chunk) => {
      this.stderr += String(chunk || "");
    });

    proc.on("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      this.exitSignal = signal;
      for (const [id, handlers] of this.pending.entries()) {
        handlers.reject(new Error(`mcp process exited before response: id=${id}, code=${code}, signal=${signal}`));
      }
      this.pending.clear();
    });
  }

  processBuffer() {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const headerText = this.buffer.slice(0, headerEnd).toString("utf8");
      const headers = parseHeaders(headerText);
      const length = Number(headers["content-length"]);
      if (!Number.isFinite(length) || length < 0) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      const total = headerEnd + 4 + length;
      if (this.buffer.length < total) {
        return;
      }
      const body = this.buffer.slice(headerEnd + 4, total).toString("utf8");
      this.buffer = this.buffer.slice(total);

      let message = null;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(message, "id")) {
        continue;
      }
      const handlers = this.pending.get(message.id);
      if (!handlers) {
        continue;
      }
      this.pending.delete(message.id);
      handlers.resolve(message);
    }
  }

  write(payload) {
    const json = JSON.stringify(payload);
    const packet = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
    this.proc.stdin.write(packet);
  }

  request(method, params = {}) {
    if (this.exited) {
      return Promise.reject(new Error(`mcp process already exited: code=${this.exitCode}, signal=${this.exitSignal}`));
    }
    const id = this.nextId;
    this.nextId += 1;
    this.write({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method, params = {}) {
    if (this.exited) {
      return;
    }
    this.write({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  async initialize() {
    const init = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: {
        name: "contextfs-test-client",
        version: "0.1.0",
      },
      capabilities: {},
    });
    this.notify("notifications/initialized", {});
    return init;
  }

  async close() {
    if (this.exited) {
      return;
    }
    try {
      await this.request("shutdown", {});
    } catch {
      // ignore
    }
    try {
      this.notify("exit", {});
    } catch {
      // ignore
    }
    await new Promise((resolve) => {
      if (this.exited) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        if (!this.exited) {
          this.proc.kill("SIGTERM");
        }
      }, 1500);
      this.proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

class LineJsonMcpClient {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.exited = false;
    this.exitCode = null;
    this.exitSignal = null;

    proc.stdout.on("data", (chunk) => {
      this.buffer += String(chunk || "");
      this.processBuffer();
    });

    proc.stderr.on("data", (chunk) => {
      this.stderr += String(chunk || "");
    });

    proc.on("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      this.exitSignal = signal;
      for (const [id, handlers] of this.pending.entries()) {
        handlers.reject(new Error(`mcp process exited before response: id=${id}, code=${code}, signal=${signal}`));
      }
      this.pending.clear();
    });
  }

  processBuffer() {
    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx < 0) {
        return;
      }
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) {
        continue;
      }
      let message = null;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(message, "id")) {
        continue;
      }
      const handlers = this.pending.get(message.id);
      if (!handlers) {
        continue;
      }
      this.pending.delete(message.id);
      handlers.resolve(message);
    }
  }

  write(payload) {
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method, params = {}) {
    if (this.exited) {
      return Promise.reject(new Error(`mcp process already exited: code=${this.exitCode}, signal=${this.exitSignal}`));
    }
    const id = this.nextId;
    this.nextId += 1;
    this.write({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method, params = {}) {
    if (this.exited) {
      return;
    }
    this.write({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  async initialize() {
    const init = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: {
        name: "contextfs-line-json-test-client",
        version: "0.1.0",
      },
      capabilities: {},
    });
    this.notify("notifications/initialized", {});
    return init;
  }

  async close() {
    if (this.exited) {
      return;
    }
    try {
      await this.request("shutdown", {});
    } catch {
      // ignore
    }
    try {
      this.notify("exit", {});
    } catch {
      // ignore
    }
    await new Promise((resolve) => {
      if (this.exited) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        if (!this.exited) {
          this.proc.kill("SIGTERM");
        }
      }, 1500);
      this.proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function withTempStorage(run) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextfs-mcp-test-"));
  const config = mergeConfig({ contextfsDir: ".contextfs" });
  const storage = new ContextFsStorage(workspaceDir, config);
  await storage.ensureInitialized();
  try {
    await run({ workspaceDir, storage, config });
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
}

function getToolText(result) {
  const text = result?.content?.[0]?.text;
  assert.equal(typeof text, "string");
  assert.ok(text.length > 0);
  return text;
}

async function withMcpClient(workspaceDir, run) {
  const serverPath = fileURLToPath(new URL("../mcp-server.mjs", import.meta.url));
  const proc = spawn(process.execPath, [serverPath, "--workspace", workspaceDir], {
    cwd: path.dirname(serverPath),
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CONTEXTFS_EMBEDDING_PROVIDER: "fake",
      CONTEXTFS_VECTOR_PROVIDER: "fake",
    },
  });
  const client = new StdioMcpClient(proc);
  try {
    await run(client);
  } finally {
    await client.close();
    assert.equal(client.exitCode, 0, `stderr:\n${client.stderr}`);
  }
}

async function withLineJsonMcpClient(workspaceDir, run) {
  const serverPath = fileURLToPath(new URL("../mcp-server.mjs", import.meta.url));
  const proc = spawn(process.execPath, [serverPath, "--workspace", workspaceDir], {
    cwd: path.dirname(serverPath),
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CONTEXTFS_EMBEDDING_PROVIDER: "fake",
      CONTEXTFS_VECTOR_PROVIDER: "fake",
    },
  });
  const client = new LineJsonMcpClient(proc);
  try {
    await run(client);
  } finally {
    await client.close();
    assert.equal(client.exitCode, 0, `stderr:\n${client.stderr}`);
  }
}

test("mcp tools/list exposes search/timeline/get/save_memory/__IMPORTANT and initialize works", async () => {
  await withTempStorage(async ({ workspaceDir }) => {
    await withMcpClient(workspaceDir, async (client) => {
      const init = await client.initialize();
      assert.ok(init.result);
      assert.equal(typeof init.result.protocolVersion, "string");
      assert.ok(init.result.capabilities);
      assert.ok(init.result.capabilities.tools);

      const listed = await client.request("tools/list", {});
      assert.ok(listed.result);
      const tools = Array.isArray(listed.result.tools) ? listed.result.tools : [];
      const names = tools.map((tool) => tool.name);
      assert.ok(names.includes("search"));
      assert.ok(names.includes("timeline"));
      assert.ok(names.includes("get"));
      assert.ok(names.includes("save_memory"));
      assert.ok(names.includes("__IMPORTANT"));
    });
  });
});

test("mcp search/timeline/get mirror ctx --json behavior", async () => {
  await withTempStorage(async ({ workspaceDir, storage }) => {
    await storage.appendHistory({
      role: "user",
      text: "needle alpha first row",
      ts: "2026-02-16T00:00:01.000Z",
      session_id: "S-ONE",
    });
    await storage.appendHistory({
      role: "assistant",
      text: "needle beta second row",
      ts: "2026-02-16T00:00:02.000Z",
      session_id: "S-ONE",
    });
    await storage.appendHistory({
      role: "assistant",
      text: "other session row",
      ts: "2026-02-16T00:00:03.000Z",
      session_id: "S-TWO",
    });

    await withMcpClient(workspaceDir, async (client) => {
      await client.initialize();

      const searchResp = await client.request("tools/call", {
        name: "search",
        arguments: {
          query: "needle",
          k: 3,
          scope: "all",
          session: "S-ONE",
        },
      });
      assert.ok(searchResp.result);
      assert.equal(Boolean(searchResp.result.isError), false);
      const searchPayload = JSON.parse(getToolText(searchResp.result));
      assert.equal(searchPayload.layer, "L0");
      assert.ok(Array.isArray(searchPayload.results));
      assert.ok(searchPayload.results.length >= 1);
      assert.ok(searchPayload.results.every((row) => row.layer === "L0"));
      const anchorId = String(searchPayload.results[0].id || "");
      assert.ok(anchorId);

      const timelineResp = await client.request("tools/call", {
        name: "timeline",
        arguments: {
          anchor_id: anchorId,
          before: 1,
          after: 1,
          session: "S-ONE",
        },
      });
      assert.ok(timelineResp.result);
      assert.equal(Boolean(timelineResp.result.isError), false);
      const timelinePayload = JSON.parse(getToolText(timelineResp.result));
      assert.equal(timelinePayload.layer, "L0");
      assert.equal(String(timelinePayload.anchor), anchorId);
      assert.ok(Array.isArray(timelinePayload.results));
      assert.ok(timelinePayload.results.length >= 1);

      const getResp = await client.request("tools/call", {
        name: "get",
        arguments: {
          id: anchorId,
          head: 120,
          session: "S-ONE",
        },
      });
      assert.ok(getResp.result);
      assert.equal(Boolean(getResp.result.isError), false);
      const getPayload = JSON.parse(getToolText(getResp.result));
      if (getPayload.note === "budget_too_small") {
        assert.equal(getPayload.truncated, true);
      } else {
        assert.equal(getPayload.layer, "L2");
        assert.equal(String(getPayload.record.id), anchorId);
      }

      const importantResp = await client.request("tools/call", {
        name: "__IMPORTANT",
        arguments: {},
      });
      assert.ok(importantResp.result);
      const importantText = getToolText(importantResp.result);
      assert.ok(importantText.includes("search(query"));
      assert.ok(importantText.includes("timeline(anchor_id"));
      assert.ok(importantText.includes("get(id"));
      assert.ok(importantText.includes("save_memory(text"));
    });
  });
});

test("mcp save_memory persists a record retrievable by search and get", async () => {
  await withTempStorage(async ({ workspaceDir }) => {
    await withMcpClient(workspaceDir, async (client) => {
      await client.initialize();

      const saveResp = await client.request("tools/call", {
        name: "save_memory",
        arguments: {
          text: "manual memory for auth retries",
          title: "Auth Retries",
          role: "assistant",
          type: "decision",
          session: "S-MCP",
        },
      });
      assert.ok(saveResp.result);
      assert.equal(Boolean(saveResp.result.isError), false);
      const savePayload = JSON.parse(getToolText(saveResp.result));
      assert.equal(savePayload.layer, "WRITE");
      assert.equal(savePayload.action, "save_memory");
      const savedId = String(savePayload.record?.id || "");
      assert.ok(savedId);

      const searchResp = await client.request("tools/call", {
        name: "search",
        arguments: {
          query: "auth retries",
          k: 5,
          session: "S-MCP",
        },
      });
      assert.ok(searchResp.result);
      assert.equal(Boolean(searchResp.result.isError), false);
      const searchPayload = JSON.parse(getToolText(searchResp.result));
      assert.equal(searchPayload.layer, "L0");
      assert.ok(Array.isArray(searchPayload.results));
      assert.ok(searchPayload.results.some((row) => String(row.id) === savedId));

      const getResp = await client.request("tools/call", {
        name: "get",
        arguments: {
          id: savedId,
          session: "S-MCP",
        },
      });
      assert.ok(getResp.result);
      assert.equal(Boolean(getResp.result.isError), false);
      const getPayload = JSON.parse(getToolText(getResp.result));
      assert.equal(getPayload.layer, "L2");
      assert.equal(String(getPayload.record.id), savedId);
      assert.equal(String(getPayload.record.type), "decision");
    });
  });
});

test("mcp tool validation errors return isError payload", async () => {
  await withTempStorage(async ({ workspaceDir }) => {
    await withMcpClient(workspaceDir, async (client) => {
      await client.initialize();
      const badGet = await client.request("tools/call", {
        name: "get",
        arguments: {},
      });
      assert.ok(badGet.result);
      assert.equal(Boolean(badGet.result.isError), true);
      const text = getToolText(badGet.result);
      assert.ok(text.includes("id is required"));

      const badSave = await client.request("tools/call", {
        name: "save_memory",
        arguments: {},
      });
      assert.ok(badSave.result);
      assert.equal(Boolean(badSave.result.isError), true);
      const badSaveText = getToolText(badSave.result);
      assert.ok(badSaveText.includes("text is required"));
    });
  });
});

test("mcp initialize/tools-list work over newline-delimited JSON transport", async () => {
  await withTempStorage(async ({ workspaceDir }) => {
    await withLineJsonMcpClient(workspaceDir, async (client) => {
      const init = await client.initialize();
      assert.ok(init.result);
      assert.equal(typeof init.result.protocolVersion, "string");

      const listed = await client.request("tools/list", {});
      assert.ok(listed.result);
      const tools = Array.isArray(listed.result.tools) ? listed.result.tools : [];
      const names = tools.map((tool) => tool.name);
      assert.ok(names.includes("search"));
      assert.ok(names.includes("timeline"));
      assert.ok(names.includes("get"));
      assert.ok(names.includes("save_memory"));
      assert.ok(names.includes("__IMPORTANT"));
    });
  });
});
