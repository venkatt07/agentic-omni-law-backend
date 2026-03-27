import fs from "fs/promises";
import path from "path";
import { getEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import { extractService } from "./extract.service.js";
import { chunkText } from "../utils/chunk.js";

type CorpusChunk = {
  source_id: string;
  source_name: string;
  source_type: "legal_corpus";
  source_label: string;
  chunk_id: string;
  chunk_text: string;
  language?: string;
  jurisdiction?: string | null;
  legal_domain?: string | null;
  doc_date?: string | null;
};

class LegalCorpusService {
  private loaded = false;
  private loading: Promise<void> | null = null;
  private chunks: CorpusChunk[] = [];

  async preload() {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = this.load();
    await this.loading;
  }

  private async load() {
    const configured = getEnv().LEGAL_CORPUS_DIR;
    let dir = path.resolve(process.cwd(), configured);
    if (!path.isAbsolute(configured) && dir.toLowerCase().includes(`${path.sep}backend${path.sep}backend${path.sep}`)) {
      dir = dir.replace(`${path.sep}backend${path.sep}backend${path.sep}`, `${path.sep}backend${path.sep}`);
    }
    try {
      const files = await listCorpusFilesRecursive(dir);
      const all: CorpusChunk[] = [];
      for (const file of files) {
        try {
          const ext = path.extname(file).toLowerCase();
          if (![".txt", ".pdf", ".docx"].includes(ext)) continue;
          const text = await extractService.extractText(file);
          if (!String(text || "").trim()) continue;
          const chunks = chunkText(text, 1000, 150);
          const rel = path.relative(dir, file);
          const sourceLabel = inferSourceLabel(rel);
          const meta = inferCorpusMeta(rel, text);
          chunks.forEach((chunk, idx) => {
            all.push({
              source_id: rel,
              source_name: rel,
              source_type: "legal_corpus",
              source_label: sourceLabel,
              chunk_id: `${rel}:${idx}`,
              chunk_text: chunk,
              language: meta.language,
              jurisdiction: meta.jurisdiction,
              legal_domain: meta.legal_domain,
              doc_date: meta.doc_date,
            });
          });
        } catch (fileErr: any) {
          logger.warn(`legal corpus file skipped: ${file} (${fileErr?.message || "unknown error"})`);
        }
      }
      this.chunks = all;
      this.loaded = true;
      logger.info(`legal corpus loaded: ${this.chunks.length} chunks from ${dir}`);
    } catch (err: any) {
      this.chunks = [];
      this.loaded = true;
      logger.warn(`legal corpus preload failed: ${dir} (${err?.message || "unknown error"})`);
    } finally {
      this.loading = null;
    }
  }

  async retrieve(terms: string[], limit = 6, sourceTypes?: string[], filters?: any) {
    await this.preload();
    const needles = [...new Set(terms.map((t) => t.toLowerCase().trim()).filter(Boolean))];
    const filtered = this.chunks.filter((c) => {
      if (sourceTypes?.length && !sourceTypes.includes(c.source_label)) return false;
      if (filters?.jurisdiction && c.jurisdiction && !String(c.jurisdiction).toLowerCase().includes(String(filters.jurisdiction).toLowerCase())) return false;
      if (filters?.legal_domain && c.legal_domain && !String(c.legal_domain).toLowerCase().includes(String(filters.legal_domain).toLowerCase())) return false;
      return true;
    });
    const scored = filtered
      .map((c) => {
        const text = c.chunk_text.toLowerCase();
        let score = 0;
        for (const n of needles) if (text.includes(n)) score += 1 + (text.split(n).length - 1) * 0.2;
        return { c, score };
      })
      .filter((x) => (needles.length ? x.score > 0 : true))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return scored.map(({ c }) => ({
      doc_id: `legal:${c.source_id}`,
      chunk_id: c.chunk_id,
      snippet: c.chunk_text.slice(0, 220),
      text: c.chunk_text,
      source_type: c.source_type,
      source_label: c.source_label,
      source_name: c.source_name,
      language: c.language,
      jurisdiction: c.jurisdiction,
      legal_domain: c.legal_domain,
      doc_date: c.doc_date,
    }));
  }
}

function inferSourceLabel(fileName: string) {
  const n = fileName.toLowerCase();
  if (n.includes("caselaw") || n.includes("judgment") || n.includes("supreme") || n.includes("high_court")) return "Case Laws";
  if (n.includes("acts") || n.includes("act") || n.includes("statute")) return "Acts & Statutes";
  if (n.includes("act") || n.includes("statute")) return "Acts & Statutes";
  if (n.includes("case") || n.includes("judgment")) return "Case Laws";
  if (n.includes("regulation") || n.includes("rule")) return "Regulations";
  return "Legal Opinions";
}

function inferCorpusMeta(fileName: string, text: string) {
  const lower = `${fileName} ${text.slice(0, 1200)}`.toLowerCase();
  const jurisdiction = lower.includes("india") ? "India" : null;
  const legal_domain = lower.includes("contract") ? "Contract" : lower.includes("compliance") ? "Compliance" : null;
  const doc_date = (text.match(/\b(20\d{2})\b/) || [])[0] || null;
  return { jurisdiction, legal_domain, doc_date, language: "English" };
}

export const legalCorpusService = new LegalCorpusService();

async function listCorpusFilesRecursive(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries: any[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }
  await walk(rootDir);
  return out;
}
