import { createHash } from "crypto";
import { getEnv } from "../config/env.js";
import { readJsonCache, runtimeMetrics, writeJsonCache } from "./runtimeMetrics.js";
import { logger } from "../config/logger.js";

const cache = new Map<string, number[]>();

function keyFor(text: string) {
  const env = getEnv();
  const hash = createHash("sha256").update(text).digest("hex");
  return `${env.EMBED_MODEL_ID}:${hash}`;
}

type EmbedResponse = { embedding?: number[]; data?: Array<{ embedding?: number[] }>; embeddings?: number[][] };
const EMBED_TIMEOUT_MS = 8000;
const EMBED_RETRIES = 2;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const embedClient = {
  async embed(text: string): Promise<number[]> {
    const normalized = text.trim();
    if (!normalized) return [];
    const key = keyFor(normalized);
    const cached = cache.get(key);
    if (cached) {
      runtimeMetrics.recordCache("embeddings", true);
      const estimatedTokens = Math.max(1, Math.ceil(normalized.length / 3.2));
      logger.info(
        `[ai.embed] endpoint=${getEnv().EMBED_ENDPOINT}/embedding input_chars=${normalized.length} input_tokens_est=${estimatedTokens} vector_dims=${cached.length} latency_ms=0 cache=memory-hit`,
      );
      return cached;
    }
    const diskCached = readJsonCache<number[]>("embeddings", key);
    if (diskCached && Array.isArray(diskCached)) {
      cache.set(key, diskCached);
      runtimeMetrics.recordCache("embeddings", true);
      const estimatedTokens = Math.max(1, Math.ceil(normalized.length / 3.2));
      logger.info(
        `[ai.embed] endpoint=${getEnv().EMBED_ENDPOINT}/embedding input_chars=${normalized.length} input_tokens_est=${estimatedTokens} vector_dims=${diskCached.length} latency_ms=0 cache=disk-hit`,
      );
      return diskCached;
    }
    runtimeMetrics.recordCache("embeddings", false);
    const env = getEnv();
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= EMBED_RETRIES; attempt++) {
      const started = Date.now();
      try {
        const timeout = AbortSignal.timeout(EMBED_TIMEOUT_MS);
        const res = await fetch(`${env.EMBED_ENDPOINT}/embedding`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: normalized }),
          signal: timeout,
        });
        if (!res.ok) throw new Error(`Embed HTTP ${res.status}`);
        const json = (await res.json()) as EmbedResponse;
        const vector = json.embedding ?? json.data?.[0]?.embedding ?? json.embeddings?.[0] ?? [];
        runtimeMetrics.recordAiLatency("/embed", Date.now() - started);
        const estimatedTokens = Math.max(1, Math.ceil(normalized.length / 3.2));
        logger.info(
          `[ai.embed] endpoint=${env.EMBED_ENDPOINT}/embedding input_chars=${normalized.length} input_tokens_est=${estimatedTokens} vector_dims=${Array.isArray(vector) ? vector.length : 0} latency_ms=${Date.now() - started} cache=miss`,
        );
        cache.set(key, vector);
        writeJsonCache("embeddings", key, vector);
        return vector;
      } catch (error) {
        lastError = error;
        if (attempt < EMBED_RETRIES) {
          const backoff = 300 * Math.pow(2, attempt - 1);
          logger.warn(`embed request failed (attempt ${attempt}/${EMBED_RETRIES}); retrying in ${backoff}ms`);
          await sleep(backoff);
          continue;
        }
      }
    }
    throw new Error(`Embed request failed after ${EMBED_RETRIES} attempts: ${String((lastError as any)?.message || lastError)}`);
  },
};

export function cosineSimilarity(a: number[], b: number[]) {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
