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

function normalizeBaseUrl(value, fallback) {
  const text = safeTrim(value) || fallback;
  return text.replace(/\/+$/, "");
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(code) {
  return code === 408 || code === 409 || code === 425 || code === 429 || (code >= 500 && code <= 599);
}

function isRetryableFetchError(err) {
  const name = String(err?.name || "").toLowerCase();
  const code = String(err?.code || "").toUpperCase();
  if (name === "aborterror") {
    return true;
  }
  return code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "EAI_AGAIN";
}

async function fetchEmbeddingsWithRetry({
  baseUrl,
  apiKey,
  model,
  input,
  timeoutMs,
  maxRetries,
}) {
  if (typeof fetch !== "function") {
    throw new Error("fetch is not available in this runtime");
  }
  const url = `${baseUrl}/embeddings`;
  const body = JSON.stringify({
    model,
    input,
  });
  let attempt = 0;
  while (attempt <= maxRetries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const text = safeTrim(await res.text());
        if (isRetryableStatus(res.status) && attempt < maxRetries) {
          await sleepMs(Math.min(3000, 250 * (2 ** attempt)));
          attempt += 1;
          continue;
        }
        throw new Error(`siliconflow embeddings failed (${res.status}): ${text || "empty error body"}`);
      }
      const data = await res.json();
      return data;
    } catch (err) {
      clearTimeout(timer);
      if (attempt < maxRetries && isRetryableFetchError(err)) {
        await sleepMs(Math.min(3000, 250 * (2 ** attempt)));
        attempt += 1;
        continue;
      }
      const label = String(err?.name || "").toLowerCase() === "aborterror"
        ? `siliconflow embeddings timeout after ${timeoutMs}ms`
        : String(err?.message || err);
      throw new Error(label);
    }
  }
  throw new Error("siliconflow embeddings failed after retries");
}

function embeddingVersion(provider, model, dim, normalize = "unit") {
  return `${safeTrim(provider) || "unknown"}:${safeTrim(model) || "unknown"}:${Number(dim) || 0}:${safeTrim(normalize) || "none"}`;
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
  if (mode === "none" || mode === "fake" || mode === "custom" || mode === "siliconflow") {
    return mode;
  }
  return "fake";
}

async function mapEmbedTexts(provider, inputs) {
  const textList = Array.isArray(inputs) ? inputs : [];
  const results = [];
  for (const input of textList) {
    results.push(await provider.embedText(input));
  }
  return results;
}

export async function embedTexts(provider, inputs, options = {}) {
  const safeProvider = provider && typeof provider === "object" ? provider : null;
  if (!safeProvider || typeof safeProvider.embedText !== "function") {
    throw new Error("invalid embedding provider");
  }
  const list = Array.isArray(inputs) ? inputs : [];
  if (!list.length) {
    return [];
  }
  const chunkSize = clampInt(options.batchSize ?? safeProvider.batchSize ?? 32, 32, 1, 256);
  const out = [];
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    const chunkResult = typeof safeProvider.embedTexts === "function"
      ? await safeProvider.embedTexts(chunk)
      : await mapEmbedTexts(safeProvider, chunk);
    if (!Array.isArray(chunkResult) || chunkResult.length !== chunk.length) {
      throw new Error("embedding provider returned invalid batch size");
    }
    out.push(...chunkResult);
  }
  return out;
}

