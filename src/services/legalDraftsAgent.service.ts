import { randomUUID } from "crypto";
import { z } from "zod";
import { HttpError } from "../middleware/error.js";
import { mysqlPool, prisma } from "../prisma/client.js";
import { RunStatus } from "../db/types.js";
import type { RunStep } from "../types/api.js";
import { agentRunner } from "./agents/agentRunner.js";
import { sha256 } from "../utils/hash.js";
import { notificationService } from "./notification.service.js";
import { runCancellationService } from "./runCancellation.service.js";
import { getEnv } from "../config/env.js";
import { assessNarrativeQuality } from "./quality/genericity.service.js";
import { resolvePrimaryCaseDocumentMeta } from "./documentMeta.service.js";
import { createPdfBuffer, toDateTime, toSingleLine } from "../utils/pdf.js";
import { llmClient } from "../ai/llmClient.js";

const AGENT_KEY = "legal_drafts_validation";
const RUN_STEP_NAMES = [
  "Extracting facts",
  "Retrieving evidence",
  "Generating draft",
  "Generating suggestions",
  "Validating schema",
] as const;

const draftCitationSchema = z.object({
  ref: z.string(),
  source_type: z.literal("user_doc"),
  doc_id: z.string(),
  page: z.number().nullable().optional(),
  offset_start: z.number().nullable().optional(),
  offset_end: z.number().nullable().optional(),
  snippet: z.string(),
});

const draftOutputSchema = z.object({
  draft_id: z.string(),
  template_key: z.string(),
  title: z.string(),
  content: z.string(),
  suggestions: z.object({
    add_clauses: z.array(z.object({ title: z.string(), why: z.string(), insert_after: z.string().nullable(), suggested_text: z.string() })).default([]),
    customizations: z.array(z.object({ section: z.string(), issue: z.string(), fix: z.string() })).default([]),
    well_structured: z.array(z.string()).default([]),
    alternative_clauses: z.array(z.object({ label: z.string(), text: z.string() })).default([]),
  }),
  evidence_validation: z.object({
    required_items: z.array(z.object({
      item: z.string(),
      status: z.enum(["present", "missing", "conflicting"]),
      notes: z.string(),
      citation_refs: z.array(z.string()).default([]),
    })).default([]),
    overall_readiness: z.enum(["Ready", "Needs Inputs", "Conflicting Evidence"]),
  }),
  citations: z.array(draftCitationSchema).default([]),
  clarifying_questions: z.array(z.string()).max(3).default([]),
  analysis_valid: z.boolean().default(false),
  mode: z.enum(["normal", "fallback"]).default("fallback"),
  failure_reason: z.string().nullable().default(null),
  qa_debug: z.record(z.any()).optional(),
});

type DraftOutput = z.infer<typeof draftOutputSchema>;
type DocMeta = { doc_id: string; filename: string; mime_type: string; kind?: string | null; updated_at: string; language: string; extracted_text: string; hash: string; pages: number | null; char_count: number | null };
type RunStatusShape = { stage: string; stepIndex: number; stepsTotal: number; stats: Record<string, any>; done: boolean; error?: string | null; steps: RunStep[]; meta: Record<string, any> };
type TemplateFit = {
  template_key: string;
  score: number;
  confidence: "high" | "medium" | "low";
  recommended: boolean;
  reason: string;
  caution: string | null;
};

type DraftRunInput = {
  template_key: string;
  language?: string;
  jurisdiction?: string;
  party_overrides?: any;
  extra_instructions?: string;
};

const TEMPLATE_CATALOG = [
  { key: "nda", title: "NDA", category: "Popular Templates", description: "Non-disclosure agreement draft", required: ["Parties", "Confidential Information Scope"] },
  { key: "service_agreement", title: "Service Agreement", category: "Popular Templates", description: "Service/work scope + payment clauses", required: ["Parties", "Scope", "Payment Terms"] },
  { key: "employment_contract", title: "Employment Contract", category: "Popular Templates", description: "Employment terms and duties", required: ["Employer", "Employee", "Compensation"] },
  { key: "mou", title: "MoU", category: "Popular Templates", description: "Memorandum of understanding", required: ["Parties", "Purpose", "Responsibilities"] },
  { key: "termination_notice", title: "Termination Notice", category: "Dispute / Notices", description: "Notice for breach/termination", required: ["Agreement reference", "Breach facts", "Notice address"] },
  { key: "demand_notice", title: "Demand Notice", category: "Dispute / Notices", description: "Payment/refund/compliance demand notice", required: ["Claim facts", "Amount", "Demand timeline"] },
].map((t) => ({ ...t, jurisdiction_default: "India" }));

export const LEGAL_DRAFTS_SYSTEM_PROMPT = `You are the Legal Draft Generator + Evidence/Document Validation agent for an India civil-law case workspace.
Use case workspace documents as evidence and query parsing output as hints only.
Do not fabricate unknown details. If details are missing, ask clarifying questions or mark [[TODO]] placeholders.
Generate a template-consistent draft, relevant drafting suggestions, and an evidence/document validation checklist grounded in case workspace documents.
Use clear, plain English where possible. Avoid archaic legalese unless the template specifically requires it.
Return valid JSON only in the required schema with verbatim citations from user documents.`;

export const LEGAL_DRAFTS_REPAIR_PROMPT = `Fix the previous draft output into valid JSON only.
Do not invent facts. Keep unknown values as [[TODO]] or clarifying questions.
Preserve evidence validation statuses and citations unless structure/type repair is needed.`;

const inFlight = new Map<string, string>();

function trimWords(text: string, max = 25) {
  return String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, max).join(" ");
}

function buildTextCitationSnippets(text: string, limit = 6): string[] {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const chunks = normalized
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.split(" ").filter(Boolean).length >= 6);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const snippet = trimWords(chunk, 25);
    const key = snippet.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(snippet);
    if (out.length >= limit) return out;
  }
  if (out.length < limit) {
    const words = normalized.split(" ").filter(Boolean);
    const window = 22;
    for (let i = 0; i < words.length && out.length < limit; i += window) {
      const snippet = words.slice(i, i + window).join(" ").trim();
      if (!snippet) continue;
      const key = snippet.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(snippet);
    }
  }
  return out.slice(0, limit);
}

function firstSentence(text: string, max = 220) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const cut = t.split(/(?<=[.?!])\s+/)[0] || t;
  return cut.slice(0, max);
}

