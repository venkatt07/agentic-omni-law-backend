import { randomUUID } from "crypto";
import { z } from "zod";
import { HttpError } from "../middleware/error.js";
import { mysqlPool, prisma } from "../prisma/client.js";
import { RunStatus } from "../db/types.js";
import type { RunStep } from "../types/api.js";
import { agentRunner } from "./agents/agentRunner.js";
import { sha256 } from "../utils/hash.js";
import { retriever } from "./retrieval/retriever.js";
import { makeCitationRefs } from "../utils/citations.js";
import { getEnv } from "../config/env.js";
import { legalCorpusIndexService } from "./legalCorpusIndex.service.js";
import { notificationService } from "./notification.service.js";
import { runCancellationService } from "./runCancellation.service.js";
import { assessNarrativeQuality, countGenericPhraseHits } from "./quality/genericity.service.js";
import { resolveCaseDocumentMetas, resolveCaseWorkspaceSummary, resolvePrimaryCaseDocumentMeta } from "./documentMeta.service.js";
import { createPdfBuffer, shortenText, toDateTime, toSingleLine } from "../utils/pdf.js";

const AGENT_KEY = "policy_compliance";
const RUN_STEP_NAMES = [
  "Extracting facts",
  "Retrieving evidence",
  "Retrieving legal corpus",
  "Generating report",
  "Validating schema",
] as const;

const policyCitationSchema = z.object({
  ref: z.string().min(1),
  source_type: z.enum(["user_doc", "legal_corpus"]),
  doc_id: z.string(),
  page: z.number().nullable().optional(),
  offset_start: z.number().nullable().optional(),
  offset_end: z.number().nullable().optional(),
  snippet: z.string().min(1),
});

const policyComplianceOutputSchema = z.object({
  framework_selected: z.string(),
  overall_score: z.number().min(0).max(100),
  risk_level: z.enum(["Low", "Medium", "High"]),
  counts: z.object({
    critical: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    compliant: z.number().int().nonnegative(),
  }),
  category_scores: z.array(z.object({
    category: z.string(),
    score: z.number().min(0).max(100),
    critical: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    compliant: z.number().int().nonnegative(),
  })),
  violations: z.array(z.object({
    severity: z.enum(["Critical", "Medium"]),
    title: z.string(),
    why_it_matters: z.string(),
    recommended_fix: z.string(),
    law_basis: z.array(z.object({ citation_ref: z.string() })).default([]),
    case_evidence: z.array(z.object({ citation_ref: z.string() })).default([]),
    confidence: z.number().min(0).max(1),
  })).default([]),
  remediation_plan: z.array(z.object({
    step: z.number().int().positive(),
    action: z.string(),
    priority: z.enum(["High", "Medium", "Low"]),
    owner: z.enum(["Client", "Lawyer", "Both"]),
    depends_on: z.array(z.string()).default([]),
  })).default([]),
  decision_support: z.object({
    best_path: z.enum(["Negotiate", "Send Notice", "Litigate", "Arbitrate", "File Complaint", "Unknown"]),
    reasoning: z.string(),
    what_changes_the_outcome: z.array(z.string()).default([]),
  }),
  citations: z.array(policyCitationSchema).min(1),
  analysis_valid: z.boolean(),
  mode: z.enum(["normal", "fallback"]),
  failure_reason: z.string().nullable(),
  clarifying_questions: z.array(z.string()).max(3).default([]),
  qa_debug: z.record(z.any()).optional(),
});

type PolicyComplianceOutput = z.infer<typeof policyComplianceOutputSchema>;
type DocMeta = { doc_id: string; filename: string; mime_type: string; kind?: string | null; updated_at: string; language: string; extracted_text: string; hash: string; pages: number | null; char_count: number | null };
type RunStatusShape = { stage: string; stepIndex: number; stepsTotal: number; stats: Record<string, any>; done: boolean; error?: string | null; steps: RunStep[]; meta: Record<string, any> };

const FRAMEWORKS = [
  "Indian Contract & Commercial",
  "Tenancy / Rent & Property",
  "Consumer Protection",
  "Employment & Labour",
  "Arbitration & ADR",
  "Digital / IT & Privacy",
  "Civil Procedure (High-level)",
] as const;

export const POLICY_COMPLIANCE_SYSTEM_PROMPT = `You are the Policy Compliance + Legal Risk Impact / Decision Support agent for an India civil-law case workspace.
Use the case workspace as the source of truth.
Inputs priority: (1) case documents extracted text and retrieved user_doc snippets, (2) query parsing output as hints, (3) legal corpus retrieval if available.
Do not hallucinate statutes, regulations, or case-law. Cite law only when supported by provided legal_corpus snippets.
If legal corpus retrieval is empty, explicitly state "No corpus citation found" and lower confidence.
Every key claim must be supported by verbatim citations (<=25 words). Tie each violation to case_evidence and law_basis citation refs where available.
Use clear, plain English. Keep sentences short and avoid legal jargon. If a legal term is required, explain it in simple words.
Return only valid JSON in the required schema.`;

export const POLICY_COMPLIANCE_REPAIR_PROMPT = `Fix the previous output into valid JSON only.
Do not invent facts or legal citations.
Preserve grounded content and schema fields exactly.
If legal corpus citations are unavailable, keep law_basis empty and lower confidence instead of fabricating statutes.`;

const inFlight = new Map<string, string>();
const RUN_STALE_MS = 10 * 60 * 1000;

function trimWords(text: string, max = 25) {
  return String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, max).join(" ");
}

function isStaleRunningRun(run: any) {
  if (!run || String(run.status || "").toUpperCase() !== RunStatus.RUNNING) return false;
  const ts = new Date(run.updatedAt || run.startedAt || run.createdAt || Date.now()).getTime();
  if (!Number.isFinite(ts)) return false;
  return (Date.now() - ts) > RUN_STALE_MS;
}

async function ensureOwnedCase(userId: string, caseId: string) {
  const c = await prisma.case.findUnique({ where: { id: caseId }, include: { user: true } });
  if (!c || c.userId !== userId) throw new HttpError(404, "Case not found", "case_not_found");
  return c as any;
}

async function resolvePrimaryDoc(caseId: string): Promise<DocMeta | null> {
  const candidate = await resolvePrimaryCaseDocumentMeta(caseId);
  if (!candidate) return null;
  return {
    doc_id: candidate.doc_id,
    filename: candidate.filename,
    mime_type: candidate.mime_type,
    kind: candidate.kind || null,
    updated_at: candidate.updated_at,
    language: candidate.language || "English",
    extracted_text: candidate.extracted_text,
    hash: String(candidate.checksum || sha256(`${candidate.doc_id}:${candidate.extracted_text}`)),
    pages: candidate.pages,
    char_count: candidate.char_count,
  };
}

