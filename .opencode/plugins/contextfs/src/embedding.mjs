function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function safeTrim(text) {
  return String(text || "").trim();
}

export function normalizeEmbeddingText(input, maxChars = 4000) {
  const safeMax = clampInt(maxChars, 4000, 128, 20000);
  const normalized = String(input || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= safeMax) {
    return normalized;
  }
  return normalized.slice(0, safeMax);
}

export function hashEmbeddingText(text) {
  const source = String(text || "");
  let h = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    h ^= source.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16).slice(0, 10);
}

function resizeVector(values, targetDim) {
  const sized = new Array(targetDim).fill(0);
  const list = Array.isArray(values) ? values : [];
  for (let i = 0; i < Math.min(targetDim, list.length); i += 1) {
    const n = Number(list[i]);
    sized[i] = Number.isFinite(n) ? n : 0;
  }
  return sized;
}

function toUnitVector(values) {
  const list = Array.isArray(values) ? values.map((item) => Number(item) || 0) : [];
  if (!list.length) {
    return [];
  }
  let sum = 0;
  for (const value of list) {
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm <= 0) {
    return list.map(() => 0);
  }
  return list.map((value) => value / norm);
}

function deterministicVector(text, dim) {
  const safeDim = clampInt(dim, 64, 8, 4096);
  const chars = Array.from(String(text || ""));
  const vector = new Array(safeDim).fill(0);
  if (!chars.length) {
    return vector;
  }
  for (let i = 0; i < chars.length; i += 1) {
    const code = chars[i].charCodeAt(0);
    const a = i % safeDim;
    const b = (i * 7 + 3) % safeDim;
    const c = (i * 13 + 11) % safeDim;
    vector[a] += ((code % 97) - 48) / 64;
    vector[b] -= ((code % 53) - 26) / 80;
    vector[c] += ((code % 23) - 11) / 96;
  }
  return toUnitVector(vector);
}

function normalizeProviderResult(raw, fallbackModel, fallbackDim) {
  if (Array.isArray(raw)) {
    const vector = toUnitVector(resizeVector(raw, fallbackDim));
    return {
      model: fallbackModel,
      dim: fallbackDim,
      vector,
    };
  }
  const src = raw && typeof raw === "object" ? raw : {};
  const candidate = Array.isArray(src.vector) ? src.vector : (Array.isArray(src.vec) ? src.vec : []);
  const dim = clampInt(src.dim, fallbackDim, 8, 4096);
  const vector = toUnitVector(resizeVector(candidate, dim));
  return {
    model: safeTrim(src.model) || fallbackModel,
    dim,
    vector,
  };
}

function resolveVectorProvider(config) {
  const mode = safeTrim(config?.vectorProvider || "fake").toLowerCase();
  if (mode === "none" || mode === "fake" || mode === "custom") {
    return mode;
  }
  return "fake";
}

export function createEmbeddingProvider(config = {}) {
  const retrievalMode = safeTrim(config?.retrievalMode || "hybrid").toLowerCase();
  const enabled = Boolean(config?.vectorEnabled) && retrievalMode === "hybrid";
  const vectorProvider = resolveVectorProvider(config);
  const dim = clampInt(config?.vectorDim, 64, 8, 4096);
  const maxChars = clampInt(config?.embeddingTextMaxChars, 4000, 128, 20000);
  const defaultModel = vectorProvider === "fake" ? "fake-deterministic-v1" : `${vectorProvider}-embedding-v1`;

  if (!enabled || vectorProvider === "none") {
    return {
      enabled: false,
      name: vectorProvider,
      model: defaultModel,
      dim,
      maxChars,
      async embedText() {
        throw new Error("vector retrieval disabled");
      },
    };
  }

  if (vectorProvider === "fake") {
    return {
      enabled: true,
      name: "fake",
      model: defaultModel,
      dim,
      maxChars,
      async embedText(input) {
        const text = normalizeEmbeddingText(input, maxChars);
        const vector = deterministicVector(text, dim);
        return {
          model: defaultModel,
          dim,
          vector,
          text,
          text_hash: hashEmbeddingText(text),
        };
      },
    };
  }

  return {
    enabled: true,
    name: "custom",
    model: defaultModel,
    dim,
    maxChars,
    async embedText(input) {
      const text = normalizeEmbeddingText(input, maxChars);
      const custom = globalThis.CONTEXTFS_EMBEDDING_PROVIDER;
      if (!custom || typeof custom.embedText !== "function") {
        throw new Error("custom embedding provider is not configured");
      }
      const raw = await custom.embedText(text, {
        dim,
        model: defaultModel,
      });
      const normalized = normalizeProviderResult(raw, defaultModel, dim);
      if (!normalized.vector.length) {
        throw new Error("custom embedding provider returned empty vector");
      }
      return {
        model: normalized.model,
        dim: normalized.dim,
        vector: normalized.vector,
        text,
        text_hash: hashEmbeddingText(text),
      };
    },
  };
}

export function cosineSimilarity(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  if (!a.length || !b.length) {
    return 0;
  }
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < n; i += 1) {
    const av = Number(a[i]) || 0;
    const bv = Number(b[i]) || 0;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  if (aNorm <= 0 || bNorm <= 0) {
    return 0;
  }
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}
