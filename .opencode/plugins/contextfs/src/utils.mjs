// utils.mjs - Common utility functions for ContextFS

/**
 * Safely trim a value to string and remove whitespace
 * @param {*} value - Any value
 * @returns {string} Trimmed string
 */
export function safeTrim(value) {
  return String(value || "").trim();
}

/**
 * Clamp an integer value within a range
 * @param {*} value - Input value
 * @param {number} fallback - Fallback value if not a number
 * @param {number} min - Minimum allowed value
 * @param {number} max - Maximum allowed value
 * @returns {number} Clamped integer
 */
export function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
export function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get current ISO timestamp
 * @returns {string} ISO 8601 timestamp
 */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * Generate a short hash from text
 * @param {string} text - Input text
 * @returns {string} 10-character hex hash
 */
export function shortHash(text) {
  const source = String(text || "");
  let h = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    h ^= source.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16).slice(0, 10);
}

/**
 * Normalize timestamp to ISO format
 * @param {*} value - Input value
 * @param {string} fallbackTs - Fallback timestamp
 * @returns {string} ISO timestamp
 */
export function normalizeTs(value, fallbackTs) {
  const text = safeTrim(value);
  if (text) {
    const t = Date.parse(text);
    if (!Number.isNaN(t)) {
      return new Date(t).toISOString();
    }
  }
  if (isValidTs(fallbackTs)) {
    return new Date(Date.parse(fallbackTs)).toISOString();
  }
  return stableFallbackTs(0);
}

/**
 * Check if value is a valid timestamp
 * @param {*} value - Input value
 * @returns {boolean}
 */
export function isValidTs(value) {
  const text = safeTrim(value);
  if (!text) {
    return false;
  }
  return Number.isFinite(Date.parse(text));
}

/**
 * Generate a stable fallback timestamp based on index
 * @param {number} index - Index number
 * @returns {string} ISO timestamp
 */
export function stableFallbackTs(index) {
  const LEGACY_FALLBACK_EPOCH_MS = 0;
  const n = Number(index);
  const safeIndex = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  return new Date(LEGACY_FALLBACK_EPOCH_MS + safeIndex).toISOString();
}

/**
 * Convert value to integer with fallback
 * @param {*} value - Input value
 * @param {number} fallback - Fallback value
 * @returns {number}
 */
export function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Clamp integer between min and max (simplified version)
 * @param {*} value - Input value
 * @param {number} min - Minimum
 * @param {number} max - Maximum
 * @returns {number}
 */
export function clampIntSimple(value, min, max) {
  return Math.max(min, Math.min(max, Math.floor(Number(value) || 0)));
}

/**
 * Get unique list of items with max limit
 * @param {Array} items - Input items
 * @param {number} max - Maximum items
 * @returns {Array}
 */
export function uniqList(items, max = 12) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const value = safeTrim(item);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

/**
 * Make temporary file path
 * @param {string} target - Target file path
 * @returns {string} Temporary path
 */
export function makeTmpPath(target) {
  const rand = Math.random().toString(16).slice(2, 10);
  return `${target}.${process.pid}.${Date.now()}.${rand}.tmp`;
}

/**
 * Normalize base URL by removing trailing slashes
 * @param {*} value - Input value
 * @param {string} fallback - Fallback URL
 * @returns {string}
 */
export function normalizeBaseUrl(value, fallback = "https://api.siliconflow.cn/v1") {
  const base = safeTrim(value) || fallback;
  return base.replace(/\/+$/, "");
}

/**
 * Check if HTTP status code is retryable
 * @param {number} code - HTTP status code
 * @returns {boolean}
 */
export function isRetryableStatus(code) {
  return code === 408 || code === 409 || code === 425 || code === 429 || (code >= 500 && code <= 599);
}

/**
 * Check if fetch error is retryable
 * @param {Error} err - Error object
 * @returns {boolean}
 */
export function isRetryableFetchError(err) {
  const name = String(err?.name || "").toLowerCase();
  const code = String(err?.code || "").toUpperCase();
  if (name === "aborterror") {
    return true;
  }
  return code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "EAI_AGAIN";
}

/**
 * Check if SQLite write error is retryable
 * @param {Error} err - Error object
 * @returns {boolean}
 */
export function isRetryableSqliteWriteError(err) {
  const msg = String(err?.message || "").toUpperCase();
  return msg.includes("SQLITE_BUSY") || msg.includes("SQLITE_LOCKED");
}
