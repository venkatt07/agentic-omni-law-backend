import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5000),
  CORS_ORIGIN: z.string().default("http://127.0.0.1:5173,http://localhost:5173"),
  DATABASE_URL: z.string().startsWith("mysql://").optional(),
  DB_HOST: z.string().default("127.0.0.1"),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().default("root"),
  DB_PASSWORD: z.string().default(""),
  DB_NAME: z.string().default("agentic_omni_law"),
  JWT_SECRET: z.string().min(8),
  JWT_EXPIRES_IN: z.string().default("1d"),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  STORAGE_DIR: z.string().default("./storage"),
  LEGAL_CORPUS_DIR: z.string().default("./legal_corpus"),
  LEGAL_CORPUS_INDEX_DIR: z.string().default("./storage/indexes/legal_corpus"),
  CASE_DOC_INDEX_DIR: z.string().default("./storage/indexes/case_docs"),
  ENABLE_LEGAL_CORPUS: z.coerce.boolean().default(true),
  ENABLE_SIMILAR_CASES: z.coerce.boolean().default(true),
  LEGAL_CORPUS_MAX_CHUNKS_PER_DOC: z.coerce.number().int().positive().default(80),
  AI_MODE: z.enum(["rag_llm", "deterministic"]).default("rag_llm"),
  AI_PROFILE: z.enum(["compact", "quality"]).default("compact"),
  LLM_ENDPOINT: z.string().url().default("http://127.0.0.1:8001"),
  PREVIEW_LLM_ENDPOINT: z.string().url().optional(),
  FINAL_LLM_ENDPOINT: z.string().url().optional(),
  EMBED_ENDPOINT: z.string().url().default("http://127.0.0.1:8002"),
  LLM_REQUEST_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(0),
  GEN_MAX_TOKENS_COMPACT: z.coerce.number().int().positive().default(300),
  GEN_MAX_TOKENS_QUALITY: z.coerce.number().int().positive().default(700),
  GEN_CTX_COMPACT: z.coerce.number().int().positive().default(2048),
  GEN_CTX_QUALITY: z.coerce.number().int().positive().default(4096),
  PREVIEW_GEN_MAX_TOKENS: z.coerce.number().int().positive().optional(),
  FINAL_GEN_MAX_TOKENS: z.coerce.number().int().positive().optional(),
  PREVIEW_GEN_CTX: z.coerce.number().int().positive().optional(),
  FINAL_GEN_CTX: z.coerce.number().int().positive().optional(),
  GEN_TEMPERATURE: z.coerce.number().min(0).max(0.35).default(0.15),
  RETRIEVE_TOPK: z.coerce.number().int().positive().default(6),
  RETRIEVE_MAX_CHARS_PER_CHUNK: z.coerce.number().int().positive().default(700),
  ENABLE_STREAMING: z.coerce.boolean().default(true),
  CACHE_DIR: z.string().default("./cache"),
  LLM_MODEL_ID: z.string().default("omni-law-gen"),
  PREVIEW_LLM_MODEL_ID: z.string().optional(),
  FINAL_LLM_MODEL_ID: z.string().optional(),
  EMBED_MODEL_ID: z.string().default("omni-law-embed"),
  REQUIRE_LLM_OUTPUT: z.coerce.boolean().default(true),
  MODELS_DIR: z.string().default("./models"),
  LLAMA_SERVER_BIN: z.string().optional(),
  EMBED_SERVER_BIN: z.string().optional(),
  MODEL_GEN_PATH: z.string().default("./models/omni-law-gen.gguf"),
  MODEL_GEN_PREVIEW_PATH: z.string().optional(),
  MODEL_GEN_FINAL_PATH: z.string().optional(),
  MODEL_EMBED_PATH: z.string().default("./models/omni-law-embed.gguf"),
  RAG_TOPK_USER: z.coerce.number().int().positive().default(8),
  RAG_TOPK_LAW: z.coerce.number().int().positive().default(8),
  RAG_RERANK_ENABLED: z.coerce.boolean().default(false),
  RAG_HYBRID_BM25_WEIGHT: z.coerce.number().min(0).max(1).default(0.5),
  RAG_VECTOR_WEIGHT: z.coerce.number().min(0).max(1).default(0.5),
  OCR_ENABLED: z.coerce.boolean().default(true),
  OCR_ENGINE: z.string().default("tesseractjs"),
  VITE_ENABLE_API_FALLBACK_MOCKS: z.coerce.boolean().default(false),
  ENABLE_DEV_MOCKS: z.coerce.boolean().default(false),
});

export type AppEnv = z.infer<typeof schema> & { corsOrigins: string[]; smtpConfigured: boolean; databaseUrl: string };
let cached: AppEnv | null = null;
const has = (v?: string) => !!v && v.trim().length > 0;
let dotenvLoaded = false;

function loadDotEnv() {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  const candidates = [
    path.resolve(process.cwd(), "backend/.env"),
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "backend/.env.example"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p, override: false });
      break;
    }
  }
}

export function buildDatabaseUrl(input: Partial<NodeJS.ProcessEnv> = process.env): string {
  if (input.DATABASE_URL && input.DATABASE_URL.trim().length > 0) {
    return input.DATABASE_URL.trim();
  }

  const host = input.DB_HOST || "127.0.0.1";
  const port = input.DB_PORT || "3306";
  const user = input.DB_USER || "root";
  const password = input.DB_PASSWORD ?? "";
  const dbName = input.DB_NAME || "agentic_omni_law";
  return `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${dbName}`;
}

export function getEnv(): AppEnv {
  if (cached) return cached;
  loadDotEnv();
  if (!process.env.DATABASE_URL) process.env.DATABASE_URL = buildDatabaseUrl(process.env);

  const parsed = schema.parse(process.env);
  const smtpConfigured = has(parsed.SMTP_HOST) && !!parsed.SMTP_PORT && has(parsed.SMTP_USER) && has(parsed.SMTP_PASS) && has(parsed.SMTP_FROM);
  if (parsed.NODE_ENV === "production" && !smtpConfigured) {
    throw new Error("SMTP not configured. Production requires SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM.");
  }
  cached = {
    ...parsed,
    databaseUrl: buildDatabaseUrl(process.env),
    corsOrigins: parsed.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean),
    smtpConfigured,
  };
  process.env.DATABASE_URL = cached.databaseUrl;
  return cached;
}
