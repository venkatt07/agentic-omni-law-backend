import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getEnv } from "../config/env.js";

const execFileAsync = promisify(execFile);

export type OcrResult = {
  text: string;
  used: boolean;
  message?: string;
};

export const ocrService = {
  isScannedPdfLikely(extractedText: string) {
    const raw = String(extractedText || "").trim();
    if (!raw) return true;
    if (raw.length < 180) return true;

    const lower = raw.toLowerCase();
    const legalDocSignals = [
      "high court",
      "supreme court",
      "district court",
      "plaintiff",
      "defendant",
      "petitioner",
      "respondent",
      "jurisdiction",
      "civil suit",
      "written statement",
      "replication",
      "affidavit",
      "order",
      "application",
      "notice",
      "agreement",
      "invoice",
    ].filter((term) => lower.includes(term)).length;

    const alphaNum = raw.replace(/[^A-Za-z0-9]/g, "");
    const words = raw.split(/\s+/).filter(Boolean);
    const longWords = words.filter((word) => word.length >= 4).length;
    const printableRatio = raw.length > 0 ? (raw.match(/[A-Za-z0-9\s.,:;()/-]/g)?.length || 0) / raw.length : 0;
    const digitHeavyShortBurst = words.length > 20 && longWords <= 4;
    const lowReadableDensity = words.length > 0 && longWords / words.length < 0.18;

    if (legalDocSignals >= 2 && printableRatio >= 0.8) return false;
    if (raw.length < 500 && legalDocSignals === 0) return true;
    if (printableRatio < 0.72) return true;
    if (alphaNum.length >= 120 && digitHeavyShortBurst) return true;
    if (raw.length < 1200 && lowReadableDensity && legalDocSignals === 0) return true;
    return false;
  },

  async tryOcrPdf(filePath: string): Promise<OcrResult> {
    const env = getEnv();
    if (!env.OCR_ENABLED) return { text: "", used: false, message: "Scanned document detected; OCR not enabled." };
    if (env.OCR_ENGINE !== "tesseractjs") return { text: "", used: false, message: "Scanned document detected; OCR engine unavailable." };
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-law-ocr-"));
    try {
      const images = await rasterizePdfPages(filePath, tempDir);
      if (!images.length) {
        return { text: "", used: false, message: "Scanned document detected; OCR rasterizer produced no images." };
      }
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("eng");
      const chunks: string[] = [];
      try {
        for (const imagePath of images) {
          const result = await worker.recognize(imagePath);
          const text = String(result?.data?.text || "").trim();
          if (text) chunks.push(text);
        }
      } finally {
        await worker.terminate().catch(() => undefined);
      }
      const text = chunks.join("\n").trim();
      if (!text) {
        return { text: "", used: false, message: "Scanned document detected; OCR completed but no readable text was extracted." };
      }
      return { text, used: true };
    } catch (error) {
      const reason = String((error as any)?.message || error || "").trim();
      return {
        text: "",
        used: false,
        message: reason
          ? `Scanned document detected; OCR failed: ${reason}`
          : "Scanned document detected; OCR failed.",
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  },
};

async function rasterizePdfPages(filePath: string, outDir: string) {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const scriptPath = path.resolve(moduleDir, "../../scripts/render_pdf_pages.py");
  const { stdout } = await execFileAsync("python", [scriptPath, filePath, outDir, "5"], {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  const parsed = JSON.parse(String(stdout || "{}"));
  return Array.isArray(parsed?.images) ? parsed.images.map((value: unknown) => String(value || "")).filter(Boolean) : [];
}
