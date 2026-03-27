import fs from "fs/promises";
import path from "path";
import type { DocumentKind } from "../db/types.js";
import { mysqlPool, prisma } from "../prisma/client.js";
import { getEnv } from "../config/env.js";
import { HttpError } from "../middleware/error.js";
import { sha256 } from "../utils/hash.js";
import { extractService } from "./extract.service.js";
import { notificationService } from "./notification.service.js";
import { detectLanguageInfo } from "../utils/language.js";
import { userDocVectorService } from "./userDocVector.service.js";

function userCaseStorageDir(userId: string, caseId: string) {
  const env = getEnv();
  return path.resolve(process.cwd(), env.STORAGE_DIR, userId, caseId);
}

async function ensureCaseOwnedByUser(userId: string, caseId: string) {
  const c = await prisma.case.findUnique({ where: { id: caseId } });
  if (!c || c.userId !== userId) throw new HttpError(404, "Case not found", "case_not_found");
  return c;
}

async function persistDocument(params: {
  userId: string;
  caseId: string;
  name: string;
  mime: string;
  size: number;
  filePath: string;
  kind: DocumentKind;
}) {
  const fileBuffer = await fs.readFile(params.filePath);
  const checksum = sha256(fileBuffer);
  const extractedText = await extractService.extractText(params.filePath, params.mime);
  const detectedLanguageInfo = detectLanguageInfo(extractedText);
  const detectedLanguage = detectedLanguageInfo.label;

  const doc = await prisma.document.create({
    data: {
      caseId: params.caseId,
      name: params.name,
      mime: params.mime,
      size: params.size,
      path: params.filePath,
      kind: params.kind,
      checksum,
      extractedText,
      detectedLanguage,
    },
  });

  const allDocs = await prisma.document.findMany({ where: { caseId: params.caseId }, select: { extractedText: true, detectedLanguage: true } });
  const caseDetectedLanguage = deriveCaseLanguage(allDocs.map((d: any) => ({ text: d.extractedText || "", language: d.detectedLanguage || "Unknown" })));
  await prisma.case.update({
    where: { id: params.caseId },
    data: { updatedAt: new Date(), detectedLanguage: caseDetectedLanguage, primaryDocId: doc.id },
  });

  const ingestion = await userDocVectorService.indexDocument({
    id: doc.id,
    caseId: params.caseId,
    userId: params.userId,
    name: params.name,
    checksum,
    extractedText,
    detectedLanguage,
  });

  await notificationService.create(params.userId, "Document uploaded", `${params.name} added to case ${params.caseId}`);

  return { doc, ingestion };
}

export const documentService = {
  userCaseStorageDir,

  async saveUploadedFiles(userId: string, caseId: string, files: Express.Multer.File[]) {
    await ensureCaseOwnedByUser(userId, caseId);
    const out = [];
    const ingestion: Array<{ doc_id: string; chunks_indexed: number; language: string }> = [];
    for (const file of files) {
      const result = await persistDocument({
        userId,
        caseId,
        name: file.originalname,
        mime: file.mimetype || "application/octet-stream",
        size: file.size,
        filePath: file.path,
        kind: "uploaded",
      });
      const doc = result.doc;
      out.push({
        doc_id: doc.id,
        name: doc.name,
        type: doc.mime,
        size: doc.size,
        created_at: doc.createdAt.toISOString(),
      });
      ingestion.push({
        doc_id: doc.id,
        chunks_indexed: result.ingestion.chunks_indexed,
        language: result.ingestion.language,
      });
    }
    return { documents: out, ingestion };
  },

  async savePastedText(userId: string, caseId: string, text: string, title?: string) {
    await ensureCaseOwnedByUser(userId, caseId);
    if (!text.trim()) throw new HttpError(400, "Text is required", "text_required");
    const normalizedTitle = title || "Pasted Text";
    const lockKey = `query_context:${caseId}`;

    // Keep a single current query-context document per case to avoid stale query contamination.
    if (normalizedTitle === "query-context") {
      try { await mysqlPool.query("SELECT GET_LOCK(?, 5)", [lockKey]); } catch {}
      try {
        const oldQueryDocs = await prisma.document.findMany({
          where: { caseId, kind: "pasted_text", name: "query-context" },
          select: { id: true, path: true },
        });
        for (const oldDoc of oldQueryDocs) {
          await userDocVectorService.deleteByDocId(oldDoc.id).catch(() => undefined);
          await prisma.indexChunk.deleteMany({ where: { caseId, docId: oldDoc.id } });
          await prisma.document.deleteMany({ where: { id: oldDoc.id } }).catch(() => undefined);
          await fs.unlink(oldDoc.path).catch(() => undefined);
        }
      } finally {
        try { await mysqlPool.query("SELECT RELEASE_LOCK(?)", [lockKey]); } catch {}
      }
    }

    const dir = userCaseStorageDir(userId, caseId);
    await fs.mkdir(dir, { recursive: true });
    const fileName = `${normalizedTitle.replace(/[^a-z0-9-_ ]/gi, "").trim() || "pasted-text"}-${Date.now()}.txt`;
    const fullPath = path.join(dir, fileName);
    await fs.writeFile(fullPath, text, "utf8");
    const result = await persistDocument({
      userId,
      caseId,
      name: normalizedTitle,
      mime: "text/plain",
      size: Buffer.byteLength(text),
      filePath: fullPath,
      kind: "pasted_text",
    });
    const doc = result.doc;

    // Defensive cleanup for rare concurrent writes: keep only newest query-context row.
    if (normalizedTitle === "query-context") {
      const rows = await prisma.document.findMany({
        where: { caseId, kind: "pasted_text", name: "query-context" },
        orderBy: { createdAt: "desc" },
      });
      const keepId = rows[0]?.id;
      for (const row of rows.slice(1)) {
        if (row.id === keepId) continue;
        await userDocVectorService.deleteByDocId(row.id).catch(() => undefined);
        await prisma.indexChunk.deleteMany({ where: { caseId, docId: row.id } });
        await prisma.document.deleteMany({ where: { id: row.id } }).catch(() => undefined);
        await fs.unlink(row.path).catch(() => undefined);
      }
    }
    return { doc_id: doc.id, ingestion: result.ingestion };
  },

  async ensureOwnedCase(userId: string, caseId: string) {
    return ensureCaseOwnedByUser(userId, caseId);
  },
};

function deriveCaseLanguage(docs: Array<{ text: string; language: string }>) {
  if (!docs.length) return "Unknown";
  const bucket = new Map<string, number>();
  for (const d of docs) {
    const weight = Math.max(1, d.text.length);
    bucket.set(d.language, (bucket.get(d.language) || 0) + weight);
  }
  return [...bucket.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "Unknown";
}
