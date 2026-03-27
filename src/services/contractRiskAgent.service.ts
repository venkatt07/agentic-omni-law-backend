import { randomUUID } from "crypto";
import PDFDocument from "pdfkit";
import { z } from "zod";
import { HttpError } from "../middleware/error.js";
import { mysqlPool, prisma } from "../prisma/client.js";
import { RunStatus } from "../db/types.js";
import type { RunStep } from "../types/api.js";
import { llmClient } from "../ai/llmClient.js";
import { getEnv } from "../config/env.js";
import { translatorService } from "./translator.service.js";
import { sha256 } from "../utils/hash.js";
import { notificationService } from "./notification.service.js";
import { runCancellationService } from "./runCancellation.service.js";
import { assessNarrativeQuality, countGenericPhraseHits } from "./quality/genericity.service.js";
import { resolveCaseDocumentMetas, resolvePrimaryCaseDocumentMeta, type CaseDocumentMeta } from "./documentMeta.service.js";

const AGENT_KEY = "contract_risk_dispute_settlement";
const RUN_STEP_NAMES = [
  "Extracting text from document...",
  "Identifying contract clauses...",
  "Analyzing risk factors...",
  "Detecting missing clauses...",
  "Generating recommendations...",
  "Generating dispute & settlement suggestions...",
] as const;

type Citation = {
  source_type: "USER_DOC";
  doc_id: string;
  snippet: string;
  offsetStart?: number;
  offsetEnd?: number;
  page?: number;
  source_label?: string;
};

const citationSchema = z.object({
  source_type: z.literal("USER_DOC"),
  doc_id: z.string().min(1),
  snippet: z.string().min(1).max(300),
  offsetStart: z.number().int().nonnegative().optional(),
  offsetEnd: z.number().int().nonnegative().optional(),
  page: z.number().int().positive().optional(),
  source_label: z.string().optional(),
});

const clauseFindingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  severity: z.enum(["high", "medium", "low"]),
  category: z.string().min(1),
  issue: z.string().min(1),
  impact: z.string().min(1),
  recommendation: z.array(z.string().min(1)).min(1).max(6),
  suggested_rewrite: z.string().min(1),
  evidence: citationSchema.optional(),
  confidence: z.number().min(0).max(100),
  needs_review: z.boolean().optional(),
});

const missingClauseSchema = z.object({
  id: z.string().min(1),
  clause_name: z.string().min(1),
  why_it_matters: z.string().min(1),
  suggested_text: z.string().min(1),
  confidence: z.number().min(0).max(100),
});

const contractRiskOutputSchema = z.object({
  agent_key: z.literal(AGENT_KEY).default(AGENT_KEY),
  mode: z.enum(["llm_refined", "deterministic_fallback", "grounded_contract_analysis"]).optional(),
  analysis_valid: z.boolean().optional(),
  failure_reason: z.string().nullable().optional(),
  doc_summary: z.object({
    doc_type_guess: z.string().min(1),
    language: z.string().min(1),
    parties: z.array(z.string()).default([]),
    effective_date: z.string().nullable().optional(),
    term: z.string().nullable().optional(),
    pages: z.number().int().positive().nullable().optional(),
  }),
  scores: z.object({
    overall_risk_score: z.number().min(0).max(10),
    risk_level: z.enum(["Low", "Medium", "High"]),
  }),
  counts: z.object({
    total_clauses_found: z.number().int().nonnegative(),
    high_risk: z.number().int().nonnegative(),
    medium_risk: z.number().int().nonnegative(),
    low_risk: z.number().int().nonnegative(),
    missing_clauses: z.number().int().nonnegative(),
  }),
  risk_distribution: z.object({
    "Liability & Indemnification": z.number().int().nonnegative(),
    Payment: z.number().int().nonnegative(),
    Termination: z.number().int().nonnegative(),
    IP: z.number().int().nonnegative(),
    Confidentiality: z.number().int().nonnegative(),
    "Dispute Resolution": z.number().int().nonnegative(),
  }),
  high_risk_clauses: z.array(clauseFindingSchema).default([]),
  medium_risk_clauses: z.array(clauseFindingSchema).default([]),
  low_risk_clauses: z.array(clauseFindingSchema).default([]),
  missing_clauses_list: z.array(missingClauseSchema).default([]),
  suggestions: z.object({
    negotiation_priorities: z.array(z.string()).default([]),
    red_flags: z.array(z.string()).default([]),
    quick_improvements: z.array(z.string()).default([]),
  }),
  dispute_resolution_and_settlement: z.object({
    dispute_clause_found: z.boolean(),
    dispute_clause_summary: z.string(),
    recommended_path: z.array(z.string()).default([]),
    negotiation_script: z.string(),
    settlement_options: z.array(z.object({
      option: z.string(), when_to_use: z.string(), upside: z.string(), risk: z.string(),
    })).default([]),
    red_flags_to_avoid: z.array(z.string()).default([]),
  }),
  citations: z.array(citationSchema).default([]),
  user_questions_to_confirm: z.array(z.string()).default([]),
  generated_at: z.string().optional(),
  source_language: z.string().optional(),
  qa_debug: z.record(z.any()).optional(),
});

type ContractRiskOutput = z.infer<typeof contractRiskOutputSchema>;
type ContractDocMeta = { doc_id: string; filename: string; mime: string; kind?: string | null; updated_at: string; hash: string; language: string; extracted_text: string; pages?: number | null; char_count?: number | null; };
type RunStatusShape = { stage: string; stepIndex: number; stepsTotal: number; stats: { clausesFound: number; risksDetected: number; missingClauses: number }; done: boolean; error?: string | null; steps: RunStep[]; meta: Record<string, any>; };

const inFlightByCaseDoc = new Map<string, string>();
const RUN_STALE_MS = 10 * 60 * 1000;
function trimWords(text: string, max = 25) { return String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, max).join(" "); }
function isStaleRunningRun(run: any) {
  if (!run || run.status !== RunStatus.RUNNING) return false;
  const ts = new Date(run.updatedAt || run.startedAt || run.createdAt || Date.now()).getTime();
  if (!Number.isFinite(ts)) return false;
  return (Date.now() - ts) > RUN_STALE_MS;
}

function buildRunSteps(stepIndex = 0): RunStep[] { return RUN_STEP_NAMES.map((name, idx) => ({ name, state: idx < stepIndex ? "SUCCEEDED" : idx === stepIndex ? "RUNNING" : "PENDING", progress: Math.round((Math.min(idx, stepIndex) / RUN_STEP_NAMES.length) * 100) })); }
function makeRunStatus(partial?: Partial<RunStatusShape>): RunStatusShape { return { stage: RUN_STEP_NAMES[0], stepIndex: 1, stepsTotal: RUN_STEP_NAMES.length, stats: { clausesFound: 0, risksDetected: 0, missingClauses: 0 }, done: false, error: null, steps: buildRunSteps(0), meta: { agent_key: AGENT_KEY }, ...partial }; }
async function ensureOwnedCase(userId: string, caseId: string) { const c = await prisma.case.findUnique({ where: { id: caseId }, include: { user: true } }); if (!c || c.userId !== userId) throw new HttpError(404, "Case not found", "case_not_found"); return c; }
function toContractDocMeta(candidate: CaseDocumentMeta): ContractDocMeta {
  const text = String(candidate?.extracted_text || "");
  return {
    doc_id: String(candidate.doc_id),
    filename: String(candidate.filename || "Untitled document"),
    mime: String(candidate.mime_type || "text/plain"),
    kind: candidate.kind || null,
    updated_at: candidate.updated_at || new Date().toISOString(),
    hash: String(candidate.checksum || sha256(`${candidate.doc_id}:${text}`)),
    language: String(candidate.language || "English"),
    extracted_text: text,
    pages: candidate.pages ?? null,
    char_count: candidate.char_count ?? text.length,
  };
}

async function resolvePrimaryContractDoc(caseId: string): Promise<ContractDocMeta | null> {
  const candidate = await resolvePrimaryCaseDocumentMeta(caseId);
  if (!candidate) return null;
  return toContractDocMeta(candidate);
}

function buildSyntheticContractDoc(caseId: string, preferredLanguage: string, qpOutput?: any, caseTitle?: string | null): ContractDocMeta {
  const summaryParts = [
    String(qpOutput?.executive_summary || "").trim(),
    String(qpOutput?.summary || "").trim(),
    String(qpOutput?.facts_summary || "").trim(),
    ...(Array.isArray(qpOutput?.legal_grounds) ? qpOutput.legal_grounds.map((value: any) => String(value || "").trim()) : []),
  ].filter(Boolean);
  const baseText = summaryParts.join("\n\n").trim();
  const extractedText = baseText || `Case title: ${String(caseTitle || "Case Workspace").trim() || "Case Workspace"}.\n\nContract risk fallback review generated from available workspace context because no primary case document text was available.`;
  return {
    doc_id: `synthetic-contract-risk:${caseId}`,
    filename: "query-parsing-context.txt",
    mime: "text/plain",
    kind: "synthetic_fallback",
    updated_at: new Date().toISOString(),
    hash: sha256(`contract-risk:${caseId}:${extractedText}`),
    language: preferredLanguage || "English",
    extracted_text: extractedText,
    pages: null,
    char_count: extractedText.length,
  };
}

async function resolveAlternateContractLikeDoc(caseId: string, qpOutput?: any, excludeDocId?: string): Promise<ContractDocMeta | null> {
  const docs = await resolveCaseDocumentMetas(caseId);
  const candidates = docs.filter((d) => String(d.extracted_text || "").trim().length > 0 && (!excludeDocId || String(d.doc_id) !== String(excludeDocId)));
  if (!candidates.length) return null;
  type ScoredDoc = {
    d: CaseDocumentMeta;
    evalResult: { isContractLike: boolean; direct: boolean; qpHint: boolean };
    score: number;
  };
  const scored: ScoredDoc[] = candidates
    .map((d) => {
      const text = String(d.extracted_text || "");
      const evalResult = evaluateContractLikeInput(text, qpOutput);
      const structureBonus = /\b(this agreement|whereas|term and termination|governing law|arbitration)\b/i.test(text) ? 2 : 0;
      const score = (evalResult.isContractLike ? 10 : 0) + (evalResult.direct ? 3 : 0) + (evalResult.qpHint ? 1 : 0) + structureBonus;
      return { d, evalResult, score };
    })
    .sort((a: ScoredDoc, b: ScoredDoc) => b.score - a.score || String(b.d.updated_at).localeCompare(String(a.d.updated_at)));
  const best = scored.find((x: ScoredDoc) => x.evalResult.isContractLike) || null;
  return best ? toContractDocMeta(best.d) : null;
}