function normalizeDraftText(text: string) {
  return String(text || "").replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function safeParseJsonLoose(value: unknown) {
  const text = String(value || "").trim();
  if (!text) return null;
  const candidates = [
    text,
    text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim(),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function stripHtml(text: string) {
  const raw = String(text || "");
  const entityMap: Record<string, string> = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": "\"",
    "&#39;": "'",
  };
  return raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (match) => entityMap[match] || match)
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function renderLegalDraftPdf(
  draft: { title: string; content: string; updated_at?: string | null },
  caseId: string,
  draftId: string,
) {
  return createPdfBuffer((doc, h) => {
    const title = toSingleLine(draft.title || "Legal Draft");
    doc.font("Helvetica-Bold").fontSize(18).fillColor("#0b1220").text(title, { width: h.pageWidth });
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(10).fillColor("#374151").text(`Case ID: ${caseId}`, { width: h.pageWidth });
    doc.text(`Draft ID: ${draftId}`, { width: h.pageWidth });
    doc.text(`Last Updated: ${toDateTime(draft.updated_at || new Date().toISOString())}`, { width: h.pageWidth });
    doc.moveDown(0.35);

    h.heading("Draft Content");
    const clean = stripHtml(draft.content || "");
    if (!clean) {
      h.paragraph("Draft content is empty.");
    } else {
      h.ensureSpace(16);
      doc.font("Helvetica").fontSize(10).fillColor("#111827").text(clean, { width: h.pageWidth, lineGap: 1.2 });
    }
  });
}


function looksLowQualityDraftText(text: string) {
  const normalized = normalizeDraftText(text);
  if (!normalized) return true;
  const lower = normalized.toLowerCase();
  const lines = normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const words = lower.split(/\s+/).filter(Boolean);
  if (words.length < 80) return true;
  if (/template selected:|return valid json only|\[\[todo\]\]|\bissue brief\b.*prepare facts/i.test(normalized)) return true;
  const repeatedLineRatio = (() => {
    if (lines.length < 4) return 0;
    const counts = new Map<string, number>();
    for (const line of lines) counts.set(line.toLowerCase(), (counts.get(line.toLowerCase()) || 0) + 1);
    const worst = Math.max(...counts.values());
    return worst / lines.length;
  })();
  if (repeatedLineRatio >= 0.25) return true;
  const repeatedPhrasePatterns = [
    /(?:petitioner\/plaintiff is dispossessed of his property will cause if the ){2,}/i,
    /(?:revise the draft against the cited case materials before final use\.?\s*){3,}/i,
  ];
  if (repeatedPhrasePatterns.some((pattern) => pattern.test(normalized))) return true;
  const windows = new Map<string, number>();
  for (let i = 0; i + 11 <= words.length; i += 1) {
    const window = words.slice(i, i + 12).join(" ");
    windows.set(window, (windows.get(window) || 0) + 1);
  }
  const duplicateWindows = [...windows.values()].filter((count) => count >= 3).length;
  if (duplicateWindows >= 2) return true;
  return false;
}

function dedupeNormalized(items: any[], limit = 8) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items || []) {
    const v = String(raw || "").trim();
    if (!v) continue;
    const key = v.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

function sanitizePartyName(raw: unknown) {
  const value = String(raw || "")
    .replace(/\s+/g, " ")
    .replace(/^[,;:\-\s]+|[,;:\-\s]+$/g, "")
    .replace(
      /^(the\s+)?(disclosing party|receiving party|first party|second party|party\s*[ab]|plaintiff|petitioner|defendant|respondent)\s*[:\-]?\s*/i,
      "",
    )
    .trim();
  return value;
}

function buildPartyOverridesBlock(partyOverrides: any) {
  if (!partyOverrides || typeof partyOverrides !== "object") return "(none)";
  const entries = Object.entries(partyOverrides)
    .map(([key, value]) => `${key}: ${String(value ?? "").trim()}`)
    .filter((line) => !line.endsWith(":"));
  return entries.length ? entries.join("\n") : "(none)";
}

function isWeakPartyLabel(raw: unknown) {
  const value = sanitizePartyName(raw);
  if (!value) return true;
  const lower = value.toLowerCase();
  if (["unknown", "na", "n/a", "nil", "none"].includes(lower)) return true;
  const weakPhrases = [
    "same relief",
    "to be confirmed",
    "first party",
    "second party",
    "disclosing party",
    "receiving party",
    "plaintiff",
    "defendant",
    "respondent",
    "petitioner",
  ];
  if (weakPhrases.some((p) => lower === p || lower.includes(` ${p}`))) return true;
  if (!/[a-z]/i.test(value)) return true;
  return false;
}

function findPartyCandidates(text: string) {
  const t = String(text || "");
  const out: string[] = [];
  const betweenPatterns = [
    /\bbetween\s*:?\s*([^\n.;]{3,180}?)\s+\band\b\s+([^\n.;]{3,180})(?:[\n.;]|$)/i,
    /\bbetween\s+(.{3,180}?)\s+\band\b\s+(.{3,180}?)(?:\n|;|\.|$)/i,
  ];
  for (const pattern of betweenPatterns) {
    const m = t.match(pattern);
    if (!m) continue;
    const a = sanitizePartyName(m[1]);
    const b = sanitizePartyName(m[2]);
    if (!isWeakPartyLabel(a)) out.push(a);
    if (!isWeakPartyLabel(b)) out.push(b);
    if (out.length >= 2) break;
  }
  const orgs = (t.match(/\b[A-Z][A-Za-z0-9&., ]{2,80}(?:Private Limited|Pvt\.?\s*Ltd\.?|Limited|LLP|Inc\.?)\b/g) || [])
    .map((x) => sanitizePartyName(x))
    .filter((x) => !isWeakPartyLabel(x));
  return dedupeNormalized([...out, ...orgs], 2);
}

function extractEffectiveDate(text: string) {
  const t = String(text || "");
  return (
    t.match(/\bmade on\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i)?.[1] ||
    t.match(/\beffective date\s*[:\-]?\s*([^\n.,]{4,40})/i)?.[1] ||
    t.match(/\bon\s+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/i)?.[1] ||
    null
  );
}

function extractClauseSentence(text: string, needles: string[]) {
  const lines = String(text || "")
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  for (const line of lines) {
    const l = line.toLowerCase();
    if (needles.some((n) => l.includes(n.toLowerCase())) && line.split(" ").length >= 6) {
      return trimWords(line, 32);
    }
  }
  return null;
}

async function ensureDraftTable() {
  await mysqlPool.query(`
    CREATE TABLE IF NOT EXISTS drafts (
      draft_id VARCHAR(191) PRIMARY KEY,
      case_id VARCHAR(191) NOT NULL,
      template_key VARCHAR(128) NOT NULL,
      title VARCHAR(255) NOT NULL,
      content LONGTEXT NOT NULL,
      suggestions_json LONGTEXT NULL,
      validation_json LONGTEXT NULL,
      citations_json LONGTEXT NULL,
      clarifying_questions_json LONGTEXT NULL,
      language VARCHAR(64) NULL,
      jurisdiction VARCHAR(128) NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'ready',
      mode VARCHAR(32) NOT NULL DEFAULT 'fallback',
      analysis_valid TINYINT(1) NOT NULL DEFAULT 0,
      failure_reason TEXT NULL,
      source_doc_hash VARCHAR(191) NULL,
      run_id VARCHAR(191) NULL,
      qa_debug_json LONGTEXT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_drafts_case_updated (case_id, updated_at),
      INDEX idx_drafts_case_template (case_id, template_key)
    )
  `);
}

async function ensureOwnedCase(userId: string, caseId: string) {
  const c = await prisma.case.findUnique({ where: { id: caseId }, include: { user: true } });
  if (!c || c.userId !== userId) throw new HttpError(404, "Case not found", "case_not_found");
  return c as any;
}

async function resolvePrimaryDoc(caseId: string): Promise<DocMeta | null> {
  const candidate = await resolvePrimaryCaseDocumentMeta(caseId);
  if (!candidate) return null;
  const text = String(candidate.extracted_text || "");
  return {
    doc_id: candidate.doc_id,
    filename: candidate.filename,
    mime_type: candidate.mime_type,
    kind: candidate.kind || null,
    updated_at: candidate.updated_at,
    language: candidate.language || "English",
    extracted_text: text,
    hash: String(candidate.checksum || sha256(candidate.doc_id + text)),
    pages: candidate.pages ?? null,
    char_count: candidate.char_count ?? text.length,
  };
}

function parseJson(v: any) {
  if (v == null) return null;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return null; }
  }
  return v;
}

function buildRunSteps(stepIndex = 0): RunStep[] {
  return RUN_STEP_NAMES.map((name, idx) => ({
    name,
    state: idx < stepIndex ? "SUCCEEDED" : idx === stepIndex ? "RUNNING" : "PENDING",
    progress: Math.round((((idx < stepIndex ? idx + 1 : idx === stepIndex ? idx + 0.4 : idx) / RUN_STEP_NAMES.length)) * 100),
  }));
}

function makeRunStatus(partial?: Partial<RunStatusShape>): RunStatusShape {
  return { stage: RUN_STEP_NAMES[0], stepIndex: 1, stepsTotal: RUN_STEP_NAMES.length, stats: {}, done: false, error: null, steps: buildRunSteps(0), meta: { agent_key: AGENT_KEY }, ...partial };
}

async function updateRunProgress(runId: string, patch: Partial<RunStatusShape>) {
  const run = await prisma.run.findUnique({ where: { id: runId } });
  if (!run) return;
  const cur = (run.stepsJson && typeof run.stepsJson === "object") ? (run.stepsJson as any) : makeRunStatus();
  const next = { ...cur, ...patch, stats: { ...(cur.stats || {}), ...(patch.stats || {}) }, steps: patch.steps || cur.steps, meta: { ...(cur.meta || {}), ...(patch.meta || {}) } };
  await prisma.run.update({ where: { id: runId }, data: { stepsJson: next as any } });
}

async function getQueryParsingPayload(caseId: string) {
  const c = await prisma.case.findUnique({ where: { id: caseId }, include: { outputs: true } });
  return ((c?.outputs || []) as any[]).find((o) => o.agentKey === "query_parsing")?.payloadJson || null;
}

function collectCitationsFromDoc(doc: DocMeta, qp: any): DraftOutput["citations"] {
  const lines = buildTextCitationSnippets(String(doc.extracted_text || ""), 6);
  const qpSummary = trimWords(String(qp?.executive_summary || qp?.summary || ""), 25);
  const qpGrounds = (Array.isArray(qp?.legal_grounds) ? qp.legal_grounds : [])
    .map((g: any) => trimWords(String(g || ""), 25))
    .filter(Boolean);
  const merged = [...lines, ...(qpSummary ? [qpSummary] : []), ...qpGrounds].slice(0, 8);
  const out: DraftOutput["citations"] = [];
  const seen = new Set<string>();
  for (let i = 0; i < merged.length && out.length < 6; i++) {
    const snippet = trimWords(merged[i], 25);
    if (!snippet) continue;
    const key = snippet.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ref: `C${out.length + 1}`, source_type: "user_doc", doc_id: doc.doc_id, page: null, offset_start: null, offset_end: null, snippet });
  }
  return out;
}

