// constants.mjs - Configuration constants for ContextFS

// ============================================================================
// Retry Configuration
// ============================================================================

/** Maximum retry attempts for operations */
export const RETRY_MAX_ATTEMPTS = 3;

/** Base delay for exponential backoff (ms) */
export const RETRY_BASE_DELAY_MS = 250;

/** Maximum delay between retries (ms) */
export const RETRY_MAX_DELAY_MS = 3000;

/** Maximum retries for lock acquisition */
export const LOCK_MAX_RETRIES = 80;

/** Default lock stale timeout (ms) */
export const LOCK_STALE_MS_DEFAULT = 30000;

/** Minimum lock stale timeout (ms) */
export const LOCK_STALE_MS_MIN = 1000;

// ============================================================================
// Timeout Configuration
// ============================================================================

/** Default timeout for compact operations (ms) */
export const COMPACT_TIMEOUT_MS_DEFAULT = 20000;

/** Minimum timeout (ms) */
export const TIMEOUT_MIN_MS = 1000;

/** Maximum timeout (ms) */
export const TIMEOUT_MAX_MS = 120000;

/** Default fetch timeout (ms) */
export const FETCH_TIMEOUT_MS_DEFAULT = 20000;

// ============================================================================
// Token and Threshold Configuration
// ============================================================================

/** Default token threshold for compaction */
export const TOKEN_THRESHOLD_DEFAULT = 8000;

/** Default number of recent turns to keep */
export const RECENT_TURNS_DEFAULT = 6;

/** Minimum recent turns */
export const RECENT_TURNS_MIN = 1;

/** Maximum summary characters */
export const SUMMARY_MAX_CHARS_DEFAULT = 3200;

/** Minimum summary characters */
export const SUMMARY_MIN_CHARS = 256;

/** Maximum summary characters allowed */
export const SUMMARY_MAX_CHARS_LIMIT = 20000;

// ============================================================================
// Search and Retrieval Configuration
// ============================================================================

/** Default number of search results */
export const SEARCH_DEFAULT_K = 5;

/** Maximum search results */
export const SEARCH_MAX_K = 50;

/** Minimum search results */
export const SEARCH_MIN_K = 1;

/** Default trace tail count */
export const TRACES_TAIL_DEFAULT = 20;

/** Maximum trace tail */
export const TRACES_TAIL_MAX = 200;

/** Maximum trace files to keep */
export const TRACES_MAX_FILES = 10;

/** Minimum trace files */
export const TRACES_MIN_FILES = 1;

/** Default head lines for cat command */
export const CAT_HEAD_DEFAULT = 30;

/** Default head chars for get command */
export const GET_HEAD_DEFAULT = 1200;

/** Maximum head for get command */
export const GET_HEAD_MAX = 200000;

/** Default timeline before count */
export const TIMELINE_BEFORE_DEFAULT = 3;

/** Default timeline after count */
export const TIMELINE_AFTER_DEFAULT = 3;

/** Maximum timeline window */
export const TIMELINE_WINDOW_MAX = 20;

// ============================================================================
// Vector and Embedding Configuration
// ============================================================================

/** Default vector top N */
export const VECTOR_TOP_N_DEFAULT = 20;

/** Maximum vector top N */
export const VECTOR_TOP_N_MAX = 200;

/** Minimum vector top N */
export const VECTOR_TOP_N_MIN = 1;

/** Default vector dimension */
export const VECTOR_DIM_DEFAULT = 64;

/** Minimum vector dimension */
export const VECTOR_DIM_MIN = 8;

/** Maximum vector dimension */
export const VECTOR_DIM_MAX = 4096;

/** Default minimum similarity for vector search */
export const VECTOR_MIN_SIMILARITY_DEFAULT = 0.35;

/** Default ANN probe top N */
export const ANN_PROBE_TOP_N_DEFAULT = 0;

/** Maximum ANN probe top N */
export const ANN_PROBE_TOP_N_MAX = 5000;

/** Default fusion RRF K */
export const FUSION_RRF_K_DEFAULT = 60;

/** Maximum fusion candidates */
export const FUSION_CANDIDATE_MAX = 500;

/** Default embedding batch size */
export const EMBEDDING_BATCH_SIZE_DEFAULT = 16;

