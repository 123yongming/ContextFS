import { toFixed3 } from "./stats.mjs";

export function dcgBinary(relevances = []) {
  let score = 0;
  for (let i = 0; i < relevances.length; i += 1) {
    const rel = Number(relevances[i]) > 0 ? 1 : 0;
    if (!rel) {
      continue;
    }
    score += rel / Math.log2(i + 2);
  }
  return score;
}

export function ndcgAtKBinary(hitFlags = [], idealHits = 0, k = 5) {
  const limit = Math.max(1, Math.floor(k));
  const actual = dcgBinary(hitFlags.slice(0, limit));
  const ideal = dcgBinary(new Array(Math.min(limit, Math.max(0, idealHits))).fill(1));
  if (ideal <= 0) {
    return 0;
  }
  return actual / ideal;
}

export function evaluateRanking(resultIds = [], goldIds = [], k = 5) {
  const limit = Math.max(1, Math.floor(k));
  const ranked = Array.isArray(resultIds) ? resultIds.map((x) => String(x || "")) : [];
  const gold = new Set((Array.isArray(goldIds) ? goldIds : []).map((x) => String(x || "")));
  const top = ranked.slice(0, limit);
  const hitFlags = top.map((id) => (gold.has(id) ? 1 : 0));
  const firstHit = top.findIndex((id) => gold.has(id));
  const recall = firstHit >= 0 ? 1 : 0;
  const mrr = firstHit >= 0 ? 1 / (firstHit + 1) : 0;
  const ndcg = ndcgAtKBinary(hitFlags, gold.size, limit);
  return {
    recall,
    mrr,
    ndcg,
    first_hit_rank: firstHit >= 0 ? firstHit + 1 : -1,
    hit_flags: hitFlags,
  };
}

export function aggregateModeRows(rows = []) {
  if (!rows.length) {
    return {
      samples: 0,
      recall_at_k: 0,
      mrr_at_k: 0,
      ndcg_at_k: 0,
      coverage: 0,
      p95_latency_ms: 0,
      avg_latency_ms: 0,
      errors: 0,
    };
  }
  let recallSum = 0;
  let mrrSum = 0;
  let ndcgSum = 0;
  let coverageHits = 0;
  let latencySum = 0;
  let errors = 0;
  const latencies = [];
  for (const row of rows) {
    const recall = Number(row?.metrics?.recall || 0);
    const mrr = Number(row?.metrics?.mrr || 0);
    const ndcg = Number(row?.metrics?.ndcg || 0);
    const latency = Number(row?.latency_ms || 0);
    recallSum += recall;
    mrrSum += mrr;
    ndcgSum += ndcg;
    if (recall > 0) {
      coverageHits += 1;
    }
    if (Number.isFinite(latency) && latency >= 0) {
      latencySum += latency;
      latencies.push(latency);
    }
    if (!row?.ok) {
      errors += 1;
    }
  }
  latencies.sort((a, b) => a - b);
  const p95Index = Math.min(latencies.length - 1, Math.max(0, Math.ceil(0.95 * latencies.length) - 1));
  return {
    samples: rows.length,
    recall_at_k: toFixed3(recallSum / rows.length),
    mrr_at_k: toFixed3(mrrSum / rows.length),
    ndcg_at_k: toFixed3(ndcgSum / rows.length),
    coverage: toFixed3(coverageHits / rows.length),
    p95_latency_ms: toFixed3(latencies[p95Index] || 0),
    avg_latency_ms: toFixed3(latencySum / Math.max(1, latencies.length)),
    errors,
  };
}

