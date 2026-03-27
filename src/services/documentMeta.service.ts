import fs from "fs/promises";
import type { DocumentKind } from "../db/types.js";
import { prisma } from "../prisma/client.js";

export type CaseDocumentMeta = {
  doc_id: string;
  filename: string;
  mime_type: string;
  kind: DocumentKind | string | null;
  path: string | null;
  checksum: string | null;
  updated_at: string;
  language: string;
  extracted_text: string;
  pages: number | null;
  char_count: number | null;
};

export type CaseWorkspaceSummary = {
  total_documents: number;
  uploaded_documents: number;
  pasted_documents: number;
  total_pages: number | null;
  total_char_count: number;
};

function inferPagesFromText(text: string) {
  const chars = String(text || "").length;
  return chars ? Math.max(1, Math.round(chars / 2800)) : null;
}

function countPdfPagesFromBufferFallback(buffer: Buffer) {
  try {
    const source = buffer.toString("latin1");
    const matches = source.match(/\/Type\s*\/Page\b/g);
    const count = matches?.length || 0;
    return count > 0 ? count : null;
  } catch {
    return null;
  }
}

function isPdfDoc(mimeType?: string | null, filename?: string | null) {
  const mime = String(mimeType || "").toLowerCase();
  const name = String(filename || "").toLowerCase();
  return mime.includes("pdf") || name.endsWith(".pdf");
}

async function inferPagesFromDocument(params: {
  text: string;
  isPasted: boolean;
  mimeType?: string | null;
  filename?: string | null;
  filePath?: string | null;
}) {
  if (params.isPasted) return null;
  if (!isPdfDoc(params.mimeType, params.filename) || !params.filePath) {
    return inferPagesFromText(params.text);
  }
  try {
    const buffer = await fs.readFile(params.filePath);
    if (buffer.length < 5 || buffer.subarray(0, 16).toString("latin1").includes("%PDF-") === false) {
      return inferPagesFromText(params.text);
    }
    const mod = (await import("pdf-parse")) as unknown as {
      default?: (buffer: Buffer, options?: Record<string, any>) => Promise<{ numpages?: number }>;
    };
    const pdfParse =
      mod.default ??
      (mod as unknown as (buffer: Buffer, options?: Record<string, any>) => Promise<{ numpages?: number }>);
    const parsed = await pdfParse(buffer, { verbosityLevel: 0 });
    const numPages = Number(parsed?.numpages || 0);
    if (Number.isFinite(numPages) && numPages > 0) return Math.round(numPages);
    const fallbackPages = countPdfPagesFromBufferFallback(buffer);
    if (Number.isFinite(fallbackPages) && Number(fallbackPages) > 0) return Math.round(Number(fallbackPages));
  } catch {
    try {
      const fallbackBuffer = await fs.readFile(params.filePath);
      const fallbackPages = countPdfPagesFromBufferFallback(fallbackBuffer);
      if (Number.isFinite(fallbackPages) && Number(fallbackPages) > 0) return Math.round(Number(fallbackPages));
    } catch {
      // Fall through to deterministic estimate.
    }
  }
  return inferPagesFromText(params.text);
}

export async function resolveCaseDocumentMetas(caseId: string): Promise<CaseDocumentMeta[]> {
  const docs = await prisma.document.findMany({
    where: { caseId },
    orderBy: { updatedAt: "desc" },
  });

  return Promise.all(
    docs.map(async (doc: any) => {
      const text = String(doc.extractedText || "");
      const kind = (doc.kind || null) as DocumentKind | null;
      const pages = await inferPagesFromDocument({
        text,
        isPasted: kind === "pasted_text",
        mimeType: doc.mime,
        filename: doc.name,
        filePath: doc.path,
      });
      return {
        doc_id: String(doc.id),
        filename: String(doc.name || "Untitled document"),
        mime_type: String(doc.mime || "application/octet-stream"),
        kind,
        path: doc.path ? String(doc.path) : null,
        checksum: doc.checksum ? String(doc.checksum) : null,
        updated_at: doc.updatedAt?.toISOString?.() || new Date().toISOString(),
        language: String(doc.detectedLanguage || "English"),
        extracted_text: text,
        pages,
        char_count: text.length || 0,
      };
    }),
  );
}

export async function resolveCaseWorkspaceSummary(caseId: string): Promise<CaseWorkspaceSummary> {
  const docs = await resolveCaseDocumentMetas(caseId);
  const uploadedDocs = docs.filter((doc) => String(doc.kind || "") !== "pasted_text");
  const pastedDocs = docs.filter((doc) => String(doc.kind || "") === "pasted_text");
  const totalPages =
    uploadedDocs.length > 0
      ? uploadedDocs.reduce((sum, doc) => sum + Math.max(0, Number(doc.pages || 0)), 0)
      : null;

  return {
    total_documents: docs.length,
    uploaded_documents: uploadedDocs.length,
    pasted_documents: pastedDocs.length,
    total_pages: totalPages && totalPages > 0 ? totalPages : null,
    total_char_count: docs.reduce((sum, doc) => sum + Math.max(0, Number(doc.char_count || 0)), 0),
  };
}

export async function resolvePrimaryCaseDocumentMeta(caseId: string): Promise<CaseDocumentMeta | null> {
  const caseRow = await prisma.case.findUnique({
    where: { id: caseId },
    select: { primaryDocId: true },
  });
  const docs = await resolveCaseDocumentMetas(caseId);
  const primaryDocId = caseRow?.primaryDocId ? String(caseRow.primaryDocId) : null;
  return (
    (primaryDocId ? docs.find((doc) => doc.doc_id === primaryDocId && String(doc.extracted_text || "").trim()) : null) ||
    docs.find((doc) => String(doc.extracted_text || "").trim()) ||
    null
  );
}

export async function resolveCaseDocumentMeta(caseId: string, docId: string): Promise<CaseDocumentMeta | null> {
  const docs = await resolveCaseDocumentMetas(caseId);
  return docs.find((doc) => doc.doc_id === docId) || null;
}
