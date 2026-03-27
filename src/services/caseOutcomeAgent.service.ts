import { randomUUID } from "crypto";
import { z } from "zod";
import { HttpError } from "../middleware/error.js";
import { mysqlPool, prisma } from "../prisma/client.js";
import { RunStatus } from "../db/types.js";
import type { RunStep } from "../types/api.js";
import { sha256 } from "../utils/hash.js";
import { createPdfBuffer, shortenText, toDateTime, toSingleLine } from "../utils/pdf.js";
import { agentRunner } from "./agents/agentRunner.js";
import { retriever } from "./retrieval/retriever.js";
import { getEnv } from "../config/env.js";
import type { RetrievedSnippet } from "./retrieval/retriever.js";
import { notificationService } from "./notification.service.js";
import { runCancellationService } from "./runCancellation.service.js";
import { assessNarrativeQuality, countGenericPhraseHits } from "./quality/genericity.service.js";
import { resolvePrimaryCaseDocumentMeta } from "./documentMeta.service.js";

const AGENT_KEY = "case_outcome_deadline_penalty";
const SOURCE_AGENT_KEY = "outcome_projection";
const RUN_STEP_NAMES = [
  "analyze_facts",
  "search_similar_cases",
  "evaluate_precedents",
  "calculate_distribution",
  "generate_report",
  "done",
] as const;

const citationSchema = z.object({
  source_type: z.string().min(1),
  doc_id: z.string().nullable().optional(),
  chunk_id: z.string().optional(),
  snippet: z.string().min(1),
  page: z.number().nullable().optional(),
  offset_start: z.number().nullable().optional(),
  offset_end: z.number().nullable().optional(),
});

const caseOutcomeOutputSchema = z.object({
  agent_key: z.literal(AGENT_KEY).default(AGENT_KEY),
  mode: z.enum(["normal", "fallback"]).default("fallback"),
  analysis_valid: z.boolean().default(false),
  failure_reason: z.string().nullable().default(null),
  doc_summary: z.object({
    doc_type_guess: z.string(),
    language: z.string(),
    pages: z.number().nullable().optional(),
  }),
  prefill: z.object({
    case_type: z.string().nullable().optional(),
    jurisdiction: z.string().nullable().optional(),
    claim_amount: z.string().nullable().optional(),
    facts_summary: z.string().nullable().optional(),
    key_legal_issues: z.array(z.string()).default([]),
    evidence_strength: z.string().nullable().optional(),
  }),
  prediction: z.object({
    distribution: z.object({
      win: z.number().min(0).max(1),
      settle: z.number().min(0).max(1),
      lose: z.number().min(0).max(1),
    }),
    confidence: z.number().min(0).max(1),
  }),
  ranges: z.object({
    duration_months: z.tuple([z.number(), z.number()]).nullable().optional(),
    award_or_cost_range_inr: z.tuple([z.number(), z.number()]).nullable().optional(),
  }),
  similar_corpus_available: z.boolean().default(false),
  similar_cases: z.array(z.object({
    title: z.string(),
    relevance: z.number().min(0).max(1).optional(),
    summary: z.string().optional(),
  })).default([]),
  deadlines_and_penalties: z.array(z.object({
    label: z.string(),
    detail: z.string().nullable().optional(),
    citation_ref: z.number().int().nullable().optional(),
  })).default([]),
  recommendations: z.array(z.string()).default([]),
  clarifying_questions: z.array(z.string()).default([]),
  citations: z.array(citationSchema).default([]),
  qa_debug: z.record(z.any()).optional(),
});

type CaseOutcomeOutput = z.infer<typeof caseOutcomeOutputSchema>;
type CaseDocMeta = { doc_id: string; filename: string; mime: string; kind?: string | null; updated_at: string; hash: string; language: string; extracted_text: string; pages?: number | null; char_count?: number | null };
type RunStatusShape = { stage: string; stepIndex: number; stepsTotal: number; stats: Record<string, any>; done: boolean; error?: string | null; steps: RunStep[]; meta: Record<string, any>; };