function deriveFacts(qp: any, doc: DocMeta) {
  const parties = Array.isArray(qp?.key_facts?.parties) ? qp.key_facts.parties : [];
  const amounts = Array.isArray(qp?.key_facts?.amounts) ? qp.key_facts.amounts : [];
  const dates = Array.isArray(qp?.key_facts?.dates) ? qp.key_facts.dates : [];
  const location = qp?.key_facts?.location || null;
  const issues = dedupeNormalized([...(qp?.legal_grounds || []), ...((qp?.issue_groups || []).map((g: any) => g?.label || g?.title).filter(Boolean))], 8);
  return { parties, amounts, dates, location, issues, summary: String(qp?.executive_summary || qp?.summary || firstSentence(doc.extracted_text, 350)) };
}

function pickPartyNameFromFact(fact: any) {
  const candidates = [
    fact?.name,
    fact?.party_name,
    fact?.entity,
    fact?.value,
    fact?.label,
    fact?.role,
  ];
  for (const c of candidates) {
    const cleaned = sanitizePartyName(c);
    if (!isWeakPartyLabel(cleaned)) return cleaned;
  }
  return null;
}

function buildDraftContent(
  templateKey: string,
  caseTitle: string,
  qp: any,
  doc: DocMeta,
  jurisdiction: string,
  language: string,
  partyOverrides?: any,
  extraInstructions?: string,
) {
  const facts = deriveFacts(qp, doc);
  const amount = facts.amounts?.[0]?.value || "Not provided in available documents";
  const partyCandidates = findPartyCandidates(doc.extracted_text);
  const factParties = (Array.isArray(facts.parties) ? facts.parties : [])
    .map((p: any) => pickPartyNameFromFact(p))
    .filter(Boolean) as string[];
  const mergedPartyNames = dedupeNormalized([...factParties, ...partyCandidates], 4).filter((p) => !isWeakPartyLabel(p));
  const overridePartyA = sanitizePartyName(partyOverrides?.party_a || partyOverrides?.party1 || partyOverrides?.claimant || partyOverrides?.sender);
  const overridePartyB = sanitizePartyName(partyOverrides?.party_b || partyOverrides?.party2 || partyOverrides?.respondent || partyOverrides?.recipient);
  const partyA = !isWeakPartyLabel(overridePartyA) ? overridePartyA : mergedPartyNames[0] || "To be confirmed";
  const partyB = !isWeakPartyLabel(overridePartyB) ? overridePartyB : mergedPartyNames[1] || "To be confirmed";
  const dateVal = facts.dates?.[0]?.value || extractEffectiveDate(doc.extracted_text) || "To be confirmed from executed document";
  const issueList = facts.issues.length ? facts.issues : ["Primary legal issues to be confirmed from case records"];
  const summary = facts.summary || "Facts summary is based on available case workspace material.";
  const confDef = extractClauseSentence(doc.extracted_text, ["confidential information", "confidential", "proprietary"]);
  const permittedDisclosure = extractClauseSentence(doc.extracted_text, ["required by law", "court order", "government authority", "compelled disclosure"]);
  const termSnippet = extractClauseSentence(doc.extracted_text, ["term", "survive", "years", "return", "destroy"]);
  const disputeSnippet = extractClauseSentence(doc.extracted_text, ["governing law", "jurisdiction", "arbitration", "dispute"]);
  const header = `# ${TEMPLATE_CATALOG.find((t) => t.key === templateKey)?.title || "Legal Draft"}\n\nCase: ${caseTitle}\nJurisdiction: ${jurisdiction}\nLanguage: ${language}\n${extraInstructions ? `Special instructions: ${extraInstructions}\n` : ""}`;
  if (templateKey === "nda") {
    return `${header}
## 1. Parties and Effective Date
This Non-Disclosure Agreement ("Agreement") is made on ${dateVal} between:
- Disclosing Party: ${partyA}
- Receiving Party: ${partyB}

## 2. Purpose
The parties intend to share information for legitimate business/legal evaluation connected to the current dispute/case context.

## 3. Confidential Information
Confidential Information includes non-public business, technical, financial, commercial, operational, and legal information disclosed in any form.
${confDef ? `Reference from case materials: ${confDef}.` : "Reference text should be verified from the executed agreement and annexures."}

## 4. Non-Disclosure and Use Restrictions
The Receiving Party shall:
- use Confidential Information only for the stated purpose;
- not disclose Confidential Information to third parties except as permitted by this Agreement;
- apply reasonable safeguards to prevent unauthorized access, use, or disclosure.

## 5. Exclusions
Confidential Information does not include information that:
- is publicly available without breach;
- was lawfully known before disclosure;
- is independently developed without use of disclosed information;
- is lawfully received from a third party without confidentiality breach.

## 6. Permitted Disclosures
Disclosure is allowed where required by applicable law, regulation, or competent court/authority order, with prior notice where legally permissible.
${permittedDisclosure ? `Reference from case materials: ${permittedDisclosure}.` : ""}

## 7. Term, Return and Destruction
Confidentiality obligations survive termination for a commercially reasonable survival period (to be aligned with executed contract terms).
Upon written request, the Receiving Party shall return or securely destroy Confidential Information, subject to legal retention requirements.
${termSnippet ? `Reference from case materials: ${termSnippet}.` : ""}

## 8. Remedies
Unauthorized disclosure may cause irreparable harm; injunctive and other legal remedies remain available in addition to contractual rights.

## 9. Governing Law and Dispute Resolution
This Agreement is governed by laws applicable in ${jurisdiction}. Disputes shall be handled through agreed dispute-resolution mechanism/forum.
${disputeSnippet ? `Reference from case materials: ${disputeSnippet}.` : "Forum/arbitration details should be finalized using executed contract language."}

## 10. Notices and Miscellaneous
All notices must be in writing to verified notice addresses of the parties.
No amendment is valid unless in writing and signed by authorized representatives.

## Signature Block
Disclosing Party: ____________________    Date: __________
Receiving Party: ____________________    Date: __________
`;
  }
  if (templateKey === "termination_notice") {
    return `${header}
## Parties
- From: ${partyA}
- To: ${partyB}

## Subject
Termination Notice regarding ${caseTitle}

## Background Facts
${summary}

## Breach / Grounds
${issueList.map((i: string) => `- ${i}`).join("\n")}

## Demand / Action Required
- Cure the breaches within a reasonable written notice period, failing which termination may take effect as per law/contract.
- Confirm outstanding amounts/refund status: ${amount}

## Documents Relied Upon
- Primary case document from workspace
- Supporting communications / invoices / notices (if available)
`;
  }
  if (templateKey === "demand_notice") {
    return `${header}
## Parties
- Claimant: ${partyA}
- Respondent: ${partyB}

## Facts Summary
${summary}

## Claims / Issues
${issueList.map((i: string) => `- ${i}`).join("\n")}

## Demand
- Amount demanded: ${amount}
- Response timeline: Provide written response within a reasonable and legally compliant notice period.

## Reservation of Rights
All rights and remedies are reserved pending response and document verification.
`;
  }
  if (templateKey === "service_agreement") {
    return `${header}
## Parties
- Service Provider: ${partyA}
- Client: ${partyB}

## Effective Date
${dateVal}

## Scope of Services
Scope is based on submitted case facts and supporting records in the case workspace.

## Fees and Payment Terms
Payment obligations, timelines, and documentary proof requirements shall follow submitted invoices/records and agreed milestones.

## Termination / Notice
Either party may issue written notice for material breach and provide a reasonable cure period before termination.

## Dispute Resolution
Disputes should follow written notice, good-faith settlement discussion, and then appropriate legal forum under applicable Indian law.
`;
  }
  return `${header}
## Purpose
${summary}

## Key Facts
${issueList.map((i: string) => `- ${i}`).join("\n")}

## Draft Body
This draft is generated from current case documents and query parsing facts. Final legal language should be reviewed and adjusted with verified party details, dates, and relief terms.
`;
}