function safeJsonParse(text: string): any | null { const raw = String(text || "").trim(); if (!raw) return null; try { return JSON.parse(raw); } catch {} const first = raw.indexOf("{"); const last = raw.lastIndexOf("}"); if (first >= 0 && last > first) { try { return JSON.parse(raw.slice(first, last + 1)); } catch {} } return null; }
function makeSnippet(text: string, idx: number, maxWords = 25) { const window = text.slice(Math.max(0, idx - 120), Math.min(text.length, idx + 220)).replace(/\s+/g, " ").trim(); return trimWords(window, maxWords); }
function findCitation(docId: string, text: string, patterns: string[]): Citation | undefined { const lower = text.toLowerCase(); for (const p of patterns) { const i = lower.indexOf(p.toLowerCase()); if (i >= 0) return { source_type: "USER_DOC", doc_id: docId, snippet: makeSnippet(text, i, 25), offsetStart: i, offsetEnd: Math.min(text.length, i + p.length) }; } return undefined; }
function buildFocusedContractContext(text: string, maxChars = 10_500) {
  const source = String(text || "").replace(/\r/g, "");
  if (!source.trim()) return "";
  const lower = source.toLowerCase();
  const patterns = [
    "agreement", "between", "whereas", "payment", "invoice", "fee", "milestone", "refund",
    "termination", "breach", "notice", "cure", "liability", "indemn", "limitation of liability",
    "confidential", "non-disclosure", "intellectual property", "license", "ownership",
    "governing law", "jurisdiction", "arbitration", "dispute", "mediation", "force majeure",
  ];
  const segments: string[] = [];
  const seen = new Set<string>();
  const pushSegment = (start: number, end: number) => {
    const clipped = source.slice(Math.max(0, start), Math.min(source.length, end)).trim();
    if (!clipped) return;
    const key = clipped.toLowerCase().replace(/\s+/g, " ").slice(0, 180);
    if (seen.has(key)) return;
    seen.add(key);
    segments.push(clipped);
  };
  pushSegment(0, Math.min(source.length, 2400));
  for (const pattern of patterns) {
    let from = 0;
    let hits = 0;
    while (from < lower.length && hits < 2) {
      const idx = lower.indexOf(pattern, from);
      if (idx < 0) break;
      pushSegment(idx - 260, idx + 520);
      from = idx + pattern.length;
      hits += 1;
      if (segments.join("\n\n").length >= maxChars) break;
    }
    if (segments.join("\n\n").length >= maxChars) break;
  }
  const joined = segments.join("\n\n---\n\n").slice(0, maxChars).trim();
  return joined || source.slice(0, maxChars).trim();
}
function collectParties(text: string) { const m = text.match(/\bbetween\s+(.+?)\s+and\s+(.+?)(?:\.|\n|,)/i); if (m) return [m[1].trim(), m[2].trim()].slice(0, 2); return [...new Set((text.match(/\b[A-Z][A-Za-z0-9&., ]{2,40}(?:Pvt\.?\s*Ltd\.?|LLP|Limited|Inc\.?)\b/g) || []).map((x) => x.trim()))].slice(0, 4); }
function looksLikeContractText(text: string) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return false;
  const contractSignals = [
    "agreement", "this agreement", "service agreement", "master service agreement", "statement of work", "between",
    "whereas", "hereinafter", "party", "parties", "scope of services", "term and termination", "payment terms",
    "invoice", "milestone", "indemn", "liability", "limitation of liability", "confidential", "governing law",
    "arbitration", "dispute resolution", "force majeure", "warranty", "intellectual property", "shall",
  ];
  const litigationSignals = [
    "plaintiff",
    "defendant",
    "respondent",
    "petition",
    "affidavit",
    "order vii",
    "rule 9",
    "cpc",
    "court of",
    "o.s.no",
    "i.a. no",
    "injunction",
    "summons",
    "cause of action",
  ];
  const contractHits = contractSignals.filter((s) => t.includes(s)).length;
  const litigationHits = litigationSignals.filter((s) => t.includes(s)).length;
  const numberedClauses = (t.match(/(?:^|\n)\s*\d{1,2}\.\s+[a-z]/g) || []).length;
  const hasContractStructure =
    /\b(this agreement|service agreement|master service agreement|agreement dated|made on this|between .+ and .+|whereas)\b/i.test(t) ||
    /\bgoverning law\b/i.test(t) ||
    /\barbitration\b/i.test(t);
  if (litigationHits >= 5 && contractHits <= 2) return false;
  if (hasContractStructure && contractHits >= 3) return true;
  if (contractHits >= 8 && numberedClauses >= 2) return true;
  if (contractHits >= 6) return true;
  return false;
}

function queryParsingSuggestsContract(qpOutput: any) {
  if (!qpOutput || typeof qpOutput !== "object") return false;
  const domainText = [
    qpOutput.legal_domain,
    qpOutput.domain,
    qpOutput?.domain?.primary,
    qpOutput.case_type,
    qpOutput.legal_subtype,
  ]
    .map((v) => String(v || "").toLowerCase())
    .join(" ");
  if (/(contract|commercial|corporate|supply|agreement|vendor|invoice|payment)/.test(domainText)) return true;
  const issues = Array.isArray(qpOutput.issue_groups)
    ? qpOutput.issue_groups.map((g: any) => String(g?.title || g?.label || "")).join(" ").toLowerCase()
    : Array.isArray(qpOutput.issues)
      ? qpOutput.issues.join(" ").toLowerCase()
      : "";
  return /(contract|breach|invoice|payment|termination|arbitration|governing law|liability)/.test(issues);
}

function evaluateContractLikeInput(text: string, qpOutput?: any) {
  const direct = looksLikeContractText(text);
  const qpHint = queryParsingSuggestsContract(qpOutput);
  const softDocSignals = /\b(agreement|contract|scope of services|payment|invoice|termination|clause|indemn|liability|governing law|arbitration)\b/i.test(String(text || ""));
  const isContractLike = direct || (qpHint && softDocSignals);
  return { isContractLike, direct, qpHint };
}
function looksLikeMixedCaseBundle(text: string) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return false;
  const repeatedCaseHeaders = (t.match(/\bcase file\b/g) || []).length + (t.match(/\bparties:\b/g) || []).length;
  const tenancySignals = ["tenant", "landlord", "security deposit", "vacating", "flat", "rent"];
  const commercialSignals = ["vendor", "erp", "implementation", "milestones", "change order", "liquidated damages"];
  const hasTenancy = tenancySignals.filter((s) => t.includes(s)).length >= 2;
  const hasCommercial = commercialSignals.filter((s) => t.includes(s)).length >= 2;
  return repeatedCaseHeaders >= 3 || (hasTenancy && hasCommercial);
}

function countOccurrences(text: string, pattern: string) {
  if (!pattern) return 0;
  let start = 0;
  let count = 0;
  const src = String(text || "");
  const needle = String(pattern || "").toLowerCase();
  const lower = src.toLowerCase();
  while (start < lower.length) {
    const idx = lower.indexOf(needle, start);
    if (idx < 0) break;
    count += 1;
    start = idx + Math.max(1, needle.length);
    if (count >= 6) break;
  }
  return count;
}

function detectClauseBuckets(docId: string, text: string) {
  const buckets = [
    {
      category: "Liability & Indemnification",
      keys: ["liability", "indemn", "hold harmless", "limitation of liability"],
      missingName: "Liability / Indemnification",
      risky: ["unlimited liability", "not liable for any", "sole discretion", "exclusive remedy"],
      adequacyChecks: [
        { test: /\bindemn/i, gap: "indemnity scope/trigger is not explicit" },
        { test: /\bliability[^.\n]{0,120}(cap|not exceed|limited|aggregate)\b/i, gap: "liability cap/limit wording is weak or absent" },
      ],
    },
    {
      category: "Payment",
      keys: ["payment", "invoice", "fee", "refund", "price", "consideration", "milestone"],
      missingName: "Payment Terms",
      risky: ["non-refundable", "without notice", "sole discretion", "immediate payment"],
      adequacyChecks: [
        { test: /\b(within\s+\d+\s+(day|days|week|weeks|month|months)|due date|business days)\b/i, gap: "clear payment timeline/due-date language is missing" },
        { test: /\b(interest|late fee|delayed payment|penalty)\b/i, gap: "delay/late-payment consequence is not clearly defined" },
      ],
    },
    {
      category: "Termination",
      keys: ["termination", "terminate", "cure period", "breach", "notice period"],
      missingName: "Termination",
      risky: ["immediate termination", "without notice", "sole discretion"],
      adequacyChecks: [
        { test: /\bnotice\b/i, gap: "termination notice procedure is not clear" },
        { test: /\bcure\b/i, gap: "cure period/remedy opportunity is missing" },
      ],
    },
    {
      category: "IP",
      keys: ["intellectual property", "ip", "copyright", "license", "ownership"],
      missingName: "IP Rights",
      risky: ["irrevocable transfer", "exclusive ownership by one party", "all rights reserved without license"],
      adequacyChecks: [
        { test: /\b(ownership|owner|retain rights)\b/i, gap: "IP ownership allocation is unclear" },
        { test: /\b(license|use rights)\b/i, gap: "license/use-rights terms are not explicit" },
      ],
    },
    {
      category: "Confidentiality",
      keys: ["confidential", "non-disclosure", "nda", "confidentiality"],
      missingName: "Confidentiality",
      risky: ["without any restriction", "public disclosure allowed", "no confidentiality obligation"],
      adequacyChecks: [
        { test: /\b(confidential|non[- ]?disclosure)\b/i, gap: "confidentiality obligations are not clearly articulated" },
        { test: /\b(survive|years?|term)\b/i, gap: "confidentiality duration/survival wording is weak or absent" },
      ],
    },
    {
      category: "Dispute Resolution",
      keys: ["dispute", "arbitration", "jurisdiction", "governing law", "mediation", "seat of arbitration"],
      missingName: "Dispute Resolution",
      risky: ["exclusive jurisdiction at sole discretion", "waive all remedies", "no right to seek interim relief"],
      adequacyChecks: [
        { test: /\b(governing law)\b/i, gap: "governing law is missing or not explicit" },
        { test: /\b(arbitration|jurisdiction)\b/i, gap: "forum/arbitration mechanism is not clearly defined" },
      ],
    },
  ] as const;
  const lower = text.toLowerCase();
  const findings: any[] = []; const missing: any[] = [];
  const dist: Record<string, number> = { "Liability & Indemnification": 0, Payment: 0, Termination: 0, IP: 0, Confidentiality: 0, "Dispute Resolution": 0 };
  let riskSeq = 1, missingSeq = 1;
  for (const bucket of buckets) {
    const foundKeys = bucket.keys.filter((k) => lower.includes(k));
    const keyHits = foundKeys.reduce((sum, k) => sum + Math.min(3, countOccurrences(lower, k)), 0);
    dist[bucket.category] = foundKeys.length ? Math.max(1, Math.min(5, Math.round(keyHits / 2))) : 0;
    if (!foundKeys.length) {
      missing.push({
        id: `mc_${missingSeq++}`,
        clause_name: bucket.missingName,
        why_it_matters: `${bucket.missingName} is missing or weak, which increases dispute ambiguity and enforcement risk.`,
        suggested_text: `Add a concise ${bucket.missingName.toLowerCase()} clause with clear obligations, timelines, triggers, and remedies.`,
        confidence: 64,
      });
      continue;
    }
    const evidencePatterns = [...foundKeys, ...bucket.risky].slice(0, 8);
    const evidence = findCitation(docId, text, evidencePatterns);
    const riskyHits = bucket.risky.filter((r) => lower.includes(r));
    const adequacyGaps = bucket.adequacyChecks.filter((c) => !c.test.test(lower)).map((c) => c.gap);
    const sparseCoverage = foundKeys.length <= 1 ? 1 : 0;
    const severityScore = riskyHits.length * 2 + adequacyGaps.length + sparseCoverage;
    const severity: "high" | "medium" | "low" =
      severityScore >= 4 ? "high" :
      severityScore >= 2 ? "medium" :
      "low";
    const issueBits = [
      ...riskyHits.slice(0, 2).map((r) => `detected phrase "${r}"`),
      ...adequacyGaps.slice(0, 2),
    ];
    const issue = issueBits.length
      ? `${bucket.category} clause has risk signals: ${issueBits.join("; ")}.`
      : `${bucket.category} clause is present with no major red-flag wording detected, but precision review is still recommended.`;
    const impact = severity === "high"
      ? "Higher dispute exposure and enforceability risk if dispute escalates."
      : severity === "medium"
        ? "Moderate interpretation risk and negotiation leverage uncertainty."
        : "Lower immediate risk, with drafting clarity checks advised.";
    const recommendation = [
      `Rework ${bucket.category.toLowerCase()} language to define scope, triggers, timelines, and exceptions clearly.`,
      ...adequacyGaps.slice(0, 2).map((g) => `Address gap: ${g}.`),
      ...(riskyHits.length ? ["Remove one-sided or ambiguous phrasing and align obligations bilaterally where commercially feasible."] : []),
    ].slice(0, 4);
    findings.push({
      id: `cf_${riskSeq++}`,
      title: `${bucket.category} clause review`,
      severity,
      category: bucket.category,
      issue,
      impact,
      recommendation,
      suggested_rewrite: `Revise ${bucket.category.toLowerCase()} wording to include explicit triggers, process, notice/cure timelines, and balanced remedies.`,
      evidence,
      confidence: evidence ? Math.max(58, Math.min(90, 76 - adequacyGaps.length * 5 + Math.min(foundKeys.length, 3) * 3)) : 42,
      needs_review: !evidence || adequacyGaps.length > 0 || riskyHits.length > 0,
    });
  }
  return { findings, missing, dist };
}