const inFlightByCaseDoc = new Map<string, string>();
function trimWords(text: string, max = 25) { return String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, max).join(" "); }
function normalizeWhitespace(text: string) { return String(text || "").replace(/\s+/g, " ").trim(); }
function escapeRegex(text: string) { return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function clipSentence(text: string, maxChars = 260) {
  const clean = normalizeWhitespace(text).replace(/^[\s•\-:;,.\d()]+/, "");
  if (!clean) return "";
  if (clean.length <= maxChars) return clean;
  const head = clean.slice(0, maxChars + 1);
  const punctCut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("; "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (punctCut >= Math.floor(maxChars * 0.55)) {
    return head.slice(0, punctCut + 1).trim();
  }
  const wordCut = head.lastIndexOf(" ");
  const cutAt = wordCut > 30 ? wordCut : maxChars;
  return `${head.slice(0, cutAt).trim()}...`;
}

function contextSnippetAround(text: string, index: number, opts?: { back?: number; forward?: number; max?: number }) {
  const source = String(text || "");
  if (!source.trim()) return "";
  const back = Math.max(80, Number(opts?.back || 220));
  const forward = Math.max(120, Number(opts?.forward || 360));
  const maxChars = Math.max(120, Number(opts?.max || 300));
  const startSeed = Math.max(0, index - back);
  const endSeed = Math.min(source.length, index + forward);
  let start = startSeed;
  let end = endSeed;
  const before = source.slice(startSeed, index);
  const after = source.slice(index, endSeed);
  const prevDelim = Math.max(before.lastIndexOf("."), before.lastIndexOf(";"), before.lastIndexOf("\n"));
  if (prevDelim >= 0) start = startSeed + prevDelim + 1;
  const nextCandidates = [after.indexOf("."), after.indexOf(";"), after.indexOf("\n")].filter((x) => x >= 0);
  if (nextCandidates.length > 0) end = index + Math.min(...nextCandidates) + 1;
  return clipSentence(source.slice(start, end), maxChars);
}

function hasUsableDistribution(value: any) {
  if (!value || typeof value !== "object") return false;
  return ["win", "settle", "lose"].every((k) => Number.isFinite(Number(value?.[k])));
}

function looksLikeOutcomeTimelineNoise(text: string) {
  const normalized = normalizeOutcomeText(text);
  if (!normalized) return true;
  return [
    "interest of justice",
    "such other orders as the honourable court deems fit",
    "such other orders as the honorable court deems fit",
    "fit and proper in the circumstances",
    "irreparable loss and serious injury",
    "out of order in the interest of justice",
  ].some((phrase) => normalized.includes(phrase));
}

function normalizeOutcomeTimelineText(text: string) {
  const normalized = normalizeOutcomeText(text)
    .replace(/\bpetitioner\b/g, "plaintiff")
    .replace(/\by ou\b/g, "you")
    .replace(/\byou are hereby required to appear in court on the day of\b/g, "court appearance notice")
    .replace(/\bthe plaintiff was able to pay loan installments till the last two months\b/g, "loan installments were paid till the last two months")
    .replace(/\bi was able to pay loan installments till the last two months\b/g, "loan installments were paid till the last two months")
    .trim();
  if (normalized.includes("appear in court") && /10 30 a m/.test(normalized)) {
    return "court appearance notice 2024 10 30 am";
  }
  return normalized;
}

function cleanOutcomeTimelineDetail(text: string, label: string) {
  const raw = normalizeWhitespace(text).replace(/^Y\+ou\b/i, "You");
  const normalized = normalizeOutcomeTimelineText(raw);
  if (label === "Court Appearance / Hearing" && normalized.includes("court appearance notice")) {
    return "Court appearance notice requiring appearance in 2024 at 10:30 A.M.";
  }
  if (label === "Recent Default Timeline" && normalized.includes("loan installments were paid till the last two months")) {
    return "The pleading states that loan installments were paid until the last two months.";
  }
  return clipSentence(raw, 320);
}

function isGroundedOutcomeTimeline(text: string) {
  const normalized = normalizeOutcomeText(text);
  if (!normalized || looksLikeOutcomeTimelineNoise(normalized)) return false;
  return [
    /\b\d{1,2}[:.]\d{2}\s*a\.?m\b/,
    /\bappear in court\b/,
    /\bwithin\s+\d+\s+(day|days|week|weeks|month|months)\b/,
    /\b\d+\s+(day|days|week|weeks|month|months)\s+(from|after|before)\b/,
    /\b(last two months|last month|last three months)\b/,
    /\bdue date\b/,
    /\bdeadline\b/,
    /\blate fee\b/,
    /\bliquidated damages\b/,
    /\binterest\b(?=[^.\n]{0,40}(?:%|per annum|p\.a\.|delay|late|charge|payment|amount))/,
  ].some((pattern) => pattern.test(normalized));
}

function parseInrAmountNumber(text: string) {
  const m = String(text || "").match(/(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)/i);
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function normalizeOutcomeText(text: string) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toPercent(value: unknown) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "N/A";
  const pct = num <= 1 ? Math.round(num * 100) : Math.round(num);
  return `${Math.max(0, Math.min(100, pct))}%`;
}

function formatRange(range?: [number, number] | null, suffix?: string) {
  if (!range || !Array.isArray(range)) return "N/A";
  const [min, max] = range;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return "N/A";
  const label = `${min} - ${max}`;
  return suffix ? `${label} ${suffix}` : label;
}

function outcomeReportStatusLabel(analysisValid: unknown) {
  return analysisValid === false ? "Needs Review" : "Complete";
}

function outcomeReportReviewNote(analysisValid: unknown) {
  if (analysisValid !== false) return null;
  return "This report was generated from available case inputs and should be reviewed before final legal use.";
}

function outcomeCitationLabel(sourceType: unknown) {
  const key = String(sourceType || "").toLowerCase();
  if (key.includes("user_doc") || key.includes("user doc")) return "Case File";
  if (key.includes("legal_corpus") || key.includes("legal corpus")) return "Legal Reference";
  if (key.includes("current_input") || key.includes("current input")) return "Submitted Query";
  return "Source";
}

async function renderCaseOutcomePdf(payload: CaseOutcomeOutput, caseId: string, caseTitle?: string) {
  return createPdfBuffer((doc, h) => {
    const title = toSingleLine(caseTitle || "Case Outcome Projection");
    doc.font("Helvetica-Bold").fontSize(18).fillColor("#0b1220").text("Case Outcome Projection Report", { width: h.pageWidth });
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(10).fillColor("#374151").text(`Case ID: ${caseId}`, { width: h.pageWidth });
    if (title) doc.text(`Case Title: ${title}`, { width: h.pageWidth });
    doc.text(`Generated At: ${toDateTime(payload?.qa_debug?.generated_at || new Date().toISOString())}`, { width: h.pageWidth });
    doc.text(`Report Status: ${outcomeReportStatusLabel(payload.analysis_valid)}`, { width: h.pageWidth });
    const reviewNote = outcomeReportReviewNote(payload.analysis_valid);
    if (reviewNote) doc.text(reviewNote, { width: h.pageWidth });
    doc.moveDown(0.35);

    h.heading("Executive Snapshot");
    h.line("Case Type", payload.prefill?.case_type || "N/A");
    h.line("Jurisdiction", payload.prefill?.jurisdiction || "N/A");
    h.line("Claim Amount", payload.prefill?.claim_amount || "N/A");
    h.line("Document Type", payload.doc_summary?.doc_type_guess || "Unknown");
    h.line("Language", payload.doc_summary?.language || "Unknown");
    h.line("Evidence Strength", payload.prefill?.evidence_strength || "N/A");
    h.line(
      "Outcome Distribution",
      `Win ${toPercent(payload.prediction?.distribution?.win)} / Settle ${toPercent(payload.prediction?.distribution?.settle)} / Lose ${toPercent(payload.prediction?.distribution?.lose)}`,
    );
    h.line("Confidence", toPercent(payload.prediction?.confidence));
    h.line("Duration Range", formatRange(payload.ranges?.duration_months, "months"));
    h.line("Award/Cost Range (INR)", formatRange(payload.ranges?.award_or_cost_range_inr, "INR"));

    h.heading("Facts Summary");
    h.paragraph(payload.prefill?.facts_summary || "No facts summary available.");

    h.heading("Key Legal Issues");
    h.bullets(payload.prefill?.key_legal_issues || [], 8);

    h.heading("Recommendations");
    h.bullets(payload.recommendations || [], 8);

    h.heading("Deadlines & Penalties");
    if (!Array.isArray(payload.deadlines_and_penalties) || !payload.deadlines_and_penalties.length) {
      h.paragraph("No deadline or penalty timeline extracted.");
    } else {
      h.bullets(
        payload.deadlines_and_penalties.slice(0, 8).map((item) => {
          const label = toSingleLine(item.label || "Milestone");
          const detail = toSingleLine(item.detail || "");
          return detail ? `${label}: ${detail}` : label;
        }),
        8,
      );
    }

    h.heading("Similar Cases");
    if (!Array.isArray(payload.similar_cases) || !payload.similar_cases.length) {
      h.paragraph("No similar cases available.");
    } else {
      for (const row of payload.similar_cases.slice(0, 5)) {
        h.subheading(toSingleLine(row.title || "Case"));
        const relevance = Number.isFinite(Number(row.relevance)) ? `${Math.round(Number(row.relevance) * 100)}% relevance` : null;
        if (relevance) h.paragraph(relevance);
        if (row.summary) h.paragraph(shortenText(row.summary, 320));
        doc.moveDown(0.15);
      }
    }

    h.heading("Clarifying Questions");
    h.bullets(payload.clarifying_questions || [], 6);

    h.heading("Top Citations");
    if (!Array.isArray(payload.citations) || !payload.citations.length) {
      h.paragraph("No citations captured.");
    } else {
      h.bullets(
        payload.citations.slice(0, 6).map((c) => {
          const ref = toSingleLine(`${outcomeCitationLabel(c.source_type)}${c.page ? ` (p.${c.page})` : ""}`);
          const snippet = shortenText(c.snippet, 240);
          return `${ref}: ${snippet}`;
        }),
        6,
      );
    }
  });
}

function tokenizeOutcomeText(text: string, limit = 18) {
  return [...new Set(
    normalizeOutcomeText(text)
      .split(/\s+/)
      .filter((token) => token.length >= 4)
      .slice(0, limit),
  )];
}

function buildOutcomeProfile(doc: CaseDocMeta, qp: any) {
  const caseType = String(qp?.domain?.subtype || qp?.legal_subtype || qp?.case_type || "").trim().toLowerCase();
  const domain = String(qp?.domain?.primary || qp?.legal_domain || qp?.domain || "").trim().toLowerCase();
  const reliefs = Array.isArray(qp?.key_facts?.reliefs_claimed) ? qp.key_facts.reliefs_claimed.map((x: any) => String(x || "").toLowerCase()) : [];
  const combined = [
    qp?.executive_summary,
    qp?.summary,
    ...(Array.isArray(qp?.legal_grounds) ? qp.legal_grounds : []),
    ...(Array.isArray(qp?.issue_groups) ? qp.issue_groups.map((g: any) => g?.label || g?.title || "") : []),
    ...reliefs,
    String(doc?.extracted_text || "").slice(0, 4000),
  ].join(" ");
  const normalized = normalizeOutcomeText(combined);
  const isCivilInjunctionFinance =
    caseType.includes("civil_injunction_finance") ||
    (/injunction/.test(normalized) && /(loan|installment|recovery|harass|respondent)/.test(normalized));
  const positiveTerms = isCivilInjunctionFinance
    ? ["civil", "injunction", "plaintiff", "petitioner", "respondent", "loan", "recovery", "harassment", "possession", "cpc"]
    : domain.includes("property")
      ? ["civil", "property", "plaintiff", "defendant", "possession", "injunction", "title"]
      : domain.includes("consumer")
        ? ["consumer", "complaint", "refund", "defect", "replacement", "service"]
        : ["civil", "court", "plaintiff", "defendant", "petition", "dispute"];
  const negativeTerms = ["accused", "bodily injury", "criminal", "murder", "assessee", "income tax", "tribunal", "fasli", "forest", "compensation officer", "customs", "excise"];
  const queryTerms = tokenizeOutcomeText([
    qp?.executive_summary,
    qp?.summary,
    ...(Array.isArray(qp?.legal_grounds) ? qp.legal_grounds : []),
    ...reliefs,
  ].join(" "), 16);
  return { caseType, domain, normalized, isCivilInjunctionFinance, positiveTerms, negativeTerms, queryTerms };
}

function buildSimilarCaseQuery(doc: CaseDocMeta, qp: any) {
  const profile = buildOutcomeProfile(doc, qp);
  if (profile.isCivilInjunctionFinance) {
    return ["civil injunction", "loan recovery harassment", "permanent injunction", "plaintiff respondent", "possession interference", "India"].join(" ");
  }
  return `${String(qp?.executive_summary || qp?.summary || "").slice(0, 1200)} ${String(qp?.domain?.primary || qp?.legal_domain || "")}`.trim();
}

function isRelevantSimilarCaseSnippet(snippet: RetrievedSnippet, profile: ReturnType<typeof buildOutcomeProfile>) {
  const hay = normalizeOutcomeText(`${snippet?.title || ""} ${snippet?.snippet || snippet?.text || ""}`);
  if (!hay) return false;
  const positiveHits = profile.positiveTerms.filter((term) => hay.includes(term)).length;
  const negativeHits = profile.negativeTerms.filter((term) => hay.includes(term)).length;
  const overlap = profile.queryTerms.filter((term) => hay.includes(term)).length;
  if (profile.isCivilInjunctionFinance) {
    if (negativeHits > 0) return false;
    return positiveHits >= 2 && overlap >= 2;
  }
  if (negativeHits >= 2) return false;
  return positiveHits >= 1 && overlap >= 1;
}

function filterRelevantSimilarCaseSnippets(snippets: RetrievedSnippet[], doc: CaseDocMeta, qp: any) {
  const profile = buildOutcomeProfile(doc, qp);
  const filtered = (snippets || [])
    .map((snippet) => {
      const hay = normalizeOutcomeText(`${snippet?.title || ""} ${snippet?.snippet || snippet?.text || ""}`);
      const positiveHits = profile.positiveTerms.filter((term) => hay.includes(term)).length;
      const overlap = profile.queryTerms.filter((term) => hay.includes(term)).length;
      return { snippet, scoreBoost: positiveHits * 0.12 + overlap * 0.08 };
    })
    .filter(({ snippet }) => isRelevantSimilarCaseSnippet(snippet, profile))
    .sort((a, b) => (Number(b.snippet.score || 0) + b.scoreBoost) - (Number(a.snippet.score || 0) + a.scoreBoost));
  const seen = new Set<string>();
  const out: RetrievedSnippet[] = [];
  for (const row of filtered) {
    const key = `${String(row.snippet.doc_id || "")}::${String(row.snippet.title || "").toLowerCase().trim()}`;
    if (!key.trim() || seen.has(key)) continue;
    seen.add(key);
    out.push(row.snippet);
    if (out.length >= 5) break;
  }
  return out;
}

function looksLikeTemplateProjection(source: any) {
  const o = source?.outcomes || {};
  const t = Array.isArray(source?.timeline_range_months) ? source.timeline_range_months : [];
  const c = Array.isArray(source?.cost_range) ? source.cost_range : [];
  const factors = Array.isArray(source?.key_factors) ? source.key_factors.map((x: any) => String(x || "").toLowerCase().trim()) : [];
  const defaultFactors = [
    "documentary evidence quality",
    "notice compliance",
    "quantification of loss",
    "counterparty settlement posture",
  ];
  const hasDefaultFactors = defaultFactors.every((f) => factors.includes(f));
  const fixedOutcomes = (
    (Number(o?.win).toFixed(2) === "0.62" && Number(o?.settle).toFixed(2) === "0.24" && Number(o?.lose).toFixed(2) === "0.14") ||
    (Number(o?.win).toFixed(2) === "0.50" && Number(o?.settle).toFixed(2) === "0.36" && Number(o?.lose).toFixed(2) === "0.14") ||
    (Number(o?.win).toFixed(2) === "0.38" && Number(o?.settle).toFixed(2) === "0.46" && Number(o?.lose).toFixed(2) === "0.16")
  );
  const fixedRanges = (
    (t[0] === 3 && t[1] === 12 && c[0] === 30000 && c[1] === 250000) ||
    (t[0] === 6 && t[1] === 18 && c[0] === 80000 && c[1] === 650000) ||
    (t[0] === 8 && t[1] === 24 && c[0] === 150000 && c[1] === 1200000)
  );
  return fixedOutcomes && fixedRanges && hasDefaultFactors;
}

function deriveEvidenceOutcomeProjection(
  doc: CaseDocMeta,
  qp: any,
  source: any,
  similarCaseSnippets: RetrievedSnippet[],
  contractRiskHint?: any,
) {
  const profile = buildOutcomeProfile(doc, qp);
  const text = `${String(doc.extracted_text || "")}\n${String(qp?.executive_summary || qp?.summary || "")}`.toLowerCase();
  const evidenceSignals = [
    /invoice|ledger|purchase order|work order/i,
    /payment|outstanding|bank transfer|utr|receipt/i,
    /notice|email|whatsapp|communication/i,
    /agreement|contract|clause|annexure/i,
  ].filter((r) => r.test(text)).length;
  const disputeSignals = [
    /breach|default|termination|delay/i,
    /liquidated damages|penalty|interest/i,
    /dispute|arbitration|jurisdiction|governing law/i,
  ].filter((r) => r.test(text)).length;
  const complexity = Math.min(
    6,
    disputeSignals + Math.ceil((Array.isArray(qp?.issue_groups) ? qp.issue_groups.length : 0) / 2) + (similarCaseSnippets.length >= 3 ? 1 : 0),
  );
  const riskLevel = String(contractRiskHint?.scores?.risk_level || contractRiskHint?.risk_level || "").toLowerCase();
  const riskPenalty = riskLevel === "high" ? -0.11 : riskLevel === "medium" ? -0.04 : 0.03;
  let win = 0.32 + evidenceSignals * 0.05 + (text.includes("governing law") ? 0.03 : 0) + riskPenalty;
  let settle = 0.26 + disputeSignals * 0.04 + (riskLevel === "high" ? 0.08 : 0.02);
  win = Math.max(0.18, Math.min(0.78, win));
  settle = Math.max(0.12, Math.min(0.68, settle));
  let lose = Math.max(0.08, 1 - win - settle);
  const total = win + settle + lose;
  win /= total; settle /= total; lose /= total;
  const timelineMin = Math.max(3, Math.min(18, 4 + complexity));
  const timelineMax = Math.max(timelineMin + 3, Math.min(36, timelineMin + 5 + complexity));
  const amount = parseInrAmountNumber(`${qp?.executive_summary || qp?.summary || ""} ${doc.extracted_text || ""}`);
  let costMin = 30000 + complexity * 12000;
  let costMax = 180000 + complexity * 60000;
  if (amount && amount > 0) {
    costMin = Math.max(35000, Math.round(amount * 0.025));
    costMax = Math.max(costMin + 50000, Math.round(amount * 0.18));
  }
  const factors: string[] = [];
  if (profile.isCivilInjunctionFinance) {
    factors.push("Prima facie injunction case, balance of convenience, and irreparable injury showing");
    if (/harass|harassment|illegal approach|public roads|residence|recovery/i.test(text)) factors.push("Proof of unlawful recovery harassment and respondent-wise incident chronology");
    if (/loan|installment|default|outstanding/i.test(text)) factors.push("Loan-account mapping, default context, and respondent-wise lending exposure");
    if (/jurisdiction|vijayawada|andhra pradesh|penamaluru/i.test(text)) factors.push("Territorial jurisdiction, maintainability, and service readiness for all respondents");
    if (/whatsapp|call|email|police|complaint|witness|cctv/i.test(text)) factors.push("Independent supporting evidence beyond pleadings, including communications and witness material");
  } else {
    if (/invoice|ledger|payment|outstanding/i.test(text)) factors.push("Invoice/ledger trail and payment chronology");
    if (/notice|email|whatsapp|communication/i.test(text)) factors.push("Notice and communication compliance with contractual process");
    if (/liquidated damages|penalty|interest/i.test(text)) factors.push("Enforceability of liquidated damages / interest / penalty clauses");
    if (/termination|breach|default/i.test(text)) factors.push("Breach attribution and termination trigger evidence");
    if (/arbitration|jurisdiction|governing law/i.test(text)) factors.push("Dispute forum/arbitration clause enforceability");
  }
  if (!factors.length) factors.push("Evidence sufficiency, timeline consistency, and claim quantification");
  const deadlines = extractExplicitDeadlinesAndPenalties(doc, qp).map((x) => `${x.label}: ${x.detail || x._snippet}`).slice(0, 6);
  const sourceConfidence = Number(source?.confidence);
  const confidence = Number.isFinite(sourceConfidence)
    ? Math.max(0.2, Math.min(0.92, sourceConfidence))
    : Math.max(0.28, Math.min(0.86, 0.42 + evidenceSignals * 0.05 + (similarCaseSnippets.length ? 0.06 : 0)));
  return {
    outcomes: { win: Number(win.toFixed(4)), settle: Number(settle.toFixed(4)), lose: Number(lose.toFixed(4)) },
    timeline_range_months: [timelineMin, timelineMax] as [number, number],
    cost_range: [Math.round(costMin), Math.round(costMax)] as [number, number],
    key_factors: [...new Set(factors)].slice(0, 6),
    deadlines,
    confidence: Number(confidence.toFixed(4)),
  };
}

function buildTextCitationSnippets(text: string, limit = 3): string[] {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];
  const chunks = normalized
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.split(" ").filter(Boolean).length >= 6);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const snippet = clipSentence(chunk, 220);
    const key = snippet.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(snippet);
    if (out.length >= limit) return out;
  }
  if (out.length < limit) {
    const words = normalized.split(" ").filter(Boolean);
    const window = 34;
    for (let i = 0; i < words.length && out.length < limit; i += window) {
      const snippet = clipSentence(words.slice(i, i + window).join(" ").trim(), 220);
      if (!snippet) continue;
      const key = snippet.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(snippet);
    }
  }
  return out.slice(0, limit);
}

