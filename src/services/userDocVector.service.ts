import { randomUUID } from "node:crypto";
import { mysqlPool } from "../prisma/client.js";
import { buildChunks } from "../utils/chunk.js";
import { embedClient } from "../ai/embedClient.js";

type IndexDocumentInput = {
  id: string;
  caseId: string;
  userId: string;
  name: string;
  checksum: string;
  extractedText: string;
  detectedLanguage?: string | null;
};

export const userDocVectorService = {
  async ensureTable() {
    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS vector_chunks (
        id VARCHAR(191) NOT NULL PRIMARY KEY,
        doc_id VARCHAR(191) NOT NULL,
        case_id VARCHAR(191) NULL,
        source_type VARCHAR(64) NOT NULL,
        corpus_type VARCHAR(64) NULL,
        chunk_id VARCHAR(191) NOT NULL,
        page INT NULL,
        offset_start INT NULL,
        offset_end INT NULL,
        chunk_text LONGTEXT NOT NULL,
        embedding_json LONGTEXT NULL,
        metadata_json JSON NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY ux_vector_chunks_doc_chunk (doc_id, chunk_id),
        KEY idx_vector_chunks_source (source_type),
        KEY idx_vector_chunks_case (case_id),
        KEY idx_vector_chunks_doc (doc_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  },

  async deleteByDocId(docId: string) {
    await this.ensureTable();
    await mysqlPool.query(
      "DELETE FROM vector_chunks WHERE doc_id=? AND source_type='user_doc'",
      [docId],
    );
  },

  async indexDocument(input: IndexDocumentInput) {
    await this.ensureTable();
    await this.deleteByDocId(input.id);
    const text = String(input.extractedText || "").trim();
    if (!text) {
      return { chunks_indexed: 0, language: input.detectedLanguage || "Unknown" };
    }

    const chunks = buildChunks(text, 1000, 150);
    let cursor = 0;
    let indexed = 0;
    for (let idx = 0; idx < chunks.length; idx += 1) {
      const chunk = chunks[idx];
      const at = text.indexOf(chunk, cursor);
      const offsetStart = at >= 0 ? at : cursor;
      const offsetEnd = offsetStart + chunk.length;
      cursor = Math.max(offsetStart + 1, offsetEnd - 150);
      const embedding = await embedClient.embed(chunk.slice(0, 2000));
      const metadata = {
        source_type: "user_doc",
        case_id: input.caseId,
        user_id: input.userId,
        session_id: null,
        doc_name: input.name,
        doc_checksum: input.checksum,
        language: input.detectedLanguage || "Unknown",
        section: chunk.slice(0, 120),
      };
      await mysqlPool.query(
        `INSERT INTO vector_chunks
         (id,doc_id,case_id,source_type,corpus_type,chunk_id,page,offset_start,offset_end,chunk_text,embedding_json,metadata_json,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW(3),NOW(3))`,
        [
          randomUUID(),
          input.id,
          input.caseId,
          "user_doc",
          null,
          `${input.id}:${idx}`,
          null,
          offsetStart,
          offsetEnd,
          chunk,
          embedding.length ? JSON.stringify(embedding) : null,
          JSON.stringify(metadata),
        ],
      );
      indexed += 1;
    }

    return { chunks_indexed: indexed, language: input.detectedLanguage || "Unknown" };
  },
};

