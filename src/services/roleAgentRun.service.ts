import { HttpError } from "../middleware/error.js";
import { mysqlPool, prisma } from "../prisma/client.js";
import { RunStatus, type UserRole } from "../db/types.js";
import { indexService } from "./index.service.js";
import { llmClient } from "../ai/llmClient.js";
import { sha256 } from "../utils/hash.js";
import { agentOutputsRepo } from "./outputs/agentOutputsRepo.js";
import { buildRoleAgentPrompt, buildRoleRepairPrompt } from "./agents/roleAgentPrompts.js";
import { getRoleAgentConfig, roleAgentKeys, type RoleAgentKey } from "./agents/roleAgentRegistry.js";
import { parseRoleOutput } from "./agents/roleAgentSchemas.js";
import { notificationService } from "./notification.service.js";
import { assessNarrativeQuality } from "./quality/genericity.service.js";
import { getEnv } from "../config/env.js";
import { getGenerationProfile } from "../ai/generationProfiles.js";
import { createPdfBuffer, shortenText, toDateTime, toSingleLine, type PdfHelpers } from "../utils/pdf.js";
import { runCancellationService } from "./runCancellation.service.js";
import { resolvePrimaryCaseDocumentMeta, resolveCaseDocumentMetas } from "./documentMeta.service.js";

function asIso(d = new Date()) {
  return d.toISOString();
}

function toRoleLabel(role: UserRole) {
  if (role === "NORMAL_PERSON") return "NORMAL_PERSON";
  return role;
}

function parseJson(input: any) {
  if (input == null) return null;
  if (typeof input === "object") return input;
  try {
    return JSON.parse(String(input));
  } catch {
    return null;
  }
}

function isReadyRoleCacheRow(row: any, payload: any) {
  const status = String(row?.status || "").toUpperCase();
  if (status && status !== "SUCCEEDED") return false;
  if (!payload || typeof payload !== "object") return false;
  return String(payload?.stage || "").toLowerCase() !== "running";
}

function extractJsonString(text: string) {
  const raw = String(text || "").trim();
  if (!raw) return "{}";
  try {
    JSON.parse(raw);
    return raw;
  } catch {}
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) return raw.slice(first, last + 1);
  return raw;
}

function formatSectionLine(item: any) {
  if (item == null) return "";
  if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") return String(item);
  if (typeof item === "object") {
    const title = item.title || item.label || item.name;
    const detail = item.detail || item.description || item.value || item.text;
    if (title && detail) return `${title}: ${detail}`;
    if (title) return String(title);
    return JSON.stringify(item);
  }
  return String(item);
}

function renderRoleSection(doc: any, h: PdfHelpers, content: any) {
  if (content == null) {
    h.paragraph("N/A");
    return;
  }
  if (typeof content === "string" || typeof content === "number" || typeof content === "boolean") {
    h.paragraph(content);
    return;
  }
  if (Array.isArray(content)) {
    const items = content.map((item) => formatSectionLine(item)).filter(Boolean);
    h.bullets(items, 10);
    return;
  }
  if (typeof content === "object") {
    const entries = Object.entries(content);
    if (!entries.length) {
      h.paragraph("N/A");
      return;
    }
    for (const [key, value] of entries) {
      const label = toSingleLine(key);
      if (Array.isArray(value)) {
        h.subheading(label);
        h.bullets(value.map((item) => formatSectionLine(item)).filter(Boolean), 10);
        continue;
      }
      if (value && typeof value === "object") {
        h.subheading(label);
        h.bullets([formatSectionLine(value)], 5);
        continue;
      }
      h.line(label, value);
    }
    return;
  }
  h.paragraph(String(content));
}

function roleReportStatusLabel(analysisValid: unknown) {
  return analysisValid === false ? "Needs Review" : "Complete";
}

function roleReportReviewNote(analysisValid: unknown) {
  if (analysisValid !== false) return null;
  return "This report was generated from available case inputs and should be reviewed before final legal use.";
}

function roleCitationLabel(source?: unknown) {
  const key = String(source || "").toLowerCase();
  if (key.includes("user_doc") || key.includes("user doc")) return "Case File";
  if (key.includes("legal_corpus") || key.includes("legal corpus")) return "Legal Reference";
  if (key.includes("current_input") || key.includes("current input")) return "Submitted Query";
  return "Source";
}

async function renderRoleAgentPdf(payload: any, meta: { caseId: string; caseTitle?: string; agentLabel: string; generatedAt?: string }) {
  return createPdfBuffer((doc, h) => {
    doc.font("Helvetica-Bold").fontSize(18).fillColor("#0b1220").text(`${meta.agentLabel} Report`, { width: h.pageWidth });
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(10).fillColor("#374151").text(`Case ID: ${meta.caseId}`, { width: h.pageWidth });
    if (meta.caseTitle) doc.text(`Case Title: ${toSingleLine(meta.caseTitle)}`, { width: h.pageWidth });
    doc.text(`Generated At: ${toDateTime(meta.generatedAt || new Date().toISOString())}`, { width: h.pageWidth });
    doc.moveDown(0.35);

    h.heading("Summary");
    h.line("Report Status", roleReportStatusLabel(payload?.analysis_valid));
    const reviewNote = roleReportReviewNote(payload?.analysis_valid);
    if (reviewNote) h.paragraph(reviewNote);

    h.heading("Sections");
    const sections = Array.isArray(payload?.sections) ? payload.sections : [];
    if (!sections.length) {
      h.paragraph("No structured sections available.");
    } else {
      for (const section of sections) {
        const title = toSingleLine(section?.title || "Section");
        h.subheading(title);
        renderRoleSection(doc, h, section?.content);
        doc.moveDown(0.1);
      }
    }

    h.heading("Clarifying Questions");
    h.bullets(payload?.clarifying_questions || [], 6);

    h.heading("Top Citations");
    if (!Array.isArray(payload?.citations) || !payload.citations.length) {
      h.paragraph("No citations captured.");
    } else {
      h.bullets(
        payload.citations.slice(0, 6).map((c: any) => {
          const label = toSingleLine(c.source_label || roleCitationLabel(c.source_type));
          const snippet = shortenText(c.snippet, 220);
          return `${label}: ${snippet}`;
        }),
        6,
      );
    }
  });
}

type RoleRunStatus = {
  stage: string;
  stepIndex: number;
  stepsTotal: number;
  done: boolean;
  error: string | null;
  meta: Record<string, any>;
  steps: Array<{ name: string; state: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED"; progress: number; message?: string }>;
};

type RoleRunStepState = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";

function makeSteps(stepNames: string[], activeIdx: number, failed = false, error?: string): RoleRunStatus["steps"] {
  return stepNames.map((name, idx) => {
    const state: RoleRunStepState = failed && idx === activeIdx ? "FAILED" : idx < activeIdx ? "SUCCEEDED" : idx === activeIdx ? "RUNNING" : "PENDING";
    return {
    name,
    state,
    progress: Math.round(((idx < activeIdx ? idx + 1 : idx === activeIdx ? idx + 0.4 : idx) / Math.max(stepNames.length, 1)) * 100),
    ...(failed && idx === activeIdx && error ? { message: error } : {}),
  };
});
}

function makeStatus(configSteps: string[], activeIdx: number, meta: Record<string, any>, done = false, error: string | null = null, failed = false): RoleRunStatus {
  return {
    stage: configSteps[Math.min(activeIdx, configSteps.length - 1)] || "Completed",
    stepIndex: activeIdx + 1,
    stepsTotal: configSteps.length,
    done,
    error,
    meta,
    steps: makeSteps(configSteps, Math.min(activeIdx, configSteps.length - 1), failed, error || undefined),
  };
}

async function updateRunProgress(runId: string, status: RoleRunStatus, runStatus?: RunStatus) {
  await prisma.run.update({
    where: { id: runId },
    data: {
      ...(runStatus ? { status: runStatus } : {}),
      ...(status.done ? { finishedAt: new Date() } : {}),
      stepsJson: status as any,
    },
  });
}

async function ensureCaseAccess(userId: string, caseId: string, agentKey: string) {
  const config = getRoleAgentConfig(agentKey);
  if (!config) throw new HttpError(404, "Role agent not found", "role_agent_not_found");
  const c = await prisma.case.findUnique({ where: { id: caseId }, include: { user: true, documents: true, outputs: true } });
  if (!c || c.userId !== userId) throw new HttpError(404, "Case not found", "case_not_found");
  return { c, config };
}

function pickPrimaryDoc(c: any) {
  const docs = (c.documents || []) as any[];
  const primaryDocId = c.primaryDocId || c.primary_doc_id;
  const byPrimary = primaryDocId ? docs.find((d) => d.id === primaryDocId) : null;
  const byUploadedText = docs.find((d) => String(d.kind || "") !== "pasted_text" && String(d.extractedText || "").trim().length > 0);
  const byText = docs.find((d) => String(d.extractedText || "").trim().length > 0);
  const doc = byPrimary || byText || null;
  const preferredDoc = byPrimary && String(byPrimary.extractedText || "").trim().length > 0
    ? byPrimary
    : byUploadedText || byText || byPrimary || null;
  const resolved = preferredDoc || doc;
  if (!resolved) return null;
  const text = String(resolved.extractedText || "").trim();
  return {
    doc_id: resolved.id,
    name: resolved.name,
    mime: resolved.mime,
    kind: resolved.kind,
    checksum: String(resolved.checksum || sha256(`${resolved.id}:${text.slice(0, 2000)}`)),
    extracted_text: text,
    language: resolved.detectedLanguage || c.language || "English",
    updated_at: resolved.updatedAt?.toISOString?.() || asIso(),
  };
}

function buildRoleFallbackText(caseTitle: string, qp: any, docs: any[]) {
  const summary = String(qp?.executive_summary || qp?.summary || "").trim();
  const issues = Array.isArray(qp?.issues) ? qp.issues.map((x: any) => String(x || "").trim()).filter(Boolean) : [];
  const grounds = Array.isArray(qp?.legal_grounds) ? qp.legal_grounds.map((x: any) => String(x || "").trim()).filter(Boolean) : [];
  const issueGroups = Array.isArray(qp?.issue_groups)
    ? qp.issue_groups.map((row: any) => String(row?.label || row?.title || "").trim()).filter(Boolean)
    : [];
  const keyFacts = qp?.key_facts && typeof qp.key_facts === "object"
    ? Object.entries(qp.key_facts)
        .map(([key, value]) => {
          const rendered = Array.isArray(value) ? value.join(", ") : String(value ?? "").trim();
          return rendered ? `${key}: ${rendered}` : "";
        })
        .filter(Boolean)
    : [];
  const docNames = (docs || []).map((d: any) => String(d?.name || "").trim()).filter(Boolean);
  return [
    caseTitle ? `Case title: ${caseTitle}` : "",
    summary ? `Executive summary: ${summary}` : "",
    issueGroups.length ? `Issue groups: ${issueGroups.join("; ")}` : "",
    issues.length ? `Issues: ${issues.join("; ")}` : "",
    grounds.length ? `Legal grounds: ${grounds.join("; ")}` : "",
    keyFacts.length ? `Key facts: ${keyFacts.join("; ")}` : "",
    docNames.length ? `Documents in workspace: ${docNames.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeSnippetText(value: unknown) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function dedupeSnippetRecords<T extends { snippet?: string; doc_id?: string; chunk_id?: string }>(items: T[], maxItems?: number) {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of items || []) {
    const text = normalizeSnippetText(item?.snippet);
    if (!text) continue;
    const key = `${String(item?.doc_id || "")}:${text.slice(0, 180)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (maxItems && out.length >= maxItems) break;
  }
  return out;
}

function toPlainList(values: any, limit = 5) {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) => String(item || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, limit);
}

function renderRoleFactValue(value: any): string {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.map((item) => renderRoleFactValue(item)).filter(Boolean).join(", ");
  }
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, nested]) => {
        const rendered = renderRoleFactValue(nested);
        if (!rendered) return "";
        const label = String(key).replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
        return `${label}: ${rendered}`;
      })
      .filter(Boolean)
      .join("; ");
  }
  return String(value).replace(/\s+/g, " ").trim();
}

