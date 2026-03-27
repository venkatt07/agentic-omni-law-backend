import { getEnv } from "../../config/env.js";
import { indexService } from "../index.service.js";
import { logger } from "../../config/logger.js";

type RetrieveBundleInput = {
  caseId: string;
  query: string;
  filters?: any;
  kUser?: number;
  kLegal?: number;
  includeLegalCorpus?: boolean;
};

export const retrieveBundleService = {
  async retrieveBundle(input: RetrieveBundleInput) {
    const started = Date.now();
    const env = getEnv();
    const query = String(input.query || "").trim();
    const filters = input.filters || {};
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const kUser = Math.max(1, Number(input.kUser || env.RAG_TOPK_USER));
    const kLegal = Math.max(0, Number(input.kLegal || env.RAG_TOPK_LAW));
    const userHits = await indexService.retrieve(
      input.caseId,
      query ? query.split(/\s+/).filter(Boolean).slice(0, 20) : [],
      kUser,
      {
        includeUserDocs: true,
        includeLegalCorpus: false,
        filters,
      },
    );

    const legalHits = input.includeLegalCorpus
      ? await indexService.retrieve(
          input.caseId,
          query ? query.split(/\s+/).filter(Boolean).slice(0, 20) : [],
          kLegal,
          {
            includeUserDocs: false,
            includeLegalCorpus: true,
            filters,
          },
        )
      : [];

    const merged = [...userHits, ...legalHits];
    const sourceDistribution = {
      user_doc: userHits.length,
      legal_corpus: legalHits.length,
    };
    logger.info(
      `retrieval_bundle request_id=${requestId} case_id=${input.caseId} k_user=${kUser} k_legal=${kLegal} ` +
      `num_chunks=${merged.length} latency_ms=${Date.now() - started} sources=${JSON.stringify(sourceDistribution)}`,
    );
    return {
      request_id: requestId,
      query,
      case_id: input.caseId,
      user_doc_hits: userHits,
      legal_corpus_hits: legalHits,
      merged_hits: merged,
      stats: {
        user_doc_count: userHits.length,
        legal_corpus_count: legalHits.length,
        merged_count: merged.length,
      },
    };
  },
};