function buildDraftSuggestions(templateKey: string, qp: any, doc: DocMeta, source: any) {
  const customizations: Array<{ section: string; issue: string; fix: string }> = [
    { section: "Parties", issue: "Party legal names or notice addresses may be incomplete", fix: "Verify full legal names, addresses, and designations from the uploaded case records before finalizing." },
  ];
  const addClauses: Array<{ title: string; why: string; insert_after: string | null; suggested_text: string }> = [];

  if (templateKey === "nda") {
    addClauses.push({
      title: "Permitted Disclosure Procedure",
      why: "Helps avoid ambiguity when disclosure is compelled by law or court process.",
      insert_after: "Permitted Disclosures",
      suggested_text: "Before any compelled disclosure, the disclosing party should be informed in writing where legally permissible so that protective steps may be considered.",
    });
  } else if (templateKey === "demand_notice" || templateKey === "termination_notice") {
    addClauses.push({
      title: "Document Preservation Direction",
      why: "Preserves records relevant to the dispute and later court proceedings.",
      insert_after: "Documents Relied Upon",
      suggested_text: "All relevant communications, invoices, account statements, notices, and delivery records should be preserved without alteration pending resolution of the dispute.",
    });
  } else {
    addClauses.push({
      title: "Record Preservation",
      why: "Improves evidentiary readiness for later review or litigation.",
      insert_after: null,
      suggested_text: "Each party should preserve all records, communications, invoices, and annexures connected to the subject matter of this draft.",
    });
  }

  if (!Array.isArray(qp?.key_facts?.dates) || !qp.key_facts.dates.length) {
    customizations.push({
      section: "Timeline",
      issue: "Dates and chronology are still incomplete.",
      fix: "Insert the material dates from the case file before issuing or signing this draft.",
    });
  }
  if (!Array.isArray(qp?.key_facts?.parties) || !qp.key_facts.parties.length) {
    customizations.push({
      section: "Parties",
      issue: "Named parties were not confidently extracted from the workspace.",
      fix: "Confirm plaintiff, defendant, claimant, respondent, or contracting party details from the uploaded documents.",
    });
  }
  if (Array.isArray(source?.validation_checks) && source.validation_checks.length) {
    for (const item of source.validation_checks.slice(0, 3)) {
      const issue = String(item || "").trim();
      if (!issue) continue;
      customizations.push({
        section: "Validation",
        issue: issue.slice(0, 140),
        fix: "Revise the draft against the cited case materials before final use.",
      });
    }
  }

  const dedupedCustomizations = customizations.filter(
    (item, idx, arr) => arr.findIndex((x) => x.section === item.section && x.issue.toLowerCase() === item.issue.toLowerCase()) === idx,
  );
  const dedupedClauses = addClauses.filter(
    (item, idx, arr) => arr.findIndex((x) => x.title.toLowerCase() === item.title.toLowerCase()) === idx,
  );

  return {
    add_clauses: dedupedClauses.slice(0, 3),
    customizations: dedupedCustomizations.slice(0, 4),
    well_structured: ["The draft is organized into a usable review sequence and should still be checked against the primary case record."],
    alternative_clauses: [
      { label: "Short response period", text: "A written response should be provided within 7 days of receipt of this notice." },
      { label: "Standard response period", text: "A written response should be provided within 15 days of receipt of this notice." },
    ],
  };
}

function buildEvidenceValidation(templateKey: string, doc: DocMeta, qp: any, citations: DraftOutput["citations"]) {
  const text = String(doc.extracted_text || "").toLowerCase();
  const citationsText = (citations || []).map((c) => String(c.snippet || "").toLowerCase()).join(" ");
  const hasAny = (patterns: string[]) => patterns.some((p) => text.includes(p) || citationsText.includes(p));
  const cRefs = (patterns: string[]) =>
    (citations || [])
      .filter((c) => patterns.some((p) => String(c.snippet || "").toLowerCase().includes(p)))
      .map((c) => c.ref)
      .slice(0, 3);
  const checksByTemplate: Record<string, Array<{ item: string; patterns: string[] }>> = {
    termination_notice: [
      { item: "Signed agreement copy", patterns: ["agreement", "contract", "work order"] },
      { item: "Breach evidence / chronology", patterns: ["breach", "default", "delay", "non-performance"] },
      { item: "Prior notice / communication", patterns: ["notice", "email", "communication", "demand"] },
      { item: "Service / notice address details", patterns: ["address", "registered office", "notice address"] },
    ],
    demand_notice: [
      { item: "Claim amount support", patterns: ["amount", "inr", "rs", "₹"] },
      { item: "Payment proof/invoice", patterns: ["payment", "invoice", "ledger", "receipt"] },
      { item: "Prior demand/notice trail", patterns: ["notice", "demand", "email", "communication"] },
    ],
    service_agreement: [
      { item: "Scope evidence", patterns: ["scope", "deliverables", "services"] },
      { item: "Payment terms evidence", patterns: ["payment", "fee", "invoice", "milestone"] },
      { item: "Term/termination evidence", patterns: ["term", "termination", "cure"] },
      { item: "Dispute mechanism evidence", patterns: ["dispute", "arbitration", "jurisdiction", "governing law"] },
    ],
    nda: [
      { item: "Parties identified", patterns: ["between", "party", "parties", "disclosing", "receiving"] },
      { item: "Confidential information definition", patterns: ["confidential", "proprietary", "non-public"] },
      { item: "Disclosure/use restrictions", patterns: ["disclose", "disclosure", "non-disclosure", "use"] },
      { item: "Obligation/remedy language", patterns: ["obligation", "liability", "injunctive", "remedy"] },
    ],
    employment_contract: [
      { item: "Employer/employee details", patterns: ["employee", "employer"] },
      { item: "Compensation evidence", patterns: ["salary", "compensation", "ctc"] },
      { item: "Termination terms evidence", patterns: ["termination", "notice period"] },
    ],
    mou: [
      { item: "Purpose statement", patterns: ["purpose", "objective"] },
      { item: "Parties details", patterns: ["parties", "between"] },
      { item: "Responsibilities evidence", patterns: ["responsibilities", "obligations", "scope"] },
    ],
  };
  const checks = checksByTemplate[templateKey] || [{ item: "Agreement/facts evidence", patterns: ["agreement", "facts"] }];
  const required_items = checks.map((chk) => ({
    item: chk.item,
    status: hasAny(chk.patterns) ? "present" as const : "missing" as const,
    notes: hasAny(chk.patterns)
      ? `Detected ${chk.item.toLowerCase()} in case workspace documents.`
      : `No clear ${chk.item.toLowerCase()} found in case workspace documents.`,
    citation_refs: hasAny(chk.patterns) ? cRefs(chk.patterns) : [],
  }));
  const missingCount = required_items.filter((r) => r.status === "missing").length;
  return {
    required_items,
    overall_readiness: missingCount === 0 ? "Ready" as const : missingCount >= 2 ? "Needs Inputs" as const : "Needs Inputs" as const,
  };
}

function getTemplateSignals(qp: any, doc: DocMeta, caseTitle: string) {
  const domainText = [
    String(qp?.domain?.primary || ""),
    String(qp?.domain?.subtype || ""),
    String(qp?.legal_subtype || ""),
    String(qp?.summary || ""),
    String(qp?.executive_summary || ""),
    String(caseTitle || ""),
    String(doc?.filename || ""),
    String(doc?.extracted_text || "").slice(0, 6000),
    ...(Array.isArray(qp?.legal_grounds) ? qp.legal_grounds.map((x: any) => String(x || "")) : []),
  ]
    .join(" ")
    .toLowerCase();
  return {
    text: domainText,
    hasAny: (terms: string[]) => terms.some((term) => domainText.includes(term)),
  };
}