function qpFactLines(queryParsingHints: any, limit = 6) {
  const facts = queryParsingHints?.key_facts;
  if (!facts || typeof facts !== "object") return [];
  return Object.entries(facts)
    .map(([key, value]) => {
      const rendered = renderRoleFactValue(value);
      if (!rendered) return "";
      const label = String(key).replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
      return `${label}: ${rendered}`;
    })
    .filter(Boolean)
    .slice(0, limit);
}

function compactSnippet(snippet: string, max = 170) {
  const clean = String(snippet || "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}...` : clean;
}

function isPlaceholderRoleText(value: unknown) {
  const text = normalizeSnippetText(typeof value === "string" ? value : JSON.stringify(value || {}));
  if (!text) return false;
  return (
    text.includes("fallback report for") ||
    text.includes("use this fallback report") ||
    text.includes("available workspace context after a runtime issue") ||
    text.includes("finalized from available workspace context after a runtime issue") ||
    text.includes("uploaded case workspace") ||
    text.includes("prepared grounded role agent output") ||
    text.includes("prepared grounded role-agent output")
  );
}

function isPlaceholderRoleLayout(sections: Array<{ id?: string; title?: string; content?: any }>) {
  if (!Array.isArray(sections) || sections.length === 0) return false;
  const placeholderTitles = new Set([
    "workspace snapshot",
    "grounded context",
    "next best step",
    "documents to check",
    "review note",
    "grounded key points",
    "recommended next actions",
  ]);
  const placeholderTitleCount = sections.reduce((acc, section) => {
    const title = String(section?.title || "").trim().toLowerCase();
    return acc + (placeholderTitles.has(title) ? 1 : 0);
  }, 0);
  const placeholderContentCount = sections.reduce((acc, section) => acc + (isPlaceholderRoleText(section?.content) ? 1 : 0), 0);
  return placeholderTitleCount >= 2 || placeholderContentCount >= 1;
}

function isBoilerplateRoleSnippet(snippet: string) {
  const text = String(snippet || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!text) return true;
  const genericHeader =
    /^in the high court\b/.test(text) ||
    /^in the court of\b/.test(text) ||
    /\bordinary original civil jurisdiction\b/.test(text) ||
    /\bcs\(os\)\b/.test(text) ||
    /\bcounsel for the plaintiff\b/.test(text) ||
    /\bdated:\s*#?\d+/.test(text) ||
    /\bindex sl no\b/.test(text);
  const actionableSignal = /(breach|termination|payment|invoice|notice|reply|objection|relief|prayer|jurisdiction|arbitration|settlement|hearing|filing|timeline|evidence|misconduct|delay|claim)/.test(text);
  return genericHeader && !actionableSignal;
}

function evidenceBullets(snippets: Array<{ snippet: string }>, limit = 5, max = 170) {
  return dedupeSnippetRecords(
    (snippets || []).filter((item) => !isBoilerplateRoleSnippet(String(item?.snippet || ""))) as any,
    limit,
  ).map((item) => compactSnippet(String(item.snippet || ""), max));
}

function buildRoleSpecificSections(
  agentKey: RoleAgentKey,
  caseTitle: string,
  queryParsingHints: any,
  snippets: Array<{ doc_id: string; chunk_id: string; snippet: string; source_type: string }>,
) {
  const summary =
    String(queryParsingHints?.executive_summary || queryParsingHints?.summary || "").replace(/\s+/g, " ").trim() ||
    `Grounded guidance prepared for ${caseTitle}.`;
  const issues = toPlainList(queryParsingHints?.issues, 5);
  const grounds = toPlainList(queryParsingHints?.legal_grounds, 5);
  const issueGroups = Array.isArray(queryParsingHints?.issue_groups)
    ? queryParsingHints.issue_groups
        .map((row: any) => String(row?.label || row?.title || "").trim())
        .filter(Boolean)
        .slice(0, 4)
    : [];
  const facts = qpFactLines(queryParsingHints, 6);
  const evidence = evidenceBullets(snippets, 6, 165);
  const shortEvidence = evidenceBullets(snippets, 4, 145);

  const firstIssue = issues[0] || grounds[0] || issueGroups[0] || "the main dispute point";
  const secondIssue = issues[1] || grounds[1] || "the supporting factual issue";

  const byAgent: Record<RoleAgentKey, Array<{ id: string; title: string; content: any }>> = {
    lawyer_strategy_action_plan: [
      { id: "strategy_options", title: "Strategy Options", content: [`Primary route: focus first on ${firstIssue}.`, `Secondary route: prepare support around ${secondIssue}.`, ...shortEvidence.slice(0, 2)] },
      { id: "action_timeline", title: "Action Timeline", content: ["Next 7 days: lock the core chronology and missing evidence.", "Next 14 days: align documents, notices, and response sequence.", "Next 30 days: prepare the strongest litigation or settlement path from the proven record."] },
      { id: "risk_matrix", title: "Risk Matrix", content: grounds.length ? grounds.map((item: string) => `${item}: affects leverage and next-step choice.`) : ["Risk should be tied to the strongest proved facts and the current procedural posture."] },
      { id: "evidence_gaps", title: "Evidence Gaps", content: facts.length ? facts : ["Dates, parties, and monetary trail should be verified against the uploaded file set."] },
      { id: "next_best_step", title: "Next Best Step", content: `Use the strongest document-backed point around ${firstIssue} before choosing the next filing or negotiation step.` },
    ],
    lawyer_client_communication: [
      { id: "client_summary", title: "Client Summary", content: `The file presently points to ${firstIssue}. The client should be updated with the verified chronology, the immediate procedural posture, and the strongest document-backed point before any next communication is sent.` },
      { id: "client_message_points", title: "Client Message Points", content: issues.length ? issues.map((item: string) => `Explain in plain terms: ${item}.`) : shortEvidence.slice(0, 3) },
      { id: "client_message_draft", title: "Client Message Draft", content: [`We have reviewed the current case record and the immediate focus is ${firstIssue}.`, `The key support presently comes from the uploaded document trail, especially around ${secondIssue}.`, "Our next step is to finalize the chronology and move on the strongest supported point in the file."] },
      { id: "intake_checklist", title: "Intake Checklist", content: facts.length ? facts : ["Collect names, dates, amounts, and all supporting correspondence."] },
    ],
    lawyer_court_process_copilot: [
      { id: "forum_options", title: "Forum Options", content: issueGroups.length ? issueGroups.map((item: string) => `Assess forum impact for ${item}.`) : ["Check the present forum, jurisdiction, and procedural posture from the record."] },
      { id: "filing_checklist", title: "Filing Checklist", content: facts.length ? facts.slice(0, 4) : ["Prepare chronology, parties, relief, and supporting documents."] },
      { id: "stage_timeline", title: "Stage Timeline", content: ["Current stage: confirm where the matter stands in the existing file.", "Next stage: prepare the immediate procedural response.", "Later stage: keep evidence and relief mapping ready for escalation."] },
      { id: "pitfalls", title: "Practical Pitfalls", content: grounds.length ? grounds.map((item: string) => `Do not proceed without resolving ${item}.`) : ["Avoid procedural assumptions not supported by the uploaded documents."] },
    ],
    lawyer_case_prep: [
      { id: "executive_summary", title: "Executive Summary", content: summary },
      { id: "chronology_table", title: "Chronology Table", content: facts.length ? facts : shortEvidence.slice(0, 4) },
      { id: "issue_exhibit_map", title: "Issue to Exhibit Map", content: issues.length ? issues.map((item: string, idx: number) => `${item}: support from evidence set ${Math.min(idx + 1, Math.max(1, shortEvidence.length))}.`) : shortEvidence.slice(0, 4) },
      { id: "witness_exhibit_list", title: "Witness / Exhibit Focus", content: evidence.length ? evidence.slice(0, 4) : ["List the most important document-backed events and the people tied to them."] },
      { id: "relief_options", title: "Relief Options", content: grounds.length ? grounds : ["Relief should be framed only around the proved case facts and current document set."] },
    ],
    lawyer_intern_guidance: [
      { id: "assignment_summary", title: "Assignment Summary", content: `Prepare a litigation support pack for ${caseTitle} using only the uploaded record. The immediate intern focus is ${firstIssue}, followed by fact verification around ${secondIssue}.` },
      { id: "research_tasks", title: "Research Tasks", content: issues.length ? issues.map((item: string) => `Trace the file-backed material for ${item} and note the exact supporting excerpt.`) : ["Build a concise note from the uploaded chronology."] },
      { id: "drafting_tasks", title: "Drafting Tasks", content: ["Prepare the chronology note.", "Prepare the issue list with record support.", "Prepare a short evidence matrix from the uploaded file set."] },
      { id: "qa_checklist", title: "QA Checklist", content: facts.length ? facts.slice(0, 4) : ["Check names, dates, relief, and amounts against the source file."] },
    ],
    student_workflow_case_mgmt: [
      { id: "case_brief", title: "Case Brief", content: summary },
      { id: "study_checklist", title: "Study Checklist", content: issues.length ? issues : ["Identify the main facts, issues, and likely legal grounds from the case file."] },
      { id: "issue_spotting", title: "Issue Spotting Exercise", content: grounds.length ? grounds : shortEvidence.slice(0, 3) },
    ],
    student_concept_learning_books: [
      { id: "concept_map", title: "Concept Map", content: grounds.length ? grounds : issues.length ? issues : ["Map the core concepts directly from the current dispute facts."] },
      { id: "reading_topics", title: "Reading Topics", content: issueGroups.length ? issueGroups : ["Read the topics that explain the present dispute structure and remedies."] },
      { id: "study_plan", title: "7-Day Study Plan", content: ["Day 1-2: understand facts and chronology.", "Day 3-4: map issues to legal concepts.", "Day 5-7: revise the dispute using the strongest evidence-backed points."] },
    ],
    student_exam_preparation: [
      { id: "issue_questions", title: "Issue-Spotting Questions", content: issues.length ? issues.map((item) => `Question: Explain the issue around ${item}.`) : ["Question: Identify the main issue from the uploaded case file."] },
      { id: "short_notes", title: "Short Notes", content: grounds.length ? grounds : shortEvidence.slice(0, 3) },
      { id: "mcq_focus", title: "MCQ Focus Areas", content: issueGroups.length ? issueGroups : ["Focus on chronology, forum, relief, and evidence points."] },
    ],
    corp_executive_decision_support: [
      { id: "executive_memo", title: "Executive Memo", content: summary },
      { id: "options_and_impact", title: "Options and Impact", content: [`Option A: move on ${firstIssue} with the current record.`, `Option B: strengthen internal proof around ${secondIssue}.`] },
      { id: "risk_register", title: "Risk Register", content: grounds.length ? grounds.map((item: string) => `${item}: business impact review needed.`) : ["Review factual, procedural, and documentation risks before escalation."] },
      { id: "stakeholder_points", title: "Stakeholder Communication Points", content: issues.length ? issues : shortEvidence.slice(0, 3) },
    ],
    corp_workflow_case_prep: [
      { id: "readiness_checklist", title: "Internal Readiness Checklist", content: facts.length ? facts : ["Check approvals, records, and responsible owners for the dispute file."] },
      { id: "approvals", title: "Approvals and Ownership", content: ["Confirm business owner.", "Confirm legal owner.", "Confirm document owner for the key evidence set."] },
      { id: "negotiation_playbook", title: "Negotiation Playbook", content: issues.length ? issues.map((item: string) => `Negotiation point: ${item}.`) : shortEvidence.slice(0, 3) },
      { id: "raci_timeline", title: "RACI Timeline", content: ["Immediate: evidence cleanup.", "Short term: internal alignment.", "Next: execution of the selected legal path."] },
    ],
    corp_court_process: [
      { id: "path_summary", title: "ADR / Court Path Summary", content: summary },
      { id: "evidence_preservation", title: "Evidence Preservation", content: evidence.length ? evidence.slice(0, 4) : ["Preserve the documents tied to the dispute timeline and decision record."] },
      { id: "counsel_briefing", title: "Counsel Briefing Outline", content: grounds.length ? grounds : issues.length ? issues : ["Brief counsel with chronology, issues, relief, and strongest documentary support."] },
    ],
    individual_step_by_step_guidance: [
      { id: "step_by_step", title: "Step-by-Step Guidance", content: ["Step 1: understand the main issue from the case file.", "Step 2: keep the key documents ready.", "Step 3: arrange dates and events in order.", "Step 4: act on the strongest document-backed point first.", "Step 5: get legal review before the next major step."] },
      { id: "document_checklist", title: "Document Checklist", content: facts.length ? facts : ["Keep names, dates, amount records, and all supporting communication ready."] },
      { id: "timeline", title: "Practical Timeline", content: ["Immediate: organize the record.", "Short term: clarify gaps.", "Next: take the most suitable legal step from the proved facts."] },
      { id: "important_note", title: "Important Note", content: `The next move should stay tied to ${firstIssue} and the uploaded document trail.` },
    ],
    individual_family_explain: [
      { id: "plain_language", title: "Plain-Language Explanation", content: summary },
      { id: "what_this_means", title: "What This Means", content: issues.length ? issues : ["Explain the dispute using the simplest facts from the uploaded case file."] },
      { id: "how_to_explain", title: "How To Explain It At Home", content: ["Keep the explanation short.", "Focus on facts, not assumptions.", "Use the current file record to explain what happened and what may happen next."] },
    ],
    individual_cost_factor: [
      { id: "cost_drivers", title: "Cost Drivers", content: grounds.length ? grounds.map((item: string) => `${item}: may affect time and cost.`) : ["Cost depends on evidence gaps, urgency, and the legal path chosen."] },
      { id: "time_factors", title: "Time Factors", content: facts.length ? facts.slice(0, 4) : ["Key dates, missing records, and procedural stage affect timing."] },
      { id: "assumptions", title: "Assumptions", content: ["Assume the current documents are the working record.", "Assume the strongest issue will drive the next legal step."] },
      { id: "optimization", title: "Cost Optimization", content: ["Organize the file before legal escalation.", "Close factual gaps early.", "Use the clearest document-backed issue first."] },
    ],
  };

  return byAgent[agentKey];
}

async function resolveBestRoleInput(caseId: string, c: any) {
  const qp = ((c.outputs || []) as any[]).find((o) => o.agentKey === "query_parsing")?.payloadJson || null;
  const rawPrimary = pickPrimaryDoc(c);
  const docMetaPrimary = await resolvePrimaryCaseDocumentMeta(caseId).catch(() => null);
  const docMetas = await resolveCaseDocumentMetas(caseId).catch(() => []);
  const bestDoc = (docMetaPrimary && String(docMetaPrimary.extracted_text || "").trim())
    ? {
        doc_id: docMetaPrimary.doc_id,
        name: docMetaPrimary.filename,
        mime: docMetaPrimary.mime_type,
        kind: docMetaPrimary.kind,
        checksum: String(docMetaPrimary.checksum || sha256(`${docMetaPrimary.doc_id}:${docMetaPrimary.extracted_text.slice(0, 2000)}`)),
        extracted_text: String(docMetaPrimary.extracted_text || "").trim(),
        language: docMetaPrimary.language || c.language || "English",
        updated_at: docMetaPrimary.updated_at || asIso(),
      }
    : rawPrimary;

  if (bestDoc && String(bestDoc.extracted_text || "").trim()) {
    return { primaryDoc: bestDoc, qp };
  }

  const fallbackText = buildRoleFallbackText(String(c.title || "Case Workspace"), qp, c.documents || docMetas || []);
  if (fallbackText.trim()) {
    return {
      primaryDoc: {
        doc_id: "query_parsing_context",
        name: "Query Parsing Context",
        mime: "text/plain",
        kind: "pasted_text",
        checksum: sha256(fallbackText),
        extracted_text: fallbackText,
        language: c.language || "English",
        updated_at: asIso(),
      },
      qp,
    };
  }

  return { primaryDoc: null, qp };
}

function buildFallbackOutput(
  agentKey: RoleAgentKey,
  reason: string,
  qa: any = {},
  input?: { caseTitle?: string; snippets?: Array<{ doc_id: string; chunk_id: string; snippet: string; source_type: string }>; queryParsingHints?: any },
) {
  const safeSnippets = Array.isArray(input?.snippets)
    ? dedupeSnippetRecords(input!.snippets!.filter((s) => !!String(s.snippet || "").trim()), 8)
    : [];
  const citations = selectRoleCitations(agentKey, [], safeSnippets, input?.queryParsingHints);
  const sectionBullets = safeSnippets.slice(0, 5).map((s) => String(s.snippet || "").slice(0, 180));
  const issueHints = Array.isArray(input?.queryParsingHints?.legal_grounds)
    ? input!.queryParsingHints.legal_grounds.map((x: any) => String(x || "").trim()).filter(Boolean).slice(0, 4)
    : [];
  const fallbackSections = buildRoleSpecificSections(
    agentKey,
    input?.caseTitle || "Current Case",
    input?.queryParsingHints,
    safeSnippets,
  ) || [
    {
      id: "summary",
      title: "Executive Summary",
      content: `Prepared grounded role-agent output for "${input?.caseTitle || "Current Case"}" from current case evidence.`,
    },
    {
      id: "grounded_points",
      title: "Grounded Key Points",
      content: sectionBullets.length ? sectionBullets : ["No reliable snippets were available from the case workspace."],
    },
    {
      id: "next_actions",
      title: "Recommended Next Actions",
      content: [
        "Verify party names, dates, and claim amounts from uploaded documents.",
        "Use the cited excerpts before making the next decision.",
        "Add any missing evidence and re-run if needed.",
      ],
    },
  ];

  while (fallbackSections.length < requiredSectionsCount(agentKey)) {
    const seed = safeSnippets[fallbackSections.length - 1] || safeSnippets[0];
    fallbackSections.push({
      id: `grounded_${fallbackSections.length + 1}`,
      title: `Grounded Section ${fallbackSections.length + 1}`,
      content: seed
        ? String(seed.snippet || "").slice(0, 220)
        : issueHints.length
          ? issueHints.slice(0, 2)
          : `Review the strongest available case evidence before finalizing ${agentKey.replaceAll("_", " ")} guidance.`,
    });
  }

  return {
    agent_key: agentKey,
    analysis_valid: true,
    failure_reason: null,
    mode: "normal",
    sections: fallbackSections,
    citations,
    clarifying_questions: citations.length
      ? []
      : ["Please provide a clearer case narrative and complete supporting document set."],
    qa_debug: qa,
  };
}

function requiredSectionsCount(agentKey: RoleAgentKey) {
  if (agentKey === "lawyer_strategy_action_plan") return 5;
  if (
    agentKey === "lawyer_client_communication" ||
    agentKey === "lawyer_court_process_copilot" ||
    agentKey === "lawyer_case_prep" ||
    agentKey === "lawyer_intern_guidance" ||
    agentKey === "corp_executive_decision_support" ||
    agentKey === "corp_workflow_case_prep" ||
    agentKey === "individual_step_by_step_guidance" ||
    agentKey === "individual_cost_factor"
  ) {
    return 4;
  }
  return 3;
}

function normalizeRolePayload(
  agentKey: RoleAgentKey,
  rawPayload: any,
  caseTitle: string,
  snippets: Array<{ doc_id: string; chunk_id: string; snippet: string; source_type: string }>,
  queryParsingHints?: any,
) {
  const payload = (rawPayload && typeof rawPayload === "object") ? { ...rawPayload } : {};
  const requiredSections = requiredSectionsCount(agentKey);
  const seedDocId = snippets[0]?.doc_id || "user_doc";
  const errorLikePayload =
    !Array.isArray(payload.sections) &&
    (
      (typeof payload.error === "string" && payload.error.trim().length > 0) ||
      (typeof payload.error_msg === "string" && payload.error_msg.trim().length > 0) ||
      (typeof payload.message === "string" && payload.message.trim().length > 0) ||
      (typeof payload.failure_reason === "string" && payload.failure_reason.trim().length > 0) ||
      (typeof payload.error_code === "number" && Number.isFinite(payload.error_code))
    );

  if (errorLikePayload) {
    const reason =
      String(
        payload.error_msg ||
        payload.failure_reason ||
        payload.error ||
        payload.message ||
        "Role-agent output was invalid and has been replaced with a grounded fallback report.",
      ).trim() || "Role-agent output was invalid and has been replaced with a grounded fallback report.";
    return buildFallbackOutput(
      agentKey,
      reason,
      {
        ...(payload.qa_debug || {}),
        normalized_from_error_payload: true,
        upstream_error: {
          error: payload.error || null,
          error_code: payload.error_code || null,
          error_msg: payload.error_msg || payload.message || null,
        },
      },
      { caseTitle, snippets, queryParsingHints },
    );
  }

  let sections: Array<{ id: string; title: string; content: any }> = [];
  if (Array.isArray(payload.sections)) {
    sections = payload.sections
      .filter((s: any) => s && typeof s === "object")
      .map((s: any, idx: number) => ({
        id: String(s.id || `section_${idx + 1}`),
        title: String(s.title || `Section ${idx + 1}`),
        content: s.content ?? "",
      }));
  }

  const genericSectionTitles = new Set([
    "executive summary",
    "grounded key points",
    "recommended next actions",
  ]);
  const hasGenericLayout =
    sections.length > 0 &&
    sections.every((section) => {
      const normalizedTitle = String(section.title || "").trim().toLowerCase();
      const normalizedContent = normalizeSnippetText(
        typeof section.content === "string" ? section.content : JSON.stringify(section.content || {}),
      );
      return (
        genericSectionTitles.has(normalizedTitle) ||
        normalizedTitle.startsWith("grounded section") ||
        normalizedContent.includes("prepared grounded role-agent output")
        );
    });

  if (hasGenericLayout || isPlaceholderRoleLayout(sections)) {
    sections = buildRoleSpecificSections(agentKey, caseTitle, queryParsingHints || payload?.query_parsing_hints || payload?.qa_debug?.query_parsing_hints || null, snippets);
  }

  if (!sections.length) {
    const reserved = new Set(["agent_key", "analysis_valid", "failure_reason", "mode", "sections", "citations", "clarifying_questions", "qa_debug"]);
    const kvSections = Object.keys(payload)
      .filter((k) => !reserved.has(k))
      .slice(0, requiredSections)
      .map((k, idx) => ({
        id: String(k).toLowerCase().replace(/[^a-z0-9]+/g, "_"),
        title: String(k).replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase()),
        content: payload[k],
      }));
    sections = kvSections;
  }

  while (sections.length < requiredSections) {
    const seed = snippets[sections.length - 1] || snippets[0];
    sections.push({
      id: `grounded_${sections.length + 1}`,
      title: sections.length === 0 ? "Executive Summary" : `Grounded Section ${sections.length + 1}`,
      content: seed ? String(seed.snippet || "").slice(0, 220) : `Grounded output for ${caseTitle}`,
    });
  }

  let citations = Array.isArray(payload.citations) ? payload.citations : [];
  citations = dedupeSnippetRecords(
    citations
      .map((c: any, idx: number) => ({
        citation_id: String(c?.citation_id || c?.ref || c?.id || `C${idx + 1}`),
        source_type: "user_doc",
        source_label: c?.source_label ? String(c.source_label) : undefined,
        doc_id: String(c?.doc_id || seedDocId),
        chunk_id: c?.chunk_id ? String(c.chunk_id) : undefined,
        snippet: String(c?.snippet || "").slice(0, 500),
      }))
      .filter((c: any) => !!String(c.snippet || "").trim() && !isBoilerplateRoleSnippet(String(c.snippet || ""))),
  );

  citations = selectRoleCitations(agentKey, citations, snippets, queryParsingHints || null);

  const clarifying = Array.isArray(payload.clarifying_questions)
    ? payload.clarifying_questions.map((q: any) => String(q)).filter(Boolean).slice(0, 3)
    : [];

  return {
    agent_key: agentKey,
    analysis_valid: true,
    failure_reason: null,
    mode: "normal",
    sections,
    citations,
    clarifying_questions: clarifying,
    qa_debug: payload.qa_debug || {},
  };
}