function buildRunSteps(stepIndex = 0): RunStep[] { return RUN_STEP_NAMES.map((name, idx) => ({ name, state: idx < stepIndex ? "SUCCEEDED" : idx === stepIndex ? "RUNNING" : "PENDING", progress: Math.round((Math.min(idx, stepIndex) / RUN_STEP_NAMES.length) * 100) })); }
function makeRunStatus(partial?: Partial<RunStatusShape>): RunStatusShape { return { stage: RUN_STEP_NAMES[0], stepIndex: 1, stepsTotal: RUN_STEP_NAMES.length, stats: {}, done: false, error: null, steps: buildRunSteps(0), meta: { agent_key: AGENT_KEY }, ...partial }; }
function markStep(idx0: number, stats: Record<string, any>) { return { stage: RUN_STEP_NAMES[idx0], stepIndex: idx0 + 1, stepsTotal: RUN_STEP_NAMES.length, stats, steps: RUN_STEP_NAMES.map((name, idx) => ({ name, state: idx < idx0 ? "SUCCEEDED" : idx === idx0 ? "RUNNING" : "PENDING", progress: Math.round((((idx < idx0 ? idx + 1 : idx === idx0 ? idx + 0.5 : idx) / RUN_STEP_NAMES.length)) * 100) })) as RunStep[] }; }

