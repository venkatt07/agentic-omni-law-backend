import fs from "fs/promises";
import path from "path";
import mammoth from "mammoth";
import { ocrService } from "../ai/ocr.js";

export const extractService = {
  async extractText(filePath: string, mime?: string) {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === ".txt" || mime?.includes("text/plain")) {
      const rawBuffer = await fs.readFile(filePath);
      const raw = decodeTextBuffer(rawBuffer);
      return normalizeText(raw);
    }

    if (ext === ".docx" || mime?.includes("wordprocessingml")) {
      const result = await mammoth.extractRawText({ path: filePath });
      return normalizeText(result.value || "");
    }

    if (ext === ".pdf" || mime?.includes("pdf")) {
      const buffer = await fs.readFile(filePath);
      if (!looksLikePdfBuffer(buffer)) {
        const head = buffer.subarray(0, 1024).toString("utf8").toLowerCase();
        if (head.includes("<!doctype html") || head.includes("<html")) {
          throw new Error("invalid_pdf_payload_html");
        }
        throw new Error("invalid_pdf_signature");
      }
      const mod = (await import("pdf-parse")) as unknown as {
        default?: (buffer: Buffer, options?: Record<string, any>) => Promise<{ text?: string }>;
      };
      const pdfParse = mod.default ?? (mod as unknown as (buffer: Buffer, options?: Record<string, any>) => Promise<{ text?: string }>);
      const parsed = await withPdfWarningsSuppressed(() => pdfParse(buffer, { verbosityLevel: 0 }));
      let text = normalizeText(parsed?.text || "");
      if (ocrService.isScannedPdfLikely(text)) {
        const ocr = await ocrService.tryOcrPdf(filePath);
        if (ocr.text?.trim()) {
          text = normalizeText(`${text}\n${ocr.text}`);
        }
      }
      return text;
    }

    // Best-effort fallback for unknown text-like files.
    try {
      const rawBuffer = await fs.readFile(filePath);
      const raw = decodeTextBuffer(rawBuffer);
      return normalizeText(raw);
    } catch {
      return "";
    }
  },
};

function normalizeText(input: string) {
  return input.replace(/\u0000/g, " ").replace(/\s+/g, " ").trim();
}

function decodeTextBuffer(buffer: Buffer) {
  if (!buffer || !buffer.length) return "";
  // UTF-8 BOM
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.slice(3).toString("utf8");
  }
  // UTF-16 LE BOM
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.slice(2).toString("utf16le");
  }
  // UTF-16 BE BOM
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.slice(2));
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const a = swapped[i];
      swapped[i] = swapped[i + 1];
      swapped[i + 1] = a;
    }
    return swapped.toString("utf16le");
  }
  // Heuristic UTF-16 without BOM
  const sample = buffer.subarray(0, Math.min(buffer.length, 2048));
  let zeroEven = 0;
  let zeroOdd = 0;
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) {
      if (i % 2 === 0) zeroEven += 1;
      else zeroOdd += 1;
    }
  }
  const threshold = Math.max(8, Math.floor(sample.length * 0.2));
  if (zeroOdd > threshold || zeroEven > threshold) {
    if (zeroOdd >= zeroEven) return buffer.toString("utf16le");
    const swapped = Buffer.from(buffer);
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const a = swapped[i];
      swapped[i] = swapped[i + 1];
      swapped[i + 1] = a;
    }
    return swapped.toString("utf16le");
  }
  return buffer.toString("utf8");
}

function looksLikePdfBuffer(buffer: Buffer) {
  if (!buffer || buffer.length < 5) return false;
  const head = buffer.subarray(0, 16).toString("latin1");
  return head.includes("%PDF-");
}

async function withPdfWarningsSuppressed<T>(fn: () => Promise<T>): Promise<T> {
  const originalWarn = console.warn;
  const originalLog = console.log;
  const noisy = [
    "Ignoring invalid character",
    "Indexing all PDF objects",
    "TT: ",
    "Required \"glyf\" table",
  ];
  const shouldSuppress = (line: string) => noisy.some((p) => line.includes(p));
  const patch = (orig: (...args: any[]) => void) => (...args: any[]) => {
    const line = args.map((a) => String(a ?? "")).join(" ");
    if (shouldSuppress(line)) return;
    orig(...args);
  };
  console.warn = patch(originalWarn);
  console.log = patch(originalLog);
  try {
    return await fn();
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
}
