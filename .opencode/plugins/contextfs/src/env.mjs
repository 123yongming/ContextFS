import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function stripInlineComment(text) {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === "\"" && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "#" && !inSingle && !inDouble) {
      return text.slice(0, i).trim();
    }
  }
  return text.trim();
}

function unquoteValue(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function parseDotEnv(rawText) {
  const out = {};
  const lines = String(rawText || "").split(/\r?\n/);
  for (const lineRaw of lines) {
    const line = stripInlineComment(lineRaw);
    if (!line) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    const value = unquoteValue(line.slice(eq + 1));
    out[key] = value;
  }
  return out;
}

export function contextFsDotEnvPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", ".env");
}

export async function loadContextFsEnv(options = {}) {
  const envPath = String(options.path || contextFsDotEnvPath());
  const override = Boolean(options.override);
  let raw = "";
  try {
    raw = await fs.readFile(envPath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { loaded: false, path: envPath, applied: [] };
    }
    throw err;
  }
  const parsed = parseDotEnv(raw);
  const applied = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!override && Object.prototype.hasOwnProperty.call(process.env, key) && String(process.env[key] || "").trim()) {
      continue;
    }
    process.env[key] = value;
    applied.push(key);
  }
  return { loaded: true, path: envPath, applied };
}