function summarizeDisputeClause(docId: string, text: string) {
  const lower = text.toLowerCase();
  const found =
    /\barbitration clause\b/.test(lower) ||
    /\bdispute resolution\b/.test(lower) ||
    /\bgoverning law\b/.test(lower) ||
    /\bseat(?:\s+of\s+arbitration)?\b/.test(lower) ||
    (/\bjurisdiction\b/.test(lower) && /\bagreement\b/.test(lower));
  const seatMatch = text.match(/\bseat(?:\s+of\s+arbitration)?\s*[:\-]?\s*([A-Za-z ,]{2,40})/i);
  const forumMatch = text.match(/\b(courts?\s+at\s+[A-Za-z ,]{2,40}|jurisdiction\s+of\s+[A-Za-z ,]{2,40})/i);
  const citation = findCitation(docId, text, ["arbitration", "dispute", "jurisdiction", "governing law", "mediation"]);
  return { found, summary: found ? `Dispute clause ${lower.includes("arbitration") ? "mentions arbitration" : "does not clearly mention arbitration"}, ${lower.includes("mediation") ? "includes mediation" : "no clear mediation step"}, ${lower.includes("notice") ? "references notice" : "notice period not clearly detected"}${seatMatch ? `, seat: ${seatMatch[1].trim()}` : ""}${forumMatch ? `, forum: ${forumMatch[1].trim()}` : ""}.` : "No clear dispute resolution clause was detected in the provided contract text.", citation };
}

function detectGeneralCaseRiskBuckets(docId: string, text: string, qpOutput?: any) {
  const lower = String(text || "").toLowerCase();
  const findings: any[] = [];
  const dist: Record<string, number> = { "Liability & Indemnification": 0, Payment: 0, Termination: 0, IP: 0, Confidentiality: 0, "Dispute Resolution": 0 };
  const pushFinding = (
    id: string,
    title: string,
    severity: "high" | "medium" | "low",
    category: keyof typeof dist,
    issue: string,
    impact: string,
    recommendation: string[],
    evidenceTerms: string[],
    confidence: number,
  ) => {
    const evidence = findCitation(docId, text, evidenceTerms);
    findings.push({
      id,
      title,
      severity,
      category,
      issue,
      impact,
      recommendation,
      suggested_rewrite: "Strengthen the factual narrative, supporting proof, and procedural framing before the next legal step.",
      evidence,
      confidence,
      needs_review: !evidence,
    });
    dist[category] += 1;
  };

  if (/\bjurisdiction\b|\bcourt of\b|\border vii\b|\bcpc\b/.test(lower)) {
    pushFinding(
      "gr_1",
      "Jurisdiction and forum risk",
      "high",
      "Dispute Resolution",
      "Jurisdiction/forum is actively in issue or may be contested from the current pleading.",
      "A weak or disputed forum position can delay maintainability, admission, or interim relief strategy.",
      ["Recheck forum facts, cause of action links, and jurisdiction pleadings before relying on the current filing posture."],
      ["jurisdiction", "court", "cause of action", "order vii", "cpc"],
      84,
    );
  }
  if (/\bplaintiff\b|\bdefendant\b|\bpetition\b|\bwritten statement\b|\breplication\b|\bobjection\b/.test(lower)) {
    pushFinding(
      "gr_2",
      "Pleading-stage procedural risk",
      "medium",
      "Termination",
      "The document is at a pleading/response stage, so factual clarity and procedural sequencing matter more than clause extraction.",
      "Poor procedural sequencing can weaken relief strategy or create avoidable delay.",
      ["Map the current filing stage, upcoming response requirements, and the next procedural deadline."],
      ["plaintiff", "defendant", "written statement", "replication", "petition", "objection"],
      78,
    );
  }
  if (/\bemail\b|\bwhatsapp\b|\binvoice\b|\bletter\b|\bnotice\b|\bannexure\b|\bexhibit\b/.test(lower)) {
    pushFinding(
      "gr_3",
      "Evidence sufficiency risk",
      "medium",
      "Payment",
      "The matter appears evidence-sensitive, and the present record should be organized into a clean chronology.",
      "Weak evidence packaging reduces the strength of claims, objections, and settlement leverage.",
      ["Build a chronology linking each pleaded fact to the strongest supporting document or communication."],
      ["invoice", "notice", "annexure", "exhibit", "email", "whatsapp", "letter"],
      76,
    );
  }
  if (/\bpayment\b|\boutstanding\b|\brecovery\b|\bdamages\b|\binterest\b|\bpenalty\b/.test(lower)) {
    pushFinding(
      "gr_4",
      "Claim quantification risk",
      "medium",
      "Liability & Indemnification",
      "Money claim / liability exposure is present, but the amount logic and supporting basis must be checked carefully.",
      "Unclear quantification can weaken recovery, defence, or settlement posture.",
      ["Reconcile the claimed amount with invoices, ledger trail, interest basis, and pleaded computation."],
      ["payment", "outstanding", "recovery", "damages", "interest", "penalty"],
      74,
    );
  }
  if (/\bsettlement\b|\bmediation\b|\bwithout prejudice\b|\bcompromise\b/.test(lower) || findings.length >= 2) {
    pushFinding(
      "gr_5",
      "Settlement posture and notice risk",
      "low",
      "Confidentiality",
      "The case is suitable for a parallel settlement/notice strategy while preserving procedural rights.",
      "A measured settlement posture can reduce time and cost, but weak notice language may dilute leverage.",
      ["Prepare a settlement-ready notice or response without weakening the core legal position."],
      ["settlement", "mediation", "notice", "without prejudice", "compromise"],
      68,
    );
  }

  const qpGrounds = Array.isArray(qpOutput?.legal_grounds) ? qpOutput.legal_grounds.map((x: any) => String(x || "").trim()).filter(Boolean) : [];
  if (!findings.length && qpGrounds.length) {
    pushFinding(
      "gr_6",
      "General dispute risk review",
      "medium",
      "Dispute Resolution",
      `The case carries legal risk around ${qpGrounds.slice(0, 2).join(" and ")}.`,
      "The current file needs a cleaner evidence and issue map before the next step is taken.",
      ["Use the parsed legal grounds to organize facts, proof, and the immediate next action."],
      qpGrounds.slice(0, 3),
      66,
    );
  }

  return { findings, missing: [] as any[], dist };
}