export function normalizeRoleAgentPayloadForDisplay(
  agentKey: RoleAgentKey,
  rawPayload: any,
  caseTitle: string,
  snippets: Array<{ doc_id: string; chunk_id: string; snippet: string; source_type: string }>,
  queryParsingHints?: any,
) {
  return normalizeRolePayload(agentKey, rawPayload, caseTitle, snippets, queryParsingHints);
}

function roleCitationIntentTerms(agentKey: RoleAgentKey, queryParsingHints: any) {
  const fixed: Record<RoleAgentKey, string[]> = {
    lawyer_strategy_action_plan: ["strategy", "timeline", "risk", "evidence", "action"],
    lawyer_client_communication: ["summary", "client", "notice", "communication", "faq"],
    lawyer_court_process_copilot: ["forum", "filing", "court", "timeline", "pitfall"],
    lawyer_case_prep: ["chronology", "exhibit", "witness", "relief", "prayer"],
    lawyer_intern_guidance: ["task", "research", "drafting", "qa", "delegation"],
    student_workflow_case_mgmt: ["brief", "checklist", "issue", "study", "case"],
    student_concept_learning_books: ["concept", "reading", "topic", "learning", "study"],
    student_exam_preparation: ["mcq", "short", "issue", "question", "exam"],
    corp_executive_decision_support: ["executive", "impact", "risk", "memo", "stakeholder"],
    corp_workflow_case_prep: ["readiness", "approval", "negotiation", "raci", "internal"],
    corp_court_process: ["arbitration", "court", "evidence", "counsel", "preservation"],
    individual_step_by_step_guidance: ["step", "document", "timeline", "plain", "guidance"],
    individual_family_explain: ["family", "explain", "implication", "communication", "plain"],
    individual_cost_factor: ["cost", "time", "assumption", "driver", "optimization"],
  };
  return [
    agentKey.replaceAll("_", " "),
    ...(fixed[agentKey] || []),
    String(queryParsingHints?.case_title || ""),
    String(queryParsingHints?.executive_summary || queryParsingHints?.summary || ""),
    ...(Array.isArray(queryParsingHints?.issues) ? queryParsingHints.issues : []),
    ...(Array.isArray(queryParsingHints?.legal_grounds) ? queryParsingHints.legal_grounds : []),
  ]
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 4);
}

