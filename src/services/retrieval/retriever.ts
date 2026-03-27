import { createHash } from "node:crypto";
import { mysqlPool } from "../../prisma/client.js";
import { embedClient, cosineSimilarity } from "../../ai/embedClient.js";
import { getEnv } from "../../config/env.js";

type RetrieverFilters = {
  source_type?: "user_doc" | "legal_corpus";
  corpus_type?: "act" | "rule" | "sc_judgment" | "hc_judgment";
  jurisdiction?: string;
  doc_id?: string;
};

export type RetrievedSnippet = {
  source_type: "user_doc" | "legal_corpus";
  doc_id: string;
  title: string | null;
  chunk_id: string;
  page: number | null;
  offset_start: number | null;
  offset_end: number | null;
  snippet: string;
  text: string;
  score: number;
  metadata?: any;
};

const CACHE_LIMIT = 256;
const queryCache = new Map<string, RetrievedSnippet[]>();

function termsFromQuery(query: string) {
  return String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .slice(0, 12);
}

function hashKey(parts: any) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function cacheGet(key: string) {
  const hit = queryCache.get(key);
  if (!hit) return null;
  queryCache.delete(key);
  queryCache.set(key, hit);
  return hit;
}

function cacheSet(key: string, value: RetrievedSnippet[]) {
  queryCache.set(key, value);
  while (queryCache.size > CACHE_LIMIT) {
    const first = queryCache.keys().next().value;
    if (!first) break;
    queryCache.delete(first);
  }
}

function lexicalScore(text: string, terms: string[]) {
  const lower = String(text || "").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    const count = lower.split(term).length - 1;
    if (count > 0) score += 1 + count * 0.25;
  }
  return score;
}

