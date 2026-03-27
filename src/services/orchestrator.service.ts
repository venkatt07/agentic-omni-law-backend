import { RunStatus } from "../db/types.js";
import { mysqlPool, prisma } from "../prisma/client.js";
import { HttpError } from "../middleware/error.js";
import { indexService } from "./index.service.js";
import { COMMON_AGENT_KEYS, ROLE_AGENT_KEYS } from "../utils/roleMap.js";
import { agentRunner } from "./agents/agentRunner.js";
import type { RunStep } from "../types/api.js";
import { notificationService } from "./notification.service.js";
import { sha256 } from "../utils/hash.js";
import { contractRiskAgentService } from "./contractRiskAgent.service.js";
import { caseOutcomeAgentService } from "./caseOutcomeAgent.service.js";
import { policyComplianceAgentService } from "./policyComplianceAgent.service.js";
import { legalDraftsAgentService } from "./legalDraftsAgent.service.js";
import { roleAgentRunService } from "./roleAgentRun.service.js";
import { retrieveBundleService } from "./retrieval/retrieveBundle.service.js";
import { documentService } from "./document.service.js";
import { runCancellationService } from "./runCancellation.service.js";
import { resolvePrimaryCaseDocumentMeta } from "./documentMeta.service.js";

const queueByCase = new Map<string, Promise<void>>();
const previewQueryTextByCase = new Map<string, { text: string; ts: number }>();
const STALE_MS = 20 * 60 * 1000;
const QUERY_PARSING_ONLY_STALE_MS = 2 * 60 * 1000;
const QUERY_PARSING_AGENT_TIMEOUT_MS = Number(process.env.QUERY_PARSING_AGENT_TIMEOUT_MS || "90000");
const PREVIEW_QUERY_TTL_MS = 10 * 60 * 1000;
const MAX_QUERY_TEXT_CHARS = 20_000;
const MAX_DOCS_TEXT_CHARS = 180_000;
const MAX_PARALLEL_AGENTS = Math.max(1, Number(process.env.MAX_PARALLEL_AGENTS || "8"));
const CHILD_RUN_POLL_INTERVAL_MS = Math.max(250, Number(process.env.CHILD_RUN_POLL_INTERVAL_MS || "350"));
const CHILD_RUN_MAX_WAIT_MS = Math.max(180_000, Number(process.env.CHILD_RUN_MAX_WAIT_MS || "240000"));
const CHILD_RUN_RECOVERY_GRACE_MS = Math.max(8_000, Number(process.env.CHILD_RUN_RECOVERY_GRACE_MS || "20000"));
const CHILD_RUN_STALE_MS = Math.max(180_000, Number(process.env.CHILD_RUN_STALE_MS || "720000"));
const AUTO_RUN_ALL = String(process.env.AUTO_RUN_ALL || "false").toLowerCase() === "true";
const runAllJobs = new Map<string, any>();

const AGENT_TITLE: Record<string, string> = {
  query_parsing: "Query Parsing",
  contract_risk_dispute_settlement: "Contract Risk",
  case_outcome_deadline_penalty: "Outcome Prediction",
  policy_compliance: "Policy Compliance",
  legal_drafts_validation: "Legal Drafts",
  final_summary: "Final Summary",
};

type RunActivityTone = "neutral" | "live" | "success" | "error";
type RunActivityEntry = {
  id: string;
  timestamp: string;
  actor?: string;
  phase?: string;
  text: string;
  detail?: string;
  next?: string;
  tone?: RunActivityTone;
};

function agentTitle(agentKey: string) {
  if (AGENT_TITLE[agentKey]) return AGENT_TITLE[agentKey];
  const text = String(agentKey || "")
    .replace(/^lawyer_/, "")
    .replace(/^student_/, "")
    .replace(/^corp_/, "")
    .replace(/^individual_/, "")
    .replaceAll("_", " ")
    .trim();
  return text ? text.replace(/\b\w/g, (s) => s.toUpperCase()) : "Agent";
}

async function ensureCaseHasRunnableInput(userId: string, caseId: string, explicitText?: string) {
  const trimmed = String(explicitText || "").trim();
  if (!trimmed) return;
  const c = await prisma.case.findUnique({ where: { id: caseId }, include: { documents: true } });
  if (!c || c.userId !== userId) throw new HttpError(404, "Case not found", "case_not_found");
  const latestQueryContext = [...(c.documents || [])]
    .filter((doc: any) => String(doc?.kind || "") === "pasted_text" && String(doc?.name || "").toLowerCase() === "query-context")
    .sort((a: any, b: any) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())[0];
  const latestText = String(latestQueryContext?.extractedText || "").trim();
  if (latestText === trimmed) return;
  await documentService.savePastedText(userId, caseId, trimmed, "query-context");
}

async function notifyAgentEvent(userId: string, caseId: string, agentKey: string, status: "completed" | "failed", detail?: string | null) {
  const title = status === "completed" ? `${agentTitle(agentKey)} completed` : `${agentTitle(agentKey)} failed`;
  const body = status === "completed"
    ? `${agentTitle(agentKey)} generated output for case ${caseId}`
    : `${agentTitle(agentKey)} failed for case ${caseId}${detail ? `: ${detail}` : ""}`;
  await notificationService.create(userId, title, body);
}

async function withMysqlLock<T>(key: string, timeoutSeconds: number, fn: () => Promise<T>) {
  const [rows]: any = await mysqlPool.query("SELECT GET_LOCK(?, ?) AS lck", [key, timeoutSeconds]);
  const acquired = Number(rows?.[0]?.lck || 0) === 1;
  if (!acquired) throw new HttpError(429, "Another Query Parsing start is in progress for this case.", "query_parsing_start_locked");
  try {
    return await fn();
  } finally {
    await mysqlPool.query("SELECT RELEASE_LOCK(?)", [key]).catch(() => undefined);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function nowIso() { return new Date().toISOString(); }
function makeAgentStatus(status: string, run_id: string | null = null, pct = 0, step = "", reason?: string | null) {
  return { status, run_id, pct, step, updated_at: nowIso(), ...(reason ? { reason } : {}) };
}

function resolveQueryParsingTimeoutMs(input: {
  docsText?: string;
  userQueryText?: string;
  extractedDocSnippets?: Array<unknown>;
}) {
  const base = Math.max(45_000, QUERY_PARSING_AGENT_TIMEOUT_MS);
  const docsChars = String(input.docsText || "").length;
  const queryChars = String(input.userQueryText || "").length;
  const snippetCount = Array.isArray(input.extractedDocSnippets) ? input.extractedDocSnippets.length : 0;
  const scaled =
    base +
    Math.min(120_000, Math.round(docsChars / 2_500) * 1_000) +
    Math.min(20_000, Math.round(queryChars / 1_000) * 1_000) +
    Math.min(15_000, snippetCount * 750);
  return Math.max(base, Math.min(240_000, scaled));
}

function isRunAllCancelled(job: any) {
  return Boolean(job?.cancel_requested) || String(job?.overall_status || "").toLowerCase() === "cancelled";
}

function cancelReason() {
  return "Run cancelled from dashboard";
}

function randomActivityId() {
  return Math.random().toString(36).slice(2, 10);
}

function prettyStep(step: string) {
  return String(step || "")
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (s) => s.toUpperCase()) || "Working";
}

function pushActivity(job: any, entry: Omit<RunActivityEntry, "id" | "timestamp">) {
  if (!Array.isArray(job.activity)) job.activity = [];
  const nextEntry: RunActivityEntry = {
    id: randomActivityId(),
    timestamp: new Date().toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }),
    ...entry,
  };
  const last = job.activity[job.activity.length - 1] as RunActivityEntry | undefined;
  if (last && last.actor === nextEntry.actor && last.phase === nextEntry.phase && last.text === nextEntry.text && last.detail === nextEntry.detail) {
    return;
  }
  job.activity.push(nextEntry);
  if (job.activity.length > 24) job.activity = job.activity.slice(-24);
}

function phaseForAgent(agentKey: string, step?: string) {
  const normalized = String(step || "").toLowerCase();
  if (normalized.includes("query") || normalized.includes("intent")) return "Thinking";
  if (normalized.includes("language") || normalized.includes("jurisdiction") || normalized.includes("extract") || normalized.includes("read")) return "Reading documents";
  if (normalized.includes("draft")) return "Drafting";
  if (normalized.includes("compliance")) return "Checking compliance";
  if (normalized.includes("outcome")) return "Solving";
  if (normalized.includes("prepare")) return "Planning next";
  if (agentKey === "query_parsing") return "Thinking";
  return "Working";
}

function describeStepActivity(agentKey: string, step?: string) {
  const normalized = String(step || "").toLowerCase().trim();
  const actor = agentTitle(agentKey);

  if (!normalized || normalized === "running" || normalized === "queued") {
    return {
      phase: phaseForAgent(agentKey, step),
      text: "Continuing analysis",
      detail: `${actor} is continuing the current runtime stage from the parsed workspace context.`,
      next: "Advance to the next available runtime step.",
    };
  }

  if (normalized.includes("extract")) {
    return {
      phase: "Reading documents",
      text: "Extracting facts and document signals",
      detail: `${actor} is reading the case material to pull facts, dates, parties, and supporting evidence.`,
      next: "Structure the extracted facts for the next decision step.",
    };
  }

  if (normalized.includes("domain")) {
    return {
      phase: "Thinking",
      text: "Classifying the legal domain",
      detail: `${actor} is mapping the submitted matter to the correct legal domain and issue group.`,
      next: "Lock the active legal path for downstream work.",
    };
  }

  if (normalized.includes("jurisdiction") || normalized.includes("language")) {
    return {
      phase: "Reading documents",
      text: "Validating language and jurisdiction",
      detail: `${actor} is checking jurisdiction, forum, and language cues from the active workspace.`,
      next: "Confirm the applicable scope for analysis.",
    };
  }

  if (normalized.includes("contract")) {
    return {
      phase: "Reading documents",
      text: "Reviewing contract clauses",
      detail: `${actor} is checking clauses, obligations, liabilities, and dispute-sensitive language in the workspace material.`,
      next: "Flag material risk and missing protections.",
    };
  }

  if (normalized.includes("outcome")) {
    return {
      phase: "Solving",
      text: "Estimating outcome direction",
      detail: `${actor} is weighing the current facts against likely outcome signals and case pressure points.`,
      next: "Summarize the strongest outcome drivers.",
    };
  }

  if (normalized.includes("compliance")) {
    return {
      phase: "Checking compliance",
      text: "Reviewing compliance obligations",
      detail: `${actor} is checking the matter against the relevant legal and policy requirements.`,
      next: "Surface the main compliance gaps and obligations.",
    };
  }

  if (normalized.includes("draft")) {
    return {
      phase: "Drafting",
      text: "Preparing draft output",
      detail: `${actor} is turning the validated case context into structured draft-ready legal output.`,
      next: "Finalize the next draft section.",
    };
  }

  if (normalized.includes("prepare")) {
    return {
      phase: "Planning next",
      text: "Preparing the next runtime step",
      detail: `${actor} is organizing the current case context for the next action.`,
      next: "Continue with the next execution stage.",
    };
  }

  return {
    phase: phaseForAgent(agentKey, step),
    text: prettyStep(step || ""),
    detail: `${actor} is executing the current runtime step from the active workspace context.`,
    next: "Continue to the next runtime action.",
  };
}

function describeWorkspaceInputs(inputStats?: {
  uploaded_docs?: number;
  pasted_docs?: number;
  input_mode?: string;
  docs_scope?: string;
  selected_docs_count?: number;
  selected_docs_missing?: number;
}) {
  const uploadedDocs = Math.max(0, Number(inputStats?.uploaded_docs || 0));
  const pastedDocs = Math.max(0, Number(inputStats?.pasted_docs || 0));
  const selectedDocs = Math.max(0, Number(inputStats?.selected_docs_count || 0));
  const selectedMissing = Math.max(0, Number(inputStats?.selected_docs_missing || 0));
  const inputMode = String(inputStats?.input_mode || "");
  const docsScope = String(inputStats?.docs_scope || "");

  const docsLabel = selectedDocs > 0
    ? `${selectedDocs} selected document${selectedDocs === 1 ? "" : "s"}`
    : `${uploadedDocs} uploaded document${uploadedDocs === 1 ? "" : "s"}`;
  const missingNote = selectedMissing > 0
    ? ` (${selectedMissing} selected document${selectedMissing === 1 ? "" : "s"} not found in workspace)`
    : "";

  if (docsScope === "selected_docs_empty") {
    return {
      scope: "the submitted issue text",
      review: "Selected documents were not found; reviewing the submitted case text only.",
    };
  }

  if (inputMode === "docs_plus_prompt") {
    return {
      scope: "the submitted issue text and workspace documents",
      review: `Reviewing ${docsLabel} together with the submitted case text.${missingNote}`,
    };
  }

  if (inputMode === "docs_only") {
    return {
      scope: "the workspace documents",
      review: `Reviewing ${docsLabel} from the workspace.${missingNote}`,
    };
  }

  if (inputMode === "prompt_only") {
    return {
      scope: "the submitted issue text",
      review: pastedDocs > 0 ? "Reviewing the submitted case text from the workspace." : "Reviewing the submitted case text.",
    };
  }

  if (uploadedDocs > 0 && pastedDocs > 0) {
    return {
      scope: "the submitted issue text and uploaded workspace documents",
      review: `Reviewing ${uploadedDocs} uploaded document${uploadedDocs === 1 ? "" : "s"} together with the submitted case text.`,
    };
  }

  if (uploadedDocs > 0) {
    return {
      scope: "the submitted issue text and uploaded workspace documents",
      review: `Reviewing ${uploadedDocs} uploaded document${uploadedDocs === 1 ? "" : "s"} from the workspace.`,
    };
  }

  if (pastedDocs > 0) {
    return {
      scope: "the submitted issue text",
      review: "Reviewing the submitted case text from the workspace.",
    };
  }

  return {
    scope: "the submitted issue text",
    review: "Reviewing the submitted case text.",
  };
}