function selectRoleCitations(
  agentKey: RoleAgentKey,
  existingCitations: Array<{ citation_id?: string; source_type?: string; doc_id?: string; chunk_id?: string; snippet?: string }>,
  snippets: Array<{ doc_id: string; chunk_id: string; snippet: string; source_type: string }>,
  queryParsingHints: any,
) {
  const normalizeCitationSnippet = (value: string) =>
    String(value || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
  const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));
  const dedupedExisting = dedupeSnippetRecords(
    Array.isArray(existingCitations)
      ? existingCitations.map((citation, idx) => ({
          citation_id: `C${idx + 1}`,
          source_type: "user_doc" as const,
          doc_id: String(citation?.doc_id || snippets[0]?.doc_id || "user_doc"),
          chunk_id: String(citation?.chunk_id || `existing_${idx + 1}`),
          snippet: String(citation?.snippet || "").slice(0, 500),
        }))
      : [],
  );
  const dedupedSnippets = dedupeSnippetRecords(
    snippets
      .filter((snippet) => !isBoilerplateRoleSnippet(String(snippet.snippet || "")))
      .map((snippet, idx) => ({
        citation_id: `S${idx + 1}`,
        source_type: "user_doc" as const,
        doc_id: String(snippet.doc_id || "user_doc"),
        chunk_id: String(snippet.chunk_id || `snippet_${idx + 1}`),
        snippet: String(snippet.snippet || "").slice(0, 500),
      })),
  );
  const supportTokens = new Set(roleCitationIntentTerms(agentKey, queryParsingHints));
  const merged = [
    ...dedupedExisting,
    ...dedupedSnippets,
  ]
    .filter((citation) => !!String(citation.snippet || "").trim())
    .map((citation, idx) => {
      const text = String(citation.snippet || "").toLowerCase();
      const tokenHits = [...supportTokens].reduce((acc, token) => acc + (text.includes(token) ? 1 : 0), 0);
      const genericPenalty = isBoilerplateRoleSnippet(text) ? 6 : 0;
      let score = 0;
      for (const token of supportTokens) {
        if (text.includes(token)) score += 2;
      }
      score += tokenHits >= 2 ? 3 : tokenHits === 1 ? 1 : 0;
      score -= genericPenalty;
      score += dedupedSnippets.some((snippet) => normalizeCitationSnippet(snippet.snippet) === normalizeCitationSnippet(citation.snippet)) ? 1.25 : 0;
      score += Math.max(0, 1 - idx * 0.04);
      return { citation, score, tokenHits, normalizedSnippet: normalizeCitationSnippet(citation.snippet) };
    })
    .sort((a, b) => b.score - a.score || b.tokenHits - a.tokenHits);

  const uniqueRanked = merged.reduce((acc, entry) => {
    if (!entry.normalizedSnippet) return acc;
    const existing = acc.get(entry.normalizedSnippet);
    if (!existing || entry.score > existing.score) {
      acc.set(entry.normalizedSnippet, entry);
    }
    return acc;
  }, new Map<string, (typeof merged)[number]>());
  const rankedPool = Array.from(uniqueRanked.values()).sort((a, b) => b.score - a.score || b.tokenHits - a.tokenHits);
  const desiredCount = Math.min(5, Math.max(1, rankedPool.length));
  const poolSize = Math.min(rankedPool.length, Math.max(desiredCount, 10));
  const selectionPool = rankedPool.slice(0, poolSize);
  const agentIndex = Math.max(0, roleAgentKeys.indexOf(agentKey));
  const agentHash = [...String(agentKey || "")]
    .reduce((acc, ch, idx) => acc + ch.charCodeAt(0) * (idx + 1), 0);
  const startIndex = selectionPool.length > 0 ? (agentIndex + agentHash) % selectionPool.length : 0;
  let stride = selectionPool.length <= 2 ? 1 : ((agentHash % (selectionPool.length - 1)) + 1);
  while (selectionPool.length > 2 && gcd(stride, selectionPool.length) !== 1) {
    stride += 1;
    if (stride >= selectionPool.length) stride = 1;
    if (stride === 1) break;
  }

  const out: Array<{ citation_id: string; source_type: "user_doc"; doc_id: string; chunk_id: string; snippet: string }> = [];
  const seen = new Set<string>();
  for (let step = 0; step < selectionPool.length && out.length < desiredCount; step += 1) {
    const entry = selectionPool[(startIndex + step * stride) % selectionPool.length];
    if (!entry) continue;
    const citation = entry.citation;
    const key = normalizeCitationSnippet(citation.snippet);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      citation_id: `C${out.length + 1}`,
      source_type: "user_doc",
      doc_id: citation.doc_id,
      chunk_id: citation.chunk_id,
      snippet: citation.snippet,
    });
    if (out.length >= desiredCount) break;
  }

  if (out.length < desiredCount) {
    for (const entry of rankedPool) {
      const citation = entry.citation;
      const key = normalizeCitationSnippet(citation.snippet);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        citation_id: `C${out.length + 1}`,
        source_type: "user_doc",
        doc_id: citation.doc_id,
        chunk_id: citation.chunk_id,
        snippet: citation.snippet,
      });
      if (out.length >= desiredCount) break;
    }
  }
  return out;
}