/** Maximum embedding text characters */
export const EMBEDDING_TEXT_MAX_CHARS_DEFAULT = 8000;

// ============================================================================
// File and Storage Configuration
// ============================================================================

/** Maximum session ID length */
export const MAX_SESSION_ID_LENGTH = 96;

/** Maximum pins items */
export const PINS_MAX_ITEMS_DEFAULT = 24;

/** Maximum summary chars for search */
export const SEARCH_SUMMARY_MAX_CHARS_DEFAULT = 280;

/** Maximum ID length */
export const ID_MAX_LEN = 128;

/** Maximum type length */
export const TYPE_MAX_LEN = 128;

/** Maximum array items in JSON */
export const ARRAY_MAX_ITEMS = 20;

/** Maximum array item length */
export const ARRAY_ITEM_MAX_LEN = 256;

/** Maximum manifest lines */
export const MANIFEST_MAX_LINES_DEFAULT = 48;

// ============================================================================
// Text and Content Limits
// ============================================================================

/** Maximum prompt turn text length */
export const PROMPT_TURN_MAX_CHARS = 1200;

/** Maximum trace query chars */
export const TRACE_QUERY_MAX_CHARS = 400;

/** Maximum trace error message */
export const TRACE_ERROR_MAX_CHARS = 400;

/** Maximum ranking items in trace */
export const TRACE_RANKING_MAX_ITEMS = 20;

/** Default text head for JSON output */
export const JSON_HEAD_DEFAULT = 1200;

// ============================================================================
// Model Configuration
// ============================================================================

/** Default compact model */
export const DEFAULT_COMPACT_MODEL = "Pro/Qwen/Qwen2.5-7B-Instruct";

/** Default embedding base URL */
export const DEFAULT_EMBEDDING_BASE_URL = "https://api.siliconflow.cn/v1";

/** Default embedding model */
export const DEFAULT_EMBEDDING_MODEL = "BAAI/bge-m3";

// ============================================================================
// Error Codes
// ============================================================================

/** Retryable lock errors */
export const RETRYABLE_LOCK_ERRORS = new Set(["EEXIST", "EBUSY"]);

/** Lock permission errors */
export const LOCK_PERMISSION_ERRORS = new Set(["EPERM", "EACCES"]);

/** Retryable rename errors */
export const RETRYABLE_RENAME_ERRORS = new Set(["EBUSY", "EPERM", "EXDEV"]);

/** Retryable unlink errors */
export const RETRYABLE_UNLINK_ERRORS = new Set(["EBUSY", "EPERM"]);

// ============================================================================
// File Names
// ============================================================================

/** File name mappings */
export const FILES = {
  manifest: "manifest.md",
  pins: "pins.md",
  summary: "summary.md",
  history: "history.ndjson",
  historyArchive: "history.archive.ndjson",
  historyEmbeddingHot: "history.embedding.hot.ndjson",
  historyEmbeddingArchive: "history.embedding.archive.ndjson",
  historyBad: "history.bad.ndjson",
  retrievalTraces: "retrieval.traces.ndjson",
  state: "state.json",
};

// ============================================================================
// Legacy and Migration
// ============================================================================

/** Legacy fallback epoch (ms) */
export const LEGACY_FALLBACK_EPOCH_MS = 0;

/** Current schema version */
export const SCHEMA_VERSION = "1";

// ============================================================================
// Size Buckets
// ============================================================================

/** Small size threshold (tokens) */
export const SIZE_SMALL_THRESHOLD = 220;

/** Medium size threshold (tokens) */
export const SIZE_MEDIUM_THRESHOLD = 520;

/** Size bucket labels */
export const SIZE_BUCKETS = {
  SMALL: "small",
  MEDIUM: "medium",
  LARGE: "large",
};

/**
 * Get size bucket label based on token count
 * @param {number} tokens - Token count
 * @returns {string} Size bucket label
 */
export function getSizeBucket(tokens) {
  const n = Number(tokens);
  const safe = Number.isFinite(n) ? n : 0;
  if (safe <= SIZE_SMALL_THRESHOLD) return SIZE_BUCKETS.SMALL;
  if (safe <= SIZE_MEDIUM_THRESHOLD) return SIZE_BUCKETS.MEDIUM;
  return SIZE_BUCKETS.LARGE;
}