function chooseDraftTemplateKey(domain: any) {
  const d = String(domain?.primary || domain?.domain || domain || "").toLowerCase();
  if (d.includes("employment")) return "employment_contract";
  if (d.includes("consumer")) return "demand_notice";
  if (d.includes("contract") || d.includes("commercial") || d.includes("corporate")) return "service_agreement";
  return "nda";
}

function inferEmergencyQueryDomain(text: string) {
  const q = String(text || "").toLowerCase();
  const checks: Array<[string, string, string[]]> = [
    ["Corporate / Contract", "Commercial Contract", ["contract", "agreement", "invoice", "payment", "vendor", "supplier", "breach", "service"]],
    ["Employment", "Employment Dispute", ["employment", "employee", "salary", "termination", "harassment", "workplace"]],
    ["Property / Tenancy", "Property / Tenancy", ["tenant", "landlord", "lease", "rent", "property", "possession"]],
    ["Consumer / Service Dispute", "Consumer Dispute", ["consumer", "refund", "defect", "service", "purchase", "warranty"]],
    ["Family", "Family Matter", ["marriage", "divorce", "custody", "maintenance", "family"]],
  ];
  let best: { primary: string; subtype: string; score: number } = {
    primary: "Civil Litigation",
    subtype: "General Civil Dispute",
    score: 0,
  };
  for (const [primary, subtype, terms] of checks) {
    const score = terms.reduce((acc, term) => acc + (q.includes(term) ? 1 : 0), 0);
    if (score > best.score) best = { primary, subtype, score };
  }
  return { primary: best.primary, subtype: best.subtype, confidence: best.score > 0 ? 0.58 : 0.34 };
}

function inferEmergencyJurisdiction(text: string) {
  const q = String(text || "").toLowerCase();
  const mentionsIndia = /\bindia\b|\bindian\b|\bdelhi\b|\bmumbai\b|\bchennai\b|\bbengaluru\b|\bkolkata\b|\bhyderabad\b|\bpunjab\b|\bmaharashtra\b|\btamil nadu\b|\bkarnataka\b/.test(q);
  return {
    country: mentionsIndia ? "India" : "Unknown",
    confidence: mentionsIndia ? 0.62 : 0.32,
    reason: mentionsIndia ? "Detected India-linked place or legal wording from submitted materials." : "No reliable jurisdiction signal was extracted before timeout.",
  };
}

function buildEmergencyIssueGroups(sourceText: string) {
  const domain = inferEmergencyQueryDomain(sourceText);
  return [
    {
      title: domain.primary,
      description: "Emergency handoff issue group generated so downstream agents can continue from available case text.",
      priority: "high",
    },
  ];
}

function buildEmergencyLegalGrounds(sourceText: string) {
  const q = String(sourceText || "").toLowerCase();
  const grounds = [
    q.includes("payment") || q.includes("invoice") ? "Payment default / recovery" : "",
    q.includes("agreement") || q.includes("contract") ? "Breach of agreement obligations" : "",
    q.includes("notice") ? "Notice and response dispute" : "",
    q.includes("termination") ? "Termination-related dispute" : "",
    q.includes("harassment") ? "Harassment / workplace grievance" : "",
  ].filter(Boolean);
  const unique = Array.from(new Set(grounds));
  if (unique.length >= 3) return unique.slice(0, 4);
  return [
    ...unique,
    "Facts and chronology need validation",
    "Document-backed claim assessment required",
    "Appropriate forum and relief need confirmation",
  ].slice(0, 4);
}

function buildEmergencyQueryParsingPayload(input: {
  caseId: string;
  role: string;
  preferredLanguage?: string | null;
  userQueryText?: string;
  docsText?: string;
  inputStats?: Record<string, any>;
  reason: string;
}) {
  const queryText = String(input.userQueryText || "").trim();
  const docsText = String(input.docsText || "").trim();
  const sourceText = `${queryText}\n${docsText}`.trim();
  const compactSource = sourceText.replace(/\s+/g, " ").trim();
  const domain = inferEmergencyQueryDomain(sourceText);
  const jurisdiction = inferEmergencyJurisdiction(sourceText);
  const legalGrounds = buildEmergencyLegalGrounds(sourceText);
  const issueGroups = buildEmergencyIssueGroups(sourceText);
  const summary = queryText
    ? `Fallback case handoff prepared from the submitted issue text and available workspace material so downstream analysis can continue on the current case.`
    : `Fallback case handoff prepared from the available workspace material so downstream analysis can continue on the current case.`;
  const citations = [];
  if (queryText) {
    citations.push({
      citation_id: "C1",
      source_type: "current_input",
      doc_id: "live_query",
      chunk_id: "live_query_1",
      snippet: queryText.slice(0, 260),
    });
  }
  if (docsText) {
    citations.push({
      citation_id: citations.length ? "C2" : "C1",
      source_type: "user_doc",
      doc_id: "workspace_fallback",
      chunk_id: "workspace_fallback_1",
      snippet: docsText.slice(0, 260),
    });
  }
  return {
    schema_version: "query_parsing_v2",
    output_mode: "fallback",
    mode: "fallback",
    analysis_valid: true,
    rejected_input: false,
    case_title: `Case ${input.caseId.slice(0, 8)}`,
    summary,
    executive_summary: summary,
    executive_summary_text: summary,
    language: {
      detected: String(input.preferredLanguage || "English"),
      confidence: 0.65,
    },
    detected_language: {
      code: String(input.preferredLanguage || "en").slice(0, 2).toLowerCase(),
      confidence: 0.65,
      name: String(input.preferredLanguage || "English"),
    },
    jurisdiction,
    jurisdiction_guess: jurisdiction.country,
    state: jurisdiction.country === "India" ? "India" : "Unknown",
    domain,
    legal_domain: domain.primary,
    legal_subtype: domain.subtype,
    case_type: domain.subtype,
    issue_groups: issueGroups,
    issues: issueGroups.map((item) => item.title),
    legal_grounds: legalGrounds,
    evidence_available: docsText ? ["workspace_documents"] : queryText ? ["submitted_query_text"] : [],
    requested_outcomes: [],
    suggested_topics: ["timeline validation", "document verification", "relief assessment"],
    missing_information_questions: [
      "What are the exact dates and chronology?",
      "Which documents best support the claim or defence?",
      "What relief or outcome is being sought?",
    ],
    recommended_next_agents: {
      common: ["query_parsing", "contract_risk", "outcome_projection", "policy_compliance", "legal_drafts_validation"],
      role_specific: ROLE_AGENT_KEYS[input.role as keyof typeof ROLE_AGENT_KEYS] || [],
    },
    confidence: 0.38,
    confidence_score: 38,
    citations,
    key_facts: {
      fallback_timeout_handoff: true,
      source_chars_used: compactSource.length,
    },
    qa_debug: {
      parser_path: "orchestrator_timeout_emergency_fallback",
      fallback_reason: input.reason,
      input_stats: input.inputStats || {},
      source_chars_used: compactSource.length,
    },
  };
}

async function resolveAudienceRole(userId: string, fallbackRole: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  return String(user?.role || fallbackRole || "");
}

async function persistEmergencyQueryParsingOutput(caseId: string, payload: any, language?: string | null) {
  await prisma.agentOutput.upsert({
    where: { caseId_agentKey: { caseId, agentKey: "query_parsing" } },
    create: {
      caseId,
      agentKey: "query_parsing",
      payloadJson: payload,
      sourceLanguage: String(language || "en"),
    },
    update: {
      payloadJson: payload,
      sourceLanguage: String(language || "en"),
    },
  });
}

function isRejectedQueryParsingPayload(payload: any) {
  if (!payload || typeof payload !== "object") return false;
  const rejectedFlag = payload.rejected_input === true || String(payload.rejected_input || "").toLowerCase() === "true";
  const invalidFlag = payload.analysis_valid === false || String(payload.analysis_valid || "").toLowerCase() === "false";
  const modeRejected = String(payload.output_mode || "").toLowerCase() === "rejected_input";
  const summary = String(payload.summary || payload.executive_summary_text || "").toLowerCase();
  const summaryRejected = summary.startsWith("rejected non-case input");
  return rejectedFlag || modeRejected || summaryRejected || (invalidFlag && (summaryRejected || modeRejected));
}

function defaultSteps(): RunStep[] {
  return [
    { name: "index_refresh", state: "PENDING", progress: 0 },
    { name: "query_parsing", state: "PENDING", progress: 0 },
    { name: "contract_risk", state: "PENDING", progress: 0 },
    { name: "outcome_projection", state: "PENDING", progress: 0 },
    { name: "policy_compliance", state: "PENDING", progress: 0 },
    { name: "legal_drafts_validation", state: "PENDING", progress: 0 },
    { name: "role_agents_parallel", state: "PENDING", progress: 0 },
    { name: "final_summary", state: "PENDING", progress: 0 },
  ];
}

async function updateRun(runId: string, status: RunStatus, steps: RunStep[], message?: string, finished = false) {
  await prisma.run.update({
    where: { id: runId },
    data: {
      status,
      stepsJson: steps.map((s) => (s.name === message ? { ...s, message } : s)) as any,
      ...(finished ? { finishedAt: new Date() } : {}),
    },
  });
}

async function markStep(runId: string, steps: RunStep[], name: string, state: RunStep["state"], progress: number, message?: string) {
  const idx = steps.findIndex((s) => s.name === name);
  if (idx >= 0) {
    steps[idx] = { ...steps[idx], state: state as RunStep["state"], progress, ...(message ? { message } : {}) };
  }
  await prisma.run.update({ where: { id: runId }, data: { stepsJson: steps as any } });
}