export const retriever = {
  async retrieveCaseSnippets(caseId: string, query: string, topK = 8, filters?: RetrieverFilters): Promise<RetrievedSnippet[]> {
    const env = getEnv();
    const terms = termsFromQuery(query);
    const clauses: string[] = ["vc.source_type='user_doc'", "vc.case_id=?"];
    const params: any[] = [caseId];
    if (filters?.doc_id) {
      clauses.push("vc.doc_id=?");
      params.push(filters.doc_id);
    }
    if (terms.length) {
      const termClause: string[] = [];
      for (const t of terms.slice(0, 6)) {
        termClause.push("vc.chunk_text LIKE ?");
        params.push(`%${t}%`);
      }
      clauses.push(`(${termClause.join(" OR ")})`);
    }
    const sql = `
      SELECT vc.doc_id, vc.chunk_id, vc.page, vc.offset_start, vc.offset_end, vc.chunk_text, vc.embedding_json, vc.metadata_json
      FROM vector_chunks vc
      WHERE ${clauses.join(" AND ")}
      ORDER BY vc.updated_at DESC
      LIMIT 1200
    `;
    const [rows]: any = await mysqlPool.query(sql, params);
    if (!Array.isArray(rows) || !rows.length) return [];
    const queryVector = terms.length ? await embedClient.embed(terms.join(" ")) : [];
    const scored = rows.map((row: any) => {
      const text = String(row.chunk_text || "");
      const lex = lexicalScore(text, terms);
      let vec = 0;
      if (queryVector.length && row.embedding_json) {
        try {
          const embedding = typeof row.embedding_json === "string" ? JSON.parse(row.embedding_json) : row.embedding_json;
          if (Array.isArray(embedding) && embedding.length === queryVector.length) {
            vec = cosineSimilarity(queryVector, embedding);
          }
        } catch {
          vec = 0;
        }
      }
      const metadata = (() => {
        try {
          return typeof row.metadata_json === "string" ? JSON.parse(row.metadata_json) : row.metadata_json;
        } catch {
          return {};
        }
      })();
      const score = env.RAG_HYBRID_BM25_WEIGHT * lex + env.RAG_VECTOR_WEIGHT * vec;
      return {
        source_type: "user_doc" as const,
        doc_id: String(row.doc_id),
        title: null,
        chunk_id: String(row.chunk_id),
        page: row.page ?? null,
        offset_start: row.offset_start ?? null,
        offset_end: row.offset_end ?? null,
        snippet: text.split(" ").slice(0, 25).join(" "),
        text,
        score,
        metadata,
      };
    });
    return scored
      .sort((a: RetrievedSnippet, b: RetrievedSnippet) => b.score - a.score)
      .slice(0, Math.max(1, topK));
  },

  async retrieveLegalCorpusSnippets(query: string, topK = 8, filters?: RetrieverFilters): Promise<RetrievedSnippet[]> {
    const env = getEnv();
    if (!env.ENABLE_LEGAL_CORPUS) return [];
    const terms = termsFromQuery(query);
    const cacheKey = hashKey({ query, topK, filters, terms });
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const clauses: string[] = ["vc.source_type='legal_corpus'"];
    const params: any[] = [];
    if (filters?.corpus_type) {
      clauses.push("vc.corpus_type=?");
      params.push(filters.corpus_type);
    }
    if (filters?.jurisdiction) {
      clauses.push("JSON_UNQUOTE(JSON_EXTRACT(vc.metadata_json,'$.jurisdiction')) LIKE ?");
      params.push(`%${filters.jurisdiction}%`);
    }
    if (terms.length) {
      const likeTerms: string[] = [];
      for (const t of terms.slice(0, 6)) {
        likeTerms.push("vc.chunk_text LIKE ?");
        params.push(`%${t}%`);
      }
      clauses.push(`(${likeTerms.join(" OR ")})`);
    }

    const sql = `
      SELECT vc.doc_id, vc.chunk_id, vc.page, vc.offset_start, vc.offset_end, vc.chunk_text, vc.embedding_json, vc.metadata_json, cd.title
      FROM vector_chunks vc
      LEFT JOIN corpus_documents cd ON cd.id = vc.doc_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY vc.updated_at DESC
      LIMIT 1200
    `;
    const [rows]: any = await mysqlPool.query(sql, params);
    if (!Array.isArray(rows) || rows.length === 0) {
      cacheSet(cacheKey, []);
      return [];
    }
    const queryVector = terms.length ? await embedClient.embed(terms.join(" ")) : [];
    const scored: RetrievedSnippet[] = rows.map((row: any) => {
      const text = String(row.chunk_text || "");
      const lex = lexicalScore(text, terms);
      let vec = 0;
      if (queryVector.length && row.embedding_json) {
        try {
          const embedding = typeof row.embedding_json === "string" ? JSON.parse(row.embedding_json) : row.embedding_json;
          if (Array.isArray(embedding) && embedding.length === queryVector.length) {
            vec = cosineSimilarity(queryVector, embedding);
          }
        } catch {
          vec = 0;
        }
      }
      return {
        source_type: "legal_corpus",
        doc_id: String(row.doc_id),
        title: row.title ? String(row.title) : null,
        chunk_id: String(row.chunk_id),
        page: row.page == null ? null : Number(row.page),
        offset_start: row.offset_start == null ? null : Number(row.offset_start),
        offset_end: row.offset_end == null ? null : Number(row.offset_end),
        snippet: text.split(" ").slice(0, 25).join(" "),
        text,
        score: env.RAG_HYBRID_BM25_WEIGHT * lex + env.RAG_VECTOR_WEIGHT * vec,
        metadata: (() => {
          try {
            return typeof row.metadata_json === "string" ? JSON.parse(row.metadata_json) : row.metadata_json;
          } catch {
            return {};
          }
        })(),
      };
    });
    const result = scored
      .sort((a: RetrievedSnippet, b: RetrievedSnippet) => b.score - a.score)
      .slice(0, Math.max(1, topK));
    cacheSet(cacheKey, result);
    return result;
  },
};
