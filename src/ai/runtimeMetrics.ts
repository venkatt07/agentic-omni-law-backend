import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getEnv } from "../config/env.js";

type LatencyRecord = { t: number; endpoint: string; ms: number };
type SchemaCounters = { pass: number; fail: number; repaired: number; fallback: number };
type CacheCounters = { hits: number; misses: number };

const apiLatencies: LatencyRecord[] = [];
const aiLatencies: LatencyRecord[] = [];
const schemaCounters: SchemaCounters = { pass: 0, fail: 0, repaired: 0, fallback: 0 };
const cacheCounters: Record<string, CacheCounters> = {
  embeddings: { hits: 0, misses: 0 },
  retrieval: { hits: 0, misses: 0 },
  generation: { hits: 0, misses: 0 },
};

function pushLatency(arr: LatencyRecord[], rec: LatencyRecord) {
  arr.push(rec);
  if (arr.length > 100) arr.splice(0, arr.length - 100);
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function cacheRoot() {
  const env = getEnv();
  const dir = path.resolve(process.cwd(), env.CACHE_DIR);
  ensureDir(dir);
  return dir;
}

export const runtimeMetrics = {
  recordApiLatency(endpoint: string, ms: number) {
    pushLatency(apiLatencies, { endpoint, ms, t: Date.now() });
  },
  recordAiLatency(endpoint: string, ms: number) {
    pushLatency(aiLatencies, { endpoint, ms, t: Date.now() });
  },
  recordSchema(event: keyof SchemaCounters) {
    schemaCounters[event] += 1;
  },
  recordCache(cacheName: keyof typeof cacheCounters, hit: boolean) {
    if (hit) cacheCounters[cacheName].hits += 1;
    else cacheCounters[cacheName].misses += 1;
  },
  snapshot() {
    const totalSchema = schemaCounters.pass + schemaCounters.fail;
    const schemaPassRate = totalSchema ? schemaCounters.pass / totalSchema : 1;
    return {
      time: new Date().toISOString(),
      api_latencies_last_100: [...apiLatencies],
      ai_latencies_last_100: [...aiLatencies],
      schema_pass_rate: schemaPassRate,
      schema_counters: { ...schemaCounters },
      cache_hit_rates: Object.fromEntries(
        Object.entries(cacheCounters).map(([name, c]) => {
          const total = c.hits + c.misses;
          return [name, { ...c, hit_rate: total ? c.hits / total : 0 }];
        }),
      ),
    };
  },
};

export function hashKey(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

export function readJsonCache<T = any>(bucket: string, key: string): T | null {
  try {
    const file = path.join(cacheRoot(), bucket, `${key}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonCache(bucket: string, key: string, value: unknown) {
  try {
    const dir = path.join(cacheRoot(), bucket);
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(value));
  } catch {
    // best-effort cache
  }
}