function scoreTemplateFit(templateKey: string, qp: any, doc: DocMeta, caseTitle: string): TemplateFit {
  const signals = getTemplateSignals(qp, doc, caseTitle);
  const isDispute = signals.hasAny(["injunction", "harassment", "notice", "plaint", "petition", "suit", "defendant", "plaintiff", "consumer", "recovery", "breach"]);
  const isEmployment = signals.hasAny(["employment", "employee", "employer", "salary", "termination of service", "appointment"]);
  const isService = signals.hasAny(["services", "scope of work", "vendor", "deliverables", "milestone", "consulting"]);
  const isConfidentiality = signals.hasAny(["confidential", "non-disclosure", "nda", "proprietary information", "trade secret"]);
  const isMou = signals.hasAny(["memorandum", "mou", "understanding", "intent", "collaboration"]);
  const hasMonetaryDemand = signals.hasAny(["refund", "payment", "amount", "dues", "outstanding", "demand"]);
  const hasTermination = signals.hasAny(["terminate", "termination", "breach notice", "cure period"]);

  let score = 0;
  let reason = "General fit based on current case materials.";
  let caution: string | null = null;

  switch (templateKey) {
    case "demand_notice":
      score = (isDispute ? 48 : 0) + (hasMonetaryDemand ? 32 : 0) + (hasTermination ? 5 : 0);
      reason = "Best when the case record points to a payment, refund, recovery, or formal pre-litigation demand.";
      break;
    case "termination_notice":
      score = (isDispute ? 30 : 0) + (hasTermination ? 38 : 0) + (signals.hasAny(["agreement", "contract"]) ? 12 : 0);
      reason = "Best when the record supports breach, cure period, or contract termination language.";
      break;
    case "service_agreement":
      score = (isService ? 55 : 0) + (signals.hasAny(["scope", "fees", "client", "provider"]) ? 20 : 0) - (isDispute ? 12 : 0);
      reason = "Best when the matter is about ongoing services, deliverables, or commercial engagement terms.";
      break;
    case "employment_contract":
      score = (isEmployment ? 68 : 0) + (signals.hasAny(["offer", "joining", "probation", "compensation"]) ? 18 : 0);
      reason = "Best when the case concerns employee, employer, salary, or service conditions.";
      break;
    case "mou":
      score = (isMou ? 60 : 0) + (signals.hasAny(["parties intend", "understanding", "cooperate", "proposal"]) ? 15 : 0) - (isDispute ? 10 : 0);
      reason = "Best for pre-contract collaboration or understanding between parties.";
      break;
    case "nda":
      score = (isConfidentiality ? 75 : 0) + (signals.hasAny(["information sharing", "sensitive information", "disclosure"]) ? 10 : 0) - (isDispute ? 20 : 0);
      reason = "Best only when the uploaded case materials actually concern confidentiality or non-disclosure obligations.";
      break;
    default:
      score = 20;
      break;
  }

  score = Math.max(0, Math.min(100, score));
  if (score < 35) {
    caution = "This template does not strongly match the detected case type and may produce a weak draft.";
  }
  return {
    template_key: templateKey,
    score,
    confidence: score >= 70 ? "high" : score >= 45 ? "medium" : "low",
    recommended: score >= 55,
    reason,
    caution,
  };
}

function rankTemplates(qp: any, doc: DocMeta, caseTitle: string) {
  return TEMPLATE_CATALOG
    .map((template) => ({ ...template, fit: scoreTemplateFit(template.key, qp, doc, caseTitle) }))
    .sort((a, b) => b.fit.score - a.fit.score || a.title.localeCompare(b.title));
}

function mapDraftOutput(params: {
  draftId: string;
  templateKey: string;
  templateTitle: string;
  qp: any;
  doc: DocMeta;
  source: any;
  language: string;
  jurisdiction: string;
  llmSucceeded?: boolean;
  requireLlm?: boolean;
  partyOverrides?: any;
  extraInstructions?: string;
}) {
  const { draftId, templateKey, templateTitle, qp, doc, source, language, jurisdiction, llmSucceeded = true, requireLlm = false, partyOverrides, extraInstructions } = params;
  const baseCitations = collectCitationsFromDoc(doc, qp);
  const sourceCitations = Array.isArray(source?.citations)
    ? source.citations
        .map((c: any, idx: number) => ({
          ref: `C${idx + 1}`,
          source_type: "user_doc" as const,
          doc_id: String(c?.doc_id || doc.doc_id),
          page: c?.page ?? null,
          offset_start: c?.offset_start ?? null,
          offset_end: c?.offset_end ?? null,
          snippet: trimWords(String(c?.snippet || ""), 25),
        }))
        .filter((c: any) => !!c.snippet)
    : [];
  const citations = [...sourceCitations, ...baseCitations].filter((c, idx, arr) => arr.findIndex((x) => x.snippet === c.snippet) === idx).slice(0, 8);
  const fallbackContent = buildDraftContent(
    templateKey,
    String(qp?.case_title || "Case Workspace"),
    qp,
    doc,
    jurisdiction,
    language,
    partyOverrides,
    extraInstructions,
  );
  const sourceDraftText = String(source?.draft_text || "").trim();
  const canUseSourceDraft = sourceDraftText.length >= 220 && !looksLowQualityDraftText(sourceDraftText);
  const shouldUseSource =
    canUseSourceDraft ||
    (requireLlm && sourceDraftText.length > 0);
  const content = shouldUseSource ? normalizeDraftText(sourceDraftText) : fallbackContent;
  const evidence_validation = buildEvidenceValidation(templateKey, doc, qp, citations);
  const suggestions = buildDraftSuggestions(templateKey, qp, doc, source);
  if (Array.isArray(source?.missing_evidence) && source.missing_evidence.length) {
    evidence_validation.required_items = [
      ...evidence_validation.required_items,
      ...source.missing_evidence.slice(0, 4).map((item: any) => ({
        item: String(item || "").slice(0, 120),
        status: "missing" as const,
        notes: "The generated draft identified this input as missing from the current workspace.",
        citation_refs: [],
      })),
    ];
    evidence_validation.overall_readiness = "Needs Inputs";
  }
  const clarifying = [];
  if (!Array.isArray(qp?.key_facts?.parties) || !qp.key_facts.parties.length) clarifying.push("Please confirm party names and roles for the selected draft.");
  if (!(qp?.key_facts?.amounts?.length)) clarifying.push("Please confirm any claim/refund/payment amount to include in the draft.");
  if (!String(qp?.key_facts?.location || "").trim()) clarifying.push("Please confirm the city/state for jurisdiction and notice details.");
  if (Array.isArray(source?.missing_evidence) && source.missing_evidence.length) {
    clarifying.push(...source.missing_evidence.slice(0, 2).map((item: any) => `Please provide: ${String(item || "").slice(0, 140)}`));
  }
  const analysis_valid = citations.length >= 3 && content.length >= 220 && !looksLowQualityDraftText(content);
  const mode = shouldUseSource && llmSucceeded ? "normal" : "fallback";
  const parsed = draftOutputSchema.parse({
    draft_id: draftId,
    template_key: templateKey,
    title: `${templateTitle} - ${String(qp?.case_title || "Case Workspace")}`.slice(0, 255),
    content,
    suggestions,
    evidence_validation,
    citations,
    clarifying_questions: clarifying.slice(0, 3),
    analysis_valid,
    mode,
    failure_reason: analysis_valid
      ? null
      : !shouldUseSource && sourceDraftText.length >= 220
        ? "Generated draft text was repetitive or insufficiently grounded; fallback draft used."
        : requireLlm && sourceDraftText.length > 0
          ? "LLM draft output was too short or insufficiently grounded."
          : "Insufficient grounded citations from case workspace documents",
    qa_debug: {
      source_agent: AGENT_KEY,
      doc_hash: doc.hash,
      template_key: templateKey,
      source_mode: source?.mode || "unknown",
      source_draft_accepted: canUseSourceDraft,
      used_source_draft: shouldUseSource,
    },
  });
  const genericity = assessNarrativeQuality({
    texts: [
      parsed.content,
      ...(parsed.suggestions?.add_clauses || []).flatMap((item) => [item.title, item.why, item.suggested_text]),
      ...(parsed.suggestions?.customizations || []).flatMap((item) => [item.section, item.issue, item.fix]),
      ...(parsed.suggestions?.well_structured || []),
      ...(parsed.suggestions?.alternative_clauses || []).flatMap((item) => [item.label, item.text]),
    ],
    supportTexts: [
      doc.extracted_text,
      qp?.executive_summary,
      qp?.summary,
      ...(Array.isArray(qp?.legal_grounds) ? qp.legal_grounds : []),
      ...parsed.citations.map((c) => c?.snippet),
    ],
    minSupportOverlap: 5,
    minCombinedLength: 220,
    maxGenericPhraseHits: 1,
  });
  parsed.qa_debug = {
    ...(parsed.qa_debug || {}),
    genericity_gate: genericity,
  };
  if (genericity.isGeneric) {
    parsed.analysis_valid = false;
    if (!llmSucceeded) {
      parsed.mode = "fallback";
    }
    parsed.failure_reason = "Legal Drafts output was too generic for grounded use";
  }
  return parsed;
}

