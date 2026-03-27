import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getEnv } from "../config/env.js";

type LatencyEntry = { endpoint: string; ms: number; at: number };

const latencies: LatencyEntry[] = [];
const counters = {
  schema_ok: 0,
  schema_fail: 0,
  schema_repair_ok: 0,
  schema_repair_fail: 0,
  gen_cache_hit: 0,
  gen_cache_miss: 0,
  retrieval_cache_hit: 0,
  retrieval_cache_miss: 0,
  embedding_cache_hit: 0,
  embedding_cache_miss: 0,
};

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function cacheRoot() {
  const env = getEnv();
  const root = path.resolve(process.cwd(), env.CACHE_DIR || "./cache");
  ensureDir(root);
  return root;
}

export function cachePath(scope: string, key: string) {
  const root = path.join(cacheRoot(), scope);
  ensureDir(root);
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return path.join(root, `${safe}.json`);
}

export function hashKey(input: unknown) {
  return createHash("sha256").update(typeof input === "string" ? input : JSON.stringify(input)).digest("hex");
}

export function readJsonCache<T>(scope: string, key: string): T | null {
  try {
    const p = cachePath(scope, key);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonCache(scope: string, key: string, value: unknown) {
  try {
    fs.writeFileSync(cachePath(scope, key), JSON.stringify(value), "utf8");
  } catch {
    // best effort
  }
}

export function recordLatency(endpoint: string, ms: number) {
  latencies.push({ endpoint, ms, at: Date.now() });
  if (latencies.length > 100) latencies.splice(0, latencies.length - 100);
}

export function incrCounter(name: keyof typeof counters, n = 1) {
  counters[name] += n;
}

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function getMetricsSnapshot() {
  const byEndpoint: Record<string, number[]> = {};
  for (const row of latencies) {
    byEndpoint[row.endpoint] ||= [];
    byEndpoint[row.endpoint].push(row.ms);
  }
  const endpointStats = Object.fromEntries(
    Object.entries(byEndpoint).map(([endpoint, vals]) => [
      endpoint,
      {
        count: vals.length,
        avg_ms: Number((vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 1)).toFixed(1)),
        p50_ms: Number(percentile(vals, 50).toFixed(1)),
        p95_ms: Number(percentile(vals, 95).toFixed(1)),
        last_100: vals.slice(-100),
      },
    ]),
  );
  const schemaPassTotal = counters.schema_ok + counters.schema_fail;
  const schema_pass_rate = schemaPassTotal ? counters.schema_ok / schemaPassTotal : 1;
  return {
    endpoints: endpointStats,
    counters,
    schema_pass_rate: Number(schema_pass_rate.toFixed(4)),
    cache_hit_rates: {
      generation: hitRate(counters.gen_cache_hit, counters.gen_cache_miss),
      retrieval: hitRate(counters.retrieval_cache_hit, counters.retrieval_cache_miss),
      embedding: hitRate(counters.embedding_cache_hit, counters.embedding_cache_miss),
    },
  };
}

function hitRate(hit: number, miss: number) {
  const t = hit + miss;
  return t ? Number((hit / t).toFixed(4)) : 0;
}

