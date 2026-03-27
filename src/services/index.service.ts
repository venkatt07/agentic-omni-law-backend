import { mysqlPool, prisma } from "../prisma/client.js";
import { buildChunks } from "../utils/chunk.js";
import { embedClient, cosineSimilarity } from "../ai/embedClient.js";
import { getEnv } from "../config/env.js";
import { hashKey, readJsonCache, runtimeMetrics, writeJsonCache } from "../ai/runtimeMetrics.js";
import { retriever } from "./retrieval/retriever.js";
import { userDocVectorService } from "./userDocVector.service.js";
import { legalCorpusService } from "./legalCorpus.service.js";

const chunkEmbeddingCache = new Map<string, number[]>();

function canonicalSourceLabel(value: unknown) {
  const v = String(value || "").toLowerCase().trim();
  if (!v) return null;
  if (v.includes("acts") || v.includes("act") || v.includes("statute")) return "Acts & Statutes";
  if (v.includes("case laws") || v.includes("case law") || v.includes("caselaw") || v.includes("judgment") || v.includes("sc_judgment") || v.includes("hc_judgment")) return "Case Laws";
  if (v.includes("regulation") || v.includes("rule")) return "Regulations";
  if (v.includes("legal opinion") || v.includes("opinion")) return "Legal Opinions";
  if (v === "legal_corpus") return "Case Laws";
  return null;
}

function normalizeSourceTypeFilter(sourceTypes: unknown): Set<string> {
  const set = new Set<string>();
  for (const t of Array.isArray(sourceTypes) ? sourceTypes : []) {
    const label = canonicalSourceLabel(t);
    if (label) set.add(label);
  }
  return set;
}