function buildLegalDraftRefinePrompt(input: {
  template: { key: string; title: string; description: string; required: string[] };
  qp: any;
  doc: DocMeta;
  language: string;
  jurisdiction: string;
  source: any;
  caseTitle: string;
  partyOverrides?: any;
  extraInstructions?: string;
}) {
  const citations = collectCitationsFromDoc(input.doc, input.qp)
    .slice(0, 6)
    .map((c) => `[${c.ref}] ${c.snippet}`)
    .join("\n");
  const evidenceSnippets = buildTextCitationSnippets(input.doc.extracted_text, 10)
    .map((snippet, idx) => `[E${idx + 1}] ${snippet}`)
    .join("\n");
  const querySummary = String(input.qp?.executive_summary || input.qp?.summary || "").trim();
  const sourceDraft = String(input.source?.draft_text || "").trim();

  return [
    LEGAL_DRAFTS_SYSTEM_PROMPT,
    `Target language: ${input.language || "English"}.`,
    `Jurisdiction: ${input.jurisdiction || "India"}.`,
    `Selected template key: ${input.template.key}.`,
    `Selected template title: ${input.template.title}.`,
    `Template purpose: ${input.template.description}.`,
    `Mandatory inputs for this template: ${input.template.required.join(", ")}.`,
    "Return JSON only with this schema:",
    '{"selected_template":"string","draft_text":"string","validation_checks":["string"],"missing_evidence":["string"],"citations":[{"doc_id":"string","chunk_id":"string","snippet":"string","source_type":"user_doc"}],"confidence":0.0}',
    "Draft quality rules:",
    "- draft_text must be a real, case-ready draft, not drafting notes or a checklist.",
    "- Use the selected template only. Do not switch template type.",
    "- Use exact parties, dates, amounts, clause wording, and chronology from the case materials whenever available.",
    "- If some required details are missing, keep the draft usable and add narrowly targeted [[TODO]] placeholders only where necessary.",
    "- Do not output meta language such as 'Template selected' or 'Prepare facts'.",
    "- Every citation snippet must be copied from the provided case workspace evidence, maximum 25 words each.",
    "- Include at least 3 citations when possible.",
    "",
    `CASE_TITLE:\n${input.caseTitle}`,
    "",
    `QUERY_PARSING_SUMMARY:\n${querySummary || "(none)"}`,
    "",
    `QUERY_PARSING_KEY_FACTS:\n${JSON.stringify(input.qp?.key_facts || {}, null, 2).slice(0, 2400)}`,
    "",
    `QUERY_PARSING_LEGAL_GROUNDS:\n${JSON.stringify(Array.isArray(input.qp?.legal_grounds) ? input.qp.legal_grounds.slice(0, 8) : [], null, 2)}`,
    "",
    `PARTY_OVERRIDES:\n${buildPartyOverridesBlock(input.partyOverrides)}`,
    "",
    `EXTRA_INSTRUCTIONS:\n${String(input.extraInstructions || "").trim() || "(none)"}`,
    "",
    `SEED_OUTPUT_FROM_SHARED_AGENT:\n${JSON.stringify({
      selected_template: input.source?.selected_template || input.template.title,
      draft_text: sourceDraft || null,
      validation_checks: input.source?.validation_checks || [],
      missing_evidence: input.source?.missing_evidence || [],
      citations: input.source?.citations || [],
    }, null, 2).slice(0, 3000)}`,
    "",
    `EVIDENCE_SNIPPETS:\n${evidenceSnippets || "(none)"}`,
    "",
    `REFERENCE_CITATIONS:\n${citations || "(none)"}`,
    "",
    `PRIMARY_CASE_TEXT:\n${String(input.doc.extracted_text || "").slice(0, 12000)}`,
  ].join("\n\n");
}

async function refineLegalDraftWithLlm(input: {
  runId: string;
  template: { key: string; title: string; description: string; required: string[] };
  qp: any;
  doc: DocMeta;
  language: string;
  jurisdiction: string;
  source: any;
  caseTitle: string;
  partyOverrides?: any;
  extraInstructions?: string;
}) {
  const signal = runCancellationService.getSignal(input.runId);
  const prompt = buildLegalDraftRefinePrompt(input);
  const raw = await llmClient.generateText(prompt, {
    tier: "final",
    temperature: 0.05,
    top_p: 0.9,
    max_tokens: 1500,
    timeoutMs: 45_000,
    signal,
  });
  const parsed = safeParseJsonLoose(raw);
  const normalized = {
    selected_template: String(parsed?.selected_template || input.template.title),
    draft_text: normalizeDraftText(String(parsed?.draft_text || "")),
    validation_checks: Array.isArray(parsed?.validation_checks) ? parsed.validation_checks.map((v: any) => String(v || "").trim()).filter(Boolean).slice(0, 8) : [],
    missing_evidence: Array.isArray(parsed?.missing_evidence) ? parsed.missing_evidence.map((v: any) => String(v || "").trim()).filter(Boolean).slice(0, 6) : [],
    confidence: typeof parsed?.confidence === "number" ? parsed.confidence : 0.72,
    citations: Array.isArray(parsed?.citations)
      ? parsed.citations.map((c: any, idx: number) => ({
          doc_id: String(c?.doc_id || input.doc.doc_id),
          chunk_id: String(c?.chunk_id || `draft_refine:${idx + 1}`),
          snippet: trimWords(String(c?.snippet || ""), 25),
          source_type: "user_doc",
        })).filter((c: any) => c.snippet)
      : [],
  };
  if (!normalized.draft_text) {
    throw new Error("Legal Draft refinement returned empty draft_text");
  }
  return normalized;
}

async function saveDraftRow(caseId: string, output: DraftOutput, meta: { language: string; jurisdiction: string; sourceDocHash: string; runId?: string | null }) {
  await ensureDraftTable();
  await mysqlPool.query(
    `INSERT INTO drafts (draft_id, case_id, template_key, title, content, suggestions_json, validation_json, citations_json, clarifying_questions_json, language, jurisdiction, status, mode, analysis_valid, failure_reason, source_doc_hash, run_id, qa_debug_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))
     ON DUPLICATE KEY UPDATE title=VALUES(title), content=VALUES(content), suggestions_json=VALUES(suggestions_json), validation_json=VALUES(validation_json), citations_json=VALUES(citations_json), clarifying_questions_json=VALUES(clarifying_questions_json), language=VALUES(language), jurisdiction=VALUES(jurisdiction), status=VALUES(status), mode=VALUES(mode), analysis_valid=VALUES(analysis_valid), failure_reason=VALUES(failure_reason), source_doc_hash=VALUES(source_doc_hash), run_id=VALUES(run_id), qa_debug_json=VALUES(qa_debug_json), updated_at=NOW(3)`,
    [
      output.draft_id,
      caseId,
      output.template_key,
      output.title,
      output.content,
      JSON.stringify(output.suggestions || {}),
      JSON.stringify(output.evidence_validation || {}),
      JSON.stringify(output.citations || []),
      JSON.stringify(output.clarifying_questions || []),
      meta.language || "English",
      meta.jurisdiction || "India",
      "ready",
      output.mode,
      output.analysis_valid ? 1 : 0,
      output.failure_reason || null,
      meta.sourceDocHash,
      meta.runId || null,
      JSON.stringify(output.qa_debug || {}),
    ],
  );
}

async function savePlaceholderDraftRow(caseId: string, params: {
  draftId: string;
  templateKey: string;
  templateTitle: string;
  language: string;
  jurisdiction: string;
  sourceDocHash: string;
  runId: string;
}) {
  await ensureDraftTable();
  await mysqlPool.query(
    `INSERT INTO drafts (draft_id, case_id, template_key, title, content, suggestions_json, validation_json, citations_json, clarifying_questions_json, language, jurisdiction, status, mode, analysis_valid, failure_reason, source_doc_hash, run_id, qa_debug_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))
     ON DUPLICATE KEY UPDATE title=VALUES(title), content=VALUES(content), language=VALUES(language), jurisdiction=VALUES(jurisdiction), status=VALUES(status), mode=VALUES(mode), analysis_valid=VALUES(analysis_valid), failure_reason=VALUES(failure_reason), source_doc_hash=VALUES(source_doc_hash), run_id=VALUES(run_id), qa_debug_json=VALUES(qa_debug_json), updated_at=NOW(3)`,
    [
      params.draftId,
      caseId,
      params.templateKey,
      `${params.templateTitle} Draft`,
      "Generating draft from the current case workspace...",
      JSON.stringify({ add_clauses: [], customizations: [], well_structured: [], alternative_clauses: [] }),
      JSON.stringify({ required_items: [], overall_readiness: "Needs Inputs" }),
      JSON.stringify([]),
      JSON.stringify([]),
      params.language || "English",
      params.jurisdiction || "India",
      "running",
      "fallback",
      0,
      null,
      params.sourceDocHash || "",
      params.runId,
      JSON.stringify({ placeholder: true, run_id: params.runId }),
    ],
  );
}

