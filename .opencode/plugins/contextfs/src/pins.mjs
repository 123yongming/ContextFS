function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[`"'“”‘’]/g, "")
    .trim();
}

function shortHash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16).slice(0, 8);
}

const CONSTRAINT_HINT = /(必须|不能|不要|只能|禁止|保持不改|不改架构|must|must not|should not|never|only|do not|don't|contract|constraint|forbid|ban)/i;

export function parsePinsMarkdown(content) {
  return String(content || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const cleaned = line.replace(/^-\s*/, "");
      const withId = cleaned.match(/^\[(P-[a-f0-9]{8})\]\s*(.+)$/i);
      if (withId) {
        return { id: withId[1], text: withId[2] };
      }
      return { id: `P-${shortHash(normalize(cleaned))}`, text: cleaned };
    });
}

export function serializePinsMarkdown(items) {
  const body = items.map((item) => `- [${item.id}] ${item.text}`).join("\n");
  return `# Pins (short, one line each)\n\n${body}${body ? "\n" : ""}`;
}

function isNearDuplicate(a, b) {
  if (a === b) {
    return true;
  }
  const prefix = 24;
  return a.startsWith(b.slice(0, prefix)) || b.startsWith(a.slice(0, prefix));
}

export function dedupePins(items, maxItems) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const text = String(item.text || "").trim();
    if (!text) {
      continue;
    }
    const n = normalize(text);
    if (!n || seen.has(n)) {
      continue;
    }
    const near = out.some((x) => isNearDuplicate(normalize(x.text), n));
    if (near) {
      continue;
    }
    seen.add(n);
    out.push({
      id: item.id || `P-${shortHash(n)}`,
      text,
    });
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}

export function extractCandidatePinsFromText(text, maxChars = 4000) {
  const source = String(text || "").slice(0, maxChars);
  const segments = source
    .split(/[\n。！？!?;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const hits = [];
  for (const segment of segments) {
    if (!CONSTRAINT_HINT.test(segment)) {
      continue;
    }
    const cleaned = segment.replace(/^[-*\d.\s]+/, "").trim();
    if (cleaned.length < 6) {
      continue;
    }
    hits.push(cleaned);
  }
  return hits;
}

export async function addPin(storage, pinText, config) {
  const raw = await storage.readText("pins");
  const current = parsePinsMarkdown(raw);
  const merged = dedupePins([...current, { text: pinText }], config.pinsMaxItems);
  await storage.writeText("pins", serializePinsMarkdown(merged));
  return merged;
}

export async function addPinsFromText(storage, text, config) {
  const candidates = extractCandidatePinsFromText(text, config.pinScanMaxChars);
  if (!candidates.length) {
    return [];
  }
  const raw = await storage.readText("pins");
  const current = parsePinsMarkdown(raw);
  const merged = dedupePins(
    [...current, ...candidates.map((t) => ({ text: t }))],
    config.pinsMaxItems,
  );
  await storage.writeText("pins", serializePinsMarkdown(merged));
  return candidates;
}