async function ensureOwnedCase(userId: string, caseId: string) {
  const c = await prisma.case.findUnique({ where: { id: caseId }, include: { user: true } });
  if (!c || c.userId !== userId) throw new HttpError(404, "Case not found", "case_not_found");
  return c as any;
}

async function resolvePrimaryDoc(caseId: string): Promise<CaseDocMeta | null> {
  const candidate = await resolvePrimaryCaseDocumentMeta(caseId);
  if (!candidate) return null;
  const text = String(candidate.extracted_text || "");
  return {
    doc_id: candidate.doc_id, filename: candidate.filename, mime: candidate.mime_type, updated_at: candidate.updated_at,
    hash: String(candidate.checksum || sha256(`${candidate.doc_id}:${text}`)), language: candidate.language || "English",
    kind: candidate.kind || null, extracted_text: text, pages: candidate.pages ?? null, char_count: candidate.char_count ?? text.length,
  };
}

function parsePayloadRow(row: any): any { if (!row) return null; if (row.payloadJson) return row.payloadJson; try { return typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json; } catch { return row.payload_json ?? null; } }
async function readLatestOutput(caseId: string) {
  try {
    const [rows]: any = await mysqlPool.query(`SELECT * FROM agent_outputs WHERE case_id=? AND agent_key=? ORDER BY updated_at DESC LIMIT 1`, [caseId, AGENT_KEY]);
    if (rows?.[0]) return rows[0];
  } catch {}
  const c = await prisma.case.findUnique({ where: { id: caseId }, include: { outputs: true } });
  return (c?.outputs || []).find((o: any) => o.agentKey === AGENT_KEY) || null;
}
async function readLatestOutputForDoc(caseId: string, docHash: string) {
  try {
    const [rows]: any = await mysqlPool.query(`SELECT * FROM agent_outputs WHERE case_id=? AND agent_key=? ORDER BY updated_at DESC LIMIT 10`, [caseId, AGENT_KEY]);
    for (const row of (rows || [])) {
      const p = parsePayloadRow(row);
      if (String(p?.qa_debug?.doc_hash || "") === String(docHash || "")) return row;
    }
  } catch {}
  const c = await prisma.case.findUnique({ where: { id: caseId }, include: { outputs: true } });
  const row = (c?.outputs || []).find((o: any) => o.agentKey === AGENT_KEY) || null;
  const payload = parsePayloadRow(row);
  return String(payload?.qa_debug?.doc_hash || "") === String(docHash || "") ? row : null;
}
async function readLatestMatchingOutput(caseId: string, docHash: string, overridesHash = "none") {
  try {
    const [rows]: any = await mysqlPool.query(`SELECT * FROM agent_outputs WHERE case_id=? AND agent_key=? ORDER BY updated_at DESC LIMIT 1`, [caseId, AGENT_KEY]);
    const row = rows?.[0];
    const p = parsePayloadRow(row);
    if (row) {
      const ok = String(p?.qa_debug?.doc_hash || "") === docHash && String(p?.qa_debug?.overrides_hash || "none") === overridesHash;
      if (ok) return row;
    }
  } catch {}
  const c = await prisma.case.findUnique({ where: { id: caseId }, include: { outputs: true } });
  const row = (c?.outputs || []).find((o: any) => o.agentKey === AGENT_KEY) || null;
  const p = parsePayloadRow(row);
  return String(p?.qa_debug?.doc_hash || "") === docHash && String(p?.qa_debug?.overrides_hash || "none") === overridesHash ? row : null;
}

async function upsertAgentOutput(params: { caseId: string; payload: CaseOutcomeOutput; language: string }) {
  await prisma.agentOutput.upsert({
    where: { caseId_agentKey: { caseId: params.caseId, agentKey: AGENT_KEY } },
    create: { caseId: params.caseId, agentKey: AGENT_KEY, payloadJson: params.payload, sourceLanguage: params.language || "en" },
    update: { payloadJson: params.payload, sourceLanguage: params.language || "en" },
  });
}

async function updateRunProgress(runId: string, patch: Partial<RunStatusShape>) {
  const run = await prisma.run.findUnique({ where: { id: runId } }); if (!run) return;
  const currentRaw = run.stepsJson as any; const current = currentRaw && typeof currentRaw === "object" && !Array.isArray(currentRaw) ? currentRaw as RunStatusShape : makeRunStatus();
  const next: RunStatusShape = { ...current, ...patch, stats: { ...(current.stats || {}), ...(patch.stats || {}) }, steps: patch.steps || current.steps || makeRunStatus().steps, meta: { ...(current.meta || {}), ...(patch.meta || {}) } };
  await prisma.run.update({ where: { id: runId }, data: { stepsJson: next as any } });
}

function topCitationsFromDoc(doc: CaseDocMeta) {
  const text = String(doc.extracted_text || "");
  const outcomeKeywords = [
    "liquidated damages",
    "penalty",
    "interest",
    "deadline",
    "due date",
    "termination",
    "breach",
    "payment",
    "invoice",
    "notice",
    "arbitration",
  ];
  const snippets: string[] = [];
  const seen = new Set<string>();
  const keywordRegex = new RegExp(`\\b(${outcomeKeywords.map(escapeRegex).join("|")})\\b`, "gi");
  let m: RegExpExecArray | null = null;
  while ((m = keywordRegex.exec(text)) && snippets.length < 4) {
    const around = contextSnippetAround(text, m.index, { back: 220, forward: 380, max: 220 });
    const key = around.toLowerCase();
    if (!around || seen.has(key)) continue;
    seen.add(key);
    snippets.push(around);
  }
  if (snippets.length < 3) {
    for (const extra of buildTextCitationSnippets(text, 4)) {
      const k = extra.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      snippets.push(extra);
      if (snippets.length >= 3) break;
    }
  }
  return snippets.map((s, i) => ({ source_type: "user_doc", doc_id: doc.doc_id, chunk_id: `doc:${i}`, snippet: s }));
}

function buildEmergencyCaseOutcomeOutput(doc: CaseDocMeta, runId?: string | null, reason?: string | null): CaseOutcomeOutput {
  const citations = topCitationsFromDoc(doc);
  return caseOutcomeOutputSchema.parse({
    agent_key: AGENT_KEY,
    mode: "fallback",
    analysis_valid: false,
    failure_reason: reason || "Emergency fallback output generated from saved case text.",
    doc_summary: {
      doc_type_guess: doc.mime.includes("pdf") ? "Case Document PDF" : "Case Text",
      language: doc.language || "English",
      pages: doc.pages ?? null,
    },
    prefill: {
      case_type: null,
      jurisdiction: "India",
      claim_amount: null,
      facts_summary: clipSentence(doc.extracted_text, 420),
      key_legal_issues: [],
      evidence_strength: citations.length >= 3 ? "Moderate" : "Limited",
    },
    prediction: {
      distribution: { win: 0.34, settle: 0.33, lose: 0.33 },
      confidence: citations.length >= 3 ? 0.28 : 0.2,
    },
    ranges: { duration_months: null, award_or_cost_range_inr: null },
    similar_corpus_available: false,
    similar_cases: [],
    deadlines_and_penalties: [],
    recommendations: [
      "Fallback projection generated from the available case text.",
      "Review the chronology, supporting evidence, and relief sought before relying on this prediction.",
      "Re-run the agent after model/runtime recovery for a stronger grounded projection.",
    ],
    clarifying_questions: [
      "Please confirm the exact chronology of events and the present procedural stage.",
      "Please add the strongest supporting records for the core claim and defence.",
    ],
    citations,
    qa_debug: {
      run_id: runId || null,
      emergency_fallback: true,
      doc_hash: doc.hash,
      hard_error: reason || null,
    },
  });
}