function deterministicContractRisk(
  doc: ContractDocMeta,
  preferredLanguage = "English",
  opts?: { qpContractHint?: boolean; qpOutput?: any },
): ContractRiskOutput {
  const text = doc.extracted_text || "";
  const directContractLike = looksLikeContractText(text);
  const contractLike = directContractLike || Boolean(opts?.qpContractHint);
  const mixedBundle = looksLikeMixedCaseBundle(text);
  const { findings, missing, dist } = contractLike
    ? detectClauseBuckets(doc.doc_id, text)
    : detectGeneralCaseRiskBuckets(doc.doc_id, text, (opts as any)?.qpOutput);
  const disputeInfo = summarizeDisputeClause(doc.doc_id, text);
  const sorted = [...findings].sort((a, b) => ({ high: 3, medium: 2, low: 1 } as any)[b.severity] - ({ high: 3, medium: 2, low: 1 } as any)[a.severity]);
  const high = sorted.filter((f) => f.severity === "high"), med = sorted.filter((f) => f.severity === "medium"), low = sorted.filter((f) => f.severity === "low");
  const overall = Math.max(1, Math.min(10, Number((2 + high.length * 2 + med.length * 1.2 + missing.length * 0.8).toFixed(1))));
  const riskLevel: "Low" | "Medium" | "High" = overall >= 7 ? "High" : overall >= 4 ? "Medium" : "Low";
  const citations = [...sorted.map((f) => f.evidence).filter(Boolean), disputeInfo.citation].filter(Boolean) as Citation[];
  const dedup: Citation[] = []; const seen = new Set<string>(); for (const c of citations) { const k = `${c.doc_id}:${String(c.snippet).toLowerCase()}`; if (!seen.has(k)) { seen.add(k); dedup.push(c); } }
  const redFlags = [
    ...high.slice(0, 3).map((f) => trimWords(f.issue, 18)),
    ...med.slice(0, 2).map((f) => trimWords(f.issue, 16)),
  ].filter(Boolean);
  const quickImprovements = [
    ...missing.slice(0, 2).map((m) => `Add ${m.clause_name} clause with explicit process/timeline wording.`),
    ...med.slice(0, 2).map((f) => `Refine ${f.category.toLowerCase()} wording to reduce interpretation risk.`),
  ].filter(Boolean);
  const output: ContractRiskOutput = {
    agent_key: AGENT_KEY,
    analysis_valid: !mixedBundle && dedup.length >= 1 && sorted.filter((f) => !!f.evidence).length > 0,
    failure_reason: mixedBundle
      ? "Input appears to contain multiple case examples/bundle content, not a single contract. Upload the executed contract only or specify the target dispute text."
      : null,
    doc_summary: { doc_type_guess: contractLike ? (doc.mime.includes("pdf") ? "Contract PDF" : doc.mime.includes("word") ? "Contract Document" : "Contract Text") : "Case / pleading document", language: doc.language || "English", parties: collectParties(text), effective_date: (text.match(/\beffective\s+date\s*[:\-]?\s*([^\n.,]{3,40})/i)?.[1] || null) as any, term: (text.match(/\bterm\s*[:\-]?\s*([^\n.]{3,80})/i)?.[1] || null) as any, pages: doc.pages ?? null },
    scores: { overall_risk_score: overall, risk_level: riskLevel },
    counts: { total_clauses_found: sorted.length, high_risk: high.length, medium_risk: med.length, low_risk: low.length, missing_clauses: missing.length },
    risk_distribution: dist as any,
    high_risk_clauses: high, medium_risk_clauses: med, low_risk_clauses: low, missing_clauses_list: missing,
    suggestions: {
      negotiation_priorities: [...high.slice(0, 3).map((f) => `${f.category}: ${f.issue}`), ...missing.slice(0, 2).map((m) => `Add ${m.clause_name} clause`)].slice(0, 5),
      red_flags: redFlags.length ? [...new Set(redFlags)].slice(0, 4) : ["One-sided remedies or unilateral discretion", "No cure period / notice process for breach", "Ambiguous dispute forum or arbitration process"],
      quick_improvements: quickImprovements.length ? [...new Set(quickImprovements)].slice(0, 4) : contractLike ? ["Add notice and cure timelines", "Clarify payment milestones and refund conditions", "Define governing law / forum or arbitration process clearly"] : ["Clarify the present procedural stage", "Tighten the evidence chronology", "Link pleaded claims to documentary proof and forum position"],
    },
    dispute_resolution_and_settlement: {
      dispute_clause_found: contractLike ? disputeInfo.found : /\bjurisdiction\b|\bcourt of\b|\barbitration\b|\bmediation\b/.test(String(text || "").toLowerCase()),
      dispute_clause_summary: contractLike ? disputeInfo.summary : "The current case file should be reviewed for forum, stage, and notice posture before the next legal step.",
      recommended_path: contractLike
        ? ["Create a clause-to-fact matrix for disputed obligations and breaches.", "Send a structured negotiation notice referencing contract language and requested cure.", "Propose a time-bound settlement discussion with deliverables and payment/rectification options.", disputeInfo.found ? "Follow the contract dispute procedure sequence before escalation." : "Add a written procedural framework for mediation/arbitration discussions in negotiations."]
        : ["Map the present filing stage and likely next procedural response.", "Create an evidence chronology tied to each pleaded issue.", "Assess settlement or notice leverage without weakening the core legal position.", "Recheck maintainability, forum, and relief posture before escalation."],
      negotiation_script: contractLike
        ? "We want to resolve this commercially under the contract. Based on the clause language and current facts, please confirm your cure/settlement position within a defined timeline so escalation can be avoided."
        : "We want to resolve this dispute efficiently. Based on the present pleadings and evidence, please confirm your response position and whether an early resolution path is possible without prejudice to rights.",
      settlement_options: contractLike
        ? [ { option: "Cure + revised timeline", when_to_use: "Performance delay or partial breach", upside: "Preserves deal relationship", risk: "Needs clear milestones and consequences" }, { option: "Price/payment adjustment", when_to_use: "Quality/spec mismatch or disputed charges", upside: "Fast commercial closure", risk: "May waive future claims if drafted broadly" }, { option: "Termination by mutual settlement", when_to_use: "Relationship breakdown or repeated breach", upside: "Clean exit", risk: "Requires release + pending obligations clarity" } ]
        : [ { option: "Notice-backed settlement discussion", when_to_use: "Facts are dispute-heavy but the parties may still negotiate", upside: "Can reduce cost and delay", risk: "Weak documentation reduces leverage" }, { option: "Stage-specific procedural response", when_to_use: "The matter is already in court or response stage", upside: "Keeps the case posture disciplined", risk: "Needs accurate chronology and forum facts" } ],
      red_flags_to_avoid: contractLike ? ["Accepting oral settlements without written confirmation", "Waiving rights unintentionally in broad release language", "Skipping mandatory notice/cure or mediation steps in the contract"] : ["Taking a procedural step without confirming current filing stage", "Relying on unorganized evidence", "Making settlement admissions without a documented strategy"],
    },
    citations: dedup.slice(0, Math.max(3, dedup.length)), user_questions_to_confirm: contractLike ? ["Is this the latest executed version of the contract (including amendments)?", "Are there side letters, email modifications, or annexures that affect obligations?"].slice(0, 3) : ["What is the current filing/procedural stage?", "Which documents best support the core pleaded facts?", "Is there any notice, reply, or court order that changes the risk posture?"], generated_at: new Date().toISOString(), source_language: preferredLanguage,
    qa_debug: {
      mode: "deterministic_fallback",
      evidence_backed_findings: sorted.filter((f) => !!f.evidence).length,
      contract_like_text: contractLike,
      contract_like_direct: directContractLike,
      contract_like_query_parsing_hint: Boolean(opts?.qpContractHint),
      adaptive_case_risk_mode: !contractLike,
      mixed_case_bundle: mixedBundle,
    },
    mode: "deterministic_fallback",
  };
  return preferredLanguage && preferredLanguage !== "English" ? translatorService.translatePayload(output, preferredLanguage) : output;
}

function buildPrompt(doc: ContractDocMeta, preferredLanguage: string, base: ContractRiskOutput, contextMaxChars = 10_500) {
  const focusedContext = buildFocusedContractContext(doc.extracted_text, contextMaxChars);
  return `You are the Contract Risk + Dispute/Settlement agent for AGENTIC OMNI LAW.\nReturn STRICT JSON only. No markdown. No commentary.\nLanguage for report content: ${preferredLanguage || "English"}.\nUse clear, plain English. Keep sentences short and avoid legal jargon. If a legal term is required, explain it in simple words.\nUse the case primary document text as the evidence source; query-parsing output is only a hint.\nIf the document is a contract, perform clause-level contract risk analysis.\nIf the document is a pleading, notice, court filing, or other non-contract case document, perform dispute-risk analysis focused on forum, stage, evidence sufficiency, notice posture, money exposure, and settlement strategy.\nNever invent facts. Every key finding must include an evidence_snippet copied verbatim (<=25 words) from the document when possible.\nProduce overall risk score, high/medium/low findings, and dispute/settlement plan aligned to the actual document type.\nAlways include >=3 citations (verbatim, <=25 words) tied to key findings when possible.\n\nSeed deterministic draft (improve, keep schema):\n${JSON.stringify(base)}\n\nPrimary case document text:\n${focusedContext}`;
}

export const CONTRACT_RISK_REPAIR_PROMPT = `Fix the previous output into valid JSON only. Preserve content. Ensure required keys exist and types match schema.`;
export const CONTRACT_RISK_AGENT_PROMPT_TEMPLATE = "See buildPrompt() in src/services/contractRiskAgent.service.ts";

async function llmRefineContractRisk(runId: string, doc: ContractDocMeta, preferredLanguage: string, base: ContractRiskOutput) {
  const signal = runCancellationService.getSignal(runId);
  let raw = "";
  try {
    raw = await llmClient.generateText(buildPrompt(doc, preferredLanguage, base, 10_500), {
      tier: "final",
      max_tokens: 900,
      temperature: 0.05,
      timeoutMs: 30_000,
      signal,
    });
  } catch (error) {
    const message = String((error as any)?.message || error);
    if (/aborted|timeout|timed out/i.test(message)) {
      raw = await llmClient.generateText(
        buildPrompt(doc, preferredLanguage, base, 6_500),
        {
          tier: "final",
          max_tokens: 700,
          temperature: 0.05,
          timeoutMs: 18_000,
          signal,
        },
      );
    } else {
      throw error;
    }
  }
  const parsed = safeJsonParse(raw); const ok = contractRiskOutputSchema.safeParse(parsed); if (ok.success) return { output: ok.data, qa: { llm_repair_used: false } };
  const repairRaw = await llmClient.generateText(`${CONTRACT_RISK_REPAIR_PROMPT}\n\nTarget example:\n${JSON.stringify(base).slice(0, 9000)}\n\nBad output:\n${String(raw).slice(0, 12000)}`, { tier: "final", max_tokens: 900, temperature: 0, timeoutMs: 18_000, signal });
  const repaired = safeJsonParse(repairRaw); const ok2 = contractRiskOutputSchema.safeParse(repaired); if (ok2.success) return { output: ok2.data, qa: { llm_repair_used: true } };
  throw new Error("contract_risk_schema_validation_failed");
}

function assessContractRiskNarrativeQuality(output: ContractRiskOutput, supportTexts: Array<unknown>) {
  return assessNarrativeQuality({
    texts: [
      ...(output.high_risk_clauses || []).flatMap((item) => [item.title, item.issue, item.impact, ...(item.recommendation || [])]),
      ...(output.medium_risk_clauses || []).flatMap((item) => [item.title, item.issue, item.impact, ...(item.recommendation || [])]),
      ...(output.low_risk_clauses || []).flatMap((item) => [item.title, item.issue, item.impact, ...(item.recommendation || [])]),
      ...(output.missing_clauses_list || []).flatMap((item) => [item.clause_name, item.why_it_matters, item.suggested_text]),
      ...(output.suggestions?.negotiation_priorities || []),
      ...(output.suggestions?.red_flags || []),
      ...(output.suggestions?.quick_improvements || []),
      output.dispute_resolution_and_settlement?.dispute_clause_summary,
      output.dispute_resolution_and_settlement?.negotiation_script,
      ...(output.dispute_resolution_and_settlement?.recommended_path || []),
      ...(output.dispute_resolution_and_settlement?.red_flags_to_avoid || []),
      ...(output.dispute_resolution_and_settlement?.settlement_options || []).flatMap((item) => [item.option, item.when_to_use, item.upside, item.risk]),
    ],
    supportTexts,
    minSupportOverlap: 6,
    minCombinedLength: 220,
    maxGenericPhraseHits: 1,
  });
}

function isContractRiskAdvisoryReason(value: unknown) {
  const text = String(value || "").toLowerCase();
  if (!text.trim()) return false;
  return /not\s+a\s+contract|non[-\s]?contract|litigation pleading|case document|court pleading|agreement document|requires a contract|not a contract\/agreement|insufficient contract text|does not appear to be a complete contract|incomplete contract/i.test(
    text,
  );
}