function parsePayloadRow(row: any): any {
  if (!row) return null;
  const raw = row.payloadJson || (() => {
    try { return typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json; } catch { return row.payload_json ?? null; }
  })();
  return normalizePolicyPayload(raw);
}

function hasRenderablePolicyPayload(payload: any) {
  if (!payload || typeof payload !== "object") return false;
  if (typeof payload.overall_score === "number") return true;
  if (Array.isArray(payload.citations) && payload.citations.length > 0) return true;
  if (Array.isArray(payload.violations) && payload.violations.length > 0) return true;
  return String(payload?.decision_support?.reasoning || "").trim().length > 0;
}

function isNonBlockingPolicyReason(reason: unknown) {
  const normalized = String(reason || "").trim().toLowerCase();
  if (!normalized) return true;
  return normalized.includes("no legal corpus citations available")
    || normalized.includes("results are heuristic and should be reviewed")
    || normalized.includes("insufficient grounded user/document citations");
}

function normalizePolicyPayload(payload: any) {
  if (!payload || typeof payload !== "object") return payload;
  const normalized = {
    ...payload,
    qa_debug: payload?.qa_debug && typeof payload.qa_debug === "object" ? { ...payload.qa_debug } : payload?.qa_debug,
  } as any;
  const citations = Array.isArray(normalized.citations) ? normalized.citations : [];
  const userDocCitations = citations.filter((item: any) => item?.source_type === "user_doc").length;
  const reasoning = String(normalized?.decision_support?.reasoning || "").trim();
  const hasSubstantiveSections =
    reasoning.length >= 80
    || (Array.isArray(normalized.violations) && normalized.violations.length > 0)
    || (Array.isArray(normalized.remediation_plan) && normalized.remediation_plan.length > 0)
    || (Array.isArray(normalized.category_scores) && normalized.category_scores.length > 0);
  const isGeneric = !!normalized?.qa_debug?.genericity_gate?.isGeneric;
  const groundedEnough = userDocCitations >= 1 && hasSubstantiveSections && !isGeneric;

  if (groundedEnough) {
    normalized.analysis_valid = true;
    normalized.clarifying_questions = [];
    if (isNonBlockingPolicyReason(normalized.failure_reason)) {
      normalized.failure_reason = null;
    }
    if (normalized.mode !== "normal" && !String(normalized.failure_reason || "").trim()) {
      normalized.mode = "normal";
    }
  }

  return normalized;
}

function buildEmergencyPolicyPayload(doc: DocMeta, framework?: string | null, runId?: string | null, reason?: string | null): PolicyComplianceOutput {
  return policyComplianceOutputSchema.parse({
    framework_selected: framework || FRAMEWORKS[0],
    overall_score: 35,
    risk_level: "Medium",
    counts: { critical: 0, medium: 1, compliant: 0 },
    category_scores: [],
    violations: [],
    remediation_plan: [
      {
        step: 1,
        action: "Review the saved case file and confirm the exact compliance framework before legal use.",
        priority: "High",
        owner: "Both",
        depends_on: [],
      },
    ],
    decision_support: {
      best_path: "Unknown",
      reasoning: "Emergency fallback compliance report generated from the saved case document because no persisted structured output was available.",
      what_changes_the_outcome: [
        "Add clearer framework-specific facts and supporting records.",
        "Re-run the compliance check after runtime recovery for stronger grounded output.",
      ],
    },
    citations: doc.extracted_text
      ? [{ ref: "C1", source_type: "user_doc", doc_id: doc.doc_id, page: null, offset_start: null, offset_end: null, snippet: trimWords(doc.extracted_text, 25) }]
      : [{ ref: "C1", source_type: "user_doc", doc_id: doc.doc_id, page: null, offset_start: null, offset_end: null, snippet: "Case file available but no extracted text snippet could be prepared." }],
    analysis_valid: false,
    mode: "fallback",
    failure_reason: reason || "Emergency fallback output generated from saved case text.",
    clarifying_questions: ["Please confirm the exact compliance framework to evaluate for this case."],
    qa_debug: { run_id: runId || null, emergency_fallback: true, doc_hash: doc.hash, hard_error: reason || null },
  });
}

async function readLatestOutput(caseId: string, docHash?: string) {
  try {
    const [rows]: any = await mysqlPool.query(`SELECT * FROM agent_outputs WHERE case_id=? AND agent_key=? ORDER BY updated_at DESC LIMIT 5`, [caseId, AGENT_KEY]);
    for (const row of (rows || [])) {
      const p = parsePayloadRow(row);
      if (!docHash || String(p?.qa_debug?.doc_hash || "") === String(docHash)) return row;
    }
  } catch {}
  const c = await prisma.case.findUnique({ where: { id: caseId }, include: { outputs: true } });
  const row = (c?.outputs || []).find((o: any) => o.agentKey === AGENT_KEY) || null;
  if (!row) return null;
  const payload = parsePayloadRow(row);
  if (!docHash || String(payload?.qa_debug?.doc_hash || "") === String(docHash)) return row;
  return row;
}

async function upsertAgentOutput(caseId: string, payload: PolicyComplianceOutput, language: string) {
  await prisma.agentOutput.upsert({
    where: { caseId_agentKey: { caseId, agentKey: AGENT_KEY } },
    create: { caseId, agentKey: AGENT_KEY, payloadJson: payload, sourceLanguage: language || "en" },
    update: { payloadJson: payload, sourceLanguage: language || "en" },
  });
}

function buildRunSteps(stepIndex = 0): RunStep[] {
  return RUN_STEP_NAMES.map((name, idx) => ({
    name,
    state: idx < stepIndex ? "SUCCEEDED" : idx === stepIndex ? "RUNNING" : "PENDING",
    progress: Math.round((((idx < stepIndex ? idx + 1 : idx === stepIndex ? idx + 0.4 : idx) / RUN_STEP_NAMES.length)) * 100),
  }));
}

function makeRunStatus(partial?: Partial<RunStatusShape>): RunStatusShape {
  return {
    stage: RUN_STEP_NAMES[0],
    stepIndex: 1,
    stepsTotal: RUN_STEP_NAMES.length,
    stats: {},
    done: false,
    error: null,
    steps: buildRunSteps(0),
    meta: { agent_key: AGENT_KEY },
    ...partial,
  };
}

function toPercent(value: unknown) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "N/A";
  const pct = num <= 1 ? Math.round(num * 100) : Math.round(num);
  return `${Math.max(0, Math.min(100, pct))}%`;
}

function policyReportStatusLabel(analysisValid: unknown) {
  return analysisValid === false ? "Needs Review" : "Complete";
}

function policyReportReviewNote(analysisValid: unknown) {
  if (analysisValid !== false) return null;
  return "This report was generated from available case inputs and should be reviewed before final legal use.";
}

