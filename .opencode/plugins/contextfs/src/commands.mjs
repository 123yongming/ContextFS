import { fileMap } from "./storage.mjs";
import { addPin, parsePinsMarkdown } from "./pins.mjs";
import { maybeCompact } from "./compactor.mjs";
import { buildContextPack } from "./packer.mjs";

function parseArgs(raw) {
  const input = String(raw || "").trim();
  const parts = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(input))) {
    parts.push(m[1] ?? m[2] ?? m[3]);
  }
  return parts;
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeFileName(name) {
  const map = fileMap();
  const target = String(name || "").toLowerCase();
  const allowed = new Set([
    "manifest",
    "manifest.md",
    "pins",
    "pins.md",
    "summary",
    "summary.md",
    "decisions",
    "decisions.md",
    "tasks/current.md",
    "current",
    "history",
    "history.ndjson",
  ]);
  if (!allowed.has(target)) {
    return null;
  }
  if (target === "current" || target === "tasks/current.md") {
    return map.tasks;
  }
  if (target.endsWith(".md") || target.endsWith(".ndjson")) {
    return target;
  }
  return map[target];
}

function textResult(text) {
  return { ok: true, text, exitCode: 0 };
}

function errorResult(text) {
  return { ok: false, text, exitCode: 1 };
}

export async function runCtxCommand(commandLine, storage, config) {
  const argv = parseArgs(commandLine);
  const cleaned = argv[0] === "ctx" ? argv.slice(1) : argv;
  const cmd = cleaned[0];
  const args = cleaned.slice(1);

  if (!cmd || cmd === "help") {
    return textResult(
      [
        "ctx commands:",
        "  ctx ls",
        "  ctx cat <file> [--head 30]",
        "  ctx pin \"<text>\"",
        "  ctx compact",
        "  ctx gc",
      ].join("\n"),
    );
  }

  if (cmd === "ls") {
    const manifest = await storage.readText("manifest");
    const pins = await storage.readText("pins");
    const summary = await storage.readText("summary");
    const pack = await buildContextPack(storage, config);
    const pinsCount = parsePinsMarkdown(pins).length;
    const lines = [
      "# ctx ls",
      "",
      "## manifest",
      ...manifest.split("\n").slice(0, 8),
      "",
      "## overview",
      `- pins.count: ${pinsCount}`,
      `- summary.chars: ${summary.length}`,
      `- pack.tokens(est): ${pack.details.estimatedTokens}`,
      `- workset.turns: ${pack.details.recentTurns}`,
    ];
    return textResult(lines.join("\n"));
  }

  if (cmd === "cat") {
    const target = safeFileName(args[0]);
    if (!target) {
      return errorResult("unknown file. use manifest|pins|summary|decisions|tasks/current.md|history");
    }
    const headIndex = args.indexOf("--head");
    const head = headIndex >= 0 ? toInt(args[headIndex + 1], 30) : null;
    const text = await storage.readText(target);
    const lines = text.split("\n");
    const out = head ? lines.slice(0, head).join("\n") : text;
    return textResult(out);
  }

  if (cmd === "pin") {
    const text = args.join(" ").trim();
    if (!text) {
      return errorResult("usage: ctx pin \"<text>\"");
    }
    const merged = await addPin(storage, text, config);
    await storage.refreshManifest();
    return textResult(`pin added (deduped): count=${merged.length}`);
  }

  if (cmd === "compact") {
    const result = await maybeCompact(storage, config, true);
    await storage.refreshManifest();
    return textResult(
      [
        "compaction done",
        `- compacted: ${String(result.compacted)}`,
        `- before.tokens: ${result.beforeTokens}`,
        `- after.tokens: ${result.afterTokens}`,
        `- compacted.turns: ${result.compactedTurns}`,
      ].join("\n"),
    );
  }

  if (cmd === "gc") {
    const compact = await maybeCompact(storage, config, true);
    const pins = await storage.readText("pins");
    const deduped = parsePinsMarkdown(pins).slice(0, config.pinsMaxItems);
    await storage.writeText(
      "pins",
      `# Pins (short, one line each)\n\n${deduped.map((x) => `- [${x.id}] ${x.text}`).join("\n")}${deduped.length ? "\n" : ""}`,
    );
    await storage.refreshManifest();
    return textResult(`gc done; compacted=${String(compact.compacted)}; pins=${deduped.length}`);
  }

  return errorResult(`unknown ctx command: ${cmd}`);
}