export const indexService = {
  async refreshCaseDocuments(caseId: string) {
    const c = await prisma.case.findUnique({ where: { id: caseId } });
    const docs = await prisma.document.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } });
    for (const doc of docs) {
      const [vectorCountRows]: any = await mysqlPool.query(
        "SELECT COUNT(*) AS c FROM vector_chunks WHERE doc_id=? AND source_type='user_doc'",
        [doc.id],
      );
      const hasUserDocVectors = Number(vectorCountRows?.[0]?.c || 0) > 0;
      if (doc.indexedChecksum && doc.indexedChecksum === doc.checksum && hasUserDocVectors) {
        continue;
      }

      await prisma.indexChunk.deleteMany({ where: { caseId, docId: doc.id } });
      const chunks = buildChunks(doc.extractedText || "", 1000, 150);
      if (chunks.length > 0) {
        await prisma.indexChunk.createMany({
          data: chunks.map((chunk, idx) => ({
            caseId,
            docId: doc.id,
            chunkId: `${doc.id}:${idx}`,
            chunkText: chunk,
            metaJson: {
              index: idx,
              length: chunk.length,
              source_type: "user_doc",
              language: doc.detectedLanguage || "Unknown",
              jurisdiction: chunk.toLowerCase().includes("india") ? "India" : null,
              legal_domain: chunk.toLowerCase().includes("contract") ? "Contract" : null,
              doc_date: (chunk.match(/\b20\d{2}\b/) || [])[0] || null,
            } as any,
          })),
          skipDuplicates: true,
        });
      }

      await userDocVectorService.indexDocument({
        id: doc.id,
        caseId,
        userId: c?.userId || "",
        name: doc.name,
        checksum: doc.checksum,
        extractedText: doc.extractedText || "",
        detectedLanguage: doc.detectedLanguage || undefined,
      });

      await prisma.document.update({
        where: { id: doc.id },
        data: { indexedChecksum: doc.checksum },
      });
    }
  },

  async retrieve(
    caseId: string,
    terms: string[],
    limit = 6,
    options?: { includeUserDocs?: boolean; includeLegalCorpus?: boolean; sourceTypes?: string[]; filters?: any; lexicalOnly?: boolean; warmChunkEmbeddings?: boolean },
  ) {
    const env = getEnv();
    const started = Date.now();
    const includeUserDocs = options?.includeUserDocs !== false;
    const includeLegalCorpus = options?.includeLegalCorpus === true;
    const lexicalOnly = options?.lexicalOnly === true;
    const warmChunkEmbeddings = options?.warmChunkEmbeddings !== false;
    const needles = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter(Boolean))];
    const retrievalCacheKey = hashKey(JSON.stringify({
      caseId,
      needles,
      limit: Math.min(limit, env.RETRIEVE_TOPK),
      includeUserDocs,
      includeLegalCorpus,
      sourceTypes: options?.sourceTypes || [],
      filters: options?.filters || {},
      lexicalOnly,
    }));
    const cached = readJsonCache<any[]>("retrieval", retrievalCacheKey);
    if (cached && Array.isArray(cached)) {
      runtimeMetrics.recordCache("retrieval", true);
      runtimeMetrics.recordAiLatency("/retrieval", Date.now() - started);
      return cached;
    }
    runtimeMetrics.recordCache("retrieval", false);
    if (needles.length === 0 && includeUserDocs) {
      const rows = await retriever.retrieveCaseSnippets(caseId, "", limit, {});
      const result = rows.map((row: any) => ({
        doc_id: row.doc_id,
        chunk_id: row.chunk_id,
        snippet: String(row.snippet || "").slice(0, 220),
        text: String(row.text || "").slice(0, env.RETRIEVE_MAX_CHARS_PER_CHUNK),
        source_type: "user_doc",
        meta: row.metadata || {},
      }));
      writeJsonCache("retrieval", retrievalCacheKey, result);
      runtimeMetrics.recordAiLatency("/retrieval", Date.now() - started);
      return result;
    }
    const candidates: Array<{ doc_id: string; chunk_id: string; text: string; snippet: string; source_type: string; source_label?: string; meta?: any }> = [];
    if (includeUserDocs) {
      const rows = await retriever.retrieveCaseSnippets(
        caseId,
        terms.join(" "),
        Math.max(limit * 4, env.RAG_TOPK_USER * 3),
        { doc_id: options?.filters?.doc_id },
      );
      const userLimit = Math.max(limit * 4, env.RAG_TOPK_USER * 3);
      candidates.push(
        ...rows.slice(0, userLimit).map((row: any) => ({
          doc_id: row.doc_id,
          chunk_id: row.chunk_id,
          text: String(row.text || "").slice(0, env.RETRIEVE_MAX_CHARS_PER_CHUNK),
          snippet: String(row.snippet || "").slice(0, 220),
          source_type: "user_doc",
          meta: row.metadata || {},
        })),
      );
    }
    if (includeLegalCorpus) {
      let corpusRows = await retriever.retrieveLegalCorpusSnippets(
        terms.join(" "),
        Math.max(limit * 4, env.RAG_TOPK_LAW * 3),
        { jurisdiction: options?.filters?.jurisdiction },
      );
      if (!corpusRows.length) {
        try {
          const fallbackRows = await legalCorpusService.retrieve(
            terms,
            Math.max(limit * 4, env.RAG_TOPK_LAW * 3),
            options?.sourceTypes || options?.filters?.source_types,
            options?.filters,
          );
          corpusRows = fallbackRows.map((row: any) => ({
            doc_id: row.doc_id,
            chunk_id: row.chunk_id,
            text: row.text,
            snippet: row.snippet,
            metadata: {
              source_label: row.source_label,
              corpus_type: row.source_label,
              jurisdiction: row.jurisdiction,
              legal_domain: row.legal_domain,
              doc_date: row.doc_date,
              language: row.language || "English",
            },
            title: row.source_name || row.doc_id,
          })) as any[];
        } catch {
          // best effort fallback only
        }
      }
        candidates.push(
          ...corpusRows.map((row) => ({
            doc_id: String(row.doc_id),
            chunk_id: String(row.chunk_id),
            text: String(row.text || "").slice(0, env.RETRIEVE_MAX_CHARS_PER_CHUNK),
            snippet: String(row.snippet || "").slice(0, 220),
            source_type: "legal_corpus",
            source_label:
              canonicalSourceLabel((row as any)?.metadata?.source_label || (row as any)?.metadata?.corpus_type || "") ||
              "Case Laws",
            meta: {
              source_type: "legal_corpus",
              source_label:
                canonicalSourceLabel((row as any)?.metadata?.source_label || (row as any)?.metadata?.corpus_type || "") ||
                "Case Laws",
              jurisdiction: (row as any)?.metadata?.jurisdiction || null,
              legal_domain: (row as any)?.metadata?.legal_domain || null,
              doc_date: (row as any)?.metadata?.doc_date || null,
              language: (row as any)?.metadata?.language || "English",
              source_name: row.title || row.doc_id,
          },
        })),
      );
    }

    const filteredCandidates = candidates.filter((row: any) => {
      const f = options?.filters;
      if (!f) return true;
      const meta = row.meta || {};
      if (f.jurisdiction && meta.jurisdiction && !String(meta.jurisdiction).toLowerCase().includes(String(f.jurisdiction).toLowerCase())) return false;
      if (f.legal_domain && meta.legal_domain && !String(meta.legal_domain).toLowerCase().includes(String(f.legal_domain).toLowerCase())) return false;
      const requestedSourceTypes = normalizeSourceTypeFilter(
        Array.isArray(f.source_types) && f.source_types.length ? f.source_types : options?.sourceTypes,
      );
      if (requestedSourceTypes.size && row.source_type !== "user_doc") {
        const rowCandidates = [
          row.source_label,
          row.meta?.source_label,
          row.meta?.corpus_type,
          row.source_type,
        ]
          .map((v: any) => canonicalSourceLabel(v))
          .filter(Boolean) as string[];
        if (!rowCandidates.some((label) => requestedSourceTypes.has(label))) return false;
      }
      if (f.date_range && meta.doc_date) {
        const from = f.date_range.from ? new Date(f.date_range.from).getTime() : null;
        const to = f.date_range.to ? new Date(f.date_range.to).getTime() : null;
        const actual = new Date(String(meta.doc_date)).getTime();
        if (!Number.isNaN(actual)) {
          if (from && actual < from) return false;
          if (to && actual > to) return false;
        }
      }
      return true;
    });

    let queryVector: number[] = [];
    if (!lexicalOnly) {
      try {
        queryVector = await embedClient.embed(needles.join(" "));
      } catch {
        queryVector = [];
      }
    }

    const scored = filteredCandidates
      .map((row) => {
        const text = row.text.toLowerCase();
        let lexical = 0;
        for (const n of needles) {
          if (text.includes(n)) lexical += 1 + (text.split(n).length - 1) * 0.2;
        }
        let vector = 0;
        if (queryVector.length) {
          const cacheKey = `${row.doc_id}:${row.chunk_id}`;
          const existing = chunkEmbeddingCache.get(cacheKey);
          if (existing) {
            vector = cosineSimilarity(queryVector, existing);
          }
        }
        const score = env.RAG_HYBRID_BM25_WEIGHT * lexical + env.RAG_VECTOR_WEIGHT * vector;
        return { row, score, lexical, vector };
      })
      .filter((x) => (needles.length ? x.score > 0 || x.lexical > 0 : true))
      .sort((a, b) => b.score - a.score);
    if (!lexicalOnly && warmChunkEmbeddings) {
      const warmRows = scored
        .slice(0, Math.min(scored.length, Math.max(4, Math.min(limit * 2, 10))))
        .map(({ row }) => row);
      // Warm embeddings in background for top candidates only; never block retrieval response.
      setImmediate(() => {
        void (async () => {
          for (const row of warmRows) {
            const key = `${row.doc_id}:${row.chunk_id}`;
            if (chunkEmbeddingCache.has(key)) continue;
            try {
              const vector = await embedClient.embed(row.text.slice(0, 2000));
              if (vector.length) chunkEmbeddingCache.set(key, vector);
            } catch {
              // best-effort
            }
          }
        })();
      });
    }
    const deduped = new Map<string, any>();
    for (const item of scored) {
      const key = `${item.row.doc_id}:${item.row.chunk_id}`;
      if (!deduped.has(key)) deduped.set(key, item.row);
      if (deduped.size >= Math.min(limit, env.RETRIEVE_TOPK)) break;
    }
    const result = [...deduped.values()];
    writeJsonCache("retrieval", retrievalCacheKey, result);
    runtimeMetrics.recordAiLatency("/retrieval", Date.now() - started);
    return result;
  },
};
