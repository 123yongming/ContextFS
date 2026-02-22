export const DEFAULT_CONFIG = {
  enabled: true,
  autoInject: true,
  autoCompact: true,
  contextfsDir: ".contextfs",
  recentTurns: 6,
  tokenThreshold: 16000,
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
  tracesEnabled: true,
  tracesMaxBytes: 1048576,
  tracesMaxFiles: 3,
  tracesTailDefault: 20,
  traceRankingMaxItems: 8,
  traceQueryMaxChars: 240,
  retrievalMode: "hybrid",
  vectorEnabled: true,
  vectorProvider: "fake",
  embeddingModel: "Pro/BAAI/bge-m3",
  embeddingBaseUrl: "https://api.siliconflow.cn/v1",
  embeddingApiKey: "",
  embeddingTimeoutMs: 20000,
  embeddingMaxRetries: 3,
  embeddingBatchSize: 32,
  compactModel: "Pro/Qwen/Qwen2.5-7B-Instruct",
  compactTimeoutMs: 20000,
  compactMaxRetries: 2,
  vectorDim: 64,
  vectorTopN: 20,
  vectorMinSimilarity: 0.35,
  searchModeDefault: "fallback",
  lexicalEngine: "legacy",
  vectorEngine: "sqlite_vec",
  indexEnabled: true,
  indexPath: "index.sqlite",
  annEnabled: true,
  annTopN: 50,
  annProbeTopN: 200,
  fusionRrfK: 60,
  fusionCandidateMax: 100,
  embeddingTextMaxChars: 4000,
  embeddingAutoCompact: true,
  embeddingHotMaxBytes: 2097152,
  embeddingArchiveMaxBytes: 16777216,
  embeddingDupRatioThreshold: 0.2,
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

function clampFloat(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

function normalizeRetrievalMode(value, fallback) {
  const clean = String(value ?? "").trim().toLowerCase();
  if (clean === "lexical" || clean === "hybrid") {
    return clean;
  }
  return fallback;
}

function normalizeSearchMode(value, fallback) {
  const clean = String(value ?? "").trim().toLowerCase();
  if (clean === "legacy" || clean === "lexical" || clean === "vector" || clean === "hybrid" || clean === "fallback") {
    return clean;
  }
  return fallback;
}

function normalizeLexicalEngine(value, fallback) {
  const clean = String(value ?? "").trim().toLowerCase();
  if (clean === "legacy" || clean === "sqlite_fts5") {
    return clean;
  }
  return fallback;
}

function normalizeVectorEngine(value, fallback) {
  const clean = String(value ?? "").trim().toLowerCase();
  if (clean === "linear" || clean === "sqlite_vec") {
    return clean;
  }
  return fallback;
}

function normalizeVectorProvider(value, fallback) {
  const clean = String(value ?? "").trim().toLowerCase();
  if (clean === "none" || clean === "fake" || clean === "custom" || clean === "siliconflow") {
    return clean;
  }
  return fallback;
}

function pickEnv(...keys) {
  for (const key of keys) {
    const raw = process.env[key];
    if (raw === undefined || raw === null) {
      continue;
    }
    const text = String(raw).trim();
    if (!text) {
      continue;
    }
    return text;
  }
  return undefined;
}

function envConfig() {
  const cfg = {};
  const retrievalMode = pickEnv("CONTEXTFS_RETRIEVAL_MODE");
  const vectorEnabled = pickEnv("CONTEXTFS_VECTOR_ENABLED");
  const vectorProvider = pickEnv("CONTEXTFS_EMBEDDING_PROVIDER", "CONTEXTFS_VECTOR_PROVIDER");
  const embeddingModel = pickEnv("CONTEXTFS_EMBEDDING_MODEL");
  const embeddingBaseUrl = pickEnv("CONTEXTFS_EMBEDDING_BASE_URL");
  const embeddingApiKey = pickEnv("CONTEXTFS_EMBEDDING_API_KEY");
  const embeddingTimeoutMs = pickEnv("CONTEXTFS_EMBEDDING_TIMEOUT_MS");
  const embeddingMaxRetries = pickEnv("CONTEXTFS_EMBEDDING_MAX_RETRIES");
  const embeddingBatchSize = pickEnv("CONTEXTFS_EMBEDDING_BATCH_SIZE");
  const compactModel = pickEnv("CONTEXTFS_COMPACT_MODEL");
  const compactTimeoutMs = pickEnv("CONTEXTFS_COMPACT_TIMEOUT_MS");
  const compactMaxRetries = pickEnv("CONTEXTFS_COMPACT_MAX_RETRIES");
  const searchModeDefault = pickEnv("CONTEXTFS_SEARCH_MODE_DEFAULT");
  const indexEnabled = pickEnv("CONTEXTFS_INDEX_ENABLED");
  const indexPath = pickEnv("CONTEXTFS_INDEX_PATH");
  const lexicalEngine = pickEnv("CONTEXTFS_LEXICAL_ENGINE");
  const vectorEngine = pickEnv("CONTEXTFS_VECTOR_ENGINE");
  const annEnabled = pickEnv("CONTEXTFS_ANN_ENABLED");
  const annTopN = pickEnv("CONTEXTFS_ANN_TOP_N");

  if (retrievalMode !== undefined) cfg.retrievalMode = retrievalMode;
  if (vectorEnabled !== undefined) cfg.vectorEnabled = vectorEnabled;
  if (vectorProvider !== undefined) cfg.vectorProvider = vectorProvider;
  if (embeddingModel !== undefined) cfg.embeddingModel = embeddingModel;
  if (embeddingBaseUrl !== undefined) cfg.embeddingBaseUrl = embeddingBaseUrl;
  if (embeddingApiKey !== undefined) cfg.embeddingApiKey = embeddingApiKey;
  if (embeddingTimeoutMs !== undefined) cfg.embeddingTimeoutMs = embeddingTimeoutMs;
  if (embeddingMaxRetries !== undefined) cfg.embeddingMaxRetries = embeddingMaxRetries;
  if (embeddingBatchSize !== undefined) cfg.embeddingBatchSize = embeddingBatchSize;
  if (compactModel !== undefined) cfg.compactModel = compactModel;
  if (compactTimeoutMs !== undefined) cfg.compactTimeoutMs = compactTimeoutMs;
  if (compactMaxRetries !== undefined) cfg.compactMaxRetries = compactMaxRetries;
  if (searchModeDefault !== undefined) cfg.searchModeDefault = searchModeDefault;
  if (indexEnabled !== undefined) cfg.indexEnabled = indexEnabled;
  if (indexPath !== undefined) cfg.indexPath = indexPath;
  if (lexicalEngine !== undefined) cfg.lexicalEngine = lexicalEngine;
  if (vectorEngine !== undefined) cfg.vectorEngine = vectorEngine;
  if (annEnabled !== undefined) cfg.annEnabled = annEnabled;
  if (annTopN !== undefined) cfg.annTopN = annTopN;
  return cfg;
}

export function mergeConfig(userConfig = {}) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...envConfig(),
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
    tracesEnabled: toBool(merged.tracesEnabled, DEFAULT_CONFIG.tracesEnabled),
    tracesMaxBytes: clampInt(merged.tracesMaxBytes, DEFAULT_CONFIG.tracesMaxBytes, 1024, 50000000),
    tracesMaxFiles: clampInt(merged.tracesMaxFiles, DEFAULT_CONFIG.tracesMaxFiles, 1, 10),
    tracesTailDefault: clampInt(merged.tracesTailDefault, DEFAULT_CONFIG.tracesTailDefault, 1, 200),
    traceRankingMaxItems: clampInt(merged.traceRankingMaxItems, DEFAULT_CONFIG.traceRankingMaxItems, 1, 50),
    traceQueryMaxChars: clampInt(merged.traceQueryMaxChars, DEFAULT_CONFIG.traceQueryMaxChars, 40, 2000),
    retrievalMode: normalizeRetrievalMode(merged.retrievalMode, DEFAULT_CONFIG.retrievalMode),
    searchModeDefault: normalizeSearchMode(merged.searchModeDefault, DEFAULT_CONFIG.searchModeDefault),
    vectorEnabled: toBool(merged.vectorEnabled, DEFAULT_CONFIG.vectorEnabled),
    vectorProvider: normalizeVectorProvider(merged.vectorProvider, DEFAULT_CONFIG.vectorProvider),
    embeddingModel: toText(merged.embeddingModel, DEFAULT_CONFIG.embeddingModel),
    embeddingBaseUrl: toText(merged.embeddingBaseUrl, DEFAULT_CONFIG.embeddingBaseUrl),
    embeddingApiKey: toText(merged.embeddingApiKey, DEFAULT_CONFIG.embeddingApiKey),
    embeddingTimeoutMs: clampInt(merged.embeddingTimeoutMs, DEFAULT_CONFIG.embeddingTimeoutMs, 1000, 120000),
    embeddingMaxRetries: clampInt(merged.embeddingMaxRetries, DEFAULT_CONFIG.embeddingMaxRetries, 0, 10),
    embeddingBatchSize: clampInt(merged.embeddingBatchSize, DEFAULT_CONFIG.embeddingBatchSize, 1, 256),
    compactModel: toText(merged.compactModel, DEFAULT_CONFIG.compactModel),
    compactTimeoutMs: clampInt(merged.compactTimeoutMs, DEFAULT_CONFIG.compactTimeoutMs, 1000, 120000),
    compactMaxRetries: clampInt(merged.compactMaxRetries, DEFAULT_CONFIG.compactMaxRetries, 0, 10),
    vectorDim: clampInt(merged.vectorDim, DEFAULT_CONFIG.vectorDim, 8, 4096),
    vectorTopN: clampInt(merged.vectorTopN, DEFAULT_CONFIG.vectorTopN, 1, 200),
    vectorMinSimilarity: clampFloat(merged.vectorMinSimilarity, DEFAULT_CONFIG.vectorMinSimilarity, -1, 1),
    lexicalEngine: normalizeLexicalEngine(merged.lexicalEngine, DEFAULT_CONFIG.lexicalEngine),
    vectorEngine: normalizeVectorEngine(merged.vectorEngine, DEFAULT_CONFIG.vectorEngine),
    indexEnabled: toBool(merged.indexEnabled, DEFAULT_CONFIG.indexEnabled),
    indexPath: toText(merged.indexPath, DEFAULT_CONFIG.indexPath),
    annEnabled: toBool(merged.annEnabled, DEFAULT_CONFIG.annEnabled),
    annTopN: clampInt(merged.annTopN, DEFAULT_CONFIG.annTopN, 1, 5000),
    annProbeTopN: clampInt(merged.annProbeTopN, DEFAULT_CONFIG.annProbeTopN, 1, 10000),
    fusionRrfK: clampInt(merged.fusionRrfK, DEFAULT_CONFIG.fusionRrfK, 1, 500),
    fusionCandidateMax: clampInt(merged.fusionCandidateMax, DEFAULT_CONFIG.fusionCandidateMax, 1, 500),
    embeddingTextMaxChars: clampInt(merged.embeddingTextMaxChars, DEFAULT_CONFIG.embeddingTextMaxChars, 128, 20000),
    embeddingAutoCompact: toBool(merged.embeddingAutoCompact, DEFAULT_CONFIG.embeddingAutoCompact),
    embeddingHotMaxBytes: clampInt(merged.embeddingHotMaxBytes, DEFAULT_CONFIG.embeddingHotMaxBytes, 4096, 500000000),
    embeddingArchiveMaxBytes: clampInt(merged.embeddingArchiveMaxBytes, DEFAULT_CONFIG.embeddingArchiveMaxBytes, 4096, 500000000),
    embeddingDupRatioThreshold: clampFloat(merged.embeddingDupRatioThreshold, DEFAULT_CONFIG.embeddingDupRatioThreshold, 0, 0.95),
    debug: toBool(merged.debug, DEFAULT_CONFIG.debug),
    packDelimiterStart,
    packDelimiterEnd,
  };
}
