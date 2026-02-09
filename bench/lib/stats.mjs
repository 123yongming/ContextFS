export function percentile(values, p) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function median(values) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarizeSeries(values) {
  if (!values.length) {
    return { avg: 0, p50: 0, p95: 0, max: 0, min: 0 };
  }
  const sum = values.reduce((acc, n) => acc + n, 0);
  return {
    avg: sum / values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: Math.max(...values),
    min: Math.min(...values),
  };
}

export function linearSlope(values) {
  if (values.length < 2) {
    return 0;
  }
  const xMean = (values.length - 1) / 2;
  const yMean = values.reduce((acc, v) => acc + v, 0) / values.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length; i += 1) {
    const x = i - xMean;
    const y = values[i] - yMean;
    num += x * y;
    den += x * x;
  }
  return den === 0 ? 0 : num / den;
}

export function detectPlateauTurn(values, window = 120, slopeEpsilon = 0.5) {
  if (values.length < window * 2) {
    return -1;
  }
  for (let i = window; i < values.length; i += 1) {
    const slice = values.slice(i - window, i);
    const slope = linearSlope(slice);
    const max = Math.max(...slice);
    const min = Math.min(...slice);
    const spread = max - min;
    if (Math.abs(slope) <= slopeEpsilon && spread <= Math.max(40, max * 0.2)) {
      return i + 1;
    }
  }
  return -1;
}

export function toFixed3(value) {
  return Number(value.toFixed(3));
}

export function normalizeSummary(summary) {
  const out = {};
  for (const [key, value] of Object.entries(summary)) {
    out[key] = typeof value === "number" ? toFixed3(value) : value;
  }
  return out;
}
