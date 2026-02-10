export const DEFAULT_CONFIG = {
  enabled: true,
  autoInject: true,
  autoCompact: true,
  contextfsDir: ".contextfs",
  recentTurns: 6,
  tokenThreshold: 8000,
  pinsMaxItems: 20,
  summaryMaxChars: 3200,
  manifestMaxLines: 20,
  pinScanMaxChars: 4000,
  lockStaleMs: 30000,
  searchDefaultK: 5,
  searchSummaryMaxChars: 120,
  timelineBeforeDefault: 3,
  timelineAfterDefault: 3,
  retrievalIndexMaxItems: 8,
  packSummaryMinChars: 128,
  getDefaultHead: 1200,
  debug: false,
  packDelimiterStart: "<<<CONTEXTFS:BEGIN>>>",
  packDelimiterEnd: "<<<CONTEXTFS:END>>>",
};

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function toBool(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1") {
      return true;
    }
    if (v === "false" || v === "0") {
      return false;
    }
  }
  return fallback;
}

function toText(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

export function mergeConfig(userConfig = {}) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...userConfig,
  };
  const rawDelimiterStart = toText(merged.packDelimiterStart, DEFAULT_CONFIG.packDelimiterStart);
  const rawDelimiterEnd = toText(merged.packDelimiterEnd, DEFAULT_CONFIG.packDelimiterEnd);
  const packDelimiterStart = rawDelimiterStart.slice(0, 128) || DEFAULT_CONFIG.packDelimiterStart;
  let packDelimiterEnd = rawDelimiterEnd.slice(0, 128) || DEFAULT_CONFIG.packDelimiterEnd;
  if (packDelimiterStart === packDelimiterEnd) {
    packDelimiterEnd = DEFAULT_CONFIG.packDelimiterEnd;
  }

  return {
    ...merged,
    enabled: toBool(merged.enabled, DEFAULT_CONFIG.enabled),
    autoInject: toBool(merged.autoInject, DEFAULT_CONFIG.autoInject),
    autoCompact: toBool(merged.autoCompact, DEFAULT_CONFIG.autoCompact),
    contextfsDir: toText(merged.contextfsDir, DEFAULT_CONFIG.contextfsDir),
    recentTurns: clampInt(merged.recentTurns, DEFAULT_CONFIG.recentTurns, 1, 64),
    tokenThreshold: clampInt(merged.tokenThreshold, DEFAULT_CONFIG.tokenThreshold, 256, 200000),
    pinsMaxItems: clampInt(merged.pinsMaxItems, DEFAULT_CONFIG.pinsMaxItems, 1, 200),
    summaryMaxChars: clampInt(merged.summaryMaxChars, DEFAULT_CONFIG.summaryMaxChars, 256, 20000),
    manifestMaxLines: clampInt(merged.manifestMaxLines, DEFAULT_CONFIG.manifestMaxLines, 8, 200),
    pinScanMaxChars: clampInt(merged.pinScanMaxChars, DEFAULT_CONFIG.pinScanMaxChars, 256, 50000),
    lockStaleMs: clampInt(merged.lockStaleMs, DEFAULT_CONFIG.lockStaleMs, 1000, 600000),
    searchDefaultK: clampInt(merged.searchDefaultK, DEFAULT_CONFIG.searchDefaultK, 1, 50),
    searchSummaryMaxChars: clampInt(merged.searchSummaryMaxChars, DEFAULT_CONFIG.searchSummaryMaxChars, 40, 400),
    timelineBeforeDefault: clampInt(merged.timelineBeforeDefault, DEFAULT_CONFIG.timelineBeforeDefault, 0, 20),
    timelineAfterDefault: clampInt(merged.timelineAfterDefault, DEFAULT_CONFIG.timelineAfterDefault, 0, 20),
    retrievalIndexMaxItems: clampInt(merged.retrievalIndexMaxItems, DEFAULT_CONFIG.retrievalIndexMaxItems, 0, 50),
    packSummaryMinChars: clampInt(merged.packSummaryMinChars, DEFAULT_CONFIG.packSummaryMinChars, 32, 2000),
    getDefaultHead: clampInt(merged.getDefaultHead, DEFAULT_CONFIG.getDefaultHead, 64, 200000),
    debug: toBool(merged.debug, DEFAULT_CONFIG.debug),
    packDelimiterStart,
    packDelimiterEnd,
  };
}