function enforceContractRiskGrounding(output: ContractRiskOutput, supportTexts: Array<unknown>) {
  if (!(output.suggestions?.negotiation_priorities || []).length) {
    const fallbackPriorities = [
      ...(output.high_risk_clauses || []).slice(0, 3).map((f) => `${f.category}: ${f.issue}`),
      ...(output.medium_risk_clauses || []).slice(0, 2).map((f) => `${f.category}: ${f.issue}`),
      ...(output.missing_clauses_list || []).slice(0, 2).map((m) => `Add ${m.clause_name} clause`),
      ...((output.dispute_resolution_and_settlement?.dispute_clause_found === false)
        ? ["Add a clear dispute resolution clause (notice, cure, forum/arbitration)."]
        : []),
    ]
      .map((x) => trimWords(String(x || ""), 20))
      .filter(Boolean);
    output.suggestions = output.suggestions || { negotiation_priorities: [], red_flags: [], quick_improvements: [] };
    output.suggestions.negotiation_priorities = [...new Set(fallbackPriorities)].slice(0, 5);
  }
  for (const list of [output.high_risk_clauses, output.medium_risk_clauses, output.low_risk_clauses]) {
    for (const f of list || []) {
      if (f.evidence?.snippet) f.evidence.snippet = trimWords(f.evidence.snippet, 25);
    }
  }
  output.citations = (output.citations || [])
    .map((c) => ({ ...c, snippet: trimWords(c.snippet, 25) }))
    .filter((c) => !!c.snippet);
  const evidenceBackedFindings = [...(output.high_risk_clauses || []), ...(output.medium_risk_clauses || []), ...(output.low_risk_clauses || [])]
    .filter((f) => !!f?.evidence?.snippet).length;
  const totalClauses = Number(output?.counts?.total_clauses_found || 0);
  const hasAnyCitation = (output.citations || []).length >= 1;
  const hasEvidence = evidenceBackedFindings > 0 || totalClauses > 0;
  // Contract runs should remain valid when grounded evidence exists, even if only deterministic fallback is available.
  output.analysis_valid = Boolean(output.analysis_valid ?? true) && hasAnyCitation && hasEvidence;
  if (output.analysis_valid && String(output.mode || "").toLowerCase().includes("deterministic")) {
    output.mode = "grounded_contract_analysis";
  }
  if (!output.analysis_valid && !output.failure_reason) {
    output.failure_reason = "Insufficient grounded evidence or citations for a reliable contract risk report";
  }
  if (output.analysis_valid) {
    output.failure_reason = null;
  }
  const genericity = assessContractRiskNarrativeQuality(output, supportTexts);
  output.qa_debug = {
    ...(output.qa_debug || {}),
    genericity_gate: genericity,
  };
  if (genericity.isGeneric) {
    output.analysis_valid = false;
    if (output.mode !== "llm_refined") {
      output.mode = "deterministic_fallback";
    }
    output.failure_reason = "Contract Risk output was too generic for grounded use";
  }
  return { evidenceBackedFindings };
}

async function readLatestMatchingOutput(caseId: string, docHash: string) {
  try {
    const [rows]: any = await mysqlPool.query(`SELECT * FROM agent_outputs WHERE case_id = ? AND agent_key = ? AND doc_hash = ? ORDER BY updated_at DESC LIMIT 1`, [caseId, AGENT_KEY, docHash]);
    if (rows?.[0]) return rows[0];
  } catch {}
  const c = await prisma.case.findUnique({ where: { id: caseId }, include: { outputs: true } });
  const prismaRow = (c?.outputs || []).find((o: any) => o.agentKey === AGENT_KEY) || null;
  const payload = parsePayloadRow(prismaRow);
  const prismaDocHash = String((prismaRow as any)?.docHash || payload?.qa_debug?.doc_hash || "");
  return prismaDocHash === String(docHash || "") ? prismaRow : null;
}
async function readLatestOutput(caseId: string) {
  try {
    const [rows]: any = await mysqlPool.query(`SELECT * FROM agent_outputs WHERE case_id = ? AND agent_key = ? ORDER BY updated_at DESC LIMIT 1`, [caseId, AGENT_KEY]);
    if (rows?.[0]) return rows[0];
  } catch {}
  const c = await prisma.case.findUnique({ where: { id: caseId }, include: { outputs: true } });
  return (c?.outputs || []).find((o: any) => o.agentKey === AGENT_KEY) || null;
}
async function readRecentOutputs(caseId: string, limit = 40) {
  try {
    const [rows]: any = await mysqlPool.query(
      `SELECT * FROM agent_outputs WHERE case_id = ? AND agent_key = ? ORDER BY updated_at DESC LIMIT ?`,
      [caseId, AGENT_KEY, limit],
    );
    if (Array.isArray(rows) && rows.length) return rows;
  } catch {}
  const c = await prisma.case.findUnique({ where: { id: caseId }, include: { outputs: true } });
  const row = (c?.outputs || []).find((o: any) => o.agentKey === AGENT_KEY);
  return row ? [row] : [];
}
async function readOutputByRunId(caseId: string, runId: string) {
  const rows = await readRecentOutputs(caseId, 60);
  for (const row of rows) {
    const payload = parsePayloadRow(row);
    if (!payload) continue;
    if (String(payload?.qa_debug?.run_id || "") === String(runId)) return row;
  }
  return null;
}

function parsePayloadRow(row: any): any { if (!row) return null; if (row.payloadJson) return row.payloadJson; try { return typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json; } catch { return row.payload_json ?? null; } }
function normalizeContractRiskPayloadForDisplay(payload: any, docText?: string | null, qpOutput?: any) {
  if (!payload || typeof payload !== "object") return payload;
  const next = { ...payload };
  const contractEval = evaluateContractLikeInput(String(docText || ""), qpOutput);
  const advisoryReason = "Current file is a litigation pleading / case document, not a complete contract/agreement; showing procedural risk guidance instead.";
  if (!contractEval.isContractLike) {
    next.mode = next.mode || "grounded_contract_analysis";
    if (!String(next.failure_reason || "").trim()) {
      next.failure_reason = advisoryReason;
    } else if (!isContractRiskAdvisoryReason(next.failure_reason)) {
      next.failure_reason = `${advisoryReason} ${String(next.failure_reason || "").trim()}`.trim();
    }
    next.qa_debug = { ...(next.qa_debug || {}), advisory_mode: "non_contract_case_document", normalized_for_display: true };
    next.doc_summary = {
      ...(next.doc_summary || {}),
      doc_type_guess: next.doc_summary?.doc_type_guess || "Case / Pleading Document",
    };
  }
  return next;
}
function isRenderableContractRiskPayload(payload: any) {
  if (!payload || typeof payload !== "object") return false;
  return contractRiskOutputSchema.safeParse(payload).success;
}
function isUsableContractRiskCache(payload: any) {
  if (!payload || typeof payload !== "object") return false;
  if (payload?.qa_debug?.genericity_gate?.isGeneric) return false;
  const genericPhrases = countGenericPhraseHits([
    ...(Array.isArray(payload?.high_risk_clauses) ? payload.high_risk_clauses.flatMap((item: any) => [item?.title, item?.issue, item?.impact]) : []),
    ...(Array.isArray(payload?.medium_risk_clauses) ? payload.medium_risk_clauses.flatMap((item: any) => [item?.title, item?.issue, item?.impact]) : []),
    payload?.dispute_resolution_and_settlement?.dispute_clause_summary,
    payload?.dispute_resolution_and_settlement?.negotiation_script,
  ]);
  if (genericPhrases > 1) return false;
  const evidenceBacked = Number(payload?.qa_debug?.evidence_backed_findings || 0);
  const totalClauses = Number(payload?.counts?.total_clauses_found || 0);
  const citations = Array.isArray(payload?.citations) ? payload.citations.length : 0;
  const high = Number(payload?.counts?.high_risk || 0);
  const medium = Number(payload?.counts?.medium_risk || 0);
  const low = Number(payload?.counts?.low_risk || 0);
  const advisoryMode = String(payload?.qa_debug?.advisory_mode || "").toLowerCase() === "non_contract_case_document";
  const distVals = Object.values(payload?.risk_distribution || {}).map((v: any) => Number(v || 0));
  const uniformTemplateLike =
    String(payload?.mode || "").toLowerCase().includes("deterministic") &&
    !advisoryMode &&
    totalClauses >= 5 &&
    high === 0 &&
    medium === 0 &&
    low >= 5 &&
    distVals.length >= 4 &&
    distVals.every((v) => v <= 1);
  if (uniformTemplateLike) return false;
  return (evidenceBacked > 0 || totalClauses > 0) && citations > 0;
}

async function upsertAgentOutput(params: { caseId: string; docId: string; docHash: string; payload: ContractRiskOutput; language: string; }) {
  try {
    await mysqlPool.query(`INSERT INTO agent_outputs (id, case_id, agent_key, doc_id, doc_hash, payload_json, source_language, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3)) ON DUPLICATE KEY UPDATE doc_id=VALUES(doc_id), doc_hash=VALUES(doc_hash), payload_json=VALUES(payload_json), source_language=VALUES(source_language), updated_at=NOW(3)`, [randomUUID(), params.caseId, AGENT_KEY, params.docId, params.docHash, JSON.stringify(params.payload), params.language || "English"]);
    return;
  } catch {}
  await prisma.agentOutput.upsert({ where: { caseId_agentKey: { caseId: params.caseId, agentKey: AGENT_KEY } }, create: { caseId: params.caseId, agentKey: AGENT_KEY, payloadJson: params.payload, sourceLanguage: params.language || "en" }, update: { payloadJson: params.payload, sourceLanguage: params.language || "en" } });
}

async function withOptionalLock(lockKey: string, ttlSec: number, fn: () => Promise<any>) {
  try { await mysqlPool.query(`INSERT INTO idempotency_locks (lock_key, expires_at, created_at, updated_at) VALUES (?, DATE_ADD(NOW(3), INTERVAL ? SECOND), NOW(3), NOW(3)) ON DUPLICATE KEY UPDATE expires_at = IF(expires_at < NOW(3), VALUES(expires_at), expires_at), updated_at = NOW(3)`, [lockKey, ttlSec]); } catch {}
  try { return await fn(); } finally { await mysqlPool.query(`DELETE FROM idempotency_locks WHERE lock_key = ?`, [lockKey]).catch(() => undefined); }
}

async function updateRunProgress(runId: string, patch: Partial<RunStatusShape>) {
  const run = await prisma.run.findUnique({ where: { id: runId } }); if (!run) return;
  const currentRaw = run.stepsJson as any; const current = currentRaw && typeof currentRaw === "object" && !Array.isArray(currentRaw) ? currentRaw as RunStatusShape : makeRunStatus();
  const next: RunStatusShape = { ...current, ...patch, stats: { ...(current.stats || makeRunStatus().stats), ...(patch.stats || {}) }, steps: patch.steps || current.steps || makeRunStatus().steps, meta: { ...(current.meta || {}), ...(patch.meta || {}) } };
  await prisma.run.update({ where: { id: runId }, data: { stepsJson: next as any } });
}
function markContractStep(idx0: number, stats: RunStatusShape["stats"]) { return { stage: RUN_STEP_NAMES[idx0], stepIndex: idx0 + 1, stepsTotal: RUN_STEP_NAMES.length, stats, steps: RUN_STEP_NAMES.map((name, idx) => ({ name, state: idx < idx0 ? "SUCCEEDED" : idx === idx0 ? "RUNNING" : "PENDING", progress: Math.round((((idx < idx0 ? idx + 1 : idx === idx0 ? idx + 0.4 : idx) / RUN_STEP_NAMES.length)) * 100) })) as RunStep[] }; }