function buildSeedSnippetsFromPrimaryText(docId: string, text: string, max = 8) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [] as Array<{ doc_id: string; chunk_id: string; snippet: string; source_type: "user_doc" }>;
  const parts = clean
    .split(/(?<=[.?!])\s+|\n+/g)
    .map((p) => p.trim())
    .filter((p) => p.length >= 40 && !isBoilerplateRoleSnippet(p));
  if (!parts.length) {
    return [
      {
        doc_id: docId,
        chunk_id: "seed_1",
        snippet: clean.slice(0, 260),
        source_type: "user_doc" as const,
      },
    ];
  }
  return parts.slice(0, Math.max(1, max)).map((p, i) => ({
    doc_id: docId,
    chunk_id: `seed_${i + 1}`,
    snippet: p.slice(0, 260),
    source_type: "user_doc" as const,
  }));
}

function packRoleSnippets(
  agentKey: RoleAgentKey,
  queryParsingHints: any,
  snippets: Array<{ doc_id: string; chunk_id: string; snippet: string; source_type: string }>,
) {
  const profile = getGenerationProfile(agentKey, "final");
  const supportTokens = new Set(
    [
      agentKey.replaceAll("_", " "),
      String(queryParsingHints?.case_title || ""),
      String(queryParsingHints?.executive_summary || queryParsingHints?.summary || ""),
      ...(Array.isArray(queryParsingHints?.issues) ? queryParsingHints.issues : []),
      ...(Array.isArray(queryParsingHints?.legal_grounds) ? queryParsingHints.legal_grounds : []),
    ]
      .join(" ")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 4),
  );
  const ranked = dedupeSnippetRecords(snippets.filter((snippet) => !isBoilerplateRoleSnippet(String(snippet.snippet || ""))))
    .map((snippet) => {
      const text = String(snippet.snippet || "").toLowerCase();
      let score = 0;
      for (const token of supportTokens) {
        if (text.includes(token)) score += 1;
      }
      return { snippet, score };
    })
    .sort((a, b) => b.score - a.score);
  return ranked.slice(0, profile.maxChunks).map((entry) => ({
    ...entry.snippet,
    snippet: String(entry.snippet.snippet || "").replace(/\s+/g, " ").trim().slice(0, profile.perChunkChars),
    source_type: "user_doc" as const,
  }));
}

