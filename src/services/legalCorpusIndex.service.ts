import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mysqlPool } from "../prisma/client.js";
import { getEnv } from "../config/env.js";
import { extractService } from "./extract.service.js";
import { buildChunks } from "../utils/chunk.js";
import { embedClient } from "../ai/embedClient.js";
import { logger } from "../config/logger.js";

type CorpusType = "act" | "rule" | "sc_judgment" | "hc_judgment";
type ReindexOptions = { force?: boolean; maxFiles?: number };

type IndexResult = {
  scanned_files: number;
  indexed_documents: number;
  indexed_chunks: number;
  skipped_unchanged: number;
  failed_files: number;
  corpus_dir: string;
};

let activeReindex: Promise<IndexResult> | null = null;

async function ensureTables() {
  await mysqlPool.query(`
    CREATE TABLE IF NOT EXISTS corpus_documents (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      source_type VARCHAR(64) NOT NULL DEFAULT 'legal_corpus',
      corpus_type VARCHAR(64) NOT NULL,
      title VARCHAR(512) NOT NULL,
      jurisdiction VARCHAR(32) NOT NULL DEFAULT 'IN',
      file_path VARCHAR(1024) NOT NULL,
      text_path VARCHAR(1024) NULL,
      sha256 VARCHAR(128) NOT NULL,
      meta_json JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY ux_corpus_documents_file_path (file_path(255)),
      KEY idx_corpus_documents_type (corpus_type),
      KEY idx_corpus_documents_sha (sha256)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
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
}

function stablePath(input: string) {
  const direct = path.resolve(process.cwd(), input);
  if (path.isAbsolute(input)) return input;
  if (direct.toLowerCase().includes(`${path.sep}backend${path.sep}backend${path.sep}`)) {
    return direct.replace(`${path.sep}backend${path.sep}backend${path.sep}`, `${path.sep}backend${path.sep}`);
  }
  return direct;
}

function resolveCorpusDir() {
  const configured = getEnv().LEGAL_CORPUS_DIR;
  const first = stablePath(configured);
  if (path.isAbsolute(configured) || first.includes(`${path.sep}legal_corpus`)) return first;
  return path.resolve(process.cwd(), "legal_corpus");
}

function resolveIndexDir() {
  return stablePath(getEnv().LEGAL_CORPUS_INDEX_DIR);
}

function extToMime(file: string) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".txt" || ext === ".json") return "text/plain";
  return "application/octet-stream";
}

function corpusTypeFor(filePath: string): CorpusType {
  const lower = filePath.toLowerCase();
  if (lower.includes(`${path.sep}acts${path.sep}`)) return "act";
  if (lower.includes(`${path.sep}rules${path.sep}`)) return "rule";
  if (lower.includes(`${path.sep}caselaw${path.sep}sc${path.sep}`)) return "sc_judgment";
  if (lower.includes(`${path.sep}caselaw${path.sep}hc${path.sep}`)) return "hc_judgment";
  return "act";
}

function titleFor(filePath: string) {
  const base = path.basename(filePath, path.extname(filePath));
  return base.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "Untitled";
}

function sha256(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

async function readTextForCorpus(filePath: string): Promise<{ text: string; textPath: string | null; needsOcr: boolean }> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".txt") {
    const text = await extractService.extractText(filePath, "text/plain");
    return { text, textPath: filePath, needsOcr: false };
  }
  if (ext === ".json") {
    const raw = await fs.readFile(filePath, "utf8");
    let parsed: any = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const text = parsed?.text || parsed?.body || parsed?.content || raw;
    return { text: String(text || ""), textPath: filePath, needsOcr: false };
  }
  const maybeTextPath = `${filePath}.txt`;
  try {
    const existing = await fs.readFile(maybeTextPath, "utf8");
    if (existing.trim()) return { text: existing, textPath: maybeTextPath, needsOcr: false };
  } catch {
    // no-op
  }
  const extracted = await extractService.extractText(filePath, extToMime(filePath));
  const normalized = String(extracted || "").trim();
  const needsOcr = normalized.length < 300;
  if (normalized) {
    await fs.writeFile(maybeTextPath, normalized, "utf8");
    return { text: normalized, textPath: maybeTextPath, needsOcr };
  }
  return { text: "", textPath: null, needsOcr: true };
}

async function walkCorpusFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries: any[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, String(e.name));
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(full).toLowerCase();
      if (![".txt", ".json", ".pdf", ".docx"].includes(ext)) continue;
      if (full.toLowerCase().includes(`${path.sep}metadata${path.sep}`)) continue;
      if (full.toLowerCase().includes(`${path.sep}cache${path.sep}`)) continue;
      out.push(full);
    }
  }
  await walk(root);
  return out;
}

async function upsertCorpusDocument(input: {
  filePath: string;
  textPath: string | null;
  corpusType: CorpusType;
  title: string;
  sha: string;
  meta: any;
}) {
  const [rows]: any = await mysqlPool.query("SELECT id, sha256 FROM corpus_documents WHERE file_path=? LIMIT 1", [input.filePath]);
  const existing = rows?.[0] || null;
  if (!existing) {
    const id = randomUUID();
    await mysqlPool.query(
      `INSERT INTO corpus_documents (id,source_type,corpus_type,title,jurisdiction,file_path,text_path,sha256,meta_json,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,NOW(3),NOW(3))`,
      [id, "legal_corpus", input.corpusType, input.title, "IN", input.filePath, input.textPath, input.sha, JSON.stringify(input.meta || {})],
    );
    return { id, changed: true };
  }
  const changed = String(existing.sha256 || "") !== String(input.sha || "");
  await mysqlPool.query(
    `UPDATE corpus_documents
     SET corpus_type=?, title=?, jurisdiction='IN', text_path=?, sha256=?, meta_json=?, updated_at=NOW(3)
     WHERE id=?`,
    [input.corpusType, input.title, input.textPath, input.sha, JSON.stringify(input.meta || {}), existing.id],
  );
  return { id: String(existing.id), changed };
}

async function replaceVectorChunks(params: {
  docId: string;
  corpusType: CorpusType;
  chunks: Array<{ text: string; idx: number; offsetStart: number; offsetEnd: number }>;
  metadata: any;
}) {
  await mysqlPool.query("DELETE FROM vector_chunks WHERE doc_id=? AND source_type='legal_corpus'", [params.docId]);
  const batchSize = 50;
  let inserted = 0;
  for (let i = 0; i < params.chunks.length; i += batchSize) {
    const batch = params.chunks.slice(i, i + batchSize);
    if (!batch.length) continue;
    const values: string[] = [];
    const args: any[] = [];
    for (const c of batch) {
      const vector = await embedClient.embed(c.text.slice(0, 2000));
      values.push("(?,?,?,?,?,?,?,?,?,?,?,?,NOW(3),NOW(3))");
      args.push(
        randomUUID(),
        params.docId,
        null,
        "legal_corpus",
        params.corpusType,
        `${params.docId}:${c.idx}`,
        null,
        c.offsetStart,
        c.offsetEnd,
        c.text,
        vector.length ? JSON.stringify(vector) : null,
        JSON.stringify({ ...(params.metadata || {}), index: c.idx }),
      );
      inserted += 1;
    }
    await mysqlPool.query(
      `INSERT INTO vector_chunks
       (id,doc_id,case_id,source_type,corpus_type,chunk_id,page,offset_start,offset_end,chunk_text,embedding_json,metadata_json,created_at,updated_at)
       VALUES ${values.join(",")}`,
      args,
    );
  }
  return inserted;
}

function toChunkData(text: string) {
  const chunks = buildChunks(text, 1000, 150);
  const maxChunks = getEnv().LEGAL_CORPUS_MAX_CHUNKS_PER_DOC;
  const bounded = chunks.length > maxChunks ? chunks.slice(0, maxChunks) : chunks;
  let cursor = 0;
  return bounded.map((c, idx) => {
    const at = text.indexOf(c, cursor);
    const offsetStart = at >= 0 ? at : cursor;
    const offsetEnd = offsetStart + c.length;
    cursor = Math.max(offsetStart + 1, offsetEnd - 150);
    return { text: c, idx, offsetStart, offsetEnd };
  });
}

async function writeIndexManifest(result: IndexResult, indexDir: string) {
  await fs.mkdir(indexDir, { recursive: true });
  const manifestPath = path.join(indexDir, "manifest.json");
  const payload = { ...result, last_indexed_at: new Date().toISOString() };
  await fs.writeFile(manifestPath, JSON.stringify(payload, null, 2), "utf8");
}

async function computeDiskUsage(root: string): Promise<number> {
  let total = 0;
  async function walk(dir: string) {
    let entries: any[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, String(e.name));
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        try {
          const st = await fs.stat(full);
          total += st.size;
        } catch {
          // ignore
        }
      }
    }
  }
  await walk(root);
  return total;
}

export const legalCorpusIndexService = {
  async reindex(options?: ReindexOptions): Promise<IndexResult> {
    if (activeReindex) return activeReindex;
    activeReindex = (async () => {
      await ensureTables();
      const env = getEnv();
      const corpusDir = resolveCorpusDir();
      const files = await walkCorpusFiles(corpusDir);
      const picked = Number(options?.maxFiles || 0) > 0 ? files.slice(0, Number(options?.maxFiles)) : files;
      const force = !!options?.force;
      let indexedDocuments = 0;
      let indexedChunks = 0;
      let skippedUnchanged = 0;
      let failedFiles = 0;
      let emptyTextSkipped = 0;
      const emptyTextSamples: string[] = [];
      let invalidBinarySkipped = 0;
      const invalidBinarySamples: string[] = [];
      for (const filePath of picked) {
        try {
          const relPath = path.relative(corpusDir, filePath).replace(/\\/g, "/");
          const corpusType = corpusTypeFor(filePath);
          const title = titleFor(filePath);
          const fileBytes = await fs.readFile(filePath);
          const fileSha = sha256(fileBytes);
          const { text, textPath, needsOcr } = await readTextForCorpus(filePath);
          if (!text.trim()) {
            failedFiles += 1;
            emptyTextSkipped += 1;
            if (emptyTextSamples.length < 5) {
              emptyTextSamples.push(filePath);
              logger.warn(`legal corpus text empty; skipped: ${filePath}`);
            }
            continue;
          }
          const textSha = sha256(text);
          const up = await upsertCorpusDocument({
            filePath: relPath,
            textPath: textPath ? path.relative(corpusDir, textPath).replace(/\\/g, "/") : null,
            corpusType,
            title,
            sha: textSha,
            meta: {
              file_sha256: fileSha,
              text_sha256: textSha,
              needs_ocr: needsOcr,
            },
          });
          if (!force && !up.changed) {
            skippedUnchanged += 1;
            continue;
          }
          const chunks = toChunkData(text);
          const inserted = await replaceVectorChunks({
            docId: up.id,
            corpusType,
            chunks,
            metadata: {
              source_type: "legal_corpus",
              corpus_type: corpusType,
              title,
              jurisdiction: "IN",
            },
          });
          indexedDocuments += 1;
          indexedChunks += inserted;
        } catch (error: any) {
          failedFiles += 1;
          const msg = String(error?.message || error || "");
          if (msg === "invalid_pdf_payload_html" || msg === "invalid_pdf_signature") {
            invalidBinarySkipped += 1;
            if (invalidBinarySamples.length < 5) {
              invalidBinarySamples.push(filePath);
              logger.warn(`legal corpus file skipped: ${filePath} (${msg})`);
            }
            continue;
          }
          logger.warn(`legal corpus indexing failed for ${filePath}: ${msg}`);
        }
      }
      if (emptyTextSkipped > emptyTextSamples.length) {
        logger.warn(`legal corpus text-empty skips: ${emptyTextSkipped} (showing first ${emptyTextSamples.length})`);
      }
      if (invalidBinarySkipped > invalidBinarySamples.length) {
        logger.warn(`legal corpus invalid-binary skips: ${invalidBinarySkipped} (showing first ${invalidBinarySamples.length})`);
      }
      const result: IndexResult = {
        scanned_files: picked.length,
        indexed_documents: indexedDocuments,
        indexed_chunks: indexedChunks,
        skipped_unchanged: skippedUnchanged,
        failed_files: failedFiles,
        corpus_dir: corpusDir,
      };
      await writeIndexManifest(result, resolveIndexDir());
      return result;
    })().finally(() => {
      activeReindex = null;
    });
    return activeReindex;
  },

  async getStatus() {
    await ensureTables();
    const corpusDir = resolveCorpusDir();
    const indexDir = resolveIndexDir();
    let docsIndexed = 0;
    let chunksIndexed = 0;
    let lastIndexedAt: string | null = null;
    try {
      const [docsRows]: any = await mysqlPool.query("SELECT COUNT(*) AS c FROM corpus_documents WHERE source_type='legal_corpus'");
      docsIndexed = Number(docsRows?.[0]?.c || 0);
      const [chunksRows]: any = await mysqlPool.query("SELECT COUNT(*) AS c FROM vector_chunks WHERE source_type='legal_corpus'");
      chunksIndexed = Number(chunksRows?.[0]?.c || 0);
      const [latestRows]: any = await mysqlPool.query("SELECT MAX(updated_at) AS latest FROM vector_chunks WHERE source_type='legal_corpus'");
      lastIndexedAt = latestRows?.[0]?.latest ? new Date(latestRows[0].latest).toISOString() : null;
    } catch {
      // table may not exist yet
      docsIndexed = 0;
      chunksIndexed = 0;
      lastIndexedAt = null;
    }
    const diskUsageBytes = await computeDiskUsage(corpusDir);
    return {
      enabled: getEnv().ENABLE_LEGAL_CORPUS,
      connected: getEnv().ENABLE_LEGAL_CORPUS && docsIndexed > 0 && chunksIndexed > 0,
      corpus_dir: corpusDir,
      index_dir: indexDir,
      docs_indexed: docsIndexed,
      chunks_indexed: chunksIndexed,
      last_indexed_at: lastIndexedAt,
      disk_usage_bytes: diskUsageBytes,
      reindex_running: !!activeReindex,
    };
  },
};