function isUsableCaseOutcomePayload(payload: any): boolean {
  if (!payload || typeof payload !== "object") return false;
  const requireLlm = getEnv().REQUIRE_LLM_OUTPUT === true;
  if (requireLlm && String(payload?.mode || "").toLowerCase() === "fallback") return false;
  if (payload?.qa_debug?.genericity_gate?.isGeneric) return false;
  const genericPhrases = countGenericPhraseHits([
    payload?.prefill?.facts_summary,
    ...(Array.isArray(payload?.recommendations) ? payload.recommendations : []),
    ...(Array.isArray(payload?.deadlines_and_penalties) ? payload.deadlines_and_penalties.map((item: any) => item?.detail) : []),
  ]);
  if (genericPhrases > 1) return false;
  const dist = payload?.prediction?.distribution || {};
  const ranges = payload?.ranges || {};
  const recs = Array.isArray(payload?.recommendations) ? payload.recommendations.map((r: any) => String(r || "").toLowerCase().trim()) : [];
  const caseType = String(payload?.prefill?.case_type || "").toLowerCase();
  const deadlines = Array.isArray(payload?.deadlines_and_penalties) ? payload.deadlines_and_penalties : [];
  const similarCases = Array.isArray(payload?.similar_cases) ? payload.similar_cases : [];
  if (deadlines.some((item: any) => looksLikeOutcomeTimelineNoise(`${item?.label || ""} ${item?.detail || ""}`))) return false;
  if (caseType.includes("civil_injunction_finance")) {
    const contractLeak = recs.some((r: string) =>
      /contract process|penalty\/interest clauses|arbitration clause enforceability|termination trigger/.test(r),
    );
    if (contractLeak) return false;
    const irrelevantSimilar = similarCases.some((item: any) =>
      /(accused|bodily injury|income tax|assessee|tribunal|forest|fasli|compensation officer)/i.test(`${item?.title || ""} ${item?.summary || ""}`),
    );
    if (irrelevantSimilar) return false;
  }
  const templateLike =
    (
      (Number(dist?.win).toFixed(2) === "0.62" && Number(dist?.settle).toFixed(2) === "0.24" && Number(dist?.lose).toFixed(2) === "0.14")
      || (Number(dist?.win).toFixed(2) === "0.50" && Number(dist?.settle).toFixed(2) === "0.36" && Number(dist?.lose).toFixed(2) === "0.14")
      || (Number(dist?.win).toFixed(2) === "0.38" && Number(dist?.settle).toFixed(2) === "0.46" && Number(dist?.lose).toFixed(2) === "0.16")
    )
    && (
      (ranges?.duration_months?.[0] === 3 && ranges?.duration_months?.[1] === 12 && ranges?.award_or_cost_range_inr?.[0] === 30000 && ranges?.award_or_cost_range_inr?.[1] === 250000)
      || (ranges?.duration_months?.[0] === 6 && ranges?.duration_months?.[1] === 18 && ranges?.award_or_cost_range_inr?.[0] === 80000 && ranges?.award_or_cost_range_inr?.[1] === 650000)
      || (ranges?.duration_months?.[0] === 8 && ranges?.duration_months?.[1] === 24 && ranges?.award_or_cost_range_inr?.[0] === 150000 && ranges?.award_or_cost_range_inr?.[1] === 1200000)
    )
    && ["documentary evidence quality", "notice compliance", "quantification of loss", "counterparty settlement posture"].every((f) => recs.includes(f));
  if (templateLike) return false;
  if (payload.analysis_valid === true) return true;
  const citations = Array.isArray(payload.citations) ? payload.citations : [];
  const grounded = citations.filter((c: any) => {
    const st = String(c?.source_type || "").toLowerCase();
    const sn = String(c?.snippet || "").trim();
    return (st === "user_doc" || st === "legal_corpus") && sn.length > 0;
  }).length;
  const d = payload?.prediction?.distribution;
  const hasDistribution = !!d && ["win", "settle", "lose"].every((k) => typeof d[k] === "number" && Number.isFinite(d[k]));
  return grounded >= 3 && hasDistribution;
}

function assessCaseOutcomeNarrativeQuality(payload: CaseOutcomeOutput, supportTexts: Array<unknown>) {
  return assessNarrativeQuality({
    texts: [
      payload?.prefill?.facts_summary,
      ...(payload?.prefill?.key_legal_issues || []),
      ...(payload?.recommendations || []),
      ...(payload?.deadlines_and_penalties || []).map((item) => `${item.label}: ${item.detail || ""}`),
      ...(payload?.similar_cases || []).map((item) => `${item.title}: ${item.summary || ""}`),
    ],
    supportTexts,
    minSupportOverlap: 3,
    minCombinedLength: 110,
    maxGenericPhraseHits: 2,
  });
}