function roleContentToText(value: any): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => roleContentToText(item)).join(" ");
  if (value && typeof value === "object") return Object.values(value).map((item) => roleContentToText(item)).join(" ");
  return String(value ?? "");
}

function looksGenericRolePayload(
  payload: any,
  snippets: Array<{ doc_id: string; chunk_id: string; snippet: string; source_type: string }>,
) {
  const sectionTexts = Array.isArray(payload?.sections)
    ? payload.sections.flatMap((s: any) => [String(s?.title || ""), roleContentToText(s?.content)])
    : [];
  const quality = assessNarrativeQuality({
    texts: sectionTexts,
    supportTexts: snippets.map((s) => s.snippet),
    minSupportOverlap: 2,
    minCombinedLength: 120,
    maxGenericPhraseHits: 2,
  });
  return quality.isGeneric;
}

async function generateRoleOutput(input: {
  agentKey: RoleAgentKey;
  runId: string;
  caseTitle: string;
  outputLang: string;
  profile: string;
  config: ReturnType<typeof getRoleAgentConfig> extends infer T ? Exclude<T, null> : never;
  queryParsingHints: any;
  primaryText: string;
  snippets: Array<{ doc_id: string; chunk_id: string; snippet: string; source_type: string }>;
}) {
  const requireLlm = getEnv().REQUIRE_LLM_OUTPUT === true;
  const prompt = buildRoleAgentPrompt({
    config: input.config,
    caseTitle: input.caseTitle,
    outputLang: input.outputLang,
    profile: input.profile,
    primaryText: input.primaryText,
    queryParsingHints: input.queryParsingHints,
    evidenceSnippets: input.snippets,
  });

  let raw = "";
  let parsed: any = null;
  let parseError = "";
  let parsedCandidate: any = null;

  const profileSettings = getGenerationProfile(input.agentKey, "final");

  try {
    raw = await llmClient.generateText(prompt, {
      tier: "final",
      max_tokens: profileSettings.maxTokens,
      temperature: profileSettings.temperature,
      top_p: profileSettings.topP,
      timeoutMs: profileSettings.timeoutMs,
      signal: runCancellationService.getSignal(input.runId),
    });
    parsedCandidate = parseJson(extractJsonString(raw));
    parsed = parseRoleOutput(input.agentKey, parsedCandidate);
  } catch (e) {
    parseError = String((e as any)?.message || e);
  }

  if (!parsed && parsedCandidate) {
    try {
      parsed = parseRoleOutput(
        input.agentKey,
        normalizeRolePayload(input.agentKey, parsedCandidate, input.caseTitle, input.snippets, input.queryParsingHints),
      );
    } catch {
      // keep repair flow
    }
  }

  if (!parsed) {
    try {
      const repair = await llmClient.generateText(buildRoleRepairPrompt(input.agentKey, raw, parseError), {
        tier: "final",
        max_tokens: profileSettings.repairMaxTokens,
        temperature: 0,
        top_p: profileSettings.topP,
        timeoutMs: profileSettings.repairTimeoutMs,
        signal: runCancellationService.getSignal(input.runId),
      });
      const repairedCandidate = parseJson(extractJsonString(repair));
      try {
        parsed = parseRoleOutput(input.agentKey, repairedCandidate);
      } catch {
        parsed = parseRoleOutput(
          input.agentKey,
          normalizeRolePayload(input.agentKey, repairedCandidate, input.caseTitle, input.snippets, input.queryParsingHints),
        );
      }
    } catch (e) {
      return buildFallbackOutput(input.agentKey, "Invalid model output after retry", {
        llm_attempted: true,
        llm_failed: true,
        llm_required_mode: requireLlm,
        parse_error: String((e as any)?.message || e),
      }, { caseTitle: input.caseTitle, snippets: input.snippets, queryParsingHints: input.queryParsingHints });
    }
  }

  const safeCitations = (parsed.citations || []).filter((c: any) => c.source_type === "user_doc" && !!c.doc_id && !!c.snippet);
  parsed.citations = selectRoleCitations(input.agentKey, safeCitations, input.snippets, input.queryParsingHints);
  parsed.clarifying_questions = Array.isArray(parsed.clarifying_questions) ? parsed.clarifying_questions.slice(0, 3) : [];
  const groundedCitationCount = Array.isArray(parsed.citations) ? parsed.citations.length : 0;

  if (input.config.citation_min_required > 0 && groundedCitationCount < input.config.citation_min_required) {
    return buildFallbackOutput(
      input.agentKey,
      "Insufficient grounded citations from case workspace documents",
      {
        llm_attempted: true,
        citation_gate_triggered: true,
        llm_required_mode: requireLlm,
        grounded_citations: groundedCitationCount,
        citation_min_required: input.config.citation_min_required,
      },
      { caseTitle: input.caseTitle, snippets: input.snippets, queryParsingHints: input.queryParsingHints },
    );
  }

  if (looksGenericRolePayload(parsed, input.snippets)) {
    return buildFallbackOutput(
      input.agentKey,
      "Model output was too generic for grounded role-agent use",
      { llm_attempted: true, genericity_gate_triggered: true, quality_gate: "generic_role_payload", llm_required_mode: requireLlm },
      { caseTitle: input.caseTitle, snippets: input.snippets, queryParsingHints: input.queryParsingHints },
    );
  }

  return parsed;
}