function policyCitationLabel(sourceType: unknown) {
  const key = String(sourceType || "").toLowerCase();
  if (key.includes("user_doc") || key.includes("user doc")) return "Case File";
  if (key.includes("legal_corpus") || key.includes("legal corpus")) return "Legal Reference";
  if (key.includes("current_input") || key.includes("current input")) return "Submitted Query";
  return "Source";
}

async function renderPolicyCompliancePdf(payload: PolicyComplianceOutput, caseId: string, caseTitle?: string) {
  return createPdfBuffer((doc, h) => {
    doc.font("Helvetica-Bold").fontSize(18).fillColor("#0b1220").text("Policy Compliance Report", { width: h.pageWidth });
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(10).fillColor("#374151").text(`Case ID: ${caseId}`, { width: h.pageWidth });
    if (caseTitle) doc.text(`Case Title: ${toSingleLine(caseTitle)}`, { width: h.pageWidth });
    doc.text(`Generated At: ${toDateTime(new Date().toISOString())}`, { width: h.pageWidth });
    doc.text(`Report Status: ${policyReportStatusLabel(payload.analysis_valid)}`, { width: h.pageWidth });
    const reviewNote = policyReportReviewNote(payload.analysis_valid);
    if (reviewNote) doc.text(reviewNote, { width: h.pageWidth });
    doc.moveDown(0.35);

    h.heading("Executive Summary");
    h.line("Framework", payload.framework_selected || "N/A");
    h.line("Overall Score", `${Math.round(Number(payload.overall_score || 0))}/100`);
    h.line("Risk Level", payload.risk_level || "N/A");
    h.line("Critical / Medium / Compliant", `${payload.counts?.critical ?? 0} / ${payload.counts?.medium ?? 0} / ${payload.counts?.compliant ?? 0}`);

    h.heading("Decision Support");
    h.line("Best Path", payload.decision_support?.best_path || "Unknown");
    h.paragraph(payload.decision_support?.reasoning || "No decision reasoning provided.");
    if (payload.decision_support?.what_changes_the_outcome?.length) {
      h.subheading("What Changes the Outcome");
      h.bullets(payload.decision_support.what_changes_the_outcome, 6);
    }

    h.heading("Category Scores");
    if (!Array.isArray(payload.category_scores) || !payload.category_scores.length) {
      h.paragraph("No category scores available.");
    } else {
      h.bullets(
        payload.category_scores.slice(0, 8).map((row) => {
          const score = Number.isFinite(Number(row.score)) ? `${Math.round(Number(row.score))}/100` : "N/A";
          const counts = `${row.critical ?? 0} critical, ${row.medium ?? 0} medium, ${row.compliant ?? 0} compliant`;
          return `${toSingleLine(row.category)}: ${score} (${counts})`;
        }),
        8,
      );
    }

    h.heading("Violations");
    if (!Array.isArray(payload.violations) || !payload.violations.length) {
      h.paragraph("No policy violations detected.");
    } else {
      for (const violation of payload.violations.slice(0, 6)) {
        h.subheading(`${toSingleLine(violation.title)} (${violation.severity})`);
        h.paragraph(shortenText(violation.why_it_matters, 320));
        h.paragraph(`Recommended Fix: ${shortenText(violation.recommended_fix, 320)}`);
        h.paragraph(`Confidence: ${toPercent(violation.confidence)}`);
        doc.moveDown(0.1);
      }
    }

    h.heading("Remediation Plan");
    if (!Array.isArray(payload.remediation_plan) || !payload.remediation_plan.length) {
      h.paragraph("No remediation plan provided.");
    } else {
      h.bullets(
        payload.remediation_plan.slice(0, 8).map((step) => {
          const deps = Array.isArray(step.depends_on) && step.depends_on.length ? ` (Depends on: ${step.depends_on.join(", ")})` : "";
          return `#${step.step} [${step.priority}/${step.owner}] ${toSingleLine(step.action)}${deps}`;
        }),
        8,
      );
    }

    h.heading("Clarifying Questions");
    h.bullets(payload.clarifying_questions || [], 6);

    h.heading("Top Citations");
    if (!Array.isArray(payload.citations) || !payload.citations.length) {
      h.paragraph("No citations captured.");
    } else {
      h.bullets(
        payload.citations.slice(0, 6).map((c) => {
          const ref = toSingleLine(`${policyCitationLabel(c.source_type)} ${c.ref || ""}`.trim());
          return `${ref}: ${shortenText(c.snippet, 220)}`;
        }),
        6,
      );
    }
  });
}

async function updateRunProgress(runId: string, patch: Partial<RunStatusShape>) {
  const run = await prisma.run.findUnique({ where: { id: runId } });
  if (!run) return;
  const cur = (run.stepsJson && typeof run.stepsJson === "object") ? (run.stepsJson as any) : makeRunStatus();
  const next = {
    ...cur,
    ...patch,
    stats: { ...(cur.stats || {}), ...(patch.stats || {}) },
    steps: patch.steps || cur.steps,
    meta: { ...(cur.meta || {}), ...(patch.meta || {}) },
  };
  await prisma.run.update({ where: { id: runId }, data: { stepsJson: next as any } });
}

function normalizePolicyCitations(raw: any[], doc: DocMeta) {
  const out: PolicyComplianceOutput["citations"] = [];
  let i = 1;
  for (const c of Array.isArray(raw) ? raw : []) {
    const source = String(c?.source_type || "").toLowerCase();
    const source_type = source.includes("legal") ? "legal_corpus" : "user_doc";
    const snippet = trimWords(String(c?.snippet || ""), 25);
    if (!snippet) continue;
    out.push({
      ref: `${source_type === "legal_corpus" ? "L" : "C"}${i++}`,
      source_type,
      doc_id: String(c?.doc_id || doc.doc_id),
      page: c?.page ?? null,
      offset_start: c?.offset_start ?? c?.offsetStart ?? null,
      offset_end: c?.offset_end ?? c?.offsetEnd ?? null,
      snippet,
    });
  }
  if (!out.some((c) => c.source_type === "user_doc") && doc.extracted_text.trim()) {
    const fallback = trimWords(doc.extracted_text, 25);
    if (fallback) out.push({ ref: `C${i++}`, source_type: "user_doc", doc_id: doc.doc_id, page: null, offset_start: null, offset_end: null, snippet: fallback });
  }
  return out.slice(0, 12);
}

function normalizePolicyText(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildPolicyTokens(value: unknown) {
  const stop = new Set([
    "this", "that", "with", "from", "into", "where", "when", "have", "has", "been", "were", "their", "there",
    "legal", "case", "document", "documents", "workspace", "query", "parsing", "report", "analysis", "review",
    "issue", "issues", "current", "matter", "evidence", "support", "policy", "compliance", "risk",
  ]);
  return new Set(
    normalizePolicyText(value)
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 && !stop.has(token)),
  );
}

