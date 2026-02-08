function trimLine(text, max = 180) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function extractLines(summaryMd) {
  return String(summaryMd || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.replace(/^-\s*/, ""));
}

export function summarizeTurns(turns, maxLines = 16) {
  const lines = [];
  for (const turn of turns) {
    const role = String(turn.role || "unknown").toUpperCase();
    const text = trimLine(turn.text || "", 140);
    if (!text) {
      continue;
    }
    lines.push(`[${role}] ${text}`);
    if (lines.length >= maxLines) {
      break;
    }
  }
  return lines;
}

function dedupeSummaryLines(lines) {
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(line);
  }
  return out;
}

export function mergeSummary(existingSummaryMd, newBulletLines, maxChars) {
  const oldLines = extractLines(existingSummaryMd);
  const merged = dedupeSummaryLines([...oldLines, ...newBulletLines]);
  const lines = [];
  let totalChars = 0;
  for (const line of merged.reverse()) {
    const candidate = `- ${line}`;
    if (totalChars + candidate.length + 1 > maxChars) {
      break;
    }
    lines.push(candidate);
    totalChars += candidate.length + 1;
  }
  lines.reverse();
  const body = lines.join("\n");
  return `# Rolling Summary\n\n${body || "- init: no summary yet."}\n`;
}