async function persistDraftAgentOutput(caseId: string, output: DraftOutput, meta: { language: string; sourceDocHash: string; runId?: string | null; profile?: string }) {
  const docId =
    Array.isArray(output.citations) && output.citations.length > 0 && output.citations[0]?.doc_id
      ? String(output.citations[0].doc_id)
      : null;
  await mysqlPool.query(
    `INSERT INTO agent_outputs (
        id, case_id, agent_key, agent_kind, doc_id, doc_hash, output_lang, profile,
        run_id, status, analysis_valid, failure_reason, payload_json, source_language, created_at, updated_at
      ) VALUES (?, ?, ?, 'common', ?, ?, ?, ?, ?, 'SUCCEEDED', ?, ?, ?, ?, NOW(3), NOW(3))
     ON DUPLICATE KEY UPDATE
        agent_kind='common',
        doc_id=VALUES(doc_id),
        doc_hash=VALUES(doc_hash),
        output_lang=VALUES(output_lang),
        profile=VALUES(profile),
        run_id=VALUES(run_id),
        status='SUCCEEDED',
        analysis_valid=VALUES(analysis_valid),
        failure_reason=VALUES(failure_reason),
        payload_json=VALUES(payload_json),
        source_language=VALUES(source_language),
        updated_at=NOW(3)`,
    [
      randomUUID(),
      caseId,
      AGENT_KEY,
      docId,
      meta.sourceDocHash || "",
      meta.language || "English",
      meta.profile || "standard",
      meta.runId || null,
      output.analysis_valid ? 1 : 0,
      output.failure_reason || null,
      JSON.stringify(output),
      meta.language || "English",
    ],
  );
}

async function getDraftRow(caseId: string, draftId: string) {
  await ensureDraftTable();
  const [rows]: any = await mysqlPool.query(`SELECT * FROM drafts WHERE case_id=? AND draft_id=? LIMIT 1`, [caseId, draftId]);
  return rows?.[0] || null;
}

async function listRecentDrafts(caseId: string) {
  await ensureDraftTable();
  const [rows]: any = await mysqlPool.query(`SELECT draft_id, template_key, title, status, mode, analysis_valid, updated_at FROM drafts WHERE case_id=? ORDER BY updated_at DESC LIMIT 10`, [caseId]);
  return (rows || []).map((r: any) => ({
    draft_id: String(r.draft_id),
    template_key: String(r.template_key),
    title: String(r.title),
    status: String(r.status || "ready"),
    mode: String(r.mode || "fallback"),
    analysis_valid: !!r.analysis_valid,
    updated_at: new Date(r.updated_at).toISOString(),
  }));
}

async function executeDraftRun(runId: string, draftId: string, caseId: string, userId: string, input: DraftRunInput) {
  const env = getEnv();
  runCancellationService.register(runId);
  const c = await ensureOwnedCase(userId, caseId);
  const doc = await resolvePrimaryDoc(caseId);
  if (!doc) throw new HttpError(400, "No case document/text found", "case_input_missing");
  const qp = await getQueryParsingPayload(caseId);
  const template = TEMPLATE_CATALOG.find((t) => t.key === input.template_key);
  if (!template) throw new HttpError(400, "Unknown template", "invalid_template");

  await prisma.run.update({ where: { id: runId }, data: { status: RunStatus.RUNNING, startedAt: new Date() } });
  await updateRunProgress(runId, { stage: RUN_STEP_NAMES[0], stepIndex: 1, stepsTotal: RUN_STEP_NAMES.length, steps: buildRunSteps(0), meta: { agent_key: AGENT_KEY, draft_id: draftId, template_key: input.template_key, doc_hash: doc.hash } });
  runCancellationService.throwIfCancelled(runId);
  await updateRunProgress(runId, { stage: RUN_STEP_NAMES[1], stepIndex: 2, steps: buildRunSteps(1) });

  let source: any;
  let llmSucceeded = false;
  try {
    source = await agentRunner.runCommonAgent(caseId, c.role, doc.extracted_text, { query_parsing: qp }, AGENT_KEY, {
      runId,
      inputHash: sha256(`${doc.hash}:${input.template_key}:${JSON.stringify(input.party_overrides || {})}:${input.extra_instructions || ""}`),
      docChecksumsUsed: [doc.hash],
      language: input.language || c.language || "English",
      preferredLanguage: input.language || c.language || "English",
      userQueryText: `${input.template_key} ${String(qp?.executive_summary || qp?.summary || "")} ${String(input.extra_instructions || "")}`.slice(0, 1200),
      filtersApplied: (c as any).filtersJson || {},
      extractedDocSnippets: [],
      inputStats: { query_source: "legal_drafts_agent", template_key: input.template_key },
    });
    source = await refineLegalDraftWithLlm({
      runId,
      template,
      qp,
      doc,
      language: input.language || c.language || "English",
      jurisdiction: input.jurisdiction || "India",
      source,
      caseTitle: String(qp?.case_title || c.title || "Case Workspace"),
      partyOverrides: input.party_overrides,
      extraInstructions: input.extra_instructions,
    });
    llmSucceeded = true;
  } catch (e) {
    if (runCancellationService.isCancellationError(e) || runCancellationService.isCancelled(runId)) throw e;
    source = { mode: "fallback", error: String((e as any)?.message || e) };
  }
  runCancellationService.throwIfCancelled(runId);

  await updateRunProgress(runId, { stage: RUN_STEP_NAMES[2], stepIndex: 3, steps: buildRunSteps(2) });
  await updateRunProgress(runId, { stage: RUN_STEP_NAMES[3], stepIndex: 4, steps: buildRunSteps(3) });

  const sourceDraftText = String(source?.draft_text || "").trim();
  if (env.REQUIRE_LLM_OUTPUT && sourceDraftText.length < 160) {
    source = {
      ...(source || {}),
      mode: "fallback",
      error: "LLM draft output was too short or empty. Fallback draft generated.",
    };
    llmSucceeded = false;
  }
  const output = mapDraftOutput({
    draftId,
    templateKey: input.template_key,
    templateTitle: template.title,
    qp,
    doc,
    source,
    language: input.language || c.language || "English",
    jurisdiction: input.jurisdiction || "India",
    llmSucceeded,
    requireLlm: env.REQUIRE_LLM_OUTPUT,
    partyOverrides: input.party_overrides,
    extraInstructions: input.extra_instructions,
  });
  if (source?.error) {
    output.mode = "fallback";
    if (!output.analysis_valid) {
      output.failure_reason = String(source.error);
    } else {
      output.failure_reason = null;
    }
  }
  output.qa_debug = { ...(output.qa_debug || {}), run_id: runId };

  await updateRunProgress(runId, { stage: RUN_STEP_NAMES[4], stepIndex: 5, steps: buildRunSteps(4) });
  await saveDraftRow(caseId, output, {
    language: input.language || c.language || "English",
    jurisdiction: input.jurisdiction || "India",
    sourceDocHash: doc.hash,
    runId,
  });
  await persistDraftAgentOutput(caseId, output, {
    language: input.language || c.language || "English",
    sourceDocHash: doc.hash,
    runId,
  });
  await prisma.run.update({ where: { id: runId }, data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() } });
  await updateRunProgress(runId, { done: true, stage: "Completed", error: null, meta: { agent_key: AGENT_KEY, draft_id: draftId, template_key: input.template_key, doc_hash: doc.hash, analysis_valid: output.analysis_valid, mode: output.mode } });
  const title = output.analysis_valid === false ? "Legal Draft completed with warnings" : "Legal Draft completed";
  const body = output.analysis_valid === false
    ? `Legal Draft generated fallback draft for case ${caseId}`
    : `Legal Draft generated draft for case ${caseId}`;
  await notificationService.create(userId, title, body);
  runCancellationService.clear(runId);
}

