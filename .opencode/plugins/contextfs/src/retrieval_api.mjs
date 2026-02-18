import { runCtxCommandArgs } from "./commands.mjs";

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.max(min, Math.min(max, safe));
}

function normalizeScope(scope) {
  const value = String(scope ?? "all").trim().toLowerCase();
  if (value === "all" || value === "hot" || value === "archive") {
    return value;
  }
  throw new Error("scope must be one of: all|hot|archive");
}

function normalizeSession(input, alias) {
  const source = input ?? alias;
  if (source === undefined || source === null) {
    return null;
  }
  const value = String(source).trim();
  if (!value) {
    throw new Error("session must be a non-empty string when provided");
  }
  const lower = value.toLowerCase();
  if (lower === "all" || lower === "current") {
    return lower;
  }
  return value;
}

function parseJsonOutput(result, label) {
  if (!result?.ok) {
    throw new Error(String(result?.text || `${label} failed`));
  }
  const raw = String(result?.text || "").trim();
  if (!raw) {
    throw new Error(`${label} returned empty output`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function runJsonCtx(argv, storage, config, label) {
  const result = await runCtxCommandArgs(argv, storage, config);
  return parseJsonOutput(result, label);
}

function pushSessionArgv(argv, session) {
  if (!session) {
    return;
  }
  argv.push("--session", session);
}

export async function searchRecords(args, storage, config) {
  const query = String(args?.query ?? "").trim();
  if (!query) {
    throw new Error("query is required");
  }
  const k = clampInt(args?.k, Number(config?.searchDefaultK || 5), 1, 50);
  const scope = normalizeScope(args?.scope);
  const session = normalizeSession(args?.session, args?.session_id);
  const argv = ["ctx", "search", query, "--k", String(k), "--scope", scope, "--json"];
  pushSessionArgv(argv, session);
  return runJsonCtx(argv, storage, config, "search");
}

export async function timelineRecords(args, storage, config) {
  const anchorId = String(args?.anchor_id ?? args?.anchor ?? "").trim();
  if (!anchorId) {
    throw new Error("anchor_id is required");
  }
  const before = clampInt(args?.before, Number(config?.timelineBeforeDefault || 3), 0, 20);
  const after = clampInt(args?.after, Number(config?.timelineAfterDefault || 3), 0, 20);
  const session = normalizeSession(args?.session, args?.session_id);
  const argv = [
    "ctx",
    "timeline",
    anchorId,
    "--before",
    String(before),
    "--after",
    String(after),
    "--json",
  ];
  pushSessionArgv(argv, session);
  return runJsonCtx(argv, storage, config, "timeline");
}

export async function getRecord(args, storage, config) {
  const id = String(args?.id ?? "").trim();
  if (!id) {
    throw new Error("id is required");
  }
  const head = clampInt(args?.head, Number(config?.getDefaultHead || 1200), 0, 200000);
  const session = normalizeSession(args?.session, args?.session_id);
  const argv = ["ctx", "get", id, "--head", String(head), "--json"];
  pushSessionArgv(argv, session);
  return runJsonCtx(argv, storage, config, "get");
}

export async function saveMemory(args, storage, config) {
  const text = String(args?.text ?? "").trim();
  if (!text) {
    throw new Error("text is required");
  }
  const title = String(args?.title ?? "").trim();
  const role = String(args?.role ?? "").trim();
  const type = String(args?.type ?? "").trim();
  const session = normalizeSession(args?.session, args?.session_id);
  const argv = ["ctx", "save", text, "--json"];
  if (title) {
    argv.push("--title", title);
  }
  if (role) {
    argv.push("--role", role);
  }
  if (type) {
    argv.push("--type", type);
  }
  if (session) {
    argv.push("--session", session);
  }
  return runJsonCtx(argv, storage, config, "save_memory");
}

export function importantWorkflowText() {
  return [
    "ContextFS progressive retrieval workflow:",
    "1. search(query, k?, scope?, session?) -> L0 compact rows.",
    "2. timeline(anchor_id, before?, after?, session?) -> L0 local context window.",
    "3. get(id, head?, session?) -> L2 detailed record with budgeted payload.",
    "4. save_memory(text, title?, role?, type?, session?) -> explicit WRITE record.",
    "",
    "Usage guidance:",
    "- Prefer search -> timeline -> get to minimize token usage.",
    "- Use save_memory to persist an important fact for future retrieval.",
    "- Use scope=all|hot|archive to control retrieval pool.",
    "- Use session=all|current|<session-id> for isolation.",
    "- Use head to enforce output budget when requesting detail.",
  ].join("\n");
}