async function executeContractRiskRun(runId: string, caseId: string, userId: string, doc: ContractDocMeta, language: string) {
  const mapKey = `${caseId}:${doc.hash}`; inFlightByCaseDoc.set(mapKey, runId);
  try {
    runCancellationService.register(runId);
    const caseRow = await prisma.case.findUnique({ where: { id: caseId }, include: { outputs: true } });
    const qpOutput = ((caseRow?.outputs || []) as any[]).find((o) => o.agentKey === "query_parsing")?.payloadJson || null;
    const caseTitleSnapshot = String(qpOutput?.case_title || (caseRow as any)?.title || "Case Workspace").trim().slice(0, 160);
    await prisma.run.update({ where: { id: runId }, data: { status: RunStatus.RUNNING, startedAt: new Date() } });
    await updateRunProgress(runId, { ...markContractStep(0, { clausesFound: 0, risksDetected: 0, missingClauses: 0 }), meta: { agent_key: AGENT_KEY, doc_id: doc.doc_id, doc_hash: doc.hash, case_title_snapshot: caseTitleSnapshot } });
    runCancellationService.throwIfCancelled(runId);
    const contractEval = evaluateContractLikeInput(String(doc.extracted_text || ""), qpOutput);
    const draft = deterministicContractRisk(doc, language, { qpContractHint: contractEval.qpHint, qpOutput });
    const stats = { clausesFound: draft.counts.total_clauses_found, risksDetected: draft.counts.high_risk + draft.counts.medium_risk, missingClauses: draft.counts.missing_clauses };
    await updateRunProgress(runId, markContractStep(1, stats));
    await updateRunProgress(runId, markContractStep(2, stats));
    const env = getEnv();
    let output = draft; let llmQa: any = { llm_attempted: false };
    const advisoryReason = !contractEval.isContractLike
      ? "Current file is a litigation pleading / case document, not a complete contract/agreement; showing procedural risk guidance instead."
      : "";
    if (!contractEval.isContractLike) {
      output = {
        ...draft,
        mode: "grounded_contract_analysis",
        analysis_valid: draft.analysis_valid !== false,
        failure_reason: advisoryReason,
        qa_debug: { ...(draft.qa_debug || {}), llm_attempted: false, advisory_mode: "non_contract_case_document" },
      };
      llmQa = { llm_attempted: false, advisory_mode: "non_contract_case_document" };
    } else {
      try {
        const refined = await llmRefineContractRisk(runId, doc, language, draft);
        output = { ...draft, ...refined.output, agent_key: AGENT_KEY, mode: "llm_refined", generated_at: new Date().toISOString(), source_language: language, qa_debug: { ...(refined.output.qa_debug || {}), ...refined.qa } } as ContractRiskOutput;
        llmQa = { llm_attempted: true, ...refined.qa };
      } catch (e) {
        if (runCancellationService.isCancellationError(e) || runCancellationService.isCancelled(runId)) throw e;
        output = { ...draft, mode: "grounded_contract_analysis", qa_debug: { ...(draft.qa_debug || {}), llm_attempted: true, llm_failed: String((e as any)?.message || e) } };
        llmQa = { llm_attempted: true, llm_failed: true, llm_required_mode: env.REQUIRE_LLM_OUTPUT === true };
      }
    }
    runCancellationService.throwIfCancelled(runId);
    await updateRunProgress(runId, markContractStep(3, stats));
    if (output.citations.length < 3) {
      for (const c of [...output.high_risk_clauses, ...output.medium_risk_clauses, ...output.low_risk_clauses].map((x) => x.evidence).filter(Boolean) as Citation[]) {
        if (!output.citations.find((e) => e.doc_id === c.doc_id && e.snippet === c.snippet)) output.citations.push(c); if (output.citations.length >= 3) break;
      }
    }
    const { evidenceBackedFindings } = enforceContractRiskGrounding(output, [
      doc.extracted_text,
      qpOutput?.executive_summary,
      qpOutput?.summary,
      ...(Array.isArray(qpOutput?.legal_grounds) ? qpOutput.legal_grounds : []),
      ...(output.citations || []).map((c) => c?.snippet),
    ]);
    output.qa_debug = { ...(output.qa_debug || {}), run_id: runId, doc_id: doc.doc_id, doc_hash: doc.hash, llm: llmQa, evidence_backed_findings: evidenceBackedFindings };
    await updateRunProgress(runId, markContractStep(4, { clausesFound: output.counts.total_clauses_found, risksDetected: output.counts.high_risk + output.counts.medium_risk, missingClauses: output.counts.missing_clauses }));
    await updateRunProgress(runId, markContractStep(5, { clausesFound: output.counts.total_clauses_found, risksDetected: output.counts.high_risk + output.counts.medium_risk, missingClauses: output.counts.missing_clauses }));
    await upsertAgentOutput({ caseId, docId: doc.doc_id, docHash: doc.hash, payload: output, language });
    await updateRunProgress(runId, {
      done: true,
      stage: "Completed",
      error: null,
      meta: {
        agent_key: AGENT_KEY,
        doc_id: doc.doc_id,
        doc_hash: doc.hash,
        case_title_snapshot: caseTitleSnapshot,
        risk_level: output.scores.risk_level,
        mode: output.mode || "grounded_contract_analysis",
        evidence_backed_findings: evidenceBackedFindings,
        analysis_valid: output.analysis_valid !== false,
        total_clauses_found: Number(output?.counts?.total_clauses_found || 0),
      },
    });
    await prisma.run.update({ where: { id: runId }, data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() } });
    const title = output.analysis_valid === false ? "Contract Risk completed with warnings" : "Contract Risk completed";
    const body = output.analysis_valid === false
      ? `Contract Risk generated a review-needed output for case ${caseId}`
      : `Contract Risk generated output for case ${caseId}`;
    await notificationService.create(userId, title, body);
  } catch (error) {
    const reason = String((error as any)?.message || error);
    if (runCancellationService.isCancellationError(error) || runCancellationService.isCancelled(runId)) {
      await updateRunProgress(runId, { done: true, stage: "Cancelled", error: "Run cancelled by user", meta: { agent_key: AGENT_KEY, doc_id: doc.doc_id, doc_hash: doc.hash, cancelled: true } }).catch(() => undefined);
      await prisma.run.update({ where: { id: runId }, data: { status: RunStatus.FAILED, finishedAt: new Date() } }).catch(() => undefined);
      await notificationService.create(userId, "Contract Risk cancelled", `Contract Risk was cancelled for case ${caseId}`).catch(() => undefined);
      return;
    }
    try {
      const fallback = deterministicContractRisk(doc, language, { qpContractHint: false, qpOutput: null });
      fallback.mode = "grounded_contract_analysis";
      fallback.failure_reason = reason;
      fallback.qa_debug = { ...(fallback.qa_debug || {}), run_id: runId, hard_error: reason, llm_required_mode: getEnv().REQUIRE_LLM_OUTPUT === true };
      const { evidenceBackedFindings } = enforceContractRiskGrounding(fallback, [
        doc.extracted_text,
        ...(fallback.citations || []).map((c) => c?.snippet),
      ]);
      fallback.qa_debug = { ...(fallback.qa_debug || {}), evidence_backed_findings: evidenceBackedFindings };
      await upsertAgentOutput({ caseId, docId: doc.doc_id, docHash: doc.hash, payload: fallback, language });
      await updateRunProgress(runId, {
        done: true,
        stage: "Completed",
        error: null,
        meta: { agent_key: AGENT_KEY, doc_id: doc.doc_id, doc_hash: doc.hash, mode: "grounded_contract_analysis", analysis_valid: fallback.analysis_valid !== false, failure_reason: fallback.failure_reason || reason },
      });
      await prisma.run.update({ where: { id: runId }, data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() } });
      await notificationService.create(
        userId,
        fallback.analysis_valid === false ? "Contract Risk completed with warnings" : "Contract Risk completed",
        fallback.analysis_valid === false
          ? `Contract Risk generated a review-needed output for case ${caseId}: ${reason}`
          : `Contract Risk generated fallback output for case ${caseId}`,
      );
    } catch {
      await updateRunProgress(runId, { done: true, error: reason });
      await prisma.run.update({ where: { id: runId }, data: { status: RunStatus.FAILED, finishedAt: new Date() } });
      await notificationService.create(userId, "Contract Risk failed", `Contract Risk failed for case ${caseId}: ${reason}`);
    }
  } finally {
    if (inFlightByCaseDoc.get(mapKey) === runId) inFlightByCaseDoc.delete(mapKey);
    runCancellationService.clear(runId);
  }
}

function toSingleLine(value: unknown, fallback = "N/A") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function toDateTime(value?: string | number | Date | null) {
  if (!value) return "N/A";
  const dt = new Date(value);
  if (!Number.isFinite(dt.getTime())) return "N/A";
  return dt.toLocaleString();
}