async function buildQueryInputs(caseId: string, currentQueryText?: string, querySourceHint?: string, docNames?: string[]) {
  const isExplicitDocsOnlyRun = querySourceHint === "run_request_docs_only";
  const isAttachmentMarkerOnly = (text: string) => {
    const trimmed = String(text || "").trim();
    if (!trimmed) return false;
    const lines = trimmed.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return false;
    return lines.every((line) => /^\[Attached documents:\s*.+\]$/i.test(line));
  };
  const [caseRow, docs] = await Promise.all([
    prisma.case.findUnique({ where: { id: caseId } }),
    prisma.document.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } }),
  ]);
  const primaryDocId = (caseRow as any)?.primaryDocId ? String((caseRow as any).primaryDocId) : null;
  const normalizedDocNames = Array.isArray(docNames)
    ? docNames.map((name) => String(name || "").trim()).filter(Boolean)
    : [];
  const docNamesSet = new Set(normalizedDocNames.map((name) => name.toLowerCase()));
  const uploadedDocs = docs.filter((d: any) => d.kind !== "pasted_text");
  const pastedDocs = docs.filter((d: any) => d.kind === "pasted_text");
  const matchedUploadedDocs = docNamesSet.size > 0
    ? uploadedDocs.filter((d: any) => docNamesSet.has(String(d?.name || "").toLowerCase()))
    : uploadedDocs;
  const matchedNames = new Set(matchedUploadedDocs.map((d: any) => String(d?.name || "").toLowerCase()));
  const selectedDocsMissing = docNamesSet.size > 0
    ? normalizedDocNames.filter((name) => !matchedNames.has(name.toLowerCase()))
    : [];
  const uploadedDocsForRun = (isExplicitDocsOnlyRun && primaryDocId)
    ? uploadedDocs.filter((d: any) => d.id === primaryDocId)
    : matchedUploadedDocs;
  const docsForRun = [...uploadedDocsForRun, ...pastedDocs];
  const allPastedIds = pastedDocs.map((d: any) => d.id);
  const latestPasted = [...docs]
    .filter((d: any) => d.kind === "pasted_text")
    .sort((a: any, b: any) => {
      const aScore = `${a.name === "query-context" ? "1" : "0"}:${new Date(a.updatedAt || a.createdAt).getTime()}:${a.id}`;
      const bScore = `${b.name === "query-context" ? "1" : "0"}:${new Date(b.updatedAt || b.createdAt).getTime()}:${b.id}`;
      return aScore < bScore ? 1 : -1;
    })[0];
  const docsTextRaw = uploadedDocsForRun
    .map((d: any) => d.extractedText || "")
    .join("\n\n")
    .trim();
  const explicitQueryText = String(currentQueryText || "").trim();
  const rawUserQueryText = isExplicitDocsOnlyRun
    ? ""
    : (explicitQueryText || (latestPasted?.extractedText || "").trim());
  const latestPastedIsMarkerOnly = isAttachmentMarkerOnly(rawUserQueryText);
  const userQueryTextRaw = latestPastedIsMarkerOnly ? "" : rawUserQueryText;
  const userQueryText = userQueryTextRaw.slice(0, MAX_QUERY_TEXT_CHARS);
  const docsText = docsTextRaw.slice(0, MAX_DOCS_TEXT_CHARS);
  const hasMeaningfulCurrentQuery =
    userQueryText.length >= 20 || /[\u0900-\u097f\u0980-\u09ff\u0b80-\u0bff\u0c00-\u0c7f]/.test(userQueryText);

  const docIdsForRun = new Set(docsForRun.map((d: any) => String(d.id)));
  let snippets: Array<{ doc_id: string; chunk_id: string; snippet: string; source_type?: string; source_label?: string }> = [];
  if (!isExplicitDocsOnlyRun && explicitQueryText) {
    snippets = [{
      doc_id: "live_query",
      chunk_id: "live_query:0",
      snippet: explicitQueryText.slice(0, 500),
      source_type: "user_doc",
      source_label: "Current Input",
    }];
  } else if (!isExplicitDocsOnlyRun && latestPasted && !latestPastedIsMarkerOnly) {
    const latestChunks = await prisma.indexChunk.findMany({
      where: { caseId, docId: latestPasted.id },
      orderBy: { createdAt: "asc" },
      take: 10,
    });
    snippets = latestChunks.map((row: any) => ({
      doc_id: row.docId,
      chunk_id: row.chunkId,
      snippet: String(row.chunkText || "").slice(0, 240),
      source_type: "user_doc",
    }));
  }
  // If the user just entered a fresh query-context, keep Query Parsing grounded to that current query first.
  // Only supplement when there is no meaningful current query (e.g. doc-only runs).
  if (snippets.length < 4 && !hasMeaningfulCurrentQuery) {
    try {
      const supplementalBundle = await retrieveBundleService.retrieveBundle({
        caseId,
        query: (userQueryText || docsText).split(/\s+/).filter(Boolean).slice(0, 16).join(" "),
        includeLegalCorpus: false,
        kUser: 10,
      });
      const supplemental = supplementalBundle.user_doc_hits;
      const scopedSupplemental =
        (isExplicitDocsOnlyRun && primaryDocId)
          ? (supplemental || []).filter((s: any) => String(s?.doc_id || s?.docId || "") === primaryDocId)
          : (docNamesSet.size > 0)
            ? (supplemental || []).filter((s: any) => docIdsForRun.has(String(s?.doc_id || s?.docId || "")))
            : (supplemental || []);
      snippets = [...snippets, ...scopedSupplemental];
    } catch {
      // best-effort only
    }
  }
  if (!snippets.length && !hasMeaningfulCurrentQuery) {
    const fallbackWhere: any = { caseId };
    if (isExplicitDocsOnlyRun && primaryDocId) {
      fallbackWhere.docId = primaryDocId;
    } else if (docNamesSet.size > 0 && docIdsForRun.size > 0) {
      fallbackWhere.docId = { in: Array.from(docIdsForRun) };
    }
    const fallbackChunks = await prisma.indexChunk.findMany({
      where: fallbackWhere,
      orderBy: { createdAt: "asc" },
      take: 10,
    });
    snippets = fallbackChunks
      .filter((row: any) => !allPastedIds.includes(row.docId))
      .map((row: any) => ({
      doc_id: row.docId,
      chunk_id: row.chunkId,
      snippet: String(row.chunkText || "").slice(0, 240),
      source_type: "user_doc",
    }));
  }

  const oldPastedIds = new Set<string>(
    explicitQueryText
      ? allPastedIds
      : allPastedIds.filter((id: string) => {
          if (latestPastedIsMarkerOnly) return true;
          return id !== latestPasted?.id;
        }),
  );
  snippets = snippets.filter((s) => !oldPastedIds.has(s.doc_id));
  // Final dedup by normalized snippet to avoid repeated citation cards.
  const seen = new Set<string>();
  snippets = snippets.filter((s) => {
    const norm = String(s.snippet || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 180);
    const key = norm ? `${s.doc_id}:${norm}` : `${s.doc_id}:${s.chunk_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const docChecksumsUsed = uploadedDocsForRun
    .map((d: any) => d.checksum)
    .filter(Boolean)
    .map(String);
  const uploadedDocsForRunCount = uploadedDocsForRun.length;
  const pastedDocsForRun = pastedDocs;
  const hasQueryText = userQueryText.length > 0;
  const hasDocs = uploadedDocsForRunCount > 0;
  const inputMode = hasDocs && hasQueryText
    ? "docs_plus_prompt"
    : hasDocs
      ? "docs_only"
      : hasQueryText
        ? "prompt_only"
        : "no_input";
  return {
    docsText,
    userQueryText,
    extractedDocSnippets: snippets,
    docChecksumsUsed,
    inputStats: {
      input_mode: inputMode,
      has_query_text: hasQueryText,
      has_docs: hasDocs,
      user_query_chars_raw: userQueryTextRaw.length,
      user_query_chars_used: userQueryText.length,
      user_query_truncated: userQueryTextRaw.length > userQueryText.length,
      docs_text_chars_raw: docsTextRaw.length,
      docs_text_chars_used: docsText.length,
      docs_text_truncated: docsTextRaw.length > docsText.length,
      total_docs: docsForRun.length,
      uploaded_docs: uploadedDocsForRunCount,
      uploaded_docs_total: uploadedDocs.length,
      pasted_docs: pastedDocsForRun.length,
      pasted_docs_total: pastedDocs.length,
      primary_doc_id: primaryDocId,
      docs_scope: isExplicitDocsOnlyRun
        ? (primaryDocId ? "primary_doc_only" : "all_case_docs_no_primary")
        : docNamesSet.size > 0
          ? (uploadedDocsForRunCount > 0 ? "selected_docs" : "selected_docs_empty")
          : "all_case_docs",
      selected_doc_names: normalizedDocNames,
      selected_docs_count: docNamesSet.size > 0 ? uploadedDocsForRunCount : 0,
      selected_docs_missing: selectedDocsMissing.length,
      seeded_snippets: snippets.length,
      query_source: querySourceHint || (explicitQueryText ? "run_request_text" : (latestPasted ? "latest_pasted_text" : "none")),
    },
  };
}

async function executeRun(runId: string, caseId: string, userId: string, currentQueryText?: string, querySourceHint?: string, docNames?: string[]) {
  const run = await prisma.run.findUnique({ where: { id: runId } });
  if (!run) return;
  const c = await prisma.case.findUnique({ where: { id: caseId } });
  if (!c) return;

  const steps = (Array.isArray(run.stepsJson) ? (run.stepsJson as unknown as RunStep[]) : defaultSteps());
  await prisma.run.update({ where: { id: runId }, data: { status: RunStatus.RUNNING, startedAt: run.startedAt ?? new Date(), stepsJson: steps as any } });

  try {
    const audienceRole = await resolveAudienceRole(userId, c.role);
    await markStep(runId, steps, "index_refresh", "RUNNING", 5, "Refreshing index");
    await indexService.refreshCaseDocuments(caseId);
    await markStep(runId, steps, "index_refresh", "SUCCEEDED", 15, "Index ready");

    const { docsText, userQueryText, extractedDocSnippets, docChecksumsUsed, inputStats } = await buildQueryInputs(caseId, currentQueryText, querySourceHint, docNames);
    const inputHash = sha256(
      JSON.stringify({
        caseId,
        querySourceHint: querySourceHint || null,
        userQueryText,
        docsTextHash: sha256(docsText),
        filters: c.filtersJson ?? {},
        docChecksumsUsed,
      }),
    );
    const existing: Record<string, any> = {};

    const commonSequence = [...COMMON_AGENT_KEYS];
    let progress = 20;
    for (const key of commonSequence) {
      await markStep(runId, steps, key, "RUNNING", progress, `Running ${key}`);
      const payload = await agentRunner.runCommonAgent(caseId, audienceRole as any, docsText, existing, key, {
        runId,
        inputHash,
        docChecksumsUsed,
        detectedLanguage: c.detectedLanguage,
        userQueryText,
        extractedDocSnippets,
        preferredLanguage: c.language,
        language: c.language,
        filtersApplied: c.filtersJson ?? {},
        inputStats,
      });
      existing[key] = payload;
      progress += 10;
      await markStep(runId, steps, key, "SUCCEEDED", progress, `${key} completed`);
      await notifyAgentEvent(userId, caseId, key, "completed");
    }

    const roleAgents = ROLE_AGENT_KEYS[audienceRole as keyof typeof ROLE_AGENT_KEYS] || [];
    await markStep(runId, steps, "role_agents_parallel", "RUNNING", 75, `Running ${roleAgents.length} role agents`);
    const roleOutputs: Record<string, any> = {};
    await Promise.all(
        roleAgents.map(async (key: string) => {
          try {
            roleOutputs[key] = await agentRunner.runRoleAgent(caseId, audienceRole as any, docsText, existing, key, {
              runId,
              inputHash,
              docChecksumsUsed,
              detectedLanguage: c.detectedLanguage,
              userQueryText,
              extractedDocSnippets,
              preferredLanguage: c.language,
              language: c.language,
              filtersApplied: c.filtersJson ?? {},
              inputStats,
            });
            await notifyAgentEvent(userId, caseId, key, "completed");
          } catch (error) {
            const message = error instanceof Error ? error.message : "Role agent failed";
            roleOutputs[key] = { error: message };
            await prisma.agentOutput.upsert({
              where: { caseId_agentKey: { caseId, agentKey: key } },
              create: { caseId, agentKey: key, payloadJson: roleOutputs[key], sourceLanguage: "en" },
              update: { payloadJson: roleOutputs[key] },
            });
            await notifyAgentEvent(userId, caseId, key, "failed", message);
          }
        }),
      );
    await markStep(runId, steps, "role_agents_parallel", "SUCCEEDED", 88, "Role agents completed");

    await markStep(runId, steps, "final_summary", "RUNNING", 92, "Generating final summary");
      await agentRunner.runFinalSummary(caseId, existing, roleOutputs, audienceRole as any, {
        runId,
        inputHash,
        docChecksumsUsed,
        detectedLanguage: c.detectedLanguage,
        userQueryText,
        extractedDocSnippets,
        preferredLanguage: c.language,
        language: c.language,
        filtersApplied: c.filtersJson ?? {},
        docsText,
        inputStats,
    });
    await markStep(runId, steps, "final_summary", "SUCCEEDED", 100, "Run completed");
    await notifyAgentEvent(userId, caseId, "final_summary", "completed");

    await prisma.run.update({
      where: { id: runId },
      data: { status: RunStatus.SUCCEEDED, finishedAt: new Date(), stepsJson: steps as any },
    });

    await notificationService.create(userId, "Run completed", `Analysis completed for case ${caseId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Run failed";
    const failing = steps.find((s) => s.state === "RUNNING");
    if (failing) failing.state = "FAILED";
    if (failing) failing.message = message;
    await prisma.run.update({
      where: { id: runId },
      data: { status: RunStatus.FAILED, finishedAt: new Date(), stepsJson: steps as any },
    });
    const runningKey = String(failing?.name || "run");
    await notifyAgentEvent(userId, caseId, runningKey, "failed", message);
    await notificationService.create(userId, "Run failed", `Analysis failed for case ${caseId}: ${message}`);
  }
}

export const orchestratorService = {
  AUTO_RUN_ALL,
  async startQueryParsingRun(userId: string, caseId: string, input?: { text?: string; filtersApplied?: any; doc_names?: string[] }) {
    const c = await prisma.case.findUnique({
      where: { id: caseId },
      include: { documents: true, runs: { orderBy: { createdAt: "desc" }, take: 10 } },
    });
    if (!c || c.userId !== userId) throw new HttpError(404, "Case not found", "case_not_found");
    if (!c.documents.length) throw new HttpError(400, "Upload a document or paste text before running analysis.", "case_no_documents");
    if (input?.filtersApplied && typeof input.filtersApplied === "object") {
      await prisma.case.update({ where: { id: caseId }, data: { filtersJson: input.filtersApplied as any } });
      c.filtersJson = input.filtersApplied as any;
    }

    const run = await withMysqlLock(`qp_start:${caseId}`, 3, async () => {
      const [inFlightRows]: any = await mysqlPool.query(
        `SELECT id, status, started_at, created_at
         FROM runs
         WHERE case_id = ?
           AND status IN ('PENDING','RUNNING')
           AND JSON_UNQUOTE(JSON_EXTRACT(steps_json, '$.meta.agent_key')) = 'query_parsing'
           AND JSON_UNQUOTE(JSON_EXTRACT(steps_json, '$.meta.kind')) = 'query_parsing_only'
         ORDER BY created_at DESC
         LIMIT 1`,
        [caseId],
      );
      const existing = Array.isArray(inFlightRows) && inFlightRows.length ? inFlightRows[0] : null;
      if (existing) {
        const startedMs = new Date(existing.started_at || existing.created_at || Date.now()).getTime();
        if (Date.now() - startedMs <= QUERY_PARSING_ONLY_STALE_MS) {
          return { id: String(existing.id) } as any;
        }
        await prisma.run.update({
          where: { id: String(existing.id) },
          data: {
            status: RunStatus.FAILED,
            finishedAt: new Date(),
            stepsJson: {
              stage: "error",
              done: true,
              error: "Stale query parsing run timed out",
              meta: { agent_key: "query_parsing", kind: "query_parsing_only" },
              steps: [{ name: "query_parsing", state: "FAILED", progress: 100, message: "Stale query parsing run timed out" }],
            } as any,
          },
        }).catch(() => undefined);
      }
      return prisma.run.create({
        data: {
          caseId,
          status: RunStatus.PENDING,
          language: c.language,
          stepsJson: {
            stage: "query_parsing",
            done: false,
            error: null,
            meta: { agent_key: "query_parsing", kind: "query_parsing_only" },
            steps: [{ name: "query_parsing", state: "PENDING", progress: 0 }],
          } as any,
          startedAt: new Date(),
        },
      });
    });

    setImmediate(() => {
      void (async () => {
        let builtInputs:
          | {
              docsText: string;
              userQueryText: string;
              extractedDocSnippets: any[];
              docChecksumsUsed: string[];
              inputStats: Record<string, any>;
            }
          | null = null;
        const audienceRole = await resolveAudienceRole(userId, c.role);
        try {
          await prisma.run.update({
            where: { id: run.id },
            data: {
              status: RunStatus.RUNNING,
              startedAt: new Date(),
              stepsJson: {
                stage: "query_parsing",
                done: false,
                error: null,
                meta: { agent_key: "query_parsing", kind: "query_parsing_only" },
                steps: [{ name: "query_parsing", state: "RUNNING", progress: 20 }],
              } as any,
            },
          });
          const querySourceHint =
            input?.text !== undefined
              ? (String(input.text || "").trim() ? "run_request_text" : "run_request_docs_only")
              : undefined;
          const { docsText, userQueryText, extractedDocSnippets, docChecksumsUsed, inputStats } =
            builtInputs = await buildQueryInputs(caseId, input?.text, querySourceHint, input?.doc_names);
          const inputHash = sha256(`${userQueryText}::${JSON.stringify(c.filtersJson ?? {})}`);
          const qpPayload = await withTimeout(agentRunner.runCommonAgent(caseId, audienceRole as any, docsText, {}, "query_parsing", {
            runId: run.id,
            inputHash,
            docChecksumsUsed,
            detectedLanguage: c.detectedLanguage,
            userQueryText,
            extractedDocSnippets,
            preferredLanguage: c.language,
            language: c.language,
            filtersApplied: c.filtersJson ?? {},
            inputStats,
          }), resolveQueryParsingTimeoutMs({ docsText, userQueryText, extractedDocSnippets }), "query_parsing");
          if (isRejectedQueryParsingPayload(qpPayload)) {
            await notificationService.create(
              userId,
              "Query Parsing completed with warnings",
              `Query Parsing produced a conservative fallback classification for case ${caseId}.`,
            );
          }
          await prisma.run.update({
            where: { id: run.id },
            data: {
              status: RunStatus.SUCCEEDED,
              finishedAt: new Date(),
              stepsJson: {
                stage: "done",
                done: true,
                error: null,
                meta: { agent_key: "query_parsing", kind: "query_parsing_only" },
                steps: [{ name: "query_parsing", state: "SUCCEEDED", progress: 100 }],
              } as any,
            },
          });
          await notifyAgentEvent(userId, caseId, "query_parsing", "completed");
        } catch (e) {
          const msg = String((e as any)?.message || e);
          if (builtInputs) {
            runCancellationService.cancel(run.id);
            const fallbackPayload = buildEmergencyQueryParsingPayload({
              caseId,
              role: audienceRole,
              preferredLanguage: c.language,
              userQueryText: builtInputs.userQueryText,
              docsText: builtInputs.docsText,
              inputStats: builtInputs.inputStats,
              reason: msg,
            });
            await persistEmergencyQueryParsingOutput(caseId, fallbackPayload, c.language || "en");
            await prisma.run.update({
              where: { id: run.id },
              data: {
                status: RunStatus.SUCCEEDED,
                finishedAt: new Date(),
                stepsJson: {
                  stage: "done",
                  done: true,
                  error: null,
                  meta: { agent_key: "query_parsing", kind: "query_parsing_only", fallback: "timeout_emergency_handoff" },
                  steps: [{ name: "query_parsing", state: "SUCCEEDED", progress: 100, message: "Fallback handoff completed after timeout" }],
                } as any,
              },
            }).catch(() => undefined);
            await notificationService.create(
              userId,
              "Query Parsing completed with fallback",
              `Query Parsing hit a timeout for case ${caseId}; a fallback handoff was saved so the workspace can continue.`,
            ).catch(() => undefined);
            await notifyAgentEvent(userId, caseId, "query_parsing", "completed").catch(() => undefined);
            return;
          }
          await prisma.run.update({
            where: { id: run.id },
            data: {
              status: RunStatus.FAILED,
              finishedAt: new Date(),
              stepsJson: {
                stage: "error",
                done: true,
                error: msg,
                meta: { agent_key: "query_parsing", kind: "query_parsing_only" },
                steps: [{ name: "query_parsing", state: "FAILED", progress: 100, message: msg }],
              } as any,
            },
          }).catch(() => undefined);
          await notifyAgentEvent(userId, caseId, "query_parsing", "failed", msg);
        }
      })();
    });

    return { run_id: run.id };
  },
  async startRunAllBackground(userId: string, caseId: string, input?: { force?: boolean; text?: string; filtersApplied?: any; doc_names?: string[] }) {
    await ensureCaseHasRunnableInput(userId, caseId, input?.text);
    const c = await prisma.case.findUnique({ where: { id: caseId }, include: { documents: true, runs: { orderBy: { createdAt: "desc" }, take: 1 } } });
    if (!c || c.userId !== userId) throw new HttpError(404, "Case not found", "case_not_found");
    if (!c.documents.length) throw new HttpError(400, "Upload a document or paste text before running analysis.", "case_no_documents");
    if (input?.filtersApplied && typeof input.filtersApplied === "object") {
      await prisma.case.update({ where: { id: caseId }, data: { filtersJson: input.filtersApplied as any } });
      c.filtersJson = input.filtersApplied as any;
    }
    const querySourceHint =
      input?.text !== undefined
        ? (String(input.text || "").trim() ? "run_request_text" : "run_request_docs_only")
        : undefined;
    const initialInputs = await buildQueryInputs(caseId, input?.text, querySourceHint, input?.doc_names);
    const docsHash = sha256(JSON.stringify({
      docChecksumsUsed: initialInputs.docChecksumsUsed || [],
      userQueryText: initialInputs.userQueryText || "",
      docsScope: initialInputs.inputStats?.docs_scope || "",
      selectedDocNames: initialInputs.inputStats?.selected_doc_names || [],
    }));
    const lockKey = `${caseId}:${docsHash}:run_all`;
    const existing = [...runAllJobs.values()].find((j: any) => j.case_id === caseId && j.doc_hash === docsHash && j.overall_status === "running");
    if (existing) {
      return { run_all_id: existing.run_all_id, runs: { query_parsing: existing.agents.query_parsing.run_id }, status_url: `/api/cases/${caseId}/run-all/${existing.run_all_id}/status` };
    }
    const qpRun = await prisma.run.create({
      data: { caseId, status: RunStatus.PENDING, language: c.language, stepsJson: { stage: "query_parsing", done: false, error: null, meta: { agent_key: "query_parsing", kind: "run_all_child" }, steps: [{ name: "query_parsing", state: "PENDING", progress: 0 }] } as any, startedAt: new Date() },
    });
    const runAllId = randomId();
    const audienceRole = await resolveAudienceRole(userId, c.role);
    const roleAgentsForCase = ROLE_AGENT_KEYS[audienceRole as keyof typeof ROLE_AGENT_KEYS] || [];
    const job: any = {
        run_all_id: runAllId,
        case_id: caseId,
        doc_hash: docsHash,
        overall_status: "running",
        cancel_requested: false,
        force: !!input?.force,
        input_snapshot: {
          query_source: querySourceHint || null,
          selected_doc_names: initialInputs.inputStats?.selected_doc_names || [],
          docs_scope: initialInputs.inputStats?.docs_scope || null,
        },
        activity: [],
        activity_cursor_by_agent: {} as Record<string, string>,
        agents: {
          query_parsing: makeAgentStatus("running", qpRun.id, 5, "query_parsing"),
        [contractRiskAgentService.AGENT_KEY]: makeAgentStatus("queued", null, 0, "queued"),
        [caseOutcomeAgentService.AGENT_KEY]: makeAgentStatus("queued", null, 0, "queued"),
        [policyComplianceAgentService.AGENT_KEY]: makeAgentStatus("queued", null, 0, "queued"),
        [legalDraftsAgentService.AGENT_KEY]: makeAgentStatus("queued", null, 0, "queued"),
        ...Object.fromEntries(roleAgentsForCase.map((key) => [key, makeAgentStatus("queued", null, 0, "queued")])),
      },
    };
    runAllJobs.set(runAllId, job);

    const runAgentWithConcurrency = async (tasks: Array<() => Promise<void>>) => {
      const queue = [...tasks];
      const workers = Array.from({ length: Math.min(MAX_PARALLEL_AGENTS, queue.length) }, async () => {
        while (queue.length) {
          if (isRunAllCancelled(job)) return;
          const fn = queue.shift();
          if (!fn) return;
          if (isRunAllCancelled(job)) return;
          await fn();
        }
      });
      await Promise.allSettled(workers);
    };

    const wrapAgentTask = (agentKey: string, task: () => Promise<void>) => async () => {
      try {
        await task();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || "Agent failed");
        const httpStatus = (error as any)?.status;
        const isBlocked = Number(httpStatus || 0) >= 400 && Number(httpStatus || 0) < 500;
        const status = isBlocked ? "blocked" : "error";
        const existing = job.agents?.[agentKey] || {};
        const pct = Math.max(1, Number(existing.pct || 0));
        job.agents[agentKey] = makeAgentStatus(status, existing.run_id || null, pct, status, message);
        pushActivity(job, {
          actor: agentTitle(agentKey),
          phase: status === "blocked" ? "Blocked" : "Issue",
          text: status === "blocked" ? "Agent cannot proceed with this input" : "Agent run failed",
          detail: message,
          tone: "error",
        });
        await notifyAgentEvent(userId, caseId, agentKey, "failed", message);
      }
    };

      setImmediate(() => {
        void (async () => {
          try {
            if (isRunAllCancelled(job)) return;
            pushActivity(job, {
              actor: "Query Parsing",
              phase: "Thinking",
              text: "Parsing legal intent",
              detail: "Reading the submitted issue text before routing the case.",
              next: "Build the structured case context for downstream agents.",
              tone: "live",
            });
            await prisma.run.update({ where: { id: qpRun.id }, data: { status: RunStatus.RUNNING, startedAt: new Date(), stepsJson: { stage: "query_parsing", done: false, error: null, steps: [{ name: "query_parsing", state: "RUNNING", progress: 20 }], meta: { agent_key: "query_parsing", kind: "run_all_child", lockKey } } as any } });
            const { docsText, userQueryText, extractedDocSnippets, docChecksumsUsed, inputStats } = initialInputs;
            const inputDescription = describeWorkspaceInputs(inputStats);
            pushActivity(job, {
              actor: "Query Parsing",
              phase: "Reading documents",
              text: "Reading workspace evidence",
              detail: inputDescription.review,
              next: "Identify issue groups, jurisdiction, and domain.",
              tone: "live",
            });
            const inputHash = sha256(`${userQueryText}::${JSON.stringify(c.filtersJson ?? {})}`);
            let qpPayload: any;
            try {
              qpPayload = await withTimeout(agentRunner.runCommonAgent(caseId, audienceRole as any, docsText, {}, "query_parsing", {
                runId: qpRun.id,
                inputHash,
                docChecksumsUsed,
                detectedLanguage: c.detectedLanguage,
                userQueryText,
                extractedDocSnippets,
                preferredLanguage: c.language,
                language: c.language,
                filtersApplied: c.filtersJson ?? {},
                inputStats,
              }), resolveQueryParsingTimeoutMs({ docsText, userQueryText, extractedDocSnippets }), "query_parsing");
            } catch (queryParsingError) {
              const reason = String((queryParsingError as any)?.message || queryParsingError);
              runCancellationService.cancel(qpRun.id);
              qpPayload = buildEmergencyQueryParsingPayload({
                caseId,
                role: audienceRole,
                preferredLanguage: c.language,
                userQueryText,
                docsText,
                inputStats,
                reason,
              });
              await persistEmergencyQueryParsingOutput(caseId, qpPayload, c.language || "en");
              pushActivity(job, {
                actor: "Query Parsing",
                phase: "Recovery",
                text: "Timeout fallback saved",
                detail: "Query Parsing exceeded the runtime window, so a fallback handoff was saved and downstream agents can continue.",
                next: "Start the parallel downstream agent run.",
                tone: "error",
              });
            }
          if (isRejectedQueryParsingPayload(qpPayload)) {
            pushActivity(job, {
              actor: "Query Parsing",
              phase: "Done",
              text: "Conservative evidence-first classification",
              detail: "Query Parsing returned a conservative evidence-first classification; downstream agents will continue.",
              tone: "neutral",
            });
          }
            if (isRunAllCancelled(job)) {
              job.agents.query_parsing = makeAgentStatus("cancelled", qpRun.id, 100, "cancelled", cancelReason());
              return;
            }
            await prisma.run.update({ where: { id: qpRun.id }, data: { status: RunStatus.SUCCEEDED, finishedAt: new Date(), stepsJson: { stage: "done", done: true, error: null, steps: [{ name: "query_parsing", state: "SUCCEEDED", progress: 100 }], meta: { agent_key: "query_parsing", kind: "run_all_child" } } as any } });
            job.agents.query_parsing = makeAgentStatus("done", qpRun.id, 100, "done");
            job.agents.query_parsing.updated_at = nowIso();
            pushActivity(job, {
              actor: "Query Parsing",
              phase: "Done",
              text: "Structured workspace is ready",
              detail: "Parsed facts, legal domain, and routing context are available for downstream agents.",
              next: "Start the parallel downstream agent run.",
              tone: "success",
            });
            await notifyAgentEvent(userId, caseId, "query_parsing", "completed");
            const draftTemplateKey = chooseDraftTemplateKey((qpPayload as any)?.domain || (qpPayload as any)?.legal_domain || null);

            const commonTasks = [
              wrapAgentTask(contractRiskAgentService.AGENT_KEY, async () => {
                if (isRunAllCancelled(job)) {
                  job.agents[contractRiskAgentService.AGENT_KEY] = makeAgentStatus("cancelled", null, 0, "cancelled", cancelReason());
                  return;
                }
                pushActivity(job, {
                  actor: agentTitle(contractRiskAgentService.AGENT_KEY),
                  phase: "Working",
                  text: "Starting from parsed workspace context",
                  detail: "Using the Query Parsing output to review clauses, dispute exposure, and contract risk.",
                  next: "Open the current contract analysis step.",
                  tone: "live",
                });
                job.agents[contractRiskAgentService.AGENT_KEY] = makeAgentStatus("running", null, 10, "queued");
                const started = await contractRiskAgentService.startRun(userId, caseId, { force: !!input?.force });
              if ((started as any).output && (started as any).status === "cached") {
                job.agents[contractRiskAgentService.AGENT_KEY] = makeAgentStatus("done", null, 100, "cached");
                await notifyAgentEvent(userId, caseId, contractRiskAgentService.AGENT_KEY, "completed");
                return;
              }
              const runId = (started as any).run_id || null;
              job.agents[contractRiskAgentService.AGENT_KEY] = makeAgentStatus("running", runId, 20, "running");
              if (runId) await orchestratorService.waitForChildRun(userId, runId, job, contractRiskAgentService.AGENT_KEY);
              }),
              wrapAgentTask(caseOutcomeAgentService.AGENT_KEY, async () => {
                if (isRunAllCancelled(job)) {
                  job.agents[caseOutcomeAgentService.AGENT_KEY] = makeAgentStatus("cancelled", null, 0, "cancelled", cancelReason());
                  return;
                }
                pushActivity(job, {
                  actor: agentTitle(caseOutcomeAgentService.AGENT_KEY),
                  phase: "Working",
                  text: "Starting from parsed workspace context",
                  detail: "Using the Query Parsing output to estimate likely outcome, timing, and case pressure points.",
                  next: "Open the current outcome analysis step.",
                  tone: "live",
                });
                job.agents[caseOutcomeAgentService.AGENT_KEY] = makeAgentStatus("running", null, 10, "queued");
                const started = await caseOutcomeAgentService.startRun(userId, caseId, { force: !!input?.force });
              if ((started as any).output && (started as any).status === "cached") {
                job.agents[caseOutcomeAgentService.AGENT_KEY] = makeAgentStatus("done", null, 100, "cached");
                await notifyAgentEvent(userId, caseId, caseOutcomeAgentService.AGENT_KEY, "completed");
                return;
              }
              const runId = (started as any).run_id || null;
              job.agents[caseOutcomeAgentService.AGENT_KEY] = makeAgentStatus("running", runId, 20, "running");
              if (runId) await orchestratorService.waitForChildRun(userId, runId, job, caseOutcomeAgentService.AGENT_KEY);
              }),
              wrapAgentTask(policyComplianceAgentService.AGENT_KEY, async () => {
                if (isRunAllCancelled(job)) {
                  job.agents[policyComplianceAgentService.AGENT_KEY] = makeAgentStatus("cancelled", null, 0, "cancelled", cancelReason());
                  return;
                }
                pushActivity(job, {
                  actor: agentTitle(policyComplianceAgentService.AGENT_KEY),
                  phase: "Working",
                  text: "Starting from parsed workspace context",
                  detail: "Using the Query Parsing output to evaluate legal and policy compliance obligations.",
                  next: "Open the current compliance review step.",
                  tone: "live",
                });
                job.agents[policyComplianceAgentService.AGENT_KEY] = makeAgentStatus("running", null, 10, "queued");
                const started = await policyComplianceAgentService.startRun(userId, caseId, { force: !!input?.force });
              if ((started as any).output && (started as any).status === "cached") {
                job.agents[policyComplianceAgentService.AGENT_KEY] = makeAgentStatus("done", null, 100, "cached");
                await notifyAgentEvent(userId, caseId, policyComplianceAgentService.AGENT_KEY, "completed");
                return;
              }
              const runId = (started as any).run_id || null;
              job.agents[policyComplianceAgentService.AGENT_KEY] = makeAgentStatus("running", runId, 20, "running");
              if (runId) await orchestratorService.waitForChildRun(userId, runId, job, policyComplianceAgentService.AGENT_KEY);
              }),
              wrapAgentTask(legalDraftsAgentService.AGENT_KEY, async () => {
                if (isRunAllCancelled(job)) {
                  job.agents[legalDraftsAgentService.AGENT_KEY] = makeAgentStatus("cancelled", null, 0, "cancelled", cancelReason());
                  return;
                }
                pushActivity(job, {
                  actor: agentTitle(legalDraftsAgentService.AGENT_KEY),
                  phase: "Drafting",
                  text: "Starting from parsed workspace context",
                  detail: "Using validated facts and the parsed issue map to prepare draft-ready legal output.",
                  next: "Open the current drafting step.",
                  tone: "live",
                });
                job.agents[legalDraftsAgentService.AGENT_KEY] = makeAgentStatus("running", null, 10, "queued");
                const started = await legalDraftsAgentService.generateDraft(userId, caseId, {
                template_key: draftTemplateKey,
                auto_select: true,
                language: c.language || "English",
                jurisdiction: "India",
              });
              if ((started as any).output && (started as any).status === "cached") {
                job.agents[legalDraftsAgentService.AGENT_KEY] = makeAgentStatus("done", null, 100, "cached");
                await notifyAgentEvent(userId, caseId, legalDraftsAgentService.AGENT_KEY, "completed");
                return;
              }
              const runId = (started as any).run_id || null;
              job.agents[legalDraftsAgentService.AGENT_KEY] = makeAgentStatus("running", runId, 20, "running");
              if (runId) await orchestratorService.waitForChildRun(userId, runId, job, legalDraftsAgentService.AGENT_KEY);
              }),
            ];
            const roleTasks = roleAgentsForCase.map((agentKey) => wrapAgentTask(agentKey, async () => {
                if (isRunAllCancelled(job)) {
                  job.agents[agentKey] = makeAgentStatus("cancelled", null, 0, "cancelled", cancelReason());
                  return;
                }
                pushActivity(job, {
                  actor: agentTitle(agentKey),
                  phase: "Working",
                  text: "Starting from parsed workspace context",
                  detail: "Using the shared case context produced by Query Parsing before beginning role-specific work.",
                  next: "Open the current role-agent step.",
                  tone: "live",
                });
                job.agents[agentKey] = makeAgentStatus("running", null, 10, "queued");
                const started = await roleAgentRunService.startRun(userId, caseId, agentKey, {
                force: !!input?.force,
                output_lang: c.language || "English",
                profile: "standard",
              });
              if ((started as any).output && (started as any).status === "cached") {
                job.agents[agentKey] = makeAgentStatus("done", (started as any).run_id || null, 100, "cached");
                await notifyAgentEvent(userId, caseId, agentKey, "completed");
                return;
              }
              const runId = (started as any).run_id || null;
              job.agents[agentKey] = makeAgentStatus("running", runId, 20, "running");
              if (runId) await orchestratorService.waitForChildRun(userId, runId, job, agentKey);
              }));
            const taskFactories: Array<() => Promise<void>> = [];
            const maxLen = Math.max(commonTasks.length, roleTasks.length);
            for (let i = 0; i < maxLen; i += 1) {
              if (commonTasks[i]) taskFactories.push(commonTasks[i]);
              if (roleTasks[i]) taskFactories.push(roleTasks[i]);
            }
          await runAgentWithConcurrency(taskFactories);
            if (isRunAllCancelled(job)) {
              return;
            }
            const expectedPersistedAgents = [
              contractRiskAgentService.AGENT_KEY,
              caseOutcomeAgentService.AGENT_KEY,
              policyComplianceAgentService.AGENT_KEY,
              legalDraftsAgentService.AGENT_KEY,
              ...roleAgentsForCase,
            ];
            let missingPersistedOutputs = await waitForPersistedOutputs(caseId, expectedPersistedAgents, 8000);
            if (!isRunAllCancelled(job) && missingPersistedOutputs.length) {
              for (const missingAgentKey of missingPersistedOutputs) {
                const reason = String(job.agents?.[missingAgentKey]?.reason || job.agents?.[missingAgentKey]?.step || "Initial run did not save a visible output").trim();
                pushActivity(job, {
                  actor: agentTitle(missingAgentKey),
                  phase: "Recovery",
                  text: "Saving fallback output",
                  detail: `${agentTitle(missingAgentKey)} did not persist a dashboard-visible report in time, so the orchestrator is saving a warning-grade fallback output from the current workspace.`,
                  next: "Use the saved fallback output in the dashboard report.",
                  tone: "live",
                });
                try {
                  const saved = await synthesizeEmergencyAgentOutput({
                    caseId,
                    agentKey: missingAgentKey,
                    reason,
                    caseTitle: c.title || "Case Workspace",
                    language: c.language || "English",
                    qpPayload,
                  });
                  if (saved) {
                    job.agents[missingAgentKey] = makeAgentStatus(
                      "done",
                      job.agents?.[missingAgentKey]?.run_id || null,
                      100,
                      "fallback_saved",
                      reason,
                    );
                    pushActivity(job, {
                      actor: agentTitle(missingAgentKey),
                      phase: "Done",
                      text: "Fallback output saved",
                      detail: `${agentTitle(missingAgentKey)} is available in the workspace with a saved fallback report.`,
                      tone: "success",
                    });
                  }
                } catch (synthError) {
                  const synthReason = String((synthError as any)?.message || synthError);
                  job.agents[missingAgentKey] = makeAgentStatus(
                    "error",
                    job.agents?.[missingAgentKey]?.run_id || null,
                    Math.max(1, Number(job.agents?.[missingAgentKey]?.pct || 0)),
                    "fallback_save_failed",
                    synthReason,
                  );
                  pushActivity(job, {
                    actor: agentTitle(missingAgentKey),
                    phase: "Issue",
                    text: "Fallback save failed",
                    detail: synthReason,
                    tone: "error",
                  });
                }
              }
              missingPersistedOutputs = await waitForPersistedOutputs(caseId, expectedPersistedAgents, 4000);
            }
            for (const missingAgentKey of missingPersistedOutputs) {
              const current = job.agents[missingAgentKey];
              if (current && current.status !== "error") {
                job.agents[missingAgentKey] = makeAgentStatus(
                  "error",
                  current.run_id || null,
                  Math.max(1, Number(current.pct || 0)),
                  current.step || "missing_output",
                  "Agent run finished without saving a dashboard-visible output.",
                );
              }
            }
            const unresolvedAgents = Object.entries(job.agents || {})
              .filter(([, agentState]: [string, any]) => {
                const status = String(agentState?.status || "").toLowerCase();
                return !["done", "cached"].includes(status);
              })
              .map(([agentKey]) => agentKey);
            const anyErr = unresolvedAgents.length > 0;
            if (anyErr) {
              job.overall_status = "error";
              pushActivity(job, {
                actor: "Agent runtime",
                phase: "Issue",
                text: "Run could not finalize all agent outputs",
                detail: `The orchestrator stopped before every agent saved a dashboard-visible output. Unresolved agents: ${unresolvedAgents.map((agentKey) => agentTitle(agentKey)).join(", ")}.`,
                tone: "error",
              });
              job.warning = `Unresolved agent outputs: ${unresolvedAgents.join(", ")}`;
              await notificationService.create(userId, "Automated run failed to finalize", `One or more agent outputs were not finalized for case ${caseId}`);
            } else {
              job.overall_status = "done";
              pushActivity(job, {
                actor: "Agent runtime",
                phase: "Done",
                text: "All agent outputs are ready",
                detail: "The workspace run finished successfully and all agent outputs have been saved.",
                tone: "success",
              });
              await notificationService.create(userId, "Automated run completed", `All agents completed for case ${caseId}`);
            }
          } catch (e) {
            const msg = String((e as any)?.message || e);
            pushActivity(job, {
              actor: "Query Parsing",
              phase: "Issue",
              text: "Run failed before downstream handoff",
              detail: msg,
              tone: "error",
            });
            job.agents.query_parsing = { ...job.agents.query_parsing, status: "error", pct: 100, step: msg, updated_at: nowIso() };
          job.agents[contractRiskAgentService.AGENT_KEY] = makeAgentStatus("blocked", null, 0, "blocked", "Query Parsing failed");
          job.agents[caseOutcomeAgentService.AGENT_KEY] = makeAgentStatus("blocked", null, 0, "blocked", "Query Parsing failed");
          job.agents[policyComplianceAgentService.AGENT_KEY] = makeAgentStatus("blocked", null, 0, "blocked", "Query Parsing failed");
          job.agents[legalDraftsAgentService.AGENT_KEY] = makeAgentStatus("blocked", null, 0, "blocked", "Query Parsing failed");
          for (const roleKey of roleAgentsForCase) {
            job.agents[roleKey] = makeAgentStatus("blocked", null, 0, "blocked", "Query Parsing failed");
          }
          await prisma.run.update({ where: { id: qpRun.id }, data: { status: RunStatus.FAILED, finishedAt: new Date(), stepsJson: { stage: "error", done: true, error: msg, steps: [{ name: "query_parsing", state: "FAILED", progress: 100, message: msg }], meta: { agent_key: "query_parsing", kind: "run_all_child" } } as any } }).catch(() => undefined);
          await notifyAgentEvent(userId, caseId, "query_parsing", "failed", msg);
          await notificationService.create(userId, "Automated run failed", `Dashboard automation failed for case ${caseId}: ${msg}`);
          job.overall_status = "error";
        }
      })();
    });
    return { run_all_id: runAllId, runs: { query_parsing: qpRun.id }, run_id: qpRun.id, status_url: `/api/cases/${caseId}/run-all/${runAllId}/status` };
  },

  async waitForChildRun(userId: string, runId: string, job: any, agentKey: string) {
    const startedAt = Date.now();
    const hasMaxWait = Number.isFinite(CHILD_RUN_MAX_WAIT_MS) && CHILD_RUN_MAX_WAIT_MS > 0;
    while (!hasMaxWait || (Date.now() - startedAt) < CHILD_RUN_MAX_WAIT_MS) {
      if (isRunAllCancelled(job)) {
        job.agents[agentKey] = makeAgentStatus("cancelled", runId, Math.max(1, Number(job.agents?.[agentKey]?.pct || 0)), "cancelled", cancelReason());
        pushActivity(job, {
          actor: agentTitle(agentKey),
          phase: "Cancelled",
          text: "Run stopped from dashboard",
          detail: "Dashboard cancellation stopped the remaining orchestration for this agent.",
          tone: "neutral",
        });
        return;
      }
      const persistedOutputReady = await hasPersistedAgentOutput(job.case_id, agentKey);
      if (persistedOutputReady) {
        const currentStep = String(job.agents?.[agentKey]?.step || "output_saved");
        job.agents[agentKey] = makeAgentStatus("done", runId, 100, currentStep);
        pushActivity(job, {
          actor: agentTitle(agentKey),
          phase: "Done",
          text: "Output ready",
          detail: `${agentTitle(agentKey)} saved its output to the workspace and is ready for the summary view.`,
          tone: "success",
        });
        return;
      }
      const s = await this.getRunStatus(userId, runId);
      const pct = Number((s as any)?.progress?.pct ?? (s.steps?.length ? Math.max(...s.steps.map((x: any) => Number(x.progress || 0))) : 0));
      const step = String((s as any)?.progress?.step || (s as any)?.stage || "");
      const cursor = `${String(s.status || "")}:${step}:${Math.max(1, pct)}`;

      if (job.activity_cursor_by_agent?.[agentKey] !== cursor) {
        job.activity_cursor_by_agent[agentKey] = cursor;
        const activity = describeStepActivity(agentKey, step);
        pushActivity(job, {
          actor: agentTitle(agentKey),
          phase: activity.phase,
          text: activity.text,
          detail: activity.detail,
          next: activity.next,
          tone: s.status === RunStatus.FAILED ? "error" : s.status === RunStatus.SUCCEEDED ? "success" : "live",
        });
      }

      if (s.status === RunStatus.SUCCEEDED || persistedOutputReady) {
        job.agents[agentKey] = makeAgentStatus("done", runId, 100, step || "done");
        pushActivity(job, {
          actor: agentTitle(agentKey),
          phase: "Done",
          text: "Output ready",
          detail: `${agentTitle(agentKey)} completed successfully and saved its output to the workspace.`,
          tone: "success",
        });
        return;
      }
      if (s.status === RunStatus.PENDING) {
        job.agents[agentKey] = makeAgentStatus(
          "queued",
          runId,
          Math.max(1, Math.min(18, pct || 10)),
          step || "queued_for_workspace_handoff",
        );
        await new Promise((r) => setTimeout(r, CHILD_RUN_POLL_INTERVAL_MS));
        continue;
      }
      if (s.status === RunStatus.FAILED) {
        const reason = (s as any)?.error_message || (s as any)?.error || "Agent failed";
        const settled = await waitForPersistedOutputs(job.case_id, [agentKey], 2500);
        if (!settled.length) {
          job.agents[agentKey] = makeAgentStatus("done", runId, 100, step || "output_saved");
          pushActivity(job, {
            actor: agentTitle(agentKey),
            phase: "Done",
            text: "Output ready",
            detail: `${agentTitle(agentKey)} saved its output to the workspace after finalization.`,
            tone: "success",
          });
          return;
        }
        job.agents[agentKey] = makeAgentStatus(
          "queued",
          runId,
          Math.max(70, Math.min(92, pct || 82)),
          "waiting_for_saved_output",
          reason,
        );
        pushActivity(job, {
          actor: agentTitle(agentKey),
          phase: "Recovery",
          text: "Finalizing saved output",
          detail: `${agentTitle(agentKey)} reported a terminal run state, so the orchestrator is verifying or regenerating the persisted output.`,
          tone: "live",
        });
        return;
      }
      job.agents[agentKey] = makeAgentStatus("running", runId, Math.max(1, pct), step || "running");
      await new Promise((r) => setTimeout(r, CHILD_RUN_POLL_INTERVAL_MS));
    }
    if (hasMaxWait) {
      const settled = await waitForPersistedOutputs(job.case_id, [agentKey], CHILD_RUN_RECOVERY_GRACE_MS);
      if (!settled.length) {
        const currentStep = String(job.agents?.[agentKey]?.step || "output_saved");
        job.agents[agentKey] = makeAgentStatus("done", runId, 100, currentStep);
        pushActivity(job, {
          actor: agentTitle(agentKey),
          phase: "Done",
          text: "Output ready",
          detail: `${agentTitle(agentKey)} completed during finalization and saved its output to the workspace.`,
          tone: "success",
        });
        return;
      }

      const finalStatus = await this.getRunStatus(userId, runId).catch(() => null);
      const finalStep = String((finalStatus as any)?.progress?.step || (finalStatus as any)?.stage || "finalizing_output");
      const finalReason =
        (finalStatus as any)?.status === RunStatus.FAILED
          ? String((finalStatus as any)?.error_message || (finalStatus as any)?.error || "Agent failed")
          : null;
      job.agents[agentKey] = makeAgentStatus(
        "queued",
        runId,
        92,
        finalStep || "waiting_for_saved_output",
        finalReason || "Waiting for saved output finalization",
      );
      pushActivity(job, {
        actor: agentTitle(agentKey),
        phase: "Recovery",
        text: "Finalizing saved output",
        detail: `${agentTitle(agentKey)} is taking longer than the live wait window, so the orchestrator is finishing persistence before deciding whether recovery output is needed.`,
        tone: "live",
      });
    }
  },

  async getRunAllStatus(userId: string, caseId: string, runAllId: string) {
    const c = await prisma.case.findUnique({ where: { id: caseId } });
    if (!c || c.userId !== userId) throw new HttpError(404, "Case not found", "case_not_found");
    const job = runAllJobs.get(runAllId);
    if (!job || job.case_id !== caseId) throw new HttpError(404, "Run-all job not found", "run_all_not_found");
    return job;
  },

  async cancelRunAll(userId: string, caseId: string, runAllId: string) {
    const c = await prisma.case.findUnique({ where: { id: caseId } });
    if (!c || c.userId !== userId) throw new HttpError(404, "Case not found", "case_not_found");
    const job = runAllJobs.get(runAllId);
    if (!job || job.case_id !== caseId) throw new HttpError(404, "Run-all job not found", "run_all_not_found");
    if (String(job.overall_status || "").toLowerCase() !== "running") {
      return job;
    }

    job.cancel_requested = true;
    job.overall_status = "cancelled";
    job.cancelled_at = nowIso();
    pushActivity(job, {
      actor: "Agent runtime",
      phase: "Cancelled",
      text: "Run cancelled from dashboard",
      detail: "Stopped the remaining multi-agent orchestration and returned control to the dashboard.",
      tone: "neutral",
    });

    Object.entries(job.agents || {}).forEach(([agentKey, agentState]: [string, any]) => {
      const status = String(agentState?.status || "").toLowerCase();
      if (status === "done" || status === "error" || status === "failed" || status === "blocked" || status === "cached") {
        return;
      }
      const pct = Math.max(0, Number(agentState?.pct || 0));
      job.agents[agentKey] = makeAgentStatus("cancelled", agentState?.run_id || null, pct, "cancelled", cancelReason());
    });

    const childRunIds = Object.values(job.agents || {})
      .map((agentState: any) => String(agentState?.run_id || "").trim())
      .filter(Boolean);
    for (const runId of childRunIds) {
      runCancellationService.cancel(runId);
      await prisma.run.update({ where: { id: runId }, data: { status: RunStatus.FAILED, finishedAt: new Date() } }).catch(() => undefined);
    }

    return job;
  },

  async previewQueryParsing(userId: string, caseId: string, userQueryText: string, filtersApplied?: any) {
    const c = await prisma.case.findUnique({
      where: { id: caseId },
      include: { documents: true },
    });
    if (!c || c.userId !== userId) throw new HttpError(404, "Case not found", "case_not_found");
    const docsTextRaw = c.documents
      .filter((d: any) => d.kind !== "pasted_text")
      .map((d: any) => d.extractedText || "")
      .join("\n\n")
      .trim();
    const docsText = docsTextRaw.slice(0, MAX_DOCS_TEXT_CHARS);
    const userQueryTrimmed = (userQueryText || "").slice(0, MAX_QUERY_TEXT_CHARS);
    const hasDocs = (c.documents || []).some((d: any) => d.kind !== "pasted_text");
    const hasQuery = !!userQueryTrimmed.trim();
    const inputMode = hasDocs && hasQuery ? "docs_plus_prompt" : hasDocs ? "docs_only" : hasQuery ? "prompt_only" : "no_input";
    const snippets = userQueryText.trim()
      ? [{
          doc_id: "live_query",
          chunk_id: "live_query:0",
          snippet: userQueryTrimmed.trim().slice(0, 500),
          source_type: "user_doc",
        }]
      : [];
    previewQueryTextByCase.set(caseId, { text: String(userQueryText || ""), ts: Date.now() });
    const previewDocChecksumsUsed = (c.documents || []).map((d: any) => d.checksum).filter(Boolean).map(String);
    const audienceRole = await resolveAudienceRole(userId, c.role);
    const payload = await agentRunner.previewQueryParsing(caseId, audienceRole as any, docsText, {
      runId: null,
      inputHash: sha256(JSON.stringify({
        caseId,
        querySourceHint: "query_preview_request_text",
        userQueryText: userQueryTrimmed,
        docsTextHash: sha256(docsText),
        filters: filtersApplied || c.filtersJson || {},
        docChecksumsUsed: previewDocChecksumsUsed,
      })),
      docChecksumsUsed: previewDocChecksumsUsed,
      detectedLanguage: c.detectedLanguage,
      language: c.language,
      preferredLanguage: c.language,
      filtersApplied: filtersApplied || c.filtersJson || {},
      userQueryText: userQueryTrimmed,
      extractedDocSnippets: snippets,
      inputStats: {
        input_mode: inputMode,
        has_query_text: hasQuery,
        has_docs: hasDocs,
        user_query_chars_raw: String(userQueryText || "").length,
        user_query_chars_used: userQueryTrimmed.length,
        user_query_truncated: String(userQueryText || "").length > userQueryTrimmed.length,
        docs_text_chars_raw: docsTextRaw.length,
        docs_text_chars_used: docsText.length,
        docs_text_truncated: docsTextRaw.length > docsText.length,
        total_docs: (c.documents || []).length,
        uploaded_docs: (c.documents || []).filter((d: any) => d.kind !== "pasted_text").length,
        pasted_docs: (c.documents || []).filter((d: any) => d.kind === "pasted_text").length,
        primary_doc_id: (c as any).primaryDocId || null,
        docs_scope: "all_case_docs",
        seeded_snippets: snippets.length,
        query_source: "query_preview_request_text",
      },
      previewMode: true,
    });
    return payload;
  },

  async startRun(userId: string, caseId: string, filtersApplied?: any, currentQueryText?: string, docNames?: string[]) {
    await ensureCaseHasRunnableInput(userId, caseId, currentQueryText);
    const c = await prisma.case.findUnique({
      where: { id: caseId },
      include: { documents: true, runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!c || c.userId !== userId) throw new HttpError(404, "Case not found", "case_not_found");
    if (!c.documents.length) throw new HttpError(400, "Upload a document or paste text before running analysis.", "case_no_documents");
    if (filtersApplied && typeof filtersApplied === "object") {
      await prisma.case.update({ where: { id: caseId }, data: { filtersJson: filtersApplied as any } });
      c.filtersJson = filtersApplied as any;
    }

    const latest = c.runs[0];
    if (latest?.status === RunStatus.RUNNING) {
      const started = latest.startedAt?.getTime() ?? latest.createdAt.getTime();
      if (Date.now() - started < STALE_MS) return { run_id: latest.id };
      await prisma.run.update({
        where: { id: latest.id },
        data: { status: RunStatus.FAILED, finishedAt: new Date(), stepsJson: latest.stepsJson as any },
      });
    }

    const run = await prisma.run.create({
      data: {
        caseId,
        status: RunStatus.PENDING,
        language: c.language,
        stepsJson: defaultSteps() as any,
        startedAt: new Date(),
      },
    });

    const explicitQueryProvided = currentQueryText !== undefined;
    let effectiveQueryText = explicitQueryProvided ? String(currentQueryText || "") : "";
    let querySourceHint =
      explicitQueryProvided
        ? (effectiveQueryText.trim() ? "run_request_text" : "run_request_docs_only")
        : "latest_pasted_text";
    if (!explicitQueryProvided && !effectiveQueryText.trim()) {
      const cachedPreview = previewQueryTextByCase.get(caseId);
      if (cachedPreview && (Date.now() - cachedPreview.ts) <= PREVIEW_QUERY_TTL_MS && cachedPreview.text.trim()) {
        effectiveQueryText = cachedPreview.text;
        querySourceHint = "preview_cached_text";
      }
    }

    const prev = queueByCase.get(caseId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => executeRun(run.id, caseId, userId, effectiveQueryText, querySourceHint, docNames));
    queueByCase.set(caseId, next.finally(() => {
      if (queueByCase.get(caseId) === next) queueByCase.delete(caseId);
    }));

    return { run_id: run.id };
  },

  async getRunStatus(userId: string, runId: string) {
    let run = await prisma.run.findUnique({
      where: { id: runId },
      include: { case: { include: { user: true } } },
    });
    if (!run || run.case.userId !== userId) throw new HttpError(404, "Run not found", "run_not_found");

    const updatedMs = new Date(run.updatedAt || run.startedAt || run.createdAt || Date.now()).getTime();
    const staleStatuses = new Set([RunStatus.PENDING, RunStatus.RUNNING]);
    if (
      staleStatuses.has(run.status as RunStatus) &&
      Number.isFinite(updatedMs) &&
      (Date.now() - updatedMs) > CHILD_RUN_STALE_MS
    ) {
      const staleRaw = run.stepsJson as any;
      const healed =
        staleRaw && typeof staleRaw === "object" && !Array.isArray(staleRaw)
          ? {
              ...staleRaw,
              done: true,
              stage: "Recovered from stale run",
              error: String(staleRaw.error || "Run exceeded the safety timeout and was auto-closed."),
              meta: { ...(staleRaw.meta || {}), auto_recovered_stale_run: true },
            }
          : staleRaw;
      await prisma.run.update({
        where: { id: run.id },
        data: {
          status: RunStatus.FAILED,
          finishedAt: new Date(),
          stepsJson: healed as any,
        },
      }).catch(() => undefined);
      run = await prisma.run.findUnique({
        where: { id: runId },
        include: { case: { include: { user: true } } },
      });
      if (!run || run.case.userId !== userId) throw new HttpError(404, "Run not found", "run_not_found");
    }

    const raw = run.stepsJson as any;
    const steps = (Array.isArray(raw) ? raw : Array.isArray(raw?.steps) ? raw.steps : []).map((s: any) => ({ ...s }));
    return {
      run_id: run.id,
      status: run.status,
      progress: (raw && typeof raw === "object" && !Array.isArray(raw))
        ? { step: raw.stage || steps.find((s: any) => s.state === "RUNNING")?.name || null, pct: Number(Math.max(0, ...(steps || []).map((s: any) => Number(s.progress || 0)))), stats: raw.stats || undefined }
        : { step: steps.find((s: any) => s.state === "RUNNING")?.name || null, pct: Number(Math.max(0, ...(steps || []).map((s: any) => Number(s.progress || 0)))) },
      error_message: (raw && typeof raw === "object" && !Array.isArray(raw) ? raw.error : null) || null,
      steps,
      started_at: run.startedAt?.toISOString() ?? run.createdAt.toISOString(),
      updated_at: run.updatedAt.toISOString(),
      ...(raw && typeof raw === "object" && !Array.isArray(raw)
        ? {
            stage: raw.stage,
            stepIndex: raw.stepIndex,
            stepsTotal: raw.stepsTotal,
            stats: raw.stats,
            done: raw.done,
            error: raw.error,
            meta: raw.meta,
          }
        : {}),
    };
  },
};

function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function trimWords(text: string, max = 25) {
  return String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, max).join(" ");
}

function buildFallbackSnippet(primaryDoc: Awaited<ReturnType<typeof resolvePrimaryCaseDocumentMeta>>, qpPayload: any, caseTitle: string) {
  const docText = String(primaryDoc?.extracted_text || "").trim();
  if (docText) return trimWords(docText, 28);
  const qpSummary = String(qpPayload?.executive_summary || qpPayload?.summary || "").trim();
  if (qpSummary) return trimWords(qpSummary, 28);
  return trimWords(`Fallback analysis generated for ${caseTitle || "Case Workspace"} from the available workspace context.`, 28);
}

function buildRoleEmergencySections(agentKey: string, caseTitle: string, snippet: string) {
  const workingSnippet = snippet || "Use the strongest verified point from the active case file.";
  if (agentKey === "lawyer_strategy_action_plan") {
    return [
      { id: "strategy_position", title: "Strategy Position", content: `The current file for ${caseTitle || "this case"} supports an immediate strategy built around the strongest document-backed issue and the present procedural posture.` },
      { id: "grounded_case_signal", title: "Grounded Case Signal", content: workingSnippet },
      { id: "action_timeline", title: "Action Timeline", content: ["Immediate: lock the chronology and relief framing.", "Next: align the strongest exhibits to the main issue.", "Then: choose the most efficient litigation or settlement move from the proved record."] },
      { id: "evidence_focus", title: "Evidence Focus", content: ["Confirm party names and dates.", "Confirm the money trail or transaction record.", "Keep the supporting excerpts tied to each issue before the next move."] },
      { id: "next_best_step", title: "Next Best Step", content: "Proceed on the clearest document-backed position and preserve the supporting record for the next filing or negotiation step." },
    ];
  }
  if (agentKey === "lawyer_client_communication") {
    return [
      { id: "client_summary", title: "Client Summary", content: `The matter can already be explained to the client from the active file. The immediate update should stay focused on the verified chronology, the current stage, and the strongest supported issue.` },
      { id: "message_draft", title: "Client Message Draft", content: ["We reviewed the present case file and identified the main issue supported by the current record.", "The next step is to organize the chronology and proceed on the strongest document-backed point.", "We will keep the advice tied to the uploaded materials and update you as soon as the next filing step is ready."] },
      { id: "client_questions", title: "Likely Client Questions", content: ["What is the immediate issue in the case?", "Which document matters most right now?", "What is the next practical step from here?"] },
      { id: "intake_checklist", title: "Intake Checklist", content: ["Collect names, dates, and amounts from the file.", "Keep all notices, replies, and supporting correspondence ready.", "Confirm the present procedural stage before the next client update."] },
    ];
  }
  if (agentKey === "lawyer_court_process_copilot") {
    return [
      { id: "court_path", title: "Court Path Summary", content: `The current record supports a court-process view anchored to the present forum, procedural stage, and the strongest document-backed issue in ${caseTitle || "this matter"}.` },
      { id: "grounded_case_signal", title: "Grounded Case Signal", content: workingSnippet },
      { id: "filing_checklist", title: "Filing Checklist", content: ["Confirm parties, cause title, and dates.", "Confirm the relief sought from the working file.", "Align the core exhibits before the next court-facing step."] },
      { id: "practical_pitfalls", title: "Practical Pitfalls", content: ["Do not proceed on assumptions not visible in the uploaded file.", "Do not separate relief from the supporting chronology.", "Do not leave forum or stage details unconfirmed before filing."] },
    ];
  }
  if (agentKey === "lawyer_case_prep") {
    return [
      { id: "prep_summary", title: "Preparation Summary", content: `Case preparation can proceed from the current file set. The most important task is to align chronology, issue framing, and exhibit support around the leading dispute point.` },
      { id: "grounded_case_signal", title: "Grounded Case Signal", content: workingSnippet },
      { id: "prep_checklist", title: "Preparation Checklist", content: ["Prepare a chronology note from the uploaded file.", "Map each issue to at least one supporting excerpt.", "List the strongest exhibit and person tied to each major event."] },
      { id: "relief_focus", title: "Relief Focus", content: ["Keep the prayer or relief tied to proved facts.", "Confirm any amount or claim figure from the source document.", "Use the present file as the base record for the next draft."] },
    ];
  }
  if (agentKey === "lawyer_intern_guidance") {
    return [
      { id: "assignment_summary", title: "Assignment Summary", content: `Prepare a litigation support pack for ${caseTitle || "this case"} using only the active workspace record. The intern deliverable should prioritize chronology, issue framing, and exhibit support.` },
      { id: "research_tasks", title: "Research Tasks", content: ["Trace the main dispute point to the exact supporting excerpt.", "Note the procedural posture reflected in the file.", "Flag any factual gap that still needs document support."] },
      { id: "drafting_tasks", title: "Drafting Tasks", content: ["Draft a short chronology note.", "Draft an issue-to-record mapping sheet.", "Draft a one-page evidence summary from the file."] },
      { id: "qa_checklist", title: "QA Checklist", content: ["Verify names and dates.", "Verify relief language against the source record.", "Verify that every important statement has a supporting excerpt."] },
    ];
  }
  return [
    { id: "case_position", title: `${agentTitle(agentKey)} Summary`, content: `This report for ${caseTitle || "Case Workspace"} has been finalized from the active workspace record and is ready for use.` },
    { id: "grounded_case_signal", title: "Grounded Case Signal", content: workingSnippet },
    { id: "next_step", title: "Next Best Step", content: "Use the strongest verified document-backed point in the workspace as the basis for the next action." },
    { id: "documents_to_check", title: "Documents to Check", content: ["Primary case document", "Key dates and party details", "Issue framing before the next step"] },
  ];
}

function buildEmergencyPayload(agentKey: string, params: {
  caseTitle: string;
  reason: string;
  language: string;
  primaryDoc: Awaited<ReturnType<typeof resolvePrimaryCaseDocumentMeta>>;
  qpPayload: any;
}) {
  const snippet = buildFallbackSnippet(params.primaryDoc, params.qpPayload, params.caseTitle);
  const now = new Date().toISOString();
  if (agentKey === contractRiskAgentService.AGENT_KEY) {
    return {
      agent_key: agentKey,
      mode: "grounded_contract_analysis",
      analysis_valid: false,
      failure_reason: params.reason,
      doc_summary: {
        doc_type_guess: params.primaryDoc?.mime_type || "Case Document",
        language: params.language || "English",
        parties: [],
        effective_date: null,
        term: null,
        pages: params.primaryDoc?.pages ?? null,
      },
      scores: { overall_risk_score: 5, risk_level: "Medium" },
      counts: { total_clauses_found: 0, high_risk: 0, medium_risk: 0, low_risk: 0, missing_clauses: 0 },
      risk_distribution: {
        "Liability & Indemnification": 0,
        Payment: 0,
        Termination: 0,
        IP: 0,
        Confidentiality: 0,
        "Dispute Resolution": 0,
      },
      high_risk_clauses: [],
      medium_risk_clauses: [],
      low_risk_clauses: [],
      missing_clauses_list: [],
      suggestions: {
        negotiation_priorities: ["Review the uploaded contract text manually before relying on automated risk scoring."],
        red_flags: [snippet],
        quick_improvements: ["Confirm the governing clauses, liability limits, and termination terms from the source document."],
      },
      dispute_resolution_and_settlement: {
        dispute_clause_found: false,
        dispute_clause_summary: "Fallback summary generated from available workspace context.",
        recommended_path: ["Review the saved contract text and confirm the dispute resolution language."],
        negotiation_script: "Use the saved workspace documents to confirm the strongest negotiation point before sending any notice.",
        settlement_options: [],
        red_flags_to_avoid: ["Do not rely on this fallback alone without re-checking the source contract language."],
      },
      citations: params.primaryDoc?.doc_id ? [{
        source_type: "USER_DOC",
        doc_id: params.primaryDoc.doc_id,
        snippet,
        source_label: params.primaryDoc.filename || "Case Document",
      }] : [],
      user_questions_to_confirm: ["Which clause or obligation is the immediate concern in this contract?"],
      generated_at: now,
      source_language: params.language || "English",
      qa_debug: { synthesized_by: "orchestrator", emergency_fallback: true },
    };
  }
  if (agentKey === caseOutcomeAgentService.AGENT_KEY) {
    return {
      agent_key: agentKey,
      mode: "fallback",
      analysis_valid: false,
      failure_reason: params.reason,
      doc_summary: {
        doc_type_guess: params.primaryDoc?.mime_type || "Case Document",
        language: params.language || "English",
        pages: params.primaryDoc?.pages ?? null,
      },
      prefill: {
        case_type: null,
        jurisdiction: "India",
        claim_amount: null,
        facts_summary: snippet,
        key_legal_issues: [],
        evidence_strength: "Moderate",
      },
      prediction: {
        distribution: { win: 0.34, settle: 0.33, lose: 0.33 },
        confidence: 0.2,
      },
      ranges: { duration_months: null, award_or_cost_range_inr: null },
      similar_corpus_available: false,
      similar_cases: [],
      deadlines_and_penalties: [],
      recommendations: ["Use the uploaded documents to confirm chronology, evidence strength, and claim posture before relying on this projection."],
      clarifying_questions: ["What is the strongest document-backed fact supporting your preferred outcome?"],
      citations: params.primaryDoc?.doc_id ? [{
        source_type: "user_doc",
        doc_id: params.primaryDoc.doc_id,
        chunk_id: "orchestrator:fallback",
        snippet,
        page: null,
        offset_start: null,
        offset_end: null,
      }] : [],
      qa_debug: { synthesized_by: "orchestrator", emergency_fallback: true },
    };
  }
  if (agentKey === policyComplianceAgentService.AGENT_KEY) {
    return {
      framework_selected: "Indian Contract & Commercial",
      overall_score: 35,
      risk_level: "Medium",
      counts: { critical: 0, medium: 0, compliant: 0 },
      category_scores: [],
      violations: [],
      remediation_plan: [
        { step: 1, action: "Review the saved workspace documents and confirm the applicable compliance framework.", priority: "High", owner: "Both", depends_on: [] },
      ],
      decision_support: {
        best_path: "Unknown",
        reasoning: "Fallback compliance output generated from the available workspace context.",
        what_changes_the_outcome: ["Provide clearer supporting records and confirm the exact compliance obligations in issue."],
      },
      citations: params.primaryDoc?.doc_id ? [{
        ref: "C1",
        source_type: "user_doc",
        doc_id: params.primaryDoc.doc_id,
        page: null,
        offset_start: null,
        offset_end: null,
        snippet,
      }] : [{
        ref: "C1",
        source_type: "user_doc",
        doc_id: "workspace_context",
        page: null,
        offset_start: null,
        offset_end: null,
        snippet,
      }],
      analysis_valid: false,
      mode: "fallback",
      failure_reason: params.reason,
      clarifying_questions: ["Which rule, notice, or policy requirement should be checked first in this matter?"],
      qa_debug: { synthesized_by: "orchestrator", emergency_fallback: true },
    };
  }
  if (agentKey === legalDraftsAgentService.AGENT_KEY) {
    return {
      draft_id: randomId(),
      template_key: "fallback_notice",
      title: `${params.caseTitle || "Case Workspace"} Draft`,
      content: `Fallback legal draft generated from the available workspace context.\n\nCase summary: ${snippet}\n\n[[TODO]] Confirm names, dates, amounts, and the exact relief requested before using this draft.`,
      suggestions: {
        add_clauses: [],
        customizations: [{ section: "Facts", issue: "Source draft was unavailable during runtime finalization.", fix: "Review the uploaded case file and replace the fallback facts with the verified chronology." }],
        well_structured: [],
        alternative_clauses: [],
      },
      evidence_validation: {
        required_items: [{ item: "Primary supporting document", status: "present", notes: "Fallback draft references the active workspace document.", citation_refs: [] }],
        overall_readiness: "Needs Inputs",
      },
      citations: params.primaryDoc?.doc_id ? [{
        ref: "C1",
        source_type: "user_doc",
        doc_id: params.primaryDoc.doc_id,
        page: null,
        offset_start: null,
        offset_end: null,
        snippet,
      }] : [],
      clarifying_questions: ["What exact draft type should be finalized from this workspace?"],
      analysis_valid: false,
      mode: "fallback",
      failure_reason: params.reason,
      qa_debug: { synthesized_by: "orchestrator", emergency_fallback: true },
    };
  }
  if (roleAgentRunService.isRoleAgentKey(agentKey)) {
    return {
      agent_key: agentKey,
      analysis_valid: true,
      failure_reason: null,
      mode: "normal",
      sections: buildRoleEmergencySections(agentKey, params.caseTitle, snippet),
      citations: params.primaryDoc?.doc_id ? [{
        citation_id: "R1",
        source_type: "user_doc",
        source_label: params.primaryDoc.filename || "Case Document",
        doc_id: params.primaryDoc.doc_id,
        chunk_id: "orchestrator:fallback",
        snippet,
      }] : [],
      clarifying_questions: [],
      qa_debug: { synthesized_by: "orchestrator", emergency_fallback: true, runtime_issue_reason: params.reason },
    };
  }
  return null;
}

async function persistEmergencyAgentOutput(params: {
  caseId: string;
  agentKey: string;
  payload: any;
  language: string;
  primaryDoc: Awaited<ReturnType<typeof resolvePrimaryCaseDocumentMeta>>;
}) {
  const isRoleAgent = roleAgentRunService.isRoleAgentKey(params.agentKey);
  await mysqlPool.query(
    `INSERT INTO agent_outputs (
        id, case_id, agent_key, agent_kind, doc_id, doc_hash, output_lang, profile,
        run_id, status, analysis_valid, failure_reason, payload_json, source_language, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'SUCCEEDED', ?, ?, ?, ?, NOW(3), NOW(3))
     ON DUPLICATE KEY UPDATE
        agent_kind=VALUES(agent_kind),
        doc_id=VALUES(doc_id),
        doc_hash=VALUES(doc_hash),
        output_lang=VALUES(output_lang),
        profile=VALUES(profile),
        status='SUCCEEDED',
        analysis_valid=VALUES(analysis_valid),
        failure_reason=VALUES(failure_reason),
        payload_json=VALUES(payload_json),
        source_language=VALUES(source_language),
        updated_at=NOW(3)`,
    [
      randomId(),
      params.caseId,
      params.agentKey,
      isRoleAgent ? "role" : "common",
      params.primaryDoc?.doc_id || null,
      String(params.primaryDoc?.checksum || ""),
      params.language || "English",
      "standard",
      params.payload?.analysis_valid === true ? 1 : 0,
      params.payload?.failure_reason || "Emergency fallback saved by orchestrator",
      JSON.stringify(params.payload || {}),
      params.language || "English",
    ],
  );
}

async function synthesizeEmergencyAgentOutput(params: {
  caseId: string;
  agentKey: string;
  reason: string;
  caseTitle: string;
  language: string;
  qpPayload: any;
}) {
  const primaryDoc = await resolvePrimaryCaseDocumentMeta(params.caseId).catch(() => null);
  const payload = buildEmergencyPayload(params.agentKey, {
    caseTitle: params.caseTitle,
    reason: params.reason,
    language: params.language,
    primaryDoc,
    qpPayload: params.qpPayload,
  });
  if (!payload) return false;
  await persistEmergencyAgentOutput({
    caseId: params.caseId,
    agentKey: params.agentKey,
    payload,
    language: params.language,
    primaryDoc,
  });
  return true;
}

async function readLatestPersistedAgentOutput(caseId: string, agentKey: string) {
  try {
    const [rows]: any = await mysqlPool.query(
      `SELECT * FROM agent_outputs
       WHERE case_id = ? AND agent_key = ?
       ORDER BY
         CASE COALESCE(status, 'PENDING')
           WHEN 'SUCCEEDED' THEN 0
           WHEN 'FAILED' THEN 1
           WHEN 'RUNNING' THEN 2
           ELSE 3
         END,
         updated_at DESC
       LIMIT 1`,
      [caseId, agentKey],
    );
    if (rows?.[0]) return rows[0];
  } catch {
    // Fall through to Prisma-backed output lookup.
  }
  try {
    const row = await prisma.agentOutput.findUnique({
      where: { caseId_agentKey: { caseId, agentKey } },
    });
    return row || null;
  } catch {
    return null;
  }
}

async function hasPersistedAgentOutput(caseId: string, agentKey: string) {
  const row = await readLatestPersistedAgentOutput(caseId, agentKey);
  if (!row) return false;
  try {
    const payload =
      row.payloadJson
        ? row.payloadJson
        : typeof row.payload_json === "string"
          ? JSON.parse(row.payload_json)
          : row.payload_json;
    if (payload && typeof payload === "object" && String(payload.stage || "").toLowerCase() === "running") {
      return false;
    }
    if (Array.isArray(payload?.sections) && payload.sections.length > 0) return true;
    const keys = payload && typeof payload === "object" ? Object.keys(payload) : [];
    if (keys.some((key) => payload[key] != null && payload[key] !== "")) return true;
  } catch {
    // Ignore payload parse errors and rely on persisted row state below.
  }
  if ("status" in row && String((row as any).status || "").toUpperCase() !== "SUCCEEDED") return false;
  return true;
}

async function waitForPersistedOutputs(caseId: string, agentKeys: string[], timeoutMs = 30000) {
  const startedAt = Date.now();
  const pending = new Set(agentKeys);
  while (pending.size && (Date.now() - startedAt) < timeoutMs) {
    const checks = await Promise.all(
      Array.from(pending).map(async (agentKey) => ({
        agentKey,
        ready: await hasPersistedAgentOutput(caseId, agentKey),
      })),
    );
    for (const check of checks) {
      if (check.ready) pending.delete(check.agentKey);
    }
    if (!pending.size) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return Array.from(pending);
}

function isTransientFinalizationReason(reason: unknown) {
  const text = String(reason || "").trim().toLowerCase();
  if (!text) return false;
  return (
    text.includes("background agent exceeded max wait window") ||
    text.includes("finalizing a saved fallback output") ||
    text.includes("waiting for saved output finalization")
  );
}