export function createEmbeddingProvider(config = {}) {
  const retrievalMode = safeTrim(config?.retrievalMode || "hybrid").toLowerCase();
  const enabled = Boolean(config?.vectorEnabled) && retrievalMode === "hybrid";
  const vectorProvider = resolveVectorProvider(config);
  const dim = clampInt(config?.vectorDim, 64, 8, 4096);
  const maxChars = clampInt(config?.embeddingTextMaxChars, 4000, 128, 20000);
  const batchSize = clampInt(config?.embeddingBatchSize, 32, 1, 256);
  const defaultModel = safeTrim(config?.embeddingModel) || (vectorProvider === "fake" ? "fake-deterministic-v1" : `${vectorProvider}-embedding-v1`);

  if (!enabled || vectorProvider === "none") {
    return {
      enabled: false,
      name: vectorProvider,
      model: defaultModel,
      dim,
      maxChars,
      batchSize,
      async embedText() {
        throw new Error("vector retrieval disabled");
      },
      async embedTexts() {
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
      batchSize,
      dynamicDim: false,
      async embedText(input) {
        const text = normalizeEmbeddingText(input, maxChars);
        const vector = deterministicVector(text, dim);
        return {
          model: defaultModel,
          dim,
          vector,
          text,
          text_hash: hashEmbeddingText(text),
          embedding_version: embeddingVersion("fake", defaultModel, dim),
        };
      },
      async embedTexts(inputs) {
        const list = Array.isArray(inputs) ? inputs : [];
        return Promise.all(list.map((item) => this.embedText(item)));
      },
    };
  }

  if (vectorProvider === "siliconflow") {
    const baseUrl = normalizeBaseUrl(config?.embeddingBaseUrl, "https://api.siliconflow.cn/v1");
    const apiKey = safeTrim(config?.embeddingApiKey || process.env.CONTEXTFS_EMBEDDING_API_KEY);
    const timeoutMs = clampInt(config?.embeddingTimeoutMs, 20000, 1000, 120000);
    const maxRetries = clampInt(config?.embeddingMaxRetries, 3, 0, 10);
    return {
      enabled: true,
      name: "siliconflow",
      model: defaultModel,
      dim: 0,
      dynamicDim: true,
      maxChars,
      batchSize,
      async embedText(input) {
        const rows = await this.embedTexts([input]);
        return rows[0];
      },
      async embedTexts(inputs) {
        if (!apiKey) {
          throw new Error("siliconflow embedding api key is missing");
        }
        const textList = (Array.isArray(inputs) ? inputs : []).map((item) => normalizeEmbeddingText(item, maxChars));
        if (!textList.length) {
          return [];
        }
        const payload = await fetchEmbeddingsWithRetry({
          baseUrl,
          apiKey,
          model: defaultModel,
          input: textList,
          timeoutMs,
          maxRetries,
        });
        const dataRows = Array.isArray(payload?.data) ? payload.data : [];
        if (dataRows.length !== textList.length) {
          throw new Error(`siliconflow embeddings result mismatch: expected ${textList.length}, got ${dataRows.length}`);
        }
        return dataRows.map((row, idx) => {
          const rawVector = Array.isArray(row?.embedding) ? row.embedding : [];
          const normalized = toUnitVector(rawVector);
          if (!normalized.length) {
            throw new Error("siliconflow returned empty embedding vector");
          }
          const rowDim = normalized.length;
          const modelName = safeTrim(row?.model || payload?.model || defaultModel) || defaultModel;
          const text = textList[idx];
          return {
            model: modelName,
            dim: rowDim,
            vector: normalized,
            text,
            text_hash: hashEmbeddingText(text),
            embedding_version: embeddingVersion("siliconflow", modelName, rowDim),
          };
        });
      },
    };
  }

  return {
    enabled: true,
    name: "custom",
    model: defaultModel,
    dim,
    dynamicDim: false,
    maxChars,
    batchSize,
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
        embedding_version: embeddingVersion("custom", normalized.model, normalized.dim),
      };
    },
    async embedTexts(inputs) {
      const custom = globalThis.CONTEXTFS_EMBEDDING_PROVIDER;
      if (custom && typeof custom.embedTexts === "function") {
        const textList = (Array.isArray(inputs) ? inputs : []).map((item) => normalizeEmbeddingText(item, maxChars));
        const rawRows = await custom.embedTexts(textList, {
          dim,
          model: defaultModel,
        });
        if (!Array.isArray(rawRows) || rawRows.length !== textList.length) {
          throw new Error("custom embedding provider returned invalid batch result");
        }
        return rawRows.map((raw, idx) => {
          const normalized = normalizeProviderResult(raw, defaultModel, dim);
          if (!normalized.vector.length) {
            throw new Error("custom embedding provider returned empty vector");
          }
          const text = textList[idx];
          return {
            model: normalized.model,
            dim: normalized.dim,
            vector: normalized.vector,
            text,
            text_hash: hashEmbeddingText(text),
            embedding_version: embeddingVersion("custom", normalized.model, normalized.dim),
          };
        });
      }
      return mapEmbedTexts(this, inputs);
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