function shorten(value: unknown, max = 420) {
  const text = toSingleLine(value, "");
  if (!text) return "";
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...` : text;
}

function reportStatusLabel(analysisValid: unknown) {
  return analysisValid === false ? "Needs Review" : "Complete";
}

function reportReviewNote(analysisValid: unknown) {
  if (analysisValid !== false) return null;
  return "This report was generated from available case inputs and may require legal review before final use.";
}

function citationSourceLabel(source?: unknown) {
  const key = String(source || "").toLowerCase();
  if (key.includes("user_doc") || key.includes("user doc")) return "Case File";
  if (key.includes("legal_corpus") || key.includes("legal corpus")) return "Legal Reference";
  if (key.includes("current_input") || key.includes("current input")) return "Submitted Query";
  return "Source";
}

async function renderContractRiskPdf(payload: ContractRiskOutput, caseId: string) {
  return await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 42, bottom: 42, left: 42, right: 42 },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const pageBottomY = doc.page.height - doc.page.margins.bottom;

    const ensureSpace = (minHeight = 28) => {
      if (doc.y + minHeight > pageBottomY) doc.addPage();
    };
    const heading = (text: string) => {
      ensureSpace(28);
      doc.moveDown(0.1);
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f172a").text(text, { width: pageWidth });
      doc.moveDown(0.15);
    };
    const line = (label: string, value: unknown) => {
      ensureSpace(16);
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#111827").text(`${label}: `, { continued: true, width: pageWidth });
      doc.font("Helvetica").fontSize(10).fillColor("#111827").text(toSingleLine(value), { width: pageWidth });
    };
    const paragraph = (value: unknown) => {
      ensureSpace(16);
      doc.font("Helvetica").fontSize(10).fillColor("#111827").text(toSingleLine(value), {
        width: pageWidth,
        lineGap: 1.2,
      });
    };
    const bullets = (items: unknown[], maxItems = 8) => {
      const list = (items || []).map((x) => toSingleLine(x, "")).filter(Boolean).slice(0, maxItems);
      if (!list.length) {
        paragraph("N/A");
        return;
      }
      for (const item of list) {
        ensureSpace(14);
        doc.font("Helvetica").fontSize(10).fillColor("#111827").text(`- ${item}`, {
          width: pageWidth,
          lineGap: 1.1,
          indent: 8,
        });
      }
    };

    const high = Array.isArray(payload.high_risk_clauses) ? payload.high_risk_clauses : [];
    const medium = Array.isArray(payload.medium_risk_clauses) ? payload.medium_risk_clauses : [];
    const low = Array.isArray(payload.low_risk_clauses) ? payload.low_risk_clauses : [];
    const findings = [...high, ...medium, ...low];

    doc.font("Helvetica-Bold").fontSize(18).fillColor("#0b1220").text("Contract Risk Review Report", { width: pageWidth });
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(10).fillColor("#374151").text(`Case ID: ${caseId}`, { width: pageWidth });
    doc.text(`Generated At: ${toDateTime(payload.generated_at || new Date().toISOString())}`, { width: pageWidth });
    doc.text(`Report Status: ${reportStatusLabel(payload.analysis_valid)}`, { width: pageWidth });
    const reviewNote = reportReviewNote(payload.analysis_valid);
    if (reviewNote) doc.text(reviewNote, { width: pageWidth });
    doc.moveDown(0.35);

    heading("Executive Summary");
    line("Document Type", payload.doc_summary?.doc_type_guess || "Unknown");
    line("Language", payload.doc_summary?.language || payload.source_language || "Unknown");
    line("Risk Level", payload.scores?.risk_level || "N/A");
    line("Overall Risk Score (0-10)", payload.scores?.overall_risk_score ?? "N/A");
    line("Total Clauses Found", payload.counts?.total_clauses_found ?? 0);
    line("High / Medium / Low", `${payload.counts?.high_risk ?? 0} / ${payload.counts?.medium_risk ?? 0} / ${payload.counts?.low_risk ?? 0}`);
    line("Missing Clauses", payload.counts?.missing_clauses ?? 0);
    const parties = Array.isArray(payload.doc_summary?.parties) ? payload.doc_summary.parties.map((p) => toSingleLine(p, "")).filter(Boolean) : [];
    line("Parties", parties.length ? parties.join("; ") : "N/A");
    line("Effective Date", payload.doc_summary?.effective_date || "N/A");
    line("Term", payload.doc_summary?.term || "N/A");

    heading("Top Clause Findings");
    if (!findings.length) {
      paragraph("No clause findings available.");
    } else {
      for (const finding of findings.slice(0, 10)) {
        ensureSpace(58);
        doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#0b1220").text(
          `${toSingleLine(finding.title)} [${String(finding.severity || "").toUpperCase() || "N/A"} | ${toSingleLine(finding.category)} | ${Math.round(Number(finding.confidence || 0))}%]`,
          { width: pageWidth },
        );
        paragraph(`Issue: ${shorten(finding.issue, 320)}`);
        paragraph(`Impact: ${shorten(finding.impact, 320)}`);
        if (Array.isArray(finding.recommendation) && finding.recommendation.length) {
          bullets((finding.recommendation || []).slice(0, 3).map((x) => `Recommendation: ${toSingleLine(x)}`), 3);
        }
        if (finding.evidence?.snippet) paragraph(`Evidence: ${shorten(finding.evidence.snippet, 260)}`);
        doc.moveDown(0.25);
      }
    }

    heading("Missing Clauses");
    if (!Array.isArray(payload.missing_clauses_list) || !payload.missing_clauses_list.length) {
      paragraph("No missing clauses identified.");
    } else {
      for (const item of payload.missing_clauses_list.slice(0, 8)) {
        ensureSpace(42);
        doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#0b1220").text(
          `${toSingleLine(item.clause_name)} (${Math.round(Number(item.confidence || 0))}%)`,
          { width: pageWidth },
        );
        paragraph(`Why it matters: ${shorten(item.why_it_matters, 260)}`);
        paragraph(`Suggested text: ${shorten(item.suggested_text, 300)}`);
        doc.moveDown(0.2);
      }
    }

    heading("Dispute Resolution & Settlement");
    line("Dispute Clause Found", payload.dispute_resolution_and_settlement?.dispute_clause_found ? "Yes" : "No");
    paragraph(`Summary: ${shorten(payload.dispute_resolution_and_settlement?.dispute_clause_summary || "N/A", 420)}`);
    if (Array.isArray(payload.dispute_resolution_and_settlement?.recommended_path) && payload.dispute_resolution_and_settlement.recommended_path.length) {
      bullets(payload.dispute_resolution_and_settlement.recommended_path.slice(0, 6).map((x) => `Path: ${x}`), 6);
    }
    paragraph(`Negotiation Script: ${shorten(payload.dispute_resolution_and_settlement?.negotiation_script || "N/A", 480)}`);

    heading("Recommendations");
    bullets((payload.suggestions?.negotiation_priorities || []).map((x) => `Negotiation priority: ${x}`), 5);
    bullets((payload.suggestions?.red_flags || []).map((x) => `Red flag: ${x}`), 5);
    bullets((payload.suggestions?.quick_improvements || []).map((x) => `Quick improvement: ${x}`), 5);

    heading("Grounded Citations");
    if (!Array.isArray(payload.citations) || !payload.citations.length) {
      paragraph("No citations attached.");
    } else {
      for (const citation of payload.citations.slice(0, 12)) {
        ensureSpace(24);
        const label = toSingleLine(citation.source_label || citationSourceLabel(citation.source_type));
        const locator = citation.page ? ` (page ${citation.page})` : "";
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#111827").text(`${label}${locator}`, { width: pageWidth });
        paragraph(shorten(citation.snippet, 260));
      }
    }

    heading("User Questions To Confirm");
    bullets(payload.user_questions_to_confirm || [], 10);

    doc.end();
  });
}

export const contractRiskAgentService = {
  AGENT_KEY,
  schema: contractRiskOutputSchema,
  async getOverview(userId: string, caseId: string, selectedRunId?: string | null) {
    const ownedCase = await ensureOwnedCase(userId, caseId);
    let doc = await resolvePrimaryContractDoc(caseId);
    const caseWithRuns = await prisma.case.findUnique({ where: { id: caseId }, include: { runs: { orderBy: { createdAt: "desc" }, take: 30 }, outputs: true } });
    const qpOutput = ((caseWithRuns?.outputs || []) as any[]).find((o) => o.agentKey === "query_parsing")?.payloadJson || null;
    let contractEval = doc ? evaluateContractLikeInput(String(doc.extracted_text || ""), qpOutput) : { isContractLike: false, direct: false, qpHint: false };
    if (doc && !contractEval.isContractLike) {
      const alt = await resolveAlternateContractLikeDoc(caseId, qpOutput, doc.doc_id);
      if (alt) {
        doc = alt;
        contractEval = evaluateContractLikeInput(String(doc.extracted_text || ""), qpOutput);
      }
    }
    const contractLikeInput = contractEval.isContractLike;
    const agentRuns = ((caseWithRuns?.runs || []) as any[]).filter((r) => {
      const sj = r.stepsJson as any;
      return sj && typeof sj === "object" && !Array.isArray(sj) && sj.meta?.agent_key === AGENT_KEY;
    });
    let latestAgentRun = agentRuns[0] || null;
    if (latestAgentRun && isStaleRunningRun(latestAgentRun)) {
      await prisma.run.update({ where: { id: latestAgentRun.id }, data: { status: RunStatus.FAILED, finishedAt: new Date() } }).catch(() => undefined);
      await updateRunProgress(latestAgentRun.id, { done: true, error: "Stale contract risk run timed out" }).catch(() => undefined);
      latestAgentRun = { ...latestAgentRun, status: RunStatus.FAILED } as any;
    }
    const latest = doc ? await readLatestOutput(caseId) : null;
    const latestPayload = normalizeContractRiskPayloadForDisplay(parsePayloadRow(latest), doc?.extracted_text || "", qpOutput);
    const matching = doc && latest && ((latest.doc_hash && String(latest.doc_hash) === doc.hash) || (latestPayload?.qa_debug?.doc_hash === doc.hash)) ? latestPayload : null;
    const latestRenderable = isRenderableContractRiskPayload(latestPayload);
    const matchingUsable = isUsableContractRiskCache(matching);
    const hasSavedMatchingOutput = !!matching;
    const rawCaseTitle = String((ownedCase as any).title || "").trim();
    const effectiveCaseTitle =
      rawCaseTitle && !["current case workspace", "quick query workspace", "query parsing workspace"].includes(rawCaseTitle.toLowerCase())
        ? rawCaseTitle
        : String(qpOutput?.case_title || rawCaseTitle || "Case Workspace").trim();
    const hasRenderableMatchingOutput = isRenderableContractRiskPayload(matching);
    const latestSavedRunId = String(
      matching?.qa_debug?.run_id ||
      latestPayload?.qa_debug?.run_id ||
      "",
    ).trim() || null;
    const latestBlocked = false;
    const latest_output_status: "none" | "running" | "done" | "error" | "blocked" =
      !doc ? "none" :
      latestRenderable ? "done" :
      hasRenderableMatchingOutput ? "done" :
      hasSavedMatchingOutput ? "done" :
      latestAgentRun?.status === RunStatus.RUNNING ? "running" :
      latestAgentRun?.status === RunStatus.FAILED ? "error" :
      "none";
    const latest_run_id =
      !doc ? null :
      latestRenderable ? latestSavedRunId :
      hasRenderableMatchingOutput ? latestSavedRunId :
      hasSavedMatchingOutput ? latestSavedRunId :
      latestAgentRun?.status === RunStatus.RUNNING ? latestAgentRun.id :
      latestSavedRunId;
    let userRuns: any[] = [];
    try {
      const [rows]: any = await mysqlPool.query(
        `SELECT r.id, r.case_id, r.status, r.created_at, r.steps_json, c.title AS case_title
         FROM runs r
         INNER JOIN cases c ON c.id = r.case_id
         WHERE c.user_id = ?
         ORDER BY r.created_at DESC
         LIMIT 120`,
        [userId],
      );
      userRuns = Array.isArray(rows) ? rows.map((row: any) => {
        let stepsJson = row.steps_json;
        if (typeof stepsJson === "string") {
          try { stepsJson = JSON.parse(stepsJson); } catch {}
        }
        return {
          id: String(row.id),
          caseId: String(row.case_id),
          status: String(row.status),
          createdAt: new Date(row.created_at),
          stepsJson,
          case: { title: row.case_title || null },
        };
      }) : [];
    } catch {
      userRuns = [];
    }
    const recent_runs = (userRuns as any[])
      .filter((r) => {
        const sj = r.stepsJson as any;
        return sj && typeof sj === "object" && !Array.isArray(sj) && sj.meta?.agent_key === AGENT_KEY;
      })
      .slice(0, 5)
      .map((r) => {
      const sj = r.stepsJson as any;
      const fallbackLike = sj?.meta?.analysis_valid === false || Number(sj?.meta?.evidence_backed_findings || 0) <= 0;
      const caseTitleForRun = String(
        sj?.meta?.case_title_snapshot ||
        r.case?.title ||
        "Case Workspace",
      ).trim();
      const normalizedStatus =
        latestSavedRunId && String(latestSavedRunId) === String(r.id)
          ? "Succeeded"
          : String(r.status || "").toUpperCase() === RunStatus.RUNNING && latestRenderable
            ? "Succeeded"
            :
        String(r.status || "").toUpperCase() === RunStatus.RUNNING && isStaleRunningRun(r)
          ? "Failed"
          : r.status === "SUCCEEDED"
            ? "Succeeded"
            : r.status === "FAILED"
              ? "Failed"
              : r.status;
      return {
        run_id: r.id,
        case_id: r.caseId,
        status: normalizedStatus,
        timestamp: r.createdAt.toISOString(),
        case_title: caseTitleForRun,
        risk_level: String(normalizedStatus) === "Succeeded" && !fallbackLike ? (sj?.meta?.risk_level || null) : null,
      };
    });
    const selectedRun = selectedRunId
      ? ((userRuns as any[]).find((r) => String(r.id) === String(selectedRunId)) || null)
      : null;
    const selectedRunSteps = (selectedRun?.stepsJson && typeof selectedRun.stepsJson === "object" && !Array.isArray(selectedRun.stepsJson))
      ? selectedRun.stepsJson as any
      : null;
    const selectedRow = selectedRunId ? await readOutputByRunId(caseId, String(selectedRunId)) : null;
    const selectedPayload = normalizeContractRiskPayloadForDisplay(parsePayloadRow(selectedRow), doc?.extracted_text || "", qpOutput);
    const selectedRenderable = isRenderableContractRiskPayload(selectedPayload);
    const effectivePayload = selectedRenderable ? selectedPayload : (matching || (latestRenderable ? latestPayload : null));
    const effectiveRunId = selectedRenderable ? String(selectedRunId) : latest_run_id || null;
    const viewingHistorical = Boolean(selectedRenderable && selectedRunId && String(selectedRunId) !== String(latest_run_id || ""));
    const effectiveBlocked = false;
    const effectiveAnalysisValid = effectivePayload
      ? !!isUsableContractRiskCache(effectivePayload) &&
        (Number(effectivePayload?.qa_debug?.evidence_backed_findings || 0) > 0 || Number(effectivePayload?.counts?.total_clauses_found || 0) > 0)
      : false;
    const effectiveStatus: "none" | "running" | "done" | "error" | "blocked" =
      selectedRunId
        ? selectedRenderable
          ? (effectiveBlocked ? "blocked" : "done")
          : selectedPayload
            ? (effectiveBlocked ? "blocked" : "done")
          : selectedRun?.status === RunStatus.RUNNING
            ? "running"
            : selectedRun?.status === RunStatus.FAILED
              ? "error"
              : "none"
        : (
          !doc ? "none" :
          latestRenderable ? (effectiveBlocked ? "blocked" : "done") :
          hasRenderableMatchingOutput ? (effectiveBlocked ? "blocked" : "done") :
          hasSavedMatchingOutput ? (effectiveBlocked ? "blocked" : "done") :
          latestAgentRun?.status === RunStatus.RUNNING ? "running" :
          latestAgentRun?.status === RunStatus.FAILED ? "error" :
          "none"
        );
    const latestObj = {
      status: effectiveStatus,
      run_id: effectiveRunId,
      output: effectiveStatus === "done" ? effectivePayload : null,
      mode: effectiveBlocked ? "advisory" : effectivePayload?.mode === "deterministic_fallback" ? "fallback" : "normal",
      analysis_valid: effectiveAnalysisValid,
      failure_reason: effectivePayload ? (effectivePayload?.failure_reason || null) : "Latest saved report requires refresh (low-signal/templated output detected). Re-run analysis.",
    };
    return {
      agent_key: AGENT_KEY,
      case: {
        case_id: caseId,
        title: effectiveCaseTitle || "Case Workspace",
        domain: (ownedCase as any).domainPrimary || (ownedCase as any).domain_primary || "General",
        language: (ownedCase as any).language || "English",
      },
      primary_doc: doc ? {
        doc_id: doc.doc_id,
        filename: doc.filename,
        mime_type: doc.mime,
        kind: doc.kind || null,
        pages: doc.pages ?? null,
        char_count: doc.char_count ?? null,
        updated_at: doc.updated_at,
        language: doc.language,
      } : null,
      latest_output_status: effectiveStatus,
      latest_run_id: effectiveRunId,
      latest_output: effectiveStatus === "done" ? effectivePayload : null,
      latest: latestObj,
      selected_run: selectedRun ? {
        run_id: String(selectedRun.id),
        status: String(selectedRun.status),
        timestamp: selectedRun.createdAt.toISOString(),
        case_title: String(selectedRunSteps?.meta?.case_title_snapshot || selectedRun.case?.title || effectiveCaseTitle || "Case Workspace").trim(),
        doc_hash: String(selectedRunSteps?.meta?.doc_hash || selectedPayload?.qa_debug?.doc_hash || ""),
        viewing_historical: viewingHistorical,
      } : null,
      qa_debug: {
        case_id: caseId,
        primary_doc_id: (ownedCase as any).primaryDocId || null,
        doc_hash: doc?.hash || null,
        contract_like_text: contractLikeInput,
        contract_like_direct: contractEval.direct,
        contract_like_query_parsing_hint: contractEval.qpHint,
        extracted_text_exists: !!doc?.extracted_text?.trim(),
        query_parsing_output_exists: !!qpOutput,
        last_run_id: latestAgentRun?.id || null,
        last_run_status: latestAgentRun?.status || null,
      },
      query_parsing: {
        output: qpOutput ? {
          case_title: qpOutput.case_title,
          domain: qpOutput.domain,
          executive_summary: qpOutput.executive_summary || qpOutput.summary || null,
        } : null,
      },
      recent_runs,
      cache_fresh: !!matching,
    };
  },
  async getOutput(userId: string, caseId: string, selectedRunId?: string | null) {
    await ensureOwnedCase(userId, caseId);
    const doc = await resolvePrimaryContractDoc(caseId);
    const qpCase = await prisma.case.findUnique({ where: { id: caseId }, include: { outputs: true } });
    const qpOutput = ((qpCase?.outputs || []) as any[]).find((o) => o.agentKey === "query_parsing")?.payloadJson || null;
    if (selectedRunId) {
      const selectedRow = await readOutputByRunId(caseId, String(selectedRunId));
      const byRun = normalizeContractRiskPayloadForDisplay(parsePayloadRow(selectedRow), doc?.extracted_text || "", qpOutput);
      if (isRenderableContractRiskPayload(byRun)) return byRun;
    }
    const latest = doc ? await readLatestMatchingOutput(caseId, doc.hash) : await readLatestOutput(caseId);
    const payload = normalizeContractRiskPayloadForDisplay(parsePayloadRow(latest), doc?.extracted_text || "", qpOutput);
    if (isRenderableContractRiskPayload(payload)) return payload;
    const anyLatest = normalizeContractRiskPayloadForDisplay(parsePayloadRow(await readLatestOutput(caseId)), doc?.extracted_text || "", qpOutput);
    if (isRenderableContractRiskPayload(anyLatest)) return anyLatest;
    if (doc) {
      return normalizeContractRiskPayloadForDisplay(
        deterministicContractRisk(doc, doc.language || "English", { qpContractHint: !!qpOutput, qpOutput }),
        doc.extracted_text || "",
        qpOutput,
      );
    }
    throw new HttpError(404, "No fresh contract risk report found for current case document. Re-run analysis.", "contract_risk_output_not_found");
  },
  async startRun(userId: string, caseId: string, input?: { force?: boolean }) {
    const c = await ensureOwnedCase(userId, caseId);
    const caseWithOutputs = await prisma.case.findUnique({ where: { id: caseId }, include: { outputs: true } });
    const qpOutput = ((caseWithOutputs?.outputs || []) as any[]).find((o) => o.agentKey === "query_parsing")?.payloadJson || null;
    let doc = await resolvePrimaryContractDoc(caseId);
    if (!doc) {
      doc = buildSyntheticContractDoc(caseId, c.language || "English", qpOutput, c.title);
    }
    let contractEval = evaluateContractLikeInput(String(doc.extracted_text || ""), qpOutput);
    if (!contractEval.isContractLike) {
      const alt = await resolveAlternateContractLikeDoc(caseId, qpOutput, doc.doc_id);
      if (alt) {
        doc = alt;
        contractEval = evaluateContractLikeInput(String(doc.extracted_text || ""), qpOutput);
      }
    }
    const cached = await readLatestMatchingOutput(caseId, doc.hash);
    if (cached && !input?.force) {
      const cachedPayload = parsePayloadRow(cached);
      if (isRenderableContractRiskPayload(cachedPayload)) return { status: "cached", output: cachedPayload };
    }
    const mapKey = `${caseId}:${doc.hash}`; const inflight = inFlightByCaseDoc.get(mapKey); if (inflight) return { status: "running", run_id: inflight };
    const caseWithRuns = await prisma.case.findUnique({ where: { id: caseId }, include: { runs: { orderBy: { createdAt: "desc" }, take: 20 } } });
    const existingRunning = ((caseWithRuns?.runs || []) as any[]).find((r) => { const sj = r.stepsJson as any; return r.status === RunStatus.RUNNING && sj && typeof sj === "object" && !Array.isArray(sj) && sj.meta?.agent_key === AGENT_KEY && sj.meta?.doc_hash === doc.hash; });
    if (existingRunning) {
      if (isStaleRunningRun(existingRunning)) {
        await prisma.run.update({ where: { id: existingRunning.id }, data: { status: RunStatus.FAILED, finishedAt: new Date() } }).catch(() => undefined);
        await updateRunProgress(existingRunning.id, { done: true, error: "Stale contract risk run timed out" }).catch(() => undefined);
      } else {
        return { status: "running", run_id: existingRunning.id };
      }
    }
    const run = await prisma.run.create({ data: { caseId, status: RunStatus.PENDING, language: c.language, stepsJson: makeRunStatus({ meta: { agent_key: AGENT_KEY, doc_id: doc.doc_id, doc_hash: doc.hash } }) as any, startedAt: new Date() } });
    setImmediate(() => { void withOptionalLock(`${AGENT_KEY}:${caseId}:${doc.hash}`, 600, async () => { const recached = await readLatestMatchingOutput(caseId, doc.hash); if (recached && !input?.force) { const recachedPayload = parsePayloadRow(recached); if (isRenderableContractRiskPayload(recachedPayload)) { await prisma.run.update({ where: { id: run.id }, data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() } }); await updateRunProgress(run.id, { done: true, stage: "Completed (cached)", meta: { agent_key: AGENT_KEY, doc_id: doc.doc_id, doc_hash: doc.hash } }); return; } } await executeContractRiskRun(run.id, caseId, userId, doc, c.language || "English"); }); });
    return { status: "queued", run_id: run.id };
  },
  async exportPdf(userId: string, caseId: string) {
    const payload = await this.getOutput(userId, caseId);
    const parsed = contractRiskOutputSchema.parse(payload);
    const buffer = await renderContractRiskPdf(parsed, caseId);
    return {
      buffer,
      filename: `contract-risk-${String(caseId || "report")}.pdf`,
    };
  },
};