export const legalDraftsAgentService = {
  AGENT_KEY,
  templates: TEMPLATE_CATALOG,
  schema: draftOutputSchema,
  async getOverview(userId: string, caseId: string) {
    const c = await ensureOwnedCase(userId, caseId);
    const doc = await resolvePrimaryDoc(caseId);
    const qp = await getQueryParsingPayload(caseId);
    const recentDrafts = await listRecentDrafts(caseId).catch(() => []);
    const rankedTemplates = doc ? rankTemplates(qp, doc, c.title) : TEMPLATE_CATALOG.map((template) => ({
      ...template,
      fit: {
        template_key: template.key,
        score: 0,
        confidence: "low" as const,
        recommended: false,
        reason: "Upload or select case materials to get a template recommendation.",
        caution: null,
      },
    }));
    return {
      case: { case_id: caseId, title: c.title, domain: (c as any).domainPrimary || "General", language: c.language || "English" },
      primary_doc: doc ? { doc_id: doc.doc_id, filename: doc.filename, mime_type: doc.mime_type, kind: doc.kind || null, pages: doc.pages, char_count: doc.char_count, updated_at: doc.updated_at } : null,
      query_parsing_subset: qp ? { domain: qp.domain, subtype: qp.domain?.subtype || qp.legal_subtype, key_facts: qp.key_facts || null, legal_grounds: qp.legal_grounds || [] } : null,
      templates: rankedTemplates,
      template_recommendation: rankedTemplates[0]?.fit || null,
      recent_drafts: recentDrafts,
      qa_debug: { case_id: caseId, primary_doc_id: (c as any).primaryDocId || null, doc_hash: doc?.hash || null, extracted_text_exists: !!doc?.extracted_text?.trim(), query_parsing_output_exists: !!qp },
    };
  },
  async generateDraft(userId: string, caseId: string, input: { template_key: string; language?: string; jurisdiction?: string; party_overrides?: any; extra_instructions?: string; auto_select?: boolean; }) {
    const c = await ensureOwnedCase(userId, caseId);
    const doc = await resolvePrimaryDoc(caseId);
    if (!doc) throw new HttpError(400, "No case document/text found for this case", "case_input_missing");
    const qp = await getQueryParsingPayload(caseId);
    const rankedTemplates = doc ? rankTemplates(qp, doc, c.title) : TEMPLATE_CATALOG.map((template) => ({
      ...template,
      fit: {
        template_key: template.key,
        score: 0,
        confidence: "low" as const,
        recommended: false,
        reason: "Upload or select case materials to get a template recommendation.",
        caution: null,
      },
    }));
    const preferredTemplateKey = rankedTemplates[0]?.key || TEMPLATE_CATALOG[0]?.key || input.template_key;
    const wantsAuto = input.auto_select === true || String(input.template_key || "").toLowerCase() === "auto";
    const resolvedTemplateKey = wantsAuto ? preferredTemplateKey : input.template_key;
    const template = TEMPLATE_CATALOG.find((t) => t.key === resolvedTemplateKey) || TEMPLATE_CATALOG[0];
    if (!template) throw new HttpError(400, "Unknown template selected", "invalid_template");
    const fit = scoreTemplateFit(template.key, qp, doc, c.title);
    const resolvedTemplate = fit.score < 20 && !wantsAuto
      ? (rankedTemplates[0] || template)
      : template;
    const resolvedInput = { ...input, template_key: resolvedTemplate.key };
    await ensureDraftTable();
    const draftId = randomUUID();
    const run = await prisma.run.create({
      data: {
        caseId,
        status: RunStatus.PENDING,
        language: input.language || c.language || "English",
        stepsJson: makeRunStatus({ meta: { agent_key: AGENT_KEY, draft_id: draftId, template_key: resolvedTemplate.key, doc_hash: doc.hash } }) as any,
        startedAt: new Date(),
      },
    });
    await savePlaceholderDraftRow(caseId, {
      draftId,
      templateKey: resolvedTemplate.key,
      templateTitle: resolvedTemplate.title,
      language: input.language || c.language || "English",
      jurisdiction: input.jurisdiction || "India",
      sourceDocHash: doc.hash,
      runId: run.id,
    });
    const lockKey = `${caseId}:${doc.hash}:${resolvedTemplate.key}`;
    inFlight.set(lockKey, run.id);
    setImmediate(() => {
      void executeDraftRun(run.id, draftId, caseId, userId, resolvedInput).catch(async (e) => {
        if (runCancellationService.isCancellationError(e) || runCancellationService.isCancelled(run.id)) {
          await updateRunProgress(run.id, { done: true, stage: "Cancelled", error: "Run cancelled by user", meta: { agent_key: AGENT_KEY, draft_id: draftId, template_key: resolvedTemplate.key, cancelled: true } }).catch(() => undefined);
          await prisma.run.update({ where: { id: run.id }, data: { status: RunStatus.FAILED, finishedAt: new Date() } }).catch(() => undefined);
          await notificationService.create(userId, "Legal Draft cancelled", `Legal Draft was cancelled for case ${caseId}`).catch(() => undefined);
          return;
        }
        const reason = String((e as any)?.message || e);
        try {
          const docNow = await resolvePrimaryDoc(caseId);
          const qpNow = await getQueryParsingPayload(caseId);
          const fallbackOutput = mapDraftOutput({
            draftId,
            templateKey: resolvedTemplate.key,
            templateTitle: resolvedTemplate.title,
            qp: qpNow,
            doc: docNow || doc,
            source: { mode: "fallback", error: reason },
            language: resolvedInput.language || c.language || "English",
            jurisdiction: resolvedInput.jurisdiction || "India",
            llmSucceeded: false,
            requireLlm: getEnv().REQUIRE_LLM_OUTPUT === true,
          });
          fallbackOutput.mode = "fallback";
          fallbackOutput.failure_reason = reason;
          fallbackOutput.qa_debug = { ...(fallbackOutput.qa_debug || {}), run_id: run.id, hard_error: reason };
          await saveDraftRow(caseId, fallbackOutput, {
            language: resolvedInput.language || c.language || "English",
            jurisdiction: resolvedInput.jurisdiction || "India",
            sourceDocHash: (docNow || doc).hash,
            runId: run.id,
          });
          await persistDraftAgentOutput(caseId, fallbackOutput, {
            language: resolvedInput.language || c.language || "English",
            sourceDocHash: (docNow || doc).hash,
            runId: run.id,
          });
          await updateRunProgress(run.id, { done: true, stage: "Completed", error: null, meta: { agent_key: AGENT_KEY, draft_id: draftId, template_key: resolvedTemplate.key, mode: "fallback", analysis_valid: !!fallbackOutput.analysis_valid } });
          await prisma.run.update({ where: { id: run.id }, data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() } }).catch(() => undefined);
          await notificationService.create(userId, "Legal Draft completed with warnings", `Legal Draft generated fallback draft for case ${caseId}: ${reason}`);
        } catch {
          await updateRunProgress(run.id, { done: true, error: reason });
          await prisma.run.update({ where: { id: run.id }, data: { status: RunStatus.FAILED, finishedAt: new Date() } }).catch(() => undefined);
          await notificationService.create(userId, "Legal Draft failed", `Legal Draft failed for case ${caseId}: ${reason}`);
        }
      }).finally(() => {
        if (inFlight.get(lockKey) === run.id) inFlight.delete(lockKey);
        runCancellationService.clear(run.id);
      });
    });
    return { draft_id: draftId, status: "queued", run_id: run.id };
  },
  async getDraft(userId: string, caseId: string, draftId: string) {
    await ensureOwnedCase(userId, caseId);
    const row = await getDraftRow(caseId, draftId);
    if (!row) throw new HttpError(404, "Draft not found", "draft_not_found");
    return {
      draft_id: String(row.draft_id),
      template_key: String(row.template_key),
      title: String(row.title),
      content: String(row.content),
      suggestions: parseJson(row.suggestions_json) || {},
      evidence_validation: parseJson(row.validation_json) || {},
      citations: parseJson(row.citations_json) || [],
      clarifying_questions: parseJson(row.clarifying_questions_json) || [],
      analysis_valid: !!row.analysis_valid,
      mode: String(row.mode || "fallback"),
      failure_reason: row.failure_reason ? String(row.failure_reason) : null,
      qa_debug: parseJson(row.qa_debug_json) || {},
      status: String(row.status || "ready"),
      run_id: row.run_id ? String(row.run_id) : null,
      updated_at: new Date(row.updated_at).toISOString(),
    };
  },
  async saveDraft(userId: string, caseId: string, draftId: string, body?: { content?: string }) {
    await ensureOwnedCase(userId, caseId);
    await ensureDraftTable();
    if (typeof body?.content === "string") {
      await mysqlPool.query(`UPDATE drafts SET content=?, updated_at=NOW(3) WHERE case_id=? AND draft_id=?`, [body.content, caseId, draftId]);
    } else {
      await mysqlPool.query(`UPDATE drafts SET updated_at=NOW(3) WHERE case_id=? AND draft_id=?`, [caseId, draftId]);
    }
    return this.getDraft(userId, caseId, draftId);
  },
  async exportPdf(userId: string, caseId: string, draftId: string) {
    const draft = await this.getDraft(userId, caseId, draftId);
    const buffer = await renderLegalDraftPdf(draft, caseId, draftId);
    return {
      buffer,
      filename: `legal-draft-${String(draftId || caseId || "draft")}.pdf`,
    };
  },
  async exportDocx(
    userId: string,
    caseId: string,
    draftId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    await this.getDraft(userId, caseId, draftId);
    throw new HttpError(404, "DOCX export is not enabled. Use PDF export.", "legal_draft_docx_not_supported");
  },
};