export const roleAgentRunService = {
  isRoleAgentKey(agentKey: string): agentKey is RoleAgentKey {
    return roleAgentKeys.includes(agentKey as RoleAgentKey);
  },

  async getMeta(userId: string, caseId: string, agentKey: string, outputLang = "English", profile = "standard") {
    const { c, config } = await ensureCaseAccess(userId, caseId, agentKey);
    const { primaryDoc, qp } = await resolveBestRoleInput(caseId, c);
    const docHash = primaryDoc?.checksum || "";
    const latest =
      await agentOutputsRepo.getRoleOutput({ caseId, agentKey, docHash, outputLang, profile }) ||
      await agentOutputsRepo.getLatestRoleOutput({ caseId, agentKey, outputLang, profile }) ||
      await agentOutputsRepo.getLatestRoleOutputAny({ caseId, agentKey });
    let latestPayload = parseJson(latest?.payload_json);
    const latestSnippets = primaryDoc?.extracted_text
      ? packRoleSnippets(
          agentKey as RoleAgentKey,
          qp,
          buildSeedSnippetsFromPrimaryText(primaryDoc.doc_id, primaryDoc.extracted_text, 8),
        )
      : [];
    if (latestPayload && String(latestPayload?.stage || "").toLowerCase() !== "running") {
      latestPayload = normalizeRolePayload(agentKey as RoleAgentKey, latestPayload, c.title, latestSnippets, qp);
    }
    const synthesizedLatestPayload =
      !latestPayload && primaryDoc
        ? normalizeRolePayload(
            agentKey as RoleAgentKey,
            buildFallbackOutput(
              agentKey as RoleAgentKey,
              latest?.failure_reason || "No saved role-agent output was available, so a workspace fallback was prepared.",
              {
                synthesized_from_meta: true,
                recovery_mode: "meta_fallback",
                output_lang: outputLang,
                profile,
              },
              {
                caseTitle: c.title,
                snippets: latestSnippets,
                queryParsingHints: qp,
              },
            ),
            c.title,
            latestSnippets,
            qp,
          )
        : null;
    const effectiveLatestPayload = latestPayload || synthesizedLatestPayload;
    const latestUsable = !!effectiveLatestPayload;
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
      userRuns = Array.isArray(rows)
        ? rows.map((row: any) => {
            let stepsJson = row.steps_json;
            if (typeof stepsJson === "string") {
              try {
                stepsJson = JSON.parse(stepsJson);
              } catch {}
            }
            return {
              id: String(row.id),
              caseId: String(row.case_id),
              status: String(row.status),
              createdAt: new Date(row.created_at),
              stepsJson,
              case: { title: row.case_title || null },
            };
          })
        : [];
    } catch {
      userRuns = [];
    }

    const recentRuns = userRuns
      .filter((run) => {
        const meta = run.stepsJson?.meta;
        return meta && meta.agent_key === agentKey && meta.agent_kind === "role";
      })
      .slice(0, 8)
      .map((run) => ({
        run_id: run.id,
        case_id: run.caseId,
        status:
          run.status === "SUCCEEDED"
            ? "Succeeded"
            : run.status === "FAILED"
              ? "Failed"
              : run.status === "RUNNING"
                ? "Running"
                : run.status,
        timestamp: run.createdAt.toISOString(),
        case_title: String(run.stepsJson?.meta?.case_title_snapshot || run.case?.title || "Case Workspace").trim(),
      }));

    return {
      agent_key: agentKey,
      case: {
        case_id: caseId,
        title: c.title,
        role: toRoleLabel(c.role),
      },
      primary_doc: primaryDoc
        ? {
            doc_id: primaryDoc.doc_id,
            filename: primaryDoc.name,
            mime_type: primaryDoc.mime,
            kind: primaryDoc.kind,
            updated_at: primaryDoc.updated_at,
            language: primaryDoc.language,
            source_hint: primaryDoc.kind === "pasted_text" ? "Pasted Text" : "Uploaded Document",
          }
        : null,
      query_parsing: qp
        ? {
            case_title: qp.case_title || c.title,
            domain: qp.domain || null,
            executive_summary: qp.executive_summary || qp.summary || null,
          }
        : null,
      latest: ((latest || effectiveLatestPayload) && latestUsable)
        ? {
            status: String(latest?.status || "SUCCEEDED").toLowerCase(),
            run_id: latest?.run_id || null,
            output: effectiveLatestPayload,
            analysis_valid: effectiveLatestPayload?.analysis_valid !== false,
            mode: effectiveLatestPayload?.mode || "normal",
            failure_reason: latest?.failure_reason || null,
          }
        : {
            status: "none",
            run_id: null,
            output: null,
            analysis_valid: false,
            mode: "normal",
            failure_reason: null,
          },
      supports_export_pdf: config.supports_export_pdf,
      supports_export_docx: config.supports_export_docx,
      preloader_steps: config.preloader_steps,
      recent_runs: recentRuns,
      qa_debug: {
        source_mode: "rag_llm",
        retrieval_scope: "case_workspace_only",
        legal_corpus_enabled: false,
        output_lang: outputLang,
        profile,
      },
    };
  },

  async getOutput(userId: string, caseId: string, agentKey: string, outputLang = "English", profile = "standard") {
    const { c } = await ensureCaseAccess(userId, caseId, agentKey);
    const { primaryDoc, qp } = await resolveBestRoleInput(caseId, c);
    const docHash = primaryDoc?.checksum || "";
    const row =
      await agentOutputsRepo.getRoleOutput({ caseId, agentKey, docHash, outputLang, profile }) ||
      await agentOutputsRepo.getLatestRoleOutput({ caseId, agentKey, outputLang, profile }) ||
      await agentOutputsRepo.getLatestRoleOutputAny({ caseId, agentKey });
    if (!row) {
      const snippets = primaryDoc?.extracted_text
        ? packRoleSnippets(
            agentKey as RoleAgentKey,
            qp,
            buildSeedSnippetsFromPrimaryText(primaryDoc.doc_id, primaryDoc.extracted_text, 8),
          )
        : [];
      return normalizeRolePayload(
        agentKey as RoleAgentKey,
        buildFallbackOutput(
          agentKey as RoleAgentKey,
          "No saved role-agent output was available, so a workspace fallback was prepared.",
          { synthesized_on_output_read: true, output_lang: outputLang, profile },
          {
            caseTitle: c.title,
            snippets,
            queryParsingHints: qp,
          },
        ),
        c.title,
        snippets,
        qp,
      );
    }
    const raw = parseJson(row.payload_json) || null;
    if (!raw || String(raw?.stage || "").toLowerCase() === "running") return raw;
    const snippets = primaryDoc?.extracted_text
      ? packRoleSnippets(
          agentKey as RoleAgentKey,
          qp,
          buildSeedSnippetsFromPrimaryText(primaryDoc.doc_id, primaryDoc.extracted_text, 8),
        )
      : [];
    return normalizeRolePayload(agentKey as RoleAgentKey, raw, c.title, snippets, qp);
  },

  async startRun(userId: string, caseId: string, agentKey: string, input?: { force?: boolean; output_lang?: string; profile?: string }) {
    const outputLang = String(input?.output_lang || "English");
    const profile = String(input?.profile || "standard");
    const { c, config } = await ensureCaseAccess(userId, caseId, agentKey);
    const env = getEnv();
    const { primaryDoc, qp } = await resolveBestRoleInput(caseId, c);
    const fallbackOnlyDocHash = sha256([
      caseId,
      agentKey,
      String(c.title || ""),
      String(qp?.executive_summary || qp?.summary || ""),
      outputLang,
      profile,
      "role_agent_no_primary_doc_fallback",
    ].join("::"));
    if (!primaryDoc || !primaryDoc.extracted_text) {
      if (!input?.force) {
        const cached =
          await agentOutputsRepo.getRoleOutput({ caseId, agentKey, docHash: fallbackOnlyDocHash, outputLang, profile }) ||
          await agentOutputsRepo.getLatestRoleOutput({ caseId, agentKey, outputLang, profile }) ||
          await agentOutputsRepo.getLatestRoleOutputAny({ caseId, agentKey });
        if (cached) {
          let cachedPayload = parseJson(cached.payload_json);
          if (isReadyRoleCacheRow(cached, cachedPayload)) {
            cachedPayload = normalizeRolePayload(agentKey as RoleAgentKey, cachedPayload, c.title, [], qp);
            return {
              status: "cached",
              run_id: cached.run_id || null,
              output: cachedPayload,
            };
          }
        }
      }

      const run = await prisma.run.create({
        data: {
          caseId,
          status: RunStatus.PENDING,
          language: outputLang,
          startedAt: new Date(),
          stepsJson: makeStatus(config.preloader_steps, 0, {
            agent_key: agentKey,
            agent_kind: "role",
            case_title_snapshot: c.title,
            doc_hash: fallbackOnlyDocHash,
            output_lang: outputLang,
            profile,
            legal_corpus_enabled: false,
            fallback_only: true,
          }) as any,
        },
      });

      await agentOutputsRepo.upsertRoleOutput({
        caseId,
        agentKey,
        docId: null,
        docHash: fallbackOnlyDocHash,
        outputLang,
        profile,
        runId: run.id,
        status: "RUNNING",
        analysisValid: false,
        failureReason: null,
        payload: { stage: "running" },
      });

      setImmediate(() => {
        void (async () => {
          try {
            runCancellationService.register(run.id);
            await updateRunProgress(
              run.id,
              makeStatus(config.preloader_steps, config.preloader_steps.length - 2, {
                agent_key: agentKey,
                agent_kind: "role",
                case_title_snapshot: c.title,
                doc_hash: fallbackOnlyDocHash,
                output_lang: outputLang,
                profile,
                legal_corpus_enabled: false,
                fallback_only: true,
              }),
              RunStatus.RUNNING,
            );
            const fallback = buildFallbackOutput(
              agentKey as RoleAgentKey,
              "No usable primary document text was available; generated fallback role report from available case context.",
              {
                run_id: run.id,
                doc_hash: fallbackOnlyDocHash,
                legal_corpus_enabled: false,
                output_lang: outputLang,
                profile,
                llm_required_mode: env.REQUIRE_LLM_OUTPUT === true,
                fallback_only: true,
              },
              { caseTitle: c.title, snippets: [], queryParsingHints: qp },
            );
            await agentOutputsRepo.upsertRoleOutput({
              caseId,
              agentKey,
              docId: null,
              docHash: fallbackOnlyDocHash,
              outputLang,
              profile,
              runId: run.id,
              status: "SUCCEEDED",
              analysisValid: !!fallback.analysis_valid,
              failureReason: fallback.failure_reason || null,
              payload: fallback,
            });
            await updateRunProgress(
              run.id,
              {
                ...makeStatus(
                  config.preloader_steps,
                  config.preloader_steps.length - 1,
                  {
                    agent_key: agentKey,
                    agent_kind: "role",
                    case_title_snapshot: c.title,
                    doc_hash: fallbackOnlyDocHash,
                    output_lang: outputLang,
                    profile,
                    legal_corpus_enabled: false,
                    fallback_only: true,
                  },
                  true,
                  null,
                ),
                done: true,
                error: null,
              },
              RunStatus.SUCCEEDED,
            );
            await notificationService.create(
              userId,
              `${config.display_name} completed with warnings`,
              `${config.display_name} generated fallback output for case ${caseId}`,
            ).catch(() => undefined);
          } catch (error) {
            const reason = String((error as any)?.message || error);
            const fallback = buildFallbackOutput(
              agentKey as RoleAgentKey,
              reason,
              {
                run_id: run.id,
                doc_hash: fallbackOnlyDocHash,
                legal_corpus_enabled: false,
                output_lang: outputLang,
                profile,
                llm_required_mode: env.REQUIRE_LLM_OUTPUT === true,
                fallback_only: true,
              },
              { caseTitle: c.title, snippets: [], queryParsingHints: qp },
            );
            await agentOutputsRepo.upsertRoleOutput({
              caseId,
              agentKey,
              docId: null,
              docHash: fallbackOnlyDocHash,
              outputLang,
              profile,
              runId: run.id,
              status: "SUCCEEDED",
              analysisValid: !!fallback.analysis_valid,
              failureReason: fallback.failure_reason || null,
              payload: fallback,
            }).catch(() => undefined);
            await updateRunProgress(
              run.id,
              {
                ...makeStatus(
                  config.preloader_steps,
                  config.preloader_steps.length - 1,
                  {
                    agent_key: agentKey,
                    agent_kind: "role",
                    case_title_snapshot: c.title,
                    doc_hash: fallbackOnlyDocHash,
                    output_lang: outputLang,
                    profile,
                    legal_corpus_enabled: false,
                    fallback_only: true,
                  },
                  true,
                  null,
                ),
                done: true,
                error: null,
              },
              RunStatus.SUCCEEDED,
            ).catch(() => undefined);
          } finally {
            runCancellationService.clear(run.id);
          }
        })();
      });

      return { status: "queued", run_id: run.id };
    }

    const docHash = primaryDoc.checksum || "";
    if (!input?.force) {
      const cached = await agentOutputsRepo.getRoleOutput({ caseId, agentKey, docHash, outputLang, profile });
      if (cached) {
        let cachedPayload = parseJson(cached.payload_json);
        if (isReadyRoleCacheRow(cached, cachedPayload)) {
          const cachedSnippets = packRoleSnippets(
            agentKey as RoleAgentKey,
            qp,
            buildSeedSnippetsFromPrimaryText(primaryDoc.doc_id, primaryDoc.extracted_text, 8),
          );
          cachedPayload = normalizeRolePayload(agentKey as RoleAgentKey, cachedPayload, c.title, cachedSnippets, qp);
          return {
            status: "cached",
            run_id: cached.run_id || null,
            output: cachedPayload,
          };
        }
      }
    }

    const run = await prisma.run.create({
      data: {
        caseId,
        status: RunStatus.PENDING,
        language: outputLang,
        startedAt: new Date(),
        stepsJson: makeStatus(config.preloader_steps, 0, {
          agent_key: agentKey,
          agent_kind: "role",
          case_title_snapshot: c.title,
          doc_hash: docHash,
          output_lang: outputLang,
          profile,
          legal_corpus_enabled: false,
        }) as any,
      },
    });

    await agentOutputsRepo.upsertRoleOutput({
      caseId,
      agentKey,
      docId: primaryDoc.doc_id,
      docHash,
      outputLang,
      profile,
      runId: run.id,
      status: "RUNNING",
      analysisValid: false,
      failureReason: null,
      payload: { stage: "running" },
    });

    setImmediate(() => {
      void (async () => {
        try {
          runCancellationService.register(run.id);
          await updateRunProgress(run.id, makeStatus(config.preloader_steps, 0, { agent_key: agentKey, agent_kind: "role", case_title_snapshot: c.title, doc_hash: docHash, output_lang: outputLang, profile, legal_corpus_enabled: false }), RunStatus.RUNNING);

          const terms = [
            agentKey.replaceAll("_", " "),
            String(qp?.domain || ""),
            String(qp?.case_title || c.title || ""),
            ...String(primaryDoc.extracted_text || "").split(/\s+/).slice(0, 24),
          ].filter(Boolean);

          await updateRunProgress(run.id, makeStatus(config.preloader_steps, 1, { agent_key: agentKey, agent_kind: "role", case_title_snapshot: c.title, doc_hash: docHash, output_lang: outputLang, profile, legal_corpus_enabled: false }));

          // Hard block legal corpus retrieval for role agents.
          let snippets: Array<{ doc_id: string; chunk_id: string; snippet: string; source_type: "user_doc" }> = [];
          try {
            const retrieved = await indexService.retrieve(caseId, terms, 12, {
              includeUserDocs: true,
              includeLegalCorpus: false,
            });
            snippets = (retrieved || [])
              .filter((s: any) => String(s.source_type || "user_doc") === "user_doc")
              .map((s: any, idx: number) => ({
                doc_id: String(s.doc_id || primaryDoc.doc_id),
                chunk_id: String(s.chunk_id || `chunk_${idx}`),
                snippet: String(s.snippet || s.text || "").slice(0, 260),
                source_type: "user_doc" as const,
              }))
              .filter((s: any) => !!s.snippet);
          } catch {
            snippets = [];
          }

          if (!snippets.length) {
            snippets = buildSeedSnippetsFromPrimaryText(primaryDoc.doc_id, primaryDoc.extracted_text, 8);
          }
          snippets = packRoleSnippets(agentKey as RoleAgentKey, qp, snippets);

          await updateRunProgress(run.id, makeStatus(config.preloader_steps, 2, { agent_key: agentKey, agent_kind: "role", case_title_snapshot: c.title, doc_hash: docHash, output_lang: outputLang, profile, legal_corpus_enabled: false, snippets_count: snippets.length }));

          const payload = await generateRoleOutput({
            agentKey: agentKey as RoleAgentKey,
            runId: run.id,
            config,
            caseTitle: c.title,
            outputLang,
            profile,
            queryParsingHints: qp,
            primaryText: primaryDoc.extracted_text,
            snippets,
          });

          const finalPayload = {
            ...payload,
            qa_debug: {
              ...(payload.qa_debug || {}),
              run_id: run.id,
              doc_hash: docHash,
              doc_id: primaryDoc.doc_id,
              source_mode: "rag_llm",
              legal_corpus_enabled: false,
              output_lang: outputLang,
              profile,
            },
          };

          await agentOutputsRepo.upsertRoleOutput({
            caseId,
            agentKey,
            docId: primaryDoc.doc_id,
            docHash,
            outputLang,
            profile,
            runId: run.id,
            status: "SUCCEEDED",
            analysisValid: !!finalPayload.analysis_valid,
            failureReason: finalPayload.failure_reason || null,
            payload: finalPayload,
          });

          await updateRunProgress(
            run.id,
            {
              ...makeStatus(config.preloader_steps, config.preloader_steps.length - 1, {
                agent_key: agentKey,
                agent_kind: "role",
                case_title_snapshot: c.title,
                doc_hash: docHash,
                output_lang: outputLang,
                profile,
                legal_corpus_enabled: false,
              }, true, null),
              done: true,
              error: null,
            },
            RunStatus.SUCCEEDED,
          );
          const title = finalPayload.analysis_valid === false
            ? `${config.display_name} completed with warnings`
            : `${config.display_name} completed`;
          const body = finalPayload.analysis_valid === false
            ? `${config.display_name} generated fallback output for case ${caseId}`
            : `${config.display_name} generated output for case ${caseId}`;
          await notificationService.create(userId, title, body);
        } catch (error) {
          if (runCancellationService.isCancellationError(error) || runCancellationService.isCancelled(run.id)) {
            await updateRunProgress(
              run.id,
              {
                ...makeStatus(
                  config.preloader_steps,
                  config.preloader_steps.length - 1,
                  { agent_key: agentKey, agent_kind: "role", case_title_snapshot: c.title, doc_hash: docHash, output_lang: outputLang, profile, legal_corpus_enabled: false, cancelled: true },
                  true,
                  "Run cancelled by user",
                ),
                done: true,
                error: "Run cancelled by user",
              },
              RunStatus.FAILED,
            ).catch(() => undefined);
            await agentOutputsRepo.upsertRoleOutput({
              caseId,
              agentKey,
              docId: primaryDoc.doc_id,
              docHash,
              outputLang,
              profile,
              runId: run.id,
              status: "FAILED",
              analysisValid: false,
              failureReason: "Run cancelled by user",
              payload: { stage: "cancelled" },
            }).catch(() => undefined);
            await notificationService.create(userId, `${config.display_name} cancelled`, `${config.display_name} was cancelled for case ${caseId}`).catch(() => undefined);
            return;
          }
          const reason = String((error as any)?.message || error);
          const seeded = buildSeedSnippetsFromPrimaryText(primaryDoc.doc_id, primaryDoc.extracted_text, 8);
          const fallback = buildFallbackOutput(agentKey as RoleAgentKey, reason, {
            run_id: run.id,
            doc_hash: docHash,
            legal_corpus_enabled: false,
            output_lang: outputLang,
            profile,
            llm_required_mode: env.REQUIRE_LLM_OUTPUT === true,
          }, { caseTitle: c.title, snippets: seeded });
          await agentOutputsRepo.upsertRoleOutput({
            caseId,
            agentKey,
            docId: primaryDoc.doc_id,
            docHash,
            outputLang,
            profile,
            runId: run.id,
            status: "SUCCEEDED",
            analysisValid: !!fallback.analysis_valid,
            failureReason: fallback.failure_reason || null,
            payload: fallback,
          });
          await updateRunProgress(
            run.id,
            {
              ...makeStatus(
                config.preloader_steps,
                config.preloader_steps.length - 1,
                { agent_key: agentKey, agent_kind: "role", case_title_snapshot: c.title, doc_hash: docHash, output_lang: outputLang, profile, legal_corpus_enabled: false },
                true,
                null,
              ),
              done: true,
              error: null,
            },
            RunStatus.SUCCEEDED,
          );
          await notificationService.create(
            userId,
            `${config.display_name} completed with warnings`,
            `${config.display_name} generated fallback output for case ${caseId}: ${reason}`,
          );
        } finally {
          runCancellationService.clear(run.id);
        }
      })();
    });

    return { status: "queued", run_id: run.id };
  },

  async exportPdf(userId: string, caseId: string, agentKey: string) {
    const { c, config } = await ensureCaseAccess(userId, caseId, agentKey);
    const outputLang = "English";
    const profile = config.profile_default || "standard";
    const rawOutput = await this.getOutput(userId, caseId, agentKey, outputLang, profile);
    let payload: any = rawOutput;
    try {
      payload = parseRoleOutput(agentKey as RoleAgentKey, rawOutput);
    } catch {
      payload = rawOutput;
    }
    const buffer = await renderRoleAgentPdf(payload, {
      caseId,
      caseTitle: c.title,
      agentLabel: config.display_name || agentKey,
      generatedAt: payload?.qa_debug?.generated_at || new Date().toISOString(),
    });
    return {
      buffer,
      filename: `${agentKey}-${caseId}.pdf`,
    };
  },
};