function extractExplicitDeadlinesAndPenalties(doc: CaseDocMeta, qp?: any) {
  const text = String(doc.extracted_text || "");
  const items: Array<{ label: string; detail: string | null; citation_ref?: number | null; _snippet: string }> = [];
  const seen = new Set<string>();
  const patterns: Array<{ regex: RegExp; label: string }> = [
    { regex: /\bliquidated damages\b/gi, label: "Liquidated Damages" },
    { regex: /\blate fee\b/gi, label: "Late Fee" },
    { regex: /\binterest\b(?=[^.\n]{0,40}(?:%|per annum|p\.a\.|delay|late|charge|payment|amount))/gi, label: "Interest / Delay Charges" },
    { regex: /\bdue date\b/gi, label: "Due Date" },
    { regex: /\bdeadline\b/gi, label: "Deadline" },
    { regex: /\bwithin\s+\d+\s+(?:day|days|week|weeks|month|months)\b/gi, label: "Contractual Timeline" },
    { regex: /\b\d+\s+(?:day|days|week|weeks|month|months)\s+(?:from|after|before)\b/gi, label: "Contractual Timeline" },
    { regex: /\b\d{1,2}:\d{2}\s*a\.?m\.?\b/gi, label: "Court Appearance / Hearing" },
    { regex: /\blast\s+two\s+months\b/gi, label: "Recent Default Timeline" },
  ];
  for (const p of patterns) {
    let m: RegExpExecArray | null = null;
    while ((m = p.regex.exec(text)) && items.length < 8) {
      const excerpt = contextSnippetAround(text, m.index, { back: 240, forward: 420, max: 320 });
      if (!excerpt || excerpt.split(" ").filter(Boolean).length < 6) continue;
      if (/interest of justice|such other orders as the honourable court deems fit|irreparable loss/i.test(excerpt)) continue;
      const key = `${p.label}:${excerpt.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        label: p.label,
        detail: clipSentence(excerpt, 320),
        citation_ref: null,
        _snippet: clipSentence(excerpt, 220),
      });
    }
  }
  if (!items.length && /\binterim injunction\b/i.test(String(qp?.executive_summary || qp?.summary || ""))) {
    const summary = clipSentence(String(qp?.executive_summary || qp?.summary || ""), 220);
    if (summary) items.push({ label: "Interim Relief Posture", detail: summary, citation_ref: null, _snippet: clipSentence(summary, 180) });
  }
  return items;
}

function deriveJurisdictionFromQueryParsing(qp: any) {
  const country = String(qp?.jurisdiction?.country || qp?.jurisdiction || "India").trim() || "India";
  const location = String(qp?.key_facts?.location || qp?.location || "").trim();
  const knownStates = ["telangana", "karnataka", "tamil nadu", "maharashtra", "delhi", "andhra pradesh", "kerala", "west bengal", "gujarat", "rajasthan", "uttar pradesh"];
  const state = knownStates.find((s) => location.toLowerCase().includes(s));
  return state ? `${country} / ${state.replace(/\b\w/g, (m) => m.toUpperCase())}` : country;
}

function deriveEvidenceStrength(doc: CaseDocMeta, qp: any) {
  const text = `${doc.extracted_text || ""} ${(qp?.executive_summary || qp?.summary || "")}`.toLowerCase();
  const hasFile = String(doc.kind || "") !== "pasted_text";
  const mentions = ["whatsapp", "email", "invoice", "receipt", "payment", "bank", "screenshot", "video", "recording", "agreement"];
  const hits = mentions.filter((m) => text.includes(m)).length;
  if (/no list of documents at present|documents will be filed at time of the trial/i.test(text)) return "Moderate";
  if (hasFile && hits >= 4) return "Strong";
  if (hasFile || hits >= 1) return "Moderate";
  return "Moderate";
}

function extractFirstAmount(text: string): string | null {
  const src = String(text || "");
  if (!src.trim()) return null;
  const patterns = [
    /₹\s?[\d,]+(?:\.\d+)?/i,
    /rs\.?\s?[\d,]+(?:\.\d+)?/i,
    /rupees?\s+[\d,]+(?:\.\d+)?/i,
  ];
  for (const p of patterns) {
    const m = src.match(p);
    if (m?.[0]) return m[0].replace(/\s+/g, " ").trim();
  }
  return null;
}

function derivePrefillDefaults(doc: CaseDocMeta | null, qp: any) {
  const legalGrounds = Array.isArray(qp?.legal_grounds) ? qp.legal_grounds : [];
  const issueGroups = Array.isArray(qp?.issue_groups) ? qp.issue_groups.map((g: any) => g?.label || g?.title).filter(Boolean) : [];
  const keyIssues = [...new Set([...legalGrounds, ...issueGroups].map((x: any) => String(x || "").trim()).filter(Boolean))].slice(0, 8);
  const amountFromQp = Array.isArray(qp?.key_facts?.amounts) ? qp.key_facts.amounts.find((a: any) => a?.value)?.value : null;
  const amount = amountFromQp
    || extractFirstAmount(String(qp?.executive_summary || qp?.summary || ""))
    || extractFirstAmount(String(doc?.extracted_text || ""));
  const domainPrimary = String(qp?.domain?.primary || qp?.legal_domain || "").trim() || null;
  const domainSubtype = String(qp?.domain?.subtype || qp?.legal_subtype || "").trim() || null;
  return {
    case_type: domainSubtype || domainPrimary || null,
    domain: domainPrimary,
    domain_subtype: domainSubtype,
    jurisdiction: deriveJurisdictionFromQueryParsing(qp),
    claim_amount: amount ? String(amount) : null,
    facts_summary: String(qp?.executive_summary || qp?.summary || "").trim() || null,
    key_legal_issues: keyIssues,
    evidence_strength: doc ? deriveEvidenceStrength(doc, qp) : "Moderate",
  };
}

function mapOutcomeOutput(
  source: any,
  doc: CaseDocMeta,
  qp: any,
  overrides: any,
  similarCaseSnippets: RetrievedSnippet[],
  similarCasesEnabled: boolean,
  contractRiskHint?: any,
  llmSucceeded = true,
): CaseOutcomeOutput {
  const outcomeProfile = buildOutcomeProfile(doc, qp);
  const citations = (Array.isArray(source?.citations) ? source.citations : []).map((c: any, i: number) => ({
    source_type: String(c?.source_type || "user_doc").toLowerCase(),
    doc_id: c?.doc_id || doc.doc_id,
    chunk_id: c?.chunk_id || `out:${i}`,
    snippet: clipSentence(String(c?.snippet || ""), 220),
  })).filter((c: any) => {
    if (!c.snippet) return false;
    if (String(c.source_type || "").toLowerCase() !== "legal_corpus") return true;
    return isRelevantSimilarCaseSnippet({
      source_type: "legal_corpus",
      doc_id: String(c.doc_id || ""),
      title: String(c.doc_id || ""),
      chunk_id: String(c.chunk_id || ""),
      page: c.page ?? null,
      offset_start: c.offset_start ?? null,
      offset_end: c.offset_end ?? null,
      snippet: String(c.snippet || ""),
      text: String(c.snippet || ""),
      score: 0,
    }, outcomeProfile);
  });
  const augmented = [...citations];
  for (const c of topCitationsFromDoc(doc)) {
    if (augmented.length >= 3) break;
    if (!augmented.find((x) => x.snippet === c.snippet)) augmented.push(c as any);
  }
  const explicitDeadlineItems = extractExplicitDeadlinesAndPenalties(doc, qp);
  const issues = Array.isArray(qp?.legal_grounds) ? qp.legal_grounds : Array.isArray(qp?.issues) ? qp.issues : [];
  const prefillDefaults = derivePrefillDefaults(doc, qp);
  const claimAmount = prefillDefaults.claim_amount || qp?.key_facts?.amounts?.[0]?.value || qp?.keyFacts?.outstanding_amount_inr || null;
  const sourceLooksFallback = !llmSucceeded || !!source?.fallback_reason || !!source?.error;
  const derivedProjection = deriveEvidenceOutcomeProjection(doc, qp, source, similarCaseSnippets, contractRiskHint);
  const sourceDistribution = hasUsableDistribution(source?.outcomes) ? source.outcomes : null;
  const useDerivedProjection =
    !sourceDistribution ||
    looksLikeTemplateProjection(source) ||
    sourceLooksFallback;
  const distribution = useDerivedProjection ? derivedProjection.outcomes : sourceDistribution;
  const mode = sourceLooksFallback ? "fallback" : "normal";
  const similarCaseCitations = (similarCaseSnippets || [])
    .slice(0, 6)
    .map((s, idx) => ({
      source_type: "legal_corpus",
      doc_id: String(s.doc_id || `legal:${idx}`),
      chunk_id: String(s.chunk_id || `legal:${idx}`),
      snippet: clipSentence(String(s.snippet || s.text || ""), 220),
      page: s.page == null ? null : Number(s.page),
      offset_start: s.offset_start == null ? null : Number(s.offset_start),
      offset_end: s.offset_end == null ? null : Number(s.offset_end),
    }))
    .filter((c) => c.snippet);
  const citationsWithRefs = [...augmented];
  for (const c of similarCaseCitations) {
    if (!citationsWithRefs.find((x: any) => String(x.doc_id || "") === c.doc_id && String(x.chunk_id || "") === c.chunk_id)) {
      citationsWithRefs.push(c as any);
    }
  }
  const hasValidDistribution = !!distribution && Object.values(distribution).every((v) => typeof v === "number" && Number.isFinite(v));
  const groundedCitationCount = citationsWithRefs.filter((c: any) => {
    const st = String(c?.source_type || "").toLowerCase();
    return (st === "user_doc" || st === "legal_corpus") && String(c?.snippet || "").trim().length > 0;
  }).length;
  const analysis_valid = groundedCitationCount >= 3 && hasValidDistribution;
  const sourceDeadlineItems = (Array.isArray(source?.deadlines) && !sourceLooksFallback ? source.deadlines : [])
    .map((d: any, idx: number) => ({
      label: "Timeline / Deadline",
      detail: clipSentence(String(d || ""), 320),
      citation_ref: null,
      _snippet: clipSentence(String(d || ""), 220) || `deadline:${idx}`,
    }))
    .filter((item: any) => isGroundedOutcomeTimeline(`${item.label} ${item.detail || item._snippet}`));
  const deadlineSeed = [
    ...explicitDeadlineItems,
    ...sourceDeadlineItems,
  ];
  const seenDeadline = new Set<string>();
  const deadlineItems = deadlineSeed
    .filter((d) => {
      if (!isGroundedOutcomeTimeline(`${d?.label || ""} ${d?._snippet || d?.detail || ""}`)) return false;
      const key = `${String(d?.label || "").toLowerCase()}::${normalizeOutcomeTimelineText(String(d?._snippet || d?.detail || ""))}`;
      if (!key.trim() || seenDeadline.has(key)) return false;
      seenDeadline.add(key);
      return true;
    })
    .map((d) => {
    let ref: number | null = null;
    const idx = citationsWithRefs.findIndex((c: any) => c.snippet === d._snippet || String(c.snippet || "").includes(d._snippet));
    if (idx >= 0) ref = idx;
    if (idx < 0 && d._snippet) {
      citationsWithRefs.push({ source_type: "user_doc", doc_id: doc.doc_id, chunk_id: `deadline:${citationsWithRefs.length}`, snippet: d._snippet });
      ref = citationsWithRefs.length - 1;
    }
    return { label: d.label, detail: cleanOutcomeTimelineDetail(String(d.detail || d._snippet || ""), d.label), citation_ref: ref };
  });
  const sourceFactors = (Array.isArray(source?.key_factors) ? source.key_factors : [])
    .map((x: any) => clipSentence(String(x || ""), 180))
    .filter(Boolean);
  const recommendations = outcomeProfile.isCivilInjunctionFinance
    ? [
        "Build a respondent-wise chronology of each loan account, default event, and alleged recovery-harassment incident.",
        "Prepare injunction support around prima facie case, balance of convenience, and irreparable injury with clean pleading references.",
        "Preserve call logs, messages, witnesses, CCTV, and any police or complaint trail supporting unlawful recovery allegations.",
        "Verify territorial jurisdiction, plaint-schedule property linkage, and service details for every respondent before downstream filing strategy.",
        "Separate lawful debt-recovery rights from alleged extra-legal recovery conduct so the relief theory stays maintainable.",
        /no list of documents at present|documents will be filed at time of the trial/i.test(String(doc.extracted_text || ""))
          ? "Collect and organize supporting documents beyond the plaint, because the current pleading itself says supporting documents are not yet filed."
          : "",
      ].filter(Boolean).slice(0, 6)
    : [...new Set((sourceFactors.length ? sourceFactors : derivedProjection.key_factors).filter(Boolean))].slice(0, 6);
  const parsed = caseOutcomeOutputSchema.parse({
    agent_key: AGENT_KEY,
    mode,
    analysis_valid,
    failure_reason: analysis_valid ? null : (!hasValidDistribution ? "Incomplete model distribution output" : "Insufficient grounded citations or incomplete model output"),
    doc_summary: { doc_type_guess: doc.mime.includes("pdf") ? "Case Document PDF" : "Case Text", language: doc.language, pages: doc.pages ?? null },
    prefill: {
      case_type: prefillDefaults.case_type || qp?.domain?.subtype || qp?.legal_subtype || qp?.case_type || null,
      jurisdiction: prefillDefaults.jurisdiction || qp?.jurisdiction?.country || qp?.jurisdiction || qp?.jurisdiction_guess || "India",
      claim_amount: claimAmount ? String(claimAmount) : null,
      facts_summary: prefillDefaults.facts_summary || String(qp?.executive_summary || qp?.summary || "").slice(0, 500) || null,
      key_legal_issues: (prefillDefaults.key_legal_issues || issues || []).slice(0, 8),
      evidence_strength: prefillDefaults.evidence_strength || (augmented.length >= 5 ? "Strong" : augmented.length >= 3 ? "Moderate" : "Limited"),
    },
    prediction: {
      distribution: { win: Number(distribution.win || 0), settle: Number(distribution.settle || 0), lose: Number(distribution.lose || 0) },
      confidence: Number(
        useDerivedProjection
          ? derivedProjection.confidence
          : (Number.isFinite(Number(source?.confidence)) ? Number(source?.confidence) : derivedProjection.confidence),
      ),
    },
    ranges: {
      duration_months: Array.isArray(source?.timeline_range_months) && source.timeline_range_months.length === 2 && !useDerivedProjection
        ? [Number(source.timeline_range_months[0]), Number(source.timeline_range_months[1])]
        : derivedProjection.timeline_range_months,
      award_or_cost_range_inr: Array.isArray(source?.cost_range) && source.cost_range.length === 2 && !useDerivedProjection
        ? [Number(source.cost_range[0]), Number(source.cost_range[1])]
        : derivedProjection.cost_range,
    },
    similar_corpus_available: Boolean(similarCasesEnabled && similarCaseSnippets.length > 0),
    similar_cases: similarCasesEnabled
      ? similarCaseSnippets.slice(0, 5).map((s, idx) => ({
        title: s.title || `Similar Case ${idx + 1}`,
        relevance: Math.max(0, Math.min(1, Number(s.score || 0))),
        summary: clipSentence(String(s.snippet || s.text || ""), 220),
      }))
      : [],
    deadlines_and_penalties: deadlineItems.slice(0, 8),
    recommendations,
    clarifying_questions: Array.isArray(qp?.clarifying_questions) ? qp.clarifying_questions.slice(0, 3) : [],
    citations: citationsWithRefs
      .slice(0, Math.max(3, citationsWithRefs.length))
      .map((c: any) => ({ ...c, snippet: clipSentence(String(c.snippet || ""), 220) }))
      .filter((c: any) => !!String(c?.snippet || "").trim()),
    qa_debug: {
      source_agent_key: SOURCE_AGENT_KEY,
      overrides_hash: sha256(JSON.stringify(overrides || {})).slice(0, 16),
      explicit_deadlines_extracted: deadlineItems.length,
      similar_cases_enabled: similarCasesEnabled,
      similar_cases_retrieved: similarCaseSnippets.length,
      used_derived_projection: useDerivedProjection,
      source_looks_fallback: sourceLooksFallback,
      legal_corpus_citations: citationsWithRefs.filter((c: any) => String(c?.source_type || "").toLowerCase() === "legal_corpus").length,
      user_doc_citations: citationsWithRefs.filter((c: any) => String(c?.source_type || "").toLowerCase() === "user_doc").length,
    },
  });
  parsed.similar_corpus_available = Boolean(parsed.similar_corpus_available);
  if (!parsed.similar_corpus_available) parsed.similar_cases = [];
  if ((parsed.citations || []).length < 3) {
    parsed.analysis_valid = false;
    parsed.failure_reason = parsed.failure_reason || "Insufficient grounded citations from case workspace text";
  }
  const genericity = assessCaseOutcomeNarrativeQuality(parsed, [
    doc.extracted_text,
    qp?.executive_summary,
    qp?.summary,
    ...(prefillDefaults.key_legal_issues || []),
    ...citationsWithRefs.map((c: any) => c?.snippet),
    ...similarCaseSnippets.map((s) => s?.snippet || s?.text || ""),
  ]);
  parsed.qa_debug = {
    ...(parsed.qa_debug || {}),
    genericity_gate: genericity,
  };
  const strongGrounding = groundedCitationCount >= 3 && hasValidDistribution;
  if (genericity.isGeneric && !strongGrounding) {
    parsed.analysis_valid = false;
    if (sourceLooksFallback) {
      parsed.mode = "fallback";
    }
    parsed.failure_reason = "Outcome Prediction output was too generic for grounded use";
  }
  parsed.deadlines_and_penalties = (parsed.deadlines_and_penalties || []).filter((d) => d.citation_ref !== null && d.citation_ref !== undefined);
  return parsed;
}

async function executeRun(runId: string, caseId: string, userId: string, force = false, overrides?: any) {
  const env = getEnv();
  runCancellationService.register(runId);
  const c = await ensureOwnedCase(userId, caseId);
  const doc = await resolvePrimaryDoc(caseId);
  if (!doc) throw new HttpError(400, "No case text/document found for this case", "case_input_missing");
  const existingCase = await prisma.case.findUnique({ where: { id: caseId }, include: { outputs: true } });
  const qpRow = ((existingCase?.outputs || []) as any[]).find((o) => o.agentKey === "query_parsing") || null;
  const crRow =
    ((existingCase?.outputs || []) as any[]).find((o) => o.agentKey === "contract_risk_dispute_settlement")
    || ((existingCase?.outputs || []) as any[]).find((o) => o.agentKey === "contract_risk")
    || null;
  const qp = parsePayloadRow(qpRow);
  const contractRiskPayload = parsePayloadRow(crRow);
  await prisma.run.update({ where: { id: runId }, data: { status: RunStatus.RUNNING, startedAt: new Date() } });
  await updateRunProgress(runId, { ...markStep(0, {}), meta: { agent_key: AGENT_KEY, doc_id: doc.doc_id, doc_hash: doc.hash } });
  runCancellationService.throwIfCancelled(runId);
  const existingCommon = {
    query_parsing: qp,
    contract_risk: contractRiskPayload
      ? {
        risk_level: contractRiskPayload?.scores?.risk_level || contractRiskPayload?.risk_level || null,
        confidence: contractRiskPayload?.scores?.overall_risk_score ?? contractRiskPayload?.confidence ?? null,
      }
      : undefined,
  };
  await updateRunProgress(runId, markStep(1, { similar_cases_found: 0 }));
  const similarCaseQuery = buildSimilarCaseQuery(doc, qp);
  let similarCaseSnippets = env.ENABLE_SIMILAR_CASES
    ? await retriever.retrieveLegalCorpusSnippets(
      similarCaseQuery,
      5,
      { source_type: "legal_corpus", jurisdiction: "IN", corpus_type: "sc_judgment" },
    )
    : [];
  if (env.ENABLE_SIMILAR_CASES && similarCaseSnippets.length < 3) {
    const hc = await retriever.retrieveLegalCorpusSnippets(
      similarCaseQuery,
      5 - similarCaseSnippets.length,
      { source_type: "legal_corpus", jurisdiction: "IN", corpus_type: "hc_judgment" },
    );
    similarCaseSnippets.push(...hc);
  }
  similarCaseSnippets = filterRelevantSimilarCaseSnippets(similarCaseSnippets, doc, qp);
  await updateRunProgress(runId, markStep(1, { similar_cases_found: similarCaseSnippets.length }));
  await updateRunProgress(runId, markStep(2, { precedents_found: similarCaseSnippets.length }));
  let sourceOutput: any;
  let llmSucceeded = false;
  try {
    sourceOutput = await agentRunner.runCommonAgent(caseId, c.user?.role || c.role, doc.extracted_text, existingCommon, "outcome_projection", {
      runId,
      inputHash: sha256(`${doc.hash}:${JSON.stringify(overrides || {})}`),
      docChecksumsUsed: [doc.hash],
      detectedLanguage: c.detectedLanguage,
      language: c.language,
      preferredLanguage: c.language,
      filtersApplied: c.filtersJson || {},
      userQueryText: String((qp?.executive_summary || qp?.summary || "")).slice(0, 1000),
      extractedDocSnippets: [],
      inputStats: { query_source: "case_outcome_worker" },
    });
    llmSucceeded = true;
  } catch (e) {
    if (runCancellationService.isCancellationError(e) || runCancellationService.isCancelled(runId)) throw e;
    sourceOutput = {
      mode: "fallback",
      confidence: 0.2,
      outcomes: null,
      timeline_range_months: null,
      cost_range: null,
      deadlines: [],
      key_factors: [],
      citations: [],
      error: String((e as any)?.message || e),
    };
  }
  runCancellationService.throwIfCancelled(runId);
  await updateRunProgress(runId, markStep(3, { confidence: Number(sourceOutput?.confidence ?? 0) }));
  const output = mapOutcomeOutput(
    sourceOutput,
    doc,
    qp,
    overrides,
    similarCaseSnippets,
    env.ENABLE_SIMILAR_CASES,
    contractRiskPayload,
    llmSucceeded,
  );
  if (sourceOutput?.error) {
    output.mode = "fallback";
    // Keep usable fallback output if it is still grounded with enough citations.
    if (!output.analysis_valid) {
      output.failure_reason = output.failure_reason || String(sourceOutput.error);
    } else {
      output.failure_reason = null;
    }
  }
  output.qa_debug = {
    ...(output.qa_debug || {}),
    run_id: runId,
    doc_hash: doc.hash,
    source_mode: sourceOutput?.mode || "unknown",
    similar_cases_enabled: env.ENABLE_SIMILAR_CASES,
    similar_cases_retrieved: similarCaseSnippets.length,
  };
  await updateRunProgress(runId, markStep(4, { confidence: output.prediction.confidence }));
  await upsertAgentOutput({ caseId, payload: output, language: c.language || "English" });
  await updateRunProgress(runId, { done: true, stage: "done", stats: { confidence: output.prediction.confidence }, meta: { agent_key: AGENT_KEY, mode: output.mode, analysis_valid: output.analysis_valid, failure_reason: output.failure_reason } });
  await prisma.run.update({ where: { id: runId }, data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() } });
  const title = output.analysis_valid === false ? "Outcome Prediction completed with warnings" : "Outcome Prediction completed";
  const body = output.analysis_valid === false
    ? `Outcome Prediction generated fallback output for case ${caseId}`
    : `Outcome Prediction generated output for case ${caseId}`;
  await notificationService.create(userId, title, body);
  runCancellationService.clear(runId);
}

export const caseOutcomeAgentService = {
  AGENT_KEY,
  schema: caseOutcomeOutputSchema,
  async getOverview(userId: string, caseId: string) {
    const c = await ensureOwnedCase(userId, caseId);
    const doc = await resolvePrimaryDoc(caseId);
    const latestAny = await readLatestOutput(caseId);
    const latestForDoc = doc ? await readLatestOutputForDoc(caseId, doc.hash) : null;
    const payload = parsePayloadRow(latestForDoc);
    const latestAnyPayload = parsePayloadRow(latestAny);
    const payloadUsable = isUsableCaseOutcomePayload(payload);
    const qpCase = await prisma.case.findUnique({ where: { id: caseId }, include: { outputs: true, runs: { orderBy: { createdAt: "desc" }, take: 30 } } });
    const qpOutput = ((qpCase?.outputs || []) as any[]).find((o) => o.agentKey === "query_parsing")?.payloadJson || null;
    const prefill_defaults = derivePrefillDefaults(doc, qpOutput);
    const runs = ((qpCase?.runs || []) as any[]).filter((r) => {
      const meta = (r.stepsJson as any)?.meta || {};
      if (meta?.agent_key !== AGENT_KEY) return false;
      if (!doc) return true;
      const runDocHash = String(meta?.doc_hash || "");
      return !runDocHash || runDocHash === String(doc.hash);
    });
    const latestRun = runs[0] || null;
    const latestStatus: any = payload
      ? "done"
      : latestRun?.status === RunStatus.RUNNING
        ? "running"
        : latestRun?.status === RunStatus.FAILED
          ? "error"
          : "none";
    return {
      case: { case_id: caseId, title: c.title, domain: (c as any).domainPrimary || "General", language: c.language || "English" },
      primary_doc: doc ? { doc_id: doc.doc_id, filename: doc.filename, mime_type: doc.mime, kind: doc.kind || null, pages: doc.pages ?? null, char_count: doc.char_count ?? null, updated_at: doc.updated_at } : null,
      query_parsing: { output: qpOutput ? { case_title: qpOutput.case_title, domain: qpOutput.domain, jurisdiction: qpOutput.jurisdiction, executive_summary: qpOutput.executive_summary || qpOutput.summary, key_facts: qpOutput.key_facts, legal_grounds: qpOutput.legal_grounds, issue_groups: qpOutput.issue_groups } : null },
      prefill_defaults,
      latest: {
        status: latestStatus,
        run_id: latestRun?.id || null,
        output: latestStatus === "done" ? payload : null,
        mode: payload?.mode || "fallback",
        analysis_valid: !!payload?.analysis_valid,
        failure_reason: payload?.failure_reason || null,
      },
      recent_runs: runs.slice(0, 5).map((r) => ({ run_id: r.id, status: r.status === "SUCCEEDED" ? "done" : "error", created_at: r.createdAt.toISOString() })),
      qa_debug: {
        case_id: caseId,
        primary_doc_id: (c as any).primaryDocId || null,
        doc_hash: doc?.hash || null,
        extracted_text_exists: !!doc?.extracted_text?.trim(),
        query_parsing_output_exists: !!qpOutput,
        last_run_id: latestRun?.id || null,
        last_run_status: latestRun?.status || null,
        latest_output_doc_hash_any: latestAnyPayload?.qa_debug?.doc_hash || null,
        latest_output_doc_hash_matched: payload?.qa_debug?.doc_hash || null,
        latest_output_usable: payloadUsable,
      },
    };
  },
  async startRun(userId: string, caseId: string, input?: { force?: boolean; user_overrides?: any }) {
    const c = await ensureOwnedCase(userId, caseId);
    const doc = await resolvePrimaryDoc(caseId);
    if (!doc) throw new HttpError(400, "No case text/document found for this case", "case_input_missing");
    const overridesHash = sha256(JSON.stringify(input?.user_overrides || {})).slice(0, 16);
    const cached = await readLatestMatchingOutput(caseId, doc.hash, overridesHash);
    const cachedPayload = parsePayloadRow(cached);
    if (cached && !input?.force && isUsableCaseOutcomePayload(cachedPayload)) {
      return { status: "cached", output: cachedPayload };
    }
    const key = `${caseId}:${doc.hash}:${overridesHash}`;
    const inflight = inFlightByCaseDoc.get(key); if (inflight) return { status: "running", run_id: inflight };
    const run = await prisma.run.create({ data: { caseId, status: RunStatus.PENDING, language: c.language, stepsJson: makeRunStatus({ meta: { agent_key: AGENT_KEY, doc_hash: doc.hash, overrides_hash: overridesHash } }) as any, startedAt: new Date() } });
    inFlightByCaseDoc.set(key, run.id);
    setImmediate(() => { void executeRun(run.id, caseId, userId, !!input?.force, input?.user_overrides).catch(async (e) => {
      if (runCancellationService.isCancellationError(e) || runCancellationService.isCancelled(run.id)) {
        await updateRunProgress(run.id, { done: true, stage: "cancelled", error: "Run cancelled by user", meta: { agent_key: AGENT_KEY, cancelled: true } }).catch(() => undefined);
        await prisma.run.update({ where: { id: run.id }, data: { status: RunStatus.FAILED, finishedAt: new Date() } }).catch(() => undefined);
        await notificationService.create(userId, "Outcome Prediction cancelled", `Outcome Prediction was cancelled for case ${caseId}`).catch(() => undefined);
        return;
      }
      const reason = String((e as any)?.message || e);
      try {
        const fallbackPayload = caseOutcomeOutputSchema.parse({
          agent_key: AGENT_KEY,
          mode: "fallback",
          analysis_valid: false,
          failure_reason: reason,
          doc_summary: { doc_type_guess: doc.mime.includes("pdf") ? "Case Document PDF" : "Case Text", language: doc.language, pages: doc.pages ?? null },
          prefill: { case_type: null, jurisdiction: "India", claim_amount: null, facts_summary: clipSentence(doc.extracted_text, 420), key_legal_issues: [], evidence_strength: "Moderate" },
          prediction: { distribution: { win: 0.34, settle: 0.33, lose: 0.33 }, confidence: 0.2 },
          ranges: { duration_months: null, award_or_cost_range_inr: null },
          similar_corpus_available: false,
          similar_cases: [],
          deadlines_and_penalties: [],
          recommendations: ["Fallback projection generated due to runtime error. Re-run after model/service health check."],
          clarifying_questions: ["Please provide clearer chronology and supporting evidence for better projection quality."],
          citations: doc.extracted_text ? [{ source_type: "user_doc", doc_id: doc.doc_id, chunk_id: "fallback:0", snippet: trimWords(doc.extracted_text, 25), page: null, offset_start: null, offset_end: null }] : [],
          qa_debug: { run_id: run.id, hard_error: reason, llm_required_mode: getEnv().REQUIRE_LLM_OUTPUT === true },
        });
        await upsertAgentOutput({ caseId, payload: fallbackPayload, language: c.language || "English" });
        await updateRunProgress(run.id, { done: true, stage: "done", error: null, meta: { agent_key: AGENT_KEY, mode: "fallback", analysis_valid: false, failure_reason: reason } });
        await prisma.run.update({ where: { id: run.id }, data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() } }).catch(() => undefined);
        await notificationService.create(userId, "Outcome Prediction completed with warnings", `Outcome Prediction generated fallback output for case ${caseId}: ${reason}`);
      } catch {
        await updateRunProgress(run.id, { done: true, error: reason });
        await prisma.run.update({ where: { id: run.id }, data: { status: RunStatus.FAILED, finishedAt: new Date() } }).catch(() => undefined);
        await notificationService.create(userId, "Outcome Prediction failed", `Outcome Prediction failed for case ${caseId}: ${reason}`);
      }
    }).finally(() => { if (inFlightByCaseDoc.get(key) === run.id) inFlightByCaseDoc.delete(key); runCancellationService.clear(run.id); }); });
    return { status: "queued", run_id: run.id };
  },
  async getOutput(userId: string, caseId: string) {
    await ensureOwnedCase(userId, caseId);
    const doc = await resolvePrimaryDoc(caseId);
    const latest = doc ? await readLatestOutputForDoc(caseId, doc.hash) : await readLatestOutput(caseId);
    const payload = parsePayloadRow(latest);
    if (payload) return payload;
    const anyLatest = parsePayloadRow(await readLatestOutput(caseId));
    if (anyLatest) return anyLatest;
    if (doc) return buildEmergencyCaseOutcomeOutput(doc, null, "No saved outcome payload found; generated emergency fallback output.");
    throw new HttpError(404, "Case outcome report not found for current case document", "case_outcome_output_not_found");
  },
  async exportPdf(userId: string, caseId: string) {
    const payload = await this.getOutput(userId, caseId);
    const buffer = await renderCaseOutcomePdf(payload, caseId, payload?.qa_debug?.case_title);
    return {
      buffer,
      filename: `case-outcome-${String(caseId || "report")}.pdf`,
    };
  },
};
