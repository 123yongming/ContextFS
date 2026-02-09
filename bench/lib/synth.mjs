import path from "node:path";

const DEFAULTS = {
  turns: 3000,
  orders: 1,
  avgChars: 400,
  variance: 0.6,
  seed: 42,
  threshold: null,
  recentN: null,
  outDir: process.cwd(),
};

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function parseBenchArgs(argv = process.argv.slice(2), overrides = {}) {
  const map = { ...DEFAULTS, ...overrides };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith("--")) {
      continue;
    }
    if (key === "--turns") {
      map.turns = toNumber(value, map.turns);
      i += 1;
      continue;
    }
    if (key === "--avgChars") {
      map.avgChars = toNumber(value, map.avgChars);
      i += 1;
      continue;
    }
    if (key === "--orders") {
      map.orders = toNumber(value, map.orders);
      i += 1;
      continue;
    }
    if (key === "--variance") {
      map.variance = toNumber(value, map.variance);
      i += 1;
      continue;
    }
    if (key === "--seed") {
      map.seed = toNumber(value, map.seed);
      i += 1;
      continue;
    }
    if (key === "--threshold") {
      map.threshold = toNumber(value, map.threshold);
      i += 1;
      continue;
    }
    if (key === "--recentN") {
      map.recentN = toNumber(value, map.recentN);
      i += 1;
      continue;
    }
    if (key === "--outDir") {
      map.outDir = path.resolve(value || map.outDir);
      i += 1;
    }
  }

  map.turns = Math.max(1, Math.floor(map.turns));
  map.orders = Math.max(1, Math.min(2, Math.floor(map.orders)));
  map.avgChars = Math.max(32, Math.floor(map.avgChars));
  map.variance = Math.max(0, Math.min(2, Number(map.variance)));
  map.seed = Math.floor(map.seed);
  map.threshold = map.threshold == null ? null : Math.max(256, Math.floor(map.threshold));
  map.recentN = map.recentN == null ? null : Math.max(1, Math.floor(map.recentN));
  map.outDir = path.resolve(map.outDir || process.cwd());
  return map;
}

export function createMulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function deterministicTimestamp(seed, index) {
  const base = Date.UTC(2025, 0, 1, 0, 0, 0, 0);
  const seedOffsetMs = (Math.abs(Math.floor(seed)) % 86400) * 1000;
  return new Date(base + seedOffsetMs + Math.max(0, index) * 1000).toISOString();
}

function makeText(targetChars, turn, role) {
  const chunks = [
    `turn=${turn}`,
    `role=${role}`,
    "topic=contextfs-benchmark",
    "payload=",
  ];
  const base = `${chunks.join(" ")} `;
  const unit = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega ";
  let text = base;
  while (text.length < targetChars) {
    text += unit;
  }
  return text.slice(0, targetChars);
}

export function generateTurn(index, rng, avgChars, variance, seed = 0) {
  const role = index % 2 === 1 ? "user" : "assistant";
  const swing = (rng() * 2 - 1) * variance;
  const targetChars = Math.max(16, Math.floor(avgChars * (1 + swing)));
  const text = makeText(targetChars, index, role);
  return {
    role,
    text,
    chars: text.length,
    ts: deterministicTimestamp(seed, index),
  };
}