function scorePolicyOverlap(a: unknown, b: unknown) {
  const left = buildPolicyTokens(a);
  if (!left.size) return 0;
  const right = buildPolicyTokens(b);
  let score = 0;
  for (const token of left) {
    if (right.has(token)) score += 1;
  }
  return score;
}

function clipPolicySentence(value: unknown, maxWords = 26) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, maxWords)
    .join(" ");
}

function uniquePolicyStrings(values: Array<unknown>, limit: number) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function pickCitationRefsByOverlap(
  needle: string,
  citations: PolicyComplianceOutput["citations"],
  sourceType: "user_doc" | "legal_corpus",
  limit = 2,
) {
  return citations
    .filter((citation) => citation.source_type === sourceType)
    .map((citation) => ({
      citation,
      score: scorePolicyOverlap(needle, citation.snippet),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({ citation_ref: entry.citation.ref }));
}

function selectPolicyAction(title: string, actions: string[]) {
  const ranked = actions
    .map((action) => ({ action, score: scorePolicyOverlap(title, action) }))
    .sort((a, b) => b.score - a.score);
  if (ranked[0]?.score > 0) return ranked[0].action;

  const text = normalizePolicyText(title);
  if (/notice|reply|service|delivery|cure|termination/.test(text)) {
    return "Build a dated notice-and-response chronology with dispatch proof, delivery proof, and any cure-period correspondence.";
  }
  if (/payment|invoice|ledger|amount|default|dues/.test(text)) {
    return "Match each payment demand with invoices, ledger entries, acknowledgments, and the exact unpaid amount before escalation.";
  }
  if (/approval|consent|authorization|signature|execution/.test(text)) {
    return "Collect the written approval or execution trail and identify precisely which missing approval creates the present exposure.";
  }
  if (/timeline|delay|deadline|limitation|date/.test(text)) {
    return "Map every key date, delay event, deadline, and contractual response window into a single chronology for review.";
  }
  if (/evidence|document|proof|record|support/.test(text)) {
    return "Tie this issue to the exact document set, page reference, and missing proof that must be completed in the workspace.";
  }
  return "Record the exact factual gap behind this issue and link it to the supporting document trail before the next legal step.";
}

function buildViolationWhy(title: string, sourceSummary: string, evidenceSnippet?: string | null) {
  const issue = String(title || "").trim();
  const summary = clipPolicySentence(sourceSummary, 20);
  const evidence = evidenceSnippet ? clipPolicySentence(evidenceSnippet, 16) : "";
  if (evidence) {
    return `Evidence points to "${evidence}", making ${issue.toLowerCase()} a concrete dispute risk that needs explanation in the file record.`;
  }
  if (summary) {
    return `${summary} This keeps ${issue.toLowerCase()} tied to the current facts rather than a template compliance concern.`;
  }
  return `${issue} is grounded in the current record and should be resolved against the existing factual chronology before escalation.`;
}

function buildViolationFix(title: string, action: string, evidenceSnippet?: string | null) {
  const actionText = String(action || "").replace(/\s+/g, " ").trim();
  const evidence = evidenceSnippet ? clipPolicySentence(evidenceSnippet, 12) : "";
  if (evidence && actionText) {
    return `${actionText} Start with the material showing "${evidence}" so the fix stays tied to the actual dispute file.`;
  }
  if (actionText) return actionText;
  return `Document the exact facts behind ${String(title || "").toLowerCase()} and align the response with the written record before proceeding.`;
}

function buildDecisionReasoning(summary: string, issueTitles: string[], legalCitations: number) {
  const issueList = uniquePolicyStrings(issueTitles, 3).join("; ");
  const summaryText = clipPolicySentence(summary, 28);
  const legalNote = legalCitations > 0
    ? "Supporting legal references were identified for at least part of the compliance position."
    : "Additional legal support would strengthen this decision path, so it should be reviewed conservatively.";
  if (summaryText && issueList) {
    return `${summaryText} The immediate decision turns on ${issueList}. ${legalNote}`;
  }
  if (issueList) return `The immediate decision turns on ${issueList}. ${legalNote}`;
  return legalNote;
}

function sanitizePolicyUserText(text: string) {
  return String(text || "")
    .replace(/\b[a-f0-9]{8}-[a-f0-9-]{27,}\b/gi, "")
    .replace(/\bchunk_id\s*=\s*[^,\s]+/gi, "")
    .replace(/\bsource_type\s*=\s*[^,\s]+/gi, "")
    .replace(/\bdoc_id\s*=\s*[^,\s]+/gi, "")
    .replace(/Scanned document detected;[^.]*\.?/gi, "")
    .replace(/OCR [^.]*configured\.?/gi, "")
    .replace(/No corpus citation found[^.]*\.?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function inferBestPathFromIssues(qp: any, issueTitles: string[]) {
  const domain = normalizePolicyText(qp?.domain?.primary || qp?.legal_domain || "");
  const issueText = normalizePolicyText(issueTitles.join(" "));
  if (/arbitr/.test(domain) || /arbitr/.test(issueText)) return "Arbitrate" as const;
  if (/consumer/.test(domain) || /consumer/.test(issueText)) return "File Complaint" as const;
  if (/termination|breach|default|notice/.test(issueText)) return "Send Notice" as const;
  if (/jurisdiction|forum|litigation|injunction|recovery suit/.test(issueText)) return "Litigate" as const;
  return "Negotiate" as const;
}

function inferOwnerFromAction(action: string): "Client" | "Lawyer" | "Both" {
  const text = normalizePolicyText(action);
  if (/draft|plead|notice|jurisdiction|forum|statute|limitation|arbitr/.test(text)) return "Lawyer";
  if (/collect|gather|locate|invoice|ledger|record|document|approval|consent/.test(text)) return "Client";
  return "Both";
}

function stripStatuteMentions(text: string) {
  return String(text || "")
    .replace(/\bsection\s+\d+[a-z]?\b/gi, "needs verification")
    .replace(/\bsec\.?\s+\d+[a-z]?\b/gi, "needs verification")
    .replace(/\b[a-z][a-z\s]+ act,?\s*\d{4}\b/gi, "relevant law (needs verification)")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function mentionsLawReference(text: string) {
  return /\b(section|sec\.|act,?\s*\d{4}|code)\b/i.test(String(text || ""));
}

function enforceLawCitationGate(output: PolicyComplianceOutput, legalSnippetsFound: number) {
  const hasLegalCitation = (output.citations || []).some((c) => c.source_type === "legal_corpus");
  const warnings: string[] = [];
  if (legalSnippetsFound > 0 && !hasLegalCitation) {
    warnings.push("Legal references could not be firmly grounded from the current retrieved legal material.");
  }
  if (!hasLegalCitation) {
    output.violations = (output.violations || []).map((v) => ({
      ...v,
      title: mentionsLawReference(v.title) ? stripStatuteMentions(v.title) : v.title,
      why_it_matters: mentionsLawReference(v.why_it_matters) ? stripStatuteMentions(v.why_it_matters) : v.why_it_matters,
      recommended_fix: mentionsLawReference(v.recommended_fix) ? stripStatuteMentions(v.recommended_fix) : v.recommended_fix,
      law_basis: [],
      confidence: Math.min(v.confidence, 0.55),
    }));
  }
  if (warnings.length) {
    output.analysis_valid = false;
    output.mode = "fallback";
    output.failure_reason = warnings.join(" ");
  }
  if (legalSnippetsFound === 0) {
    output.overall_score = Math.max(0, Math.round(output.overall_score * 0.85));
    output.failure_reason = output.failure_reason || "Direct legal-reference support was limited, so this output should be reviewed carefully.";
  }
  return output;
}

function assessPolicyNarrativeQuality(output: PolicyComplianceOutput, supportTexts: Array<unknown>) {
  return assessNarrativeQuality({
    texts: [
      ...(output.violations || []).flatMap((item) => [item.title, item.why_it_matters, item.recommended_fix]),
      ...(output.remediation_plan || []).map((item) => `${item.action} ${item.priority} ${item.owner}`),
      output.decision_support?.reasoning,
      ...(output.decision_support?.what_changes_the_outcome || []),
    ],
    supportTexts,
    minSupportOverlap: 5,
    minCombinedLength: 180,
    maxGenericPhraseHits: 1,
  });
}

function mapPolicyOutput(
  source: any,
  framework: string,
  doc: DocMeta,
  qp: any,
  retrievedCaseSnippets: Array<{ source_type: string; doc_id: string; title?: string | null; page?: number | null; offset_start?: number | null; offset_end?: number | null; snippet: string }>,
  retrievedLawSnippets: Array<{ source_type: string; doc_id: string; title?: string | null; page?: number | null; offset_start?: number | null; offset_end?: number | null; snippet: string }>,
  llmSucceeded = true,
): PolicyComplianceOutput {
  const violationsRaw = Array.isArray(source?.violations) ? source.violations : [];
  const compliantAreas = Array.isArray(source?.compliant_areas) ? source.compliant_areas : [];
  const sourceCitations = normalizePolicyCitations(source?.citations || [], doc);
  const grounded = makeCitationRefs([
    ...retrievedCaseSnippets,
    ...retrievedLawSnippets,
    ...sourceCitations.map((c) => ({
      source_type: c.source_type,
      doc_id: c.doc_id,
      title: null,
      page: c.page ?? null,
      offset_start: c.offset_start ?? null,
      offset_end: c.offset_end ?? null,
      snippet: c.snippet,
    })),
  ]).citations;
  const citations = grounded.slice(0, 16).map((c) => ({
    ref: c.ref || "C1",
    source_type: (c.source_type === "legal_corpus" ? "legal_corpus" : "user_doc") as "user_doc" | "legal_corpus",
    doc_id: c.doc_id,
    page: c.page ?? null,
    offset_start: c.offset_start ?? null,
    offset_end: c.offset_end ?? null,
    snippet: c.snippet,
  }));
  const hasLegalCorpus = citations.some((c) => c.source_type === "legal_corpus");
  const hasUserDoc = citations.some((c) => c.source_type === "user_doc");
  const sourceSummary = String(source?.summary || "").trim();
  const sourceActions = uniquePolicyStrings(source?.recommended_actions || [], 6);
  const issueTitles = uniquePolicyStrings(violationsRaw, 10);
  const critical = issueTitles.map((title, idx) => {
    const matchedCaseRefs = pickCitationRefsByOverlap(title, citations, "user_doc", 2);
    const matchedLawRefs = pickCitationRefsByOverlap(title, citations, "legal_corpus", 2);
    const firstCaseEvidence = matchedCaseRefs[0]
      ? citations.find((citation) => citation.ref === matchedCaseRefs[0].citation_ref)?.snippet
      : null;
    const selectedAction = selectPolicyAction(title, sourceActions);
    const severity: "Critical" | "Medium" =
      /termination|default|breach|jurisdiction|injunction|limitation|statute|regulator|penalty/i.test(title) || (idx === 0 && issueTitles.length > 2)
        ? "Critical"
        : "Medium";

    return {
      severity,
      title,
      why_it_matters: buildViolationWhy(title, sourceSummary, firstCaseEvidence),
      recommended_fix: buildViolationFix(title, selectedAction, firstCaseEvidence),
      law_basis: hasLegalCorpus ? matchedLawRefs : [],
      case_evidence: matchedCaseRefs,
      confidence: Math.max(0.35, Math.min(0.92, Number(source?.confidence || 0.5) + (matchedCaseRefs.length ? 0.08 : 0))),
    };
  });
  const categories = [
    "Contract Validity / Performance",
    "Notice & Cure / Termination Process",
    "Evidence Sufficiency",
    "Forum / Jurisdiction / ADR",
    "Limitation / Timelines",
  ];
  const baseScore = Math.max(0, Math.min(100, Number(source?.compliance_score ?? 50)));
  const catScores = categories.map((category, idx) => {
    const catCritical = idx === 1 ? critical.filter((v: { title: string }) => /notice|cure|termination/i.test(v.title)).length : idx === 2 ? critical.filter((v: { title: string }) => /evidence|invoice|proof/i.test(v.title)).length : 0;
    const catMedium = idx !== 1 && idx !== 2 ? Math.max(0, Math.min(2, critical.length - catCritical)) : Math.max(0, critical.length - catCritical);
    const catCompliant = Math.max(0, Math.min(3, compliantAreas.length - idx));
    const score = Math.max(0, Math.min(100, baseScore - catCritical * 12 - catMedium * 6 + catCompliant * 3));
    return { category, score, critical: catCritical, medium: catMedium, compliant: catCompliant };
  });
  const overall_score = Math.round(Math.max(0, Math.min(100, baseScore)));
  const risk_level: "Low" | "Medium" | "High" = overall_score >= 75 ? "Low" : overall_score >= 45 ? "Medium" : "High";
  const noCorpusWarning = !hasLegalCorpus ? "No legal corpus citations available; results are grounded in workspace evidence only." : null;
  const remediationActions = uniquePolicyStrings(
    [
      ...sourceActions,
      ...critical.map((item) => item.recommended_fix),
      "Finalize a fact-to-evidence matrix for every issue that remains open after review.",
    ],
    4,
  );
  const changeDrivers = uniquePolicyStrings(
    [
      ...sourceActions,
      ...critical.map((item) => item.title),
      hasLegalCorpus ? "Direct statutory or case-law support for the disputed point" : "Additional legal-corpus support for the disputed point",
      "A cleaner notice, chronology, and document trail for the disputed events",
    ],
    4,
  );
  const decisionReasoning = buildDecisionReasoning(sourceSummary, critical.map((item) => item.title), citations.filter((item) => item.source_type === "legal_corpus").length);
  const userDocCitations = citations.filter((item) => item.source_type === "user_doc").length;
  const hasSubstantiveFindings = critical.length > 0 || compliantAreas.length > 0 || remediationActions.length > 0 || catScores.length > 0;
  const hasDecisionNarrative = decisionReasoning.trim().length >= 80;
  const analysis_valid = hasUserDoc && userDocCitations >= 1 && hasSubstantiveFindings && hasDecisionNarrative && (retrievedLawSnippets.length === 0 || hasLegalCorpus);
  const mode = llmSucceeded ? "normal" : (analysis_valid ? "normal" : "fallback");
  const output: PolicyComplianceOutput = {
    framework_selected: framework,
    overall_score,
    risk_level,
    counts: { critical: critical.filter((v: { severity: string }) => v.severity === "Critical").length, medium: critical.filter((v: { severity: string }) => v.severity === "Medium").length, compliant: compliantAreas.length },
    category_scores: catScores,
    violations: critical,
    remediation_plan: remediationActions.map((action, idx) => ({
      step: idx + 1,
      action,
      priority: idx < 2 ? "High" : idx === 2 ? "Medium" : "Low",
      owner: inferOwnerFromAction(action),
      depends_on: idx === 0 ? [] : [remediationActions[0]],
    })),
    decision_support: {
      best_path: inferBestPathFromIssues(qp, critical.map((item) => item.title)),
      reasoning: decisionReasoning,
      what_changes_the_outcome: changeDrivers,
    },
    citations,
    analysis_valid,
    mode,
    failure_reason: analysis_valid ? null : "Insufficient grounded user/document citations",
    clarifying_questions: analysis_valid ? [] : ["Which exact legal issue/framework should be checked for this case?", "Can you confirm the key disputed action and timeline?", "Are there additional supporting documents (notices, invoices, emails)?"],
    qa_debug: {
      doc_hash: doc.hash,
      source_agent: "policy_compliance_common",
      legal_corpus_citations: citations.filter((c) => c.source_type === "legal_corpus").length,
      user_doc_citations: citations.filter((c) => c.source_type === "user_doc").length,
      retrieved_case_snippets: retrievedCaseSnippets.length,
      retrieved_law_snippets: retrievedLawSnippets.length,
      corpus_note: noCorpusWarning,
    },
  };
  const parsed = policyComplianceOutputSchema.parse(output);
  const gated = enforceLawCitationGate(parsed, retrievedLawSnippets.length);
  gated.decision_support.reasoning = sanitizePolicyUserText(gated.decision_support.reasoning);
  gated.failure_reason = gated.failure_reason ? sanitizePolicyUserText(gated.failure_reason) : gated.failure_reason;
  gated.violations = (gated.violations || []).map((item) => ({
    ...item,
    title: sanitizePolicyUserText(item.title),
    why_it_matters: sanitizePolicyUserText(item.why_it_matters),
    recommended_fix: sanitizePolicyUserText(item.recommended_fix),
  }));
  gated.remediation_plan = (gated.remediation_plan || []).map((item) => ({
    ...item,
    action: sanitizePolicyUserText(item.action),
  }));
  const genericity = assessPolicyNarrativeQuality(gated, [
    doc.extracted_text,
    qp?.executive_summary,
    qp?.summary,
    ...(Array.isArray(qp?.legal_grounds) ? qp.legal_grounds : []),
    ...retrievedCaseSnippets.map((s) => s?.snippet),
    ...retrievedLawSnippets.map((s) => s?.snippet),
    ...gated.citations.map((c) => c?.snippet),
  ]);
  gated.qa_debug = {
    ...(gated.qa_debug || {}),
    genericity_gate: genericity,
  };
  if (genericity.isGeneric) {
    gated.analysis_valid = false;
    if (!llmSucceeded) {
      gated.mode = "fallback";
    }
    gated.failure_reason = "Policy Compliance output was too generic for grounded use";
  }
  return gated;
}

function isUsablePolicyPayload(payload: any, framework?: string | null) {
  const normalized = normalizePolicyPayload(payload);
  if (!hasRenderablePolicyPayload(normalized)) return false;
  if (framework && normalized.framework_selected !== framework) return false;
  if (normalized?.qa_debug?.genericity_gate?.isGeneric) return false;
  const citations = Array.isArray(normalized?.citations) ? normalized.citations : [];
  const userDocCitations = citations.filter((item: any) => item?.source_type === "user_doc").length;
  if (userDocCitations < 1) return false;
  const genericPhrases = countGenericPhraseHits([
    ...(Array.isArray(normalized?.violations) ? normalized.violations.flatMap((item: any) => [item?.title, item?.why_it_matters, item?.recommended_fix]) : []),
    normalized?.decision_support?.reasoning,
  ]);
  if (genericPhrases > 2) return false;
  return true;
}

async function executeRun(runId: string, caseId: string, userId: string, framework: string | null) {
  const env = getEnv();
  runCancellationService.register(runId);
  const c = await ensureOwnedCase(userId, caseId);
  const doc = await resolvePrimaryDoc(caseId);
  if (!doc) throw new HttpError(400, "No case document/text found", "case_input_missing");
  const caseWithOutputs = await prisma.case.findUnique({ where: { id: caseId }, include: { outputs: true } });
  const qp = ((caseWithOutputs?.outputs || []) as any[]).find((o) => o.agentKey === "query_parsing")?.payloadJson || null;

  await prisma.run.update({ where: { id: runId }, data: { status: RunStatus.RUNNING, startedAt: new Date() } });
  await updateRunProgress(runId, { stage: RUN_STEP_NAMES[0], stepIndex: 1, stepsTotal: RUN_STEP_NAMES.length, stats: {}, steps: buildRunSteps(0), meta: { agent_key: AGENT_KEY, doc_hash: doc.hash, framework_selected: framework || null } });
  runCancellationService.throwIfCancelled(runId);
  await updateRunProgress(runId, { stage: RUN_STEP_NAMES[1], stepIndex: 2, steps: buildRunSteps(1) });
  const caseEvidence = await retriever.retrieveCaseSnippets(caseId, `${framework || ""} ${String(qp?.executive_summary || qp?.summary || "").slice(0, 1200)}`, 8, { source_type: "user_doc", doc_id: doc.doc_id });
  await updateRunProgress(runId, { stage: RUN_STEP_NAMES[2], stepIndex: 3, steps: buildRunSteps(2) });
  const legalEvidence = env.ENABLE_LEGAL_CORPUS
    ? await retriever.retrieveLegalCorpusSnippets(`${framework || ""} ${String(qp?.executive_summary || qp?.summary || "").slice(0, 1200)}`, 8, { source_type: "legal_corpus", jurisdiction: "IN" })
    : [];

  let source: any;
  let llmSucceeded = false;
  try {
    source = await agentRunner.runCommonAgent(caseId, c.user?.role || c.role, doc.extracted_text, { query_parsing: qp }, AGENT_KEY, {
      runId,
      inputHash: sha256(`${doc.hash}:${framework || "auto"}`),
      docChecksumsUsed: [doc.hash],
      language: c.language,
      preferredLanguage: c.language,
      userQueryText: String(qp?.executive_summary || qp?.summary || "").slice(0, 1200),
      filtersApplied: (c as any).filtersJson || {},
      extractedDocSnippets: [],
      inputStats: { query_source: "policy_compliance_agent" },
    });
    llmSucceeded = true;
  } catch (e) {
    if (runCancellationService.isCancellationError(e) || runCancellationService.isCancelled(runId)) throw e;
    source = { mode: "fallback", compliance_score: 35, violations: [], compliant_areas: [], confidence: 0.2, citations: [], error: String((e as any)?.message || e) };
  }
  runCancellationService.throwIfCancelled(runId);

  await updateRunProgress(runId, { stage: RUN_STEP_NAMES[3], stepIndex: 4, steps: buildRunSteps(3) });
  const frameworkFinal = framework || FRAMEWORKS[0];
  const output = mapPolicyOutput(
    source,
    frameworkFinal,
    doc,
    qp,
    caseEvidence.map((s) => ({
      source_type: s.source_type,
      doc_id: s.doc_id,
      title: s.title,
      page: s.page,
      offset_start: s.offset_start,
      offset_end: s.offset_end,
      snippet: s.snippet,
    })),
    legalEvidence.map((s) => ({
      source_type: s.source_type,
      doc_id: s.doc_id,
      title: s.title,
      page: s.page,
      offset_start: s.offset_start,
      offset_end: s.offset_end,
      snippet: s.snippet,
    })),
    llmSucceeded,
  );
  if (source?.error) {
    output.mode = "fallback";
    output.failure_reason = String(source.error);
  }
  output.qa_debug = {
    ...(output.qa_debug || {}),
    run_id: runId,
    framework_selected: frameworkFinal,
    legal_corpus_enabled: env.ENABLE_LEGAL_CORPUS,
    retrieved_case_snippets: caseEvidence.length,
    retrieved_law_snippets: legalEvidence.length,
  };
  await updateRunProgress(runId, { stage: RUN_STEP_NAMES[4], stepIndex: 5, steps: buildRunSteps(4), stats: { overall_score: output.overall_score } });
  await upsertAgentOutput(caseId, output, c.language || "English");
  await prisma.run.update({ where: { id: runId }, data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() } });
  await updateRunProgress(runId, { done: true, stage: "Completed", error: null, meta: { agent_key: AGENT_KEY, doc_hash: doc.hash, analysis_valid: output.analysis_valid, mode: output.mode, framework_selected: frameworkFinal }, stats: { overall_score: output.overall_score } });
  const title = output.analysis_valid === false ? "Policy Compliance completed with warnings" : "Policy Compliance completed";
  const body = output.analysis_valid === false
    ? `Policy Compliance generated fallback output for case ${caseId}`
    : `Policy Compliance generated output for case ${caseId}`;
  await notificationService.create(userId, title, body);
  runCancellationService.clear(runId);
}

export const policyComplianceAgentService = {
  AGENT_KEY,
  frameworks: FRAMEWORKS,
  schema: policyComplianceOutputSchema,
  async getOverview(userId: string, caseId: string) {
    const corpusStatus = await legalCorpusIndexService.getStatus();
    const c = await ensureOwnedCase(userId, caseId);
    const doc = await resolvePrimaryDoc(caseId);
    const workspaceSummary = await resolveCaseWorkspaceSummary(caseId);
    const caseWith = await prisma.case.findUnique({ where: { id: caseId }, include: { outputs: true, runs: { orderBy: { createdAt: "desc" }, take: 30 } } });
    const qp = ((caseWith?.outputs || []) as any[]).find((o) => o.agentKey === "query_parsing")?.payloadJson || null;
    const latestRow = await readLatestOutput(caseId, doc?.hash);
    const latestOutput = parsePayloadRow(latestRow);
    const runs = ((caseWith?.runs || []) as any[]).filter((r) => ((r.stepsJson as any)?.meta?.agent_key) === AGENT_KEY);
    const staleRuns = runs.filter((r) => isStaleRunningRun(r));
    if (staleRuns.length) {
      await Promise.all(staleRuns.map((r) => prisma.run.update({ where: { id: r.id }, data: { status: RunStatus.FAILED, finishedAt: new Date() } }).catch(() => undefined)));
      await Promise.all(staleRuns.map((r) => updateRunProgress(r.id, { done: true, error: "Stale policy compliance run timed out" }).catch(() => undefined)));
    }
    const latestRun = runs[0] ? (isStaleRunningRun(runs[0]) ? { ...runs[0], status: RunStatus.FAILED } : runs[0]) : null;
    const latestOutputSavedAt = new Date((latestRow as any)?.updated_at || 0).getTime();
    const latestSavedRunId = String(latestOutput?.qa_debug?.run_id || "").trim();
    const latestStatus =
      hasRenderablePolicyPayload(latestOutput)
        ? "done"
        : latestRun?.status === RunStatus.RUNNING
          ? "running"
          : latestRun?.status === RunStatus.FAILED
            ? "error"
            : "none";
    return {
      case: { case_id: caseId, title: c.title, domain: (c as any).domainPrimary || "General", language: c.language || "English" },
      primary_doc: doc ? { doc_id: doc.doc_id, filename: doc.filename, mime_type: doc.mime_type, kind: doc.kind || null, pages: doc.pages, char_count: doc.char_count, updated_at: doc.updated_at, language: doc.language } : null,
      workspace_summary: workspaceSummary,
      query_parsing_subset: qp ? { domain: qp.domain, subtype: qp.domain?.subtype || qp.legal_subtype, legal_grounds: qp.legal_grounds || [], key_facts: qp.key_facts || null } : null,
      latest: { status: latestStatus, run_id: latestSavedRunId || latestRun?.id || null, output: latestStatus === "done" ? latestOutput : null, analysis_valid: !!latestOutput?.analysis_valid, mode: latestOutput?.mode || "fallback", failure_reason: latestOutput?.failure_reason || null },
      recent_runs: runs.slice(0, 5).map((r) => {
        const runCreatedAt = new Date(r.createdAt || 0).getTime();
        const normalizedStatus =
          String(r.status || "").toUpperCase() === RunStatus.RUNNING && latestSavedRunId && latestSavedRunId === String(r.id)
            ? "done"
            : String(r.status || "").toUpperCase() === RunStatus.RUNNING && Number.isFinite(latestOutputSavedAt) && runCreatedAt > 0 && runCreatedAt <= latestOutputSavedAt && hasRenderablePolicyPayload(latestOutput)
              ? "done"
              : String(r.status || "").toUpperCase() === RunStatus.RUNNING && isStaleRunningRun(r)
                ? "error"
                : r.status === "SUCCEEDED"
                  ? "done"
                  : r.status === "FAILED"
                    ? "error"
                    : "running";
        return { run_id: r.id, status: normalizedStatus, created_at: r.createdAt.toISOString(), risk_level: (r.stepsJson as any)?.meta?.risk_level || null };
      }),
      frameworks: FRAMEWORKS,
      legal_corpus: { connected: corpusStatus.connected, enabled: corpusStatus.enabled, docs_indexed: corpusStatus.docs_indexed, chunks_indexed: corpusStatus.chunks_indexed, last_indexed_at: corpusStatus.last_indexed_at },
      qa_debug: { case_id: caseId, primary_doc_id: (c as any).primaryDocId || null, doc_hash: doc?.hash || null, extracted_text_exists: !!doc?.extracted_text?.trim(), query_parsing_output_exists: !!qp, last_run_id: latestRun?.id || null, last_run_status: latestRun?.status || null },
    };
  },
  async startRun(userId: string, caseId: string, input?: { force?: boolean; framework?: string | null }) {
    const c = await ensureOwnedCase(userId, caseId);
    const doc = await resolvePrimaryDoc(caseId);
    if (!doc) throw new HttpError(400, "No case text/document found for this case", "case_input_missing");
    const framework = input?.framework && FRAMEWORKS.includes(input.framework as any) ? input.framework : null;
    const cache = await readLatestOutput(caseId, doc.hash);
    if (cache && !input?.force) {
      const payload = parsePayloadRow(cache);
      if (isUsablePolicyPayload(payload, framework)) {
        return { status: "cached", output: payload };
      }
    }
    const lockKey = `${caseId}:${doc.hash}:${framework || "auto"}`;
    const existing = inFlight.get(lockKey);
    if (existing) return { status: "running", run_id: existing };
    const run = await prisma.run.create({ data: { caseId, status: RunStatus.PENDING, language: c.language, stepsJson: makeRunStatus({ meta: { agent_key: AGENT_KEY, framework_selected: framework || null, doc_hash: doc.hash } }) as any, startedAt: new Date() } });
    inFlight.set(lockKey, run.id);
    setImmediate(() => {
      void executeRun(run.id, caseId, userId, framework).catch(async (e) => {
        if (runCancellationService.isCancellationError(e) || runCancellationService.isCancelled(run.id)) {
          await updateRunProgress(run.id, { done: true, stage: "Cancelled", error: "Run cancelled by user", meta: { agent_key: AGENT_KEY, cancelled: true }, stats: { overall_score: 0 } }).catch(() => undefined);
          await prisma.run.update({ where: { id: run.id }, data: { status: RunStatus.FAILED, finishedAt: new Date() } }).catch(() => undefined);
          await notificationService.create(userId, "Policy Compliance cancelled", `Policy Compliance was cancelled for case ${caseId}`).catch(() => undefined);
          return;
        }
        const reason = String((e as any)?.message || e);
        try {
          const docNow = await resolvePrimaryDoc(caseId);
          const fallback = policyComplianceOutputSchema.parse({
            framework_selected: framework || FRAMEWORKS[0],
            overall_score: 35,
            risk_level: "Medium",
            counts: { critical: 0, medium: 0, compliant: 0 },
            category_scores: [],
            violations: [],
            remediation_plan: [],
            decision_support: {
              best_path: "Unknown",
              reasoning: "Generated fallback output due to runtime error; review case facts and rerun when model health is restored.",
              what_changes_the_outcome: ["Provide clearer case facts and supporting records for a stronger compliance assessment."],
            },
            citations: docNow?.extracted_text
              ? [{ ref: "C1", source_type: "user_doc", doc_id: docNow.doc_id, page: null, offset_start: null, offset_end: null, snippet: trimWords(docNow.extracted_text, 25) }]
              : [],
            analysis_valid: false,
            mode: "fallback",
            failure_reason: reason,
            clarifying_questions: ["Please confirm the exact compliance framework to evaluate for this case."],
            qa_debug: { run_id: run.id, hard_error: reason, llm_required_mode: getEnv().REQUIRE_LLM_OUTPUT === true },
          });
          await upsertAgentOutput(caseId, fallback, c.language || "English");
          await updateRunProgress(run.id, { done: true, stage: "Completed", error: null, meta: { agent_key: AGENT_KEY, mode: "fallback", analysis_valid: false }, stats: { overall_score: fallback.overall_score } });
          await prisma.run.update({ where: { id: run.id }, data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() } }).catch(() => undefined);
          await notificationService.create(userId, "Policy Compliance completed with warnings", `Policy Compliance generated fallback output for case ${caseId}: ${reason}`);
        } catch {
          await updateRunProgress(run.id, { done: true, error: reason });
          await prisma.run.update({ where: { id: run.id }, data: { status: RunStatus.FAILED, finishedAt: new Date() } }).catch(() => undefined);
          await notificationService.create(userId, "Policy Compliance failed", `Policy Compliance failed for case ${caseId}: ${reason}`);
        }
      }).finally(() => {
        if (inFlight.get(lockKey) === run.id) inFlight.delete(lockKey);
        runCancellationService.clear(run.id);
      });
    });
    return { status: "queued", run_id: run.id };
  },
  async getOutput(userId: string, caseId: string) {
    await ensureOwnedCase(userId, caseId);
    const doc = await resolvePrimaryDoc(caseId);
    const row = await readLatestOutput(caseId, doc?.hash);
    const payload = parsePayloadRow(row);
    if (payload) return payload;
    const anyLatest = parsePayloadRow(await readLatestOutput(caseId));
    if (anyLatest) return anyLatest;
    if (doc) return buildEmergencyPolicyPayload(doc, null, null, "No saved policy compliance payload found; generated emergency fallback output.");
    throw new HttpError(404, "Policy compliance output not found", "policy_compliance_output_not_found");
  },
  async exportPdf(userId: string, caseId: string) {
    const payload = await this.getOutput(userId, caseId);
    const buffer = await renderPolicyCompliancePdf(payload, caseId, payload?.qa_debug?.case_title);
    return {
      buffer,
      filename: `policy-compliance-${String(caseId || "report")}.pdf`,
    };
  },
};
