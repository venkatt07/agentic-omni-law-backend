import { prisma } from "../../prisma/client.js";
import type { UserRole } from "../../db/types.js";
import { runQueryParsing, runTermsAndPolicies, runContractRisk, runOutcomeProjection, runPolicyCompliance, runLegalDraftsValidation } from "./commonAgents.js";
import { runRoleAgent } from "./roleAgents.js";
import { buildFinalSummary } from "./finalSummary.js";
import { groundedGenerator } from "../../ai/groundedGenerator.js";
import { getEnv } from "../../config/env.js";
import { sha256 } from "../../utils/hash.js";
import { retrieveBundleService } from "../retrieval/retrieveBundle.service.js";
import { runCancellationService } from "../runCancellation.service.js";

type CommonAgentKey =
  | "query_parsing"
  | "terms_and_policies"
  | "contract_risk"
  | "outcome_projection"
  | "policy_compliance"
  | "legal_drafts_validation"
  | "final_summary";

function clamp01(n: any, fallback = 0.5) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(1, v));
}

function applyRoleAwareLabel(role: UserRole) {
  switch (role) {
    case "LAWYER":
      return "professional_legal";
    case "LAW_STUDENT":
      return "learning_focused";
    case "BUSINESS_CORPORATE":
      return "decision_support";
    case "NORMAL_PERSON":
      return "plain_language";
    default:
      return "general";
  }
}

const ROLE_SUMMARY_APPENDIX: Record<CommonAgentKey, Record<UserRole, string>> = {
  query_parsing: {
    LAWYER: "This framing prioritizes cause of action, evidence gaps, and the next litigation-facing move.",
    LAW_STUDENT: "This framing prioritizes issue spotting, doctrine mapping, and structured understanding of the file.",
    BUSINESS_CORPORATE: "This framing prioritizes business impact, risk visibility, and decision readiness.",
    NORMAL_PERSON: "This framing prioritizes plain-language understanding and the next practical step.",
  },
  terms_and_policies: {
    LAWYER: "The emphasis is on enforceability, leverage, and dispute-ready drafting posture.",
    LAW_STUDENT: "The emphasis is on understanding why each policy or clause matters.",
    BUSINESS_CORPORATE: "The emphasis is on operational clarity, approvals, and commercial safeguards.",
    NORMAL_PERSON: "The emphasis is on clear protections you can understand and use.",
  },
  contract_risk: {
    LAWYER: "The emphasis is on clause attack points, notice posture, and settlement leverage.",
    LAW_STUDENT: "The emphasis is on why each flagged term changes the legal risk picture.",
    BUSINESS_CORPORATE: "The emphasis is on exposure, escalation points, and control actions.",
    NORMAL_PERSON: "The emphasis is on what the risky terms mean and what to check first.",
  },
  outcome_projection: {
    LAWYER: "The emphasis is on filing posture, evidentiary strength, and realistic forum strategy.",
    LAW_STUDENT: "The emphasis is on why the case may win, settle, or weaken.",
    BUSINESS_CORPORATE: "The emphasis is on commercial exposure, recovery chance, and decision trade-offs.",
    NORMAL_PERSON: "The emphasis is on likely result, time, cost, and the next practical move.",
  },
  policy_compliance: {
    LAWYER: "The emphasis is on legally material deviations, documentary gaps, and notice defects.",
    LAW_STUDENT: "The emphasis is on how compliance issues connect to legal reasoning and consequence.",
    BUSINESS_CORPORATE: "The emphasis is on control failures, approval gaps, and remediation priority.",
    NORMAL_PERSON: "The emphasis is on what looks missing, risky, or important to fix now.",
  },
  legal_drafts_validation: {
    LAWYER: "The emphasis is on drafting posture, relief framing, and evidence-backed structure.",
    LAW_STUDENT: "The emphasis is on understanding the draft structure and why each section exists.",
    BUSINESS_CORPORATE: "The emphasis is on measured communication, approvals, and business-safe wording.",
    NORMAL_PERSON: "The emphasis is on a simple, usable drafting path with clear wording.",
  },
  final_summary: {
    LAWYER: "The summary is tuned for legal execution, evidentiary posture, and next-step strategy.",
    LAW_STUDENT: "The summary is tuned for structured learning, issue mapping, and reasoning clarity.",
    BUSINESS_CORPORATE: "The summary is tuned for business decision support, exposure, and execution planning.",
    NORMAL_PERSON: "The summary is tuned for plain-language understanding and practical next steps.",
  },
};

const ROLE_LIST_PRIORITIES: Record<CommonAgentKey, Record<UserRole, string[]>> = {
  query_parsing: {
    LAWYER: ["Validate cause of action, relief strategy, and evidentiary gaps first."],
    LAW_STUDENT: ["Map the facts to issues and note which facts support each issue."],
    BUSINESS_CORPORATE: ["Separate legal risk from business impact before escalating."],
    NORMAL_PERSON: ["Keep the next steps simple: collect the main papers, dates, and proof first."],
  },
  terms_and_policies: {
    LAWYER: ["Tighten enforceability, forum, and remedy language before relying on the terms."],
    LAW_STUDENT: ["Study what each clause is trying to control and why that matters in disputes."],
    BUSINESS_CORPORATE: ["Prefer terms that reduce ambiguity, approval gaps, and recovery delays."],
    NORMAL_PERSON: ["Look for simple protections around payment, notice, and dispute handling."],
  },
  contract_risk: {
    LAWYER: ["Test the strongest clause challenge points and notice failures first."],
    LAW_STUDENT: ["Note why each flagged clause changes legal risk."],
    BUSINESS_CORPORATE: ["Prioritize the clauses that affect money, delay, and escalation exposure."],
    NORMAL_PERSON: ["Check the most dangerous terms first before taking action."],
  },
  outcome_projection: {
    LAWYER: ["Compare filing leverage versus settlement leverage using the strongest documents first."],
    LAW_STUDENT: ["Track which evidence improves the likely outcome and which gaps weaken it."],
    BUSINESS_CORPORATE: ["Use the outcome range to guide commercial decision-making and reserve planning."],
    NORMAL_PERSON: ["Focus on what can improve your chances before spending more time or money."],
  },
  policy_compliance: {
    LAWYER: ["Recheck notice chain, approvals, and missing supporting records."],
    LAW_STUDENT: ["Link each compliance issue to the legal consequence it may create."],
    BUSINESS_CORPORATE: ["Fix the highest-impact control gap first, then document remediation."],
    NORMAL_PERSON: ["Fix the clearest missing step or document first."],
  },
  legal_drafts_validation: {
    LAWYER: ["Sharpen relief language and attach the strongest documentary support."],
    LAW_STUDENT: ["Use the draft structure to understand how facts are turned into submissions."],
    BUSINESS_CORPORATE: ["Keep the draft commercially clear, measured, and approval-ready."],
    NORMAL_PERSON: ["Use simple wording and keep the draft focused on the key facts and request."],
  },
  final_summary: {
    LAWYER: ["Review legal posture, evidence gaps, and filing readiness first."],
    LAW_STUDENT: ["Read the outputs in issue order and connect each one to the facts."],
    BUSINESS_CORPORATE: ["Read the outputs in decision order: exposure, options, and next execution step."],
    NORMAL_PERSON: ["Start with the simplest next action and gather the missing proof first."],
  },
};

function appendRolePerspective(text: unknown, agentKey: CommonAgentKey, role: UserRole) {
  const base = String(text || "").replace(/\s+/g, " ").trim();
  const appendix = ROLE_SUMMARY_APPENDIX[agentKey]?.[role] || "";
  if (!base) return appendix;
  if (!appendix) return base;
  if (base.includes(appendix)) return base;
  return `${base} ${appendix}`.trim();
}

function trimSentence(text: unknown) {
  return String(text || "").replace(/\s+/g, " ").trim().replace(/[.?!\s]+$/g, "").trim();
}

function toSentence(text: unknown) {
  const clean = trimSentence(text);
  return clean ? `${clean}.` : "";
}

function simplifyPlainLanguage(text: unknown) {
  return String(text || "")
    .replace(/\bplaintiff\b/gi, "person who filed the case")
    .replace(/\bdefendant\b/gi, "other side")
    .replace(/\bpetitioner\b/gi, "person who approached the court")
    .replace(/\brespondent\b/gi, "other side")
    .replace(/\brelief sought\b/gi, "request to the court")
    .replace(/\bcause of action\b/gi, "main legal basis of the case")
    .replace(/\bevidentiary gaps?\b/gi, "missing proof")
    .replace(/\bprocedural posture\b/gi, "current stage of the case")
    .replace(/\blitigation-facing\b/gi, "court-focused")
    .replace(/\bexecuted a demand promissory note\b/gi, "signed a promissory note")
    .replace(/\bcosts of the suit\b/gi, "court costs")
    .replace(/\bhumbly submits\b/gi, "states")
    .replace(/\s+/g, " ")
    .trim();
}

function joinSentences(parts: Array<string | null | undefined>) {
  return parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

const ROLE_SUMMARY_PREFIXES = [
  "Case framing:",
  "Case brief:",
  "Decision brief:",
  "Simple summary:",
  "Risk memo:",
  "Risk note:",
  "Exposure view:",
  "Simple risk view:",
  "Outcome posture:",
  "Outcome note:",
  "Decision outlook:",
  "Simple outcome view:",
  "Compliance memo:",
  "Compliance note:",
  "Control view:",
  "Simple compliance view:",
  "Terms memo:",
  "Terms note:",
  "Policy view:",
  "Simple terms view:",
  "Drafting memo:",
  "Drafting note:",
  "Drafting view:",
  "Simple draft view:",
  "Execution summary:",
  "Learning summary:",
  "Decision summary:",
  "Simple final summary:",
];

const ROLE_SUMMARY_TAILS = new Set([
  ...Object.values(ROLE_SUMMARY_APPENDIX).flatMap((byRole) => Object.values(byRole)),
  "Legal focus: validate cause of action, relief strategy, evidentiary gaps, and current procedural posture before the next filing.",
  "Study focus: map the facts to issues, procedure, likely relief, and the facts that support each issue.",
  "Business focus: estimate exposure, recovery path, timeline, and escalation choice before committing more resources.",
  "Next step: keep the main papers, dates, and proof ready before taking the next legal step.",
  "Legal focus: pressure-test clause attack points, notice posture, and settlement leverage.",
  "Study focus: understand why each flagged term changes the legal risk analysis.",
  "Business focus: isolate the clauses that drive financial exposure, delay, and escalation risk.",
  "What this means: check the most risky terms first before taking action.",
  "Legal focus: compare filing leverage, settlement posture, and evidentiary strength.",
  "Study focus: track why the case may win, settle, or weaken.",
  "Business focus: use the range to plan exposure, recovery, and escalation.",
  "What this means: focus on the next step that can improve your chances.",
  "Legal focus: recheck notice defects, documentary gaps, and legally material deviations.",
  "Study focus: connect each compliance issue to its legal consequence.",
  "Business focus: prioritize approval gaps, control failures, and remediation order.",
  "What to fix first: handle the clearest missing step or document now.",
  "Legal focus: tighten enforceability, forum, and remedy language.",
  "Study focus: understand the function of each clause and policy point.",
  "Business focus: reduce ambiguity, approval gaps, and commercial delay.",
  "What to look for: clear protection around payment, notice, and dispute handling.",
  "Legal focus: sharpen relief framing and evidence-backed structure.",
  "Study focus: understand how facts are converted into a structured legal draft.",
  "Business focus: keep the communication measured, approval-ready, and commercially safe.",
  "What to do: use clear wording and stay focused on the main facts and request.",
  "Legal focus: prioritize posture, evidence gaps, and the next strategic move.",
  "Study focus: read the outputs in issue order and connect each one to the facts.",
  "Business focus: prioritize exposure, options, and the next execution step.",
  "Next step: start with the simplest action and gather the missing proof first.",
].map((text) => trimSentence(text).toLowerCase()));

function stripRoleAwareSummaryArtifacts(text: unknown) {
  let clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return clean;

  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of ROLE_SUMMARY_PREFIXES) {
      const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i");
      if (re.test(clean)) {
        clean = clean.replace(re, "").trim();
        changed = true;
      }
    }
  }

  const parts = clean
    .split(/(?<=[.!?])\s+/)
    .map((part) => String(part || "").trim())
    .filter(Boolean);

  const filtered = parts.filter((part) => !ROLE_SUMMARY_TAILS.has(trimSentence(part).toLowerCase()));
  return filtered.join(" ").replace(/\s+/g, " ").trim();
}

function buildRoleAwareSummary(agentKey: CommonAgentKey, role: UserRole, text: unknown) {
  const base = trimSentence(stripRoleAwareSummaryArtifacts(text));
  if (!base) return appendRolePerspective("", agentKey, role);
  const plain = trimSentence(simplifyPlainLanguage(base));

  if (agentKey === "query_parsing") {
    switch (role) {
      case "LAWYER":
        return joinSentences([
          `Case framing: ${base}.`,
          "Legal focus: validate cause of action, relief strategy, evidentiary gaps, and current procedural posture before the next filing.",
        ]);
      case "LAW_STUDENT":
        return joinSentences([
          `Case brief: ${base}.`,
          "Study focus: map the facts to issues, procedure, likely relief, and the facts that support each issue.",
        ]);
      case "BUSINESS_CORPORATE":
        return joinSentences([
          `Decision brief: ${base}.`,
          "Business focus: estimate exposure, recovery path, timeline, and escalation choice before committing more resources.",
        ]);
      case "NORMAL_PERSON":
        return joinSentences([
          `Simple summary: ${plain}.`,
          "Next step: keep the main papers, dates, and proof ready before taking the next legal step.",
        ]);
      default:
        return appendRolePerspective(base, agentKey, role);
    }
  }

  if (agentKey === "contract_risk") {
    switch (role) {
      case "LAWYER":
        return joinSentences([`Risk memo: ${base}.`, "Legal focus: pressure-test clause attack points, notice posture, and settlement leverage."]);
      case "LAW_STUDENT":
        return joinSentences([`Risk note: ${base}.`, "Study focus: understand why each flagged term changes the legal risk analysis."]);
      case "BUSINESS_CORPORATE":
        return joinSentences([`Exposure view: ${base}.`, "Business focus: isolate the clauses that drive financial exposure, delay, and escalation risk."]);
      case "NORMAL_PERSON":
        return joinSentences([`Simple risk view: ${simplifyPlainLanguage(base)}.`, "What this means: check the most risky terms first before taking action."]);
      default:
        return appendRolePerspective(base, agentKey, role);
    }
  }

  if (agentKey === "outcome_projection") {
    switch (role) {
      case "LAWYER":
        return joinSentences([`Outcome posture: ${base}.`, "Legal focus: compare filing leverage, settlement posture, and evidentiary strength."]);
      case "LAW_STUDENT":
        return joinSentences([`Outcome note: ${base}.`, "Study focus: track why the case may win, settle, or weaken."]);
      case "BUSINESS_CORPORATE":
        return joinSentences([`Decision outlook: ${base}.`, "Business focus: use the range to plan exposure, recovery, and escalation."]);
      case "NORMAL_PERSON":
        return joinSentences([`Simple outcome view: ${simplifyPlainLanguage(base)}.`, "What this means: focus on the next step that can improve your chances."]);
      default:
        return appendRolePerspective(base, agentKey, role);
    }
  }

  if (agentKey === "policy_compliance") {
    switch (role) {
      case "LAWYER":
        return joinSentences([`Compliance memo: ${base}.`, "Legal focus: recheck notice defects, documentary gaps, and legally material deviations."]);
      case "LAW_STUDENT":
        return joinSentences([`Compliance note: ${base}.`, "Study focus: connect each compliance issue to its legal consequence."]);
      case "BUSINESS_CORPORATE":
        return joinSentences([`Control view: ${base}.`, "Business focus: prioritize approval gaps, control failures, and remediation order."]);
      case "NORMAL_PERSON":
        return joinSentences([`Simple compliance view: ${simplifyPlainLanguage(base)}.`, "What to fix first: handle the clearest missing step or document now."]);
      default:
        return appendRolePerspective(base, agentKey, role);
    }
  }

  if (agentKey === "terms_and_policies") {
    switch (role) {
      case "LAWYER":
        return joinSentences([`Terms memo: ${base}.`, "Legal focus: tighten enforceability, forum, and remedy language."]);
      case "LAW_STUDENT":
        return joinSentences([`Terms note: ${base}.`, "Study focus: understand the function of each clause and policy point."]);
      case "BUSINESS_CORPORATE":
        return joinSentences([`Policy view: ${base}.`, "Business focus: reduce ambiguity, approval gaps, and commercial delay."]);
      case "NORMAL_PERSON":
        return joinSentences([`Simple terms view: ${simplifyPlainLanguage(base)}.`, "What to look for: clear protection around payment, notice, and dispute handling."]);
      default:
        return appendRolePerspective(base, agentKey, role);
    }
  }

  if (agentKey === "legal_drafts_validation") {
    switch (role) {
      case "LAWYER":
        return joinSentences([`Drafting memo: ${base}.`, "Legal focus: sharpen relief framing and evidence-backed structure."]);
      case "LAW_STUDENT":
        return joinSentences([`Drafting note: ${base}.`, "Study focus: understand how facts are converted into a structured legal draft."]);
      case "BUSINESS_CORPORATE":
        return joinSentences([`Drafting view: ${base}.`, "Business focus: keep the communication measured, approval-ready, and commercially safe."]);
      case "NORMAL_PERSON":
        return joinSentences([`Simple draft view: ${simplifyPlainLanguage(base)}.`, "What to do: use clear wording and stay focused on the main facts and request."]);
      default:
        return appendRolePerspective(base, agentKey, role);
    }
  }

  if (agentKey === "final_summary") {
    switch (role) {
      case "LAWYER":
        return joinSentences([`Execution summary: ${base}.`, "Legal focus: prioritize posture, evidence gaps, and the next strategic move."]);
      case "LAW_STUDENT":
        return joinSentences([`Learning summary: ${base}.`, "Study focus: read the outputs in issue order and connect each one to the facts."]);
      case "BUSINESS_CORPORATE":
        return joinSentences([`Decision summary: ${base}.`, "Business focus: prioritize exposure, options, and the next execution step."]);
      case "NORMAL_PERSON":
        return joinSentences([`Simple final summary: ${simplifyPlainLanguage(base)}.`, "Next step: start with the simplest action and gather the missing proof first."]);
      default:
        return appendRolePerspective(base, agentKey, role);
    }
  }

  return appendRolePerspective(base, agentKey, role);
}

const ROLE_ITEM_PREFIXES = [
  "Legal priority:",
  "Legal review:",
  "Study note:",
  "Study focus:",
  "Business priority:",
  "Business takeaway:",
  "Simple next step:",
  "What this means:",
];

function stripRoleAwareListArtifacts(text: unknown) {
  let clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return clean;

  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of ROLE_ITEM_PREFIXES) {
      const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i");
      if (re.test(clean)) {
        clean = clean.replace(re, "").trim();
        changed = true;
      }
    }
  }

  return clean.replace(/\s+/g, " ").trim();
}

function buildRoleAwareListText(agentKey: CommonAgentKey, role: UserRole, text: unknown) {
  const base = trimSentence(stripRoleAwareListArtifacts(text));
  if (!base) return "";

  const plain = trimSentence(simplifyPlainLanguage(base));

  switch (role) {
    case "LAWYER":
      return toSentence(`Legal priority: ${base}`);
    case "LAW_STUDENT":
      return toSentence(
        `${agentKey === "query_parsing" || agentKey === "final_summary" ? "Study focus" : "Study note"}: ${base}`,
      );
    case "BUSINESS_CORPORATE":
      return toSentence(
        `${agentKey === "outcome_projection" || agentKey === "policy_compliance" ? "Business priority" : "Business takeaway"}: ${base}`,
      );
    case "NORMAL_PERSON":
      return toSentence(
        `${agentKey === "contract_risk" || agentKey === "outcome_projection" ? "What this means" : "Simple next step"}: ${plain}`,
      );
    default:
      return toSentence(base);
  }
}

function mapRoleAwareStringArray(values: unknown, agentKey: CommonAgentKey, role: UserRole) {
  const items = Array.isArray(values) ? values : [];
  return items
    .map((item) => buildRoleAwareListText(agentKey, role, item))
    .filter(Boolean);
}

function mapRoleAwareObjectArray(
  values: unknown,
  formatter: (entry: Record<string, any>) => Record<string, any>,
) {
  if (!Array.isArray(values)) return [];
  return values.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    return formatter({ ...entry });
  });
}

function prependUniqueItems(values: unknown, additions: string[], limit?: number) {
  const normalized = Array.isArray(values)
    ? values.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of [...additions, ...normalized]) {
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (typeof limit === "number" && out.length >= limit) break;
  }
  return out;
}

export function applyRoleAwareCommonPayload(agentKey: CommonAgentKey, payload: any, role: UserRole) {
  if (!payload || typeof payload !== "object") return payload;
  const next: any = {
    ...payload,
    qa_debug: payload?.qa_debug && typeof payload.qa_debug === "object" ? { ...payload.qa_debug } : payload?.qa_debug,
  };
  const additions = ROLE_LIST_PRIORITIES[agentKey]?.[role] || [];
  const roleAwareAdditions = mapRoleAwareStringArray(additions, agentKey, role);
  next.audience_mode = typeof next.audience_mode === "string" && next.audience_mode.trim()
    ? next.audience_mode
    : applyRoleAwareLabel(role);
  next.qa_debug = {
    ...(next.qa_debug || {}),
    audience_role: role,
    audience_mode: next.audience_mode,
    role_aware_common_payload: true,
  };

  switch (agentKey) {
    case "query_parsing":
      {
        const summarySource = next.summary || next.executive_summary_text || next.executive_summary;
        const roleAwareSummary = buildRoleAwareSummary(agentKey, role, summarySource);
        next.summary = roleAwareSummary;
        if (typeof next.executive_summary_text === "string" || typeof summarySource === "string") {
          next.executive_summary_text = roleAwareSummary;
        }
        if (typeof next.executive_summary === "string" || typeof summarySource === "string") {
          next.executive_summary = roleAwareSummary;
        }
      }
      next.suggested_topics = prependUniqueItems(
        mapRoleAwareStringArray(next.suggested_topics, agentKey, role),
        roleAwareAdditions,
        5,
      );
      next.missing_information_questions = prependUniqueItems(
        mapRoleAwareStringArray(next.missing_information_questions, agentKey, role),
        roleAwareAdditions,
        5,
      );
      return next;
    case "terms_and_policies":
      next.summary = buildRoleAwareSummary(agentKey, role, next.summary);
      next.applicable_policies = mapRoleAwareObjectArray(next.applicable_policies, (entry) => ({
        ...entry,
        rationale: buildRoleAwareListText(agentKey, role, entry.rationale),
      }));
      next.risk_flags = mapRoleAwareObjectArray(next.risk_flags, (entry) => ({
        ...entry,
        description: buildRoleAwareListText(agentKey, role, entry.description),
      }));
      next.recommended_actions = prependUniqueItems(
        mapRoleAwareStringArray(next.recommended_actions, agentKey, role),
        roleAwareAdditions,
        5,
      );
      return next;
    case "contract_risk":
      next.summary = buildRoleAwareSummary(agentKey, role, next.summary);
      next.dispute_suggestions = prependUniqueItems(
        mapRoleAwareStringArray(next.dispute_suggestions, agentKey, role),
        roleAwareAdditions,
        5,
      );
      return next;
    case "outcome_projection":
      next.summary = buildRoleAwareSummary(agentKey, role, next.summary);
      next.key_factors = prependUniqueItems(
        mapRoleAwareStringArray(next.key_factors, agentKey, role),
        roleAwareAdditions,
        6,
      );
      next.recommended_actions = prependUniqueItems(
        mapRoleAwareStringArray(next.recommended_actions, agentKey, role),
        roleAwareAdditions,
        5,
      );
      return next;
    case "policy_compliance":
      next.summary = buildRoleAwareSummary(agentKey, role, next.summary);
      next.recommended_actions = prependUniqueItems(
        mapRoleAwareStringArray(next.recommended_actions, agentKey, role),
        roleAwareAdditions,
        6,
      );
      return next;
    case "legal_drafts_validation":
      if (typeof next.draft_text === "string" && /^template selected:/i.test(String(next.draft_text || "").trim())) {
        next.draft_text = buildRoleAwareSummary(agentKey, role, next.draft_text);
      }
      next.validation_checks = prependUniqueItems(
        mapRoleAwareStringArray(next.validation_checks, agentKey, role),
        roleAwareAdditions,
        6,
      );
      next.missing_evidence = prependUniqueItems(
        mapRoleAwareStringArray(next.missing_evidence, agentKey, role),
        roleAwareAdditions,
        5,
      );
      return next;
    case "final_summary":
      next.consolidated_summary = buildRoleAwareSummary(agentKey, role, next.consolidated_summary);
      next.next_actions = prependUniqueItems(
        mapRoleAwareStringArray(next.next_actions, agentKey, role),
        roleAwareAdditions,
        5,
      );
      return next;
    default:
      return next;
  }
}

function normalizeExecutiveSummaryText(value: string) {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return text;
  text = text
    .replace(/\bthe user is seeking seek\b/gi, "the user is seeking")
    .replace(/\bthe user seeks seek\b/gi, "the user seeks")
    .replace(/\bthis appears to be\b/gi, "")
    .replace(/\bthe matter appears to involve\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (text) {
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }
  return text;
}

function normalizeQueryParsingPayload(payload: any) {
  if (!payload || typeof payload !== "object") return payload;
  const next: any = { ...payload };
  next.schema_version = typeof next.schema_version === "string" ? next.schema_version : "query_parsing_v2";
  next.output_mode = typeof next.output_mode === "string" ? next.output_mode : (typeof next.mode === "string" ? next.mode : "normal");

  const execSummary =
    (typeof next.executive_summary === "string" && next.executive_summary.trim()) ||
    (typeof next.executive_summary_text === "string" && next.executive_summary_text.trim()) ||
    (typeof next.summary === "string" && next.summary.trim()) ||
    "";
  if (execSummary) {
    const normalizedSummary = normalizeExecutiveSummaryText(execSummary);
    next.executive_summary = normalizedSummary;
    next.executive_summary_text = normalizedSummary;
    next.summary = normalizedSummary;
  }

  const langObj = (next.language && typeof next.language === "object") ? next.language : null;
  const detectedLegacy =
    typeof next.detected_language === "string"
      ? { detected: next.detected_language, confidence: 0.8 }
      : next.detected_language && typeof next.detected_language === "object"
        ? { detected: next.detected_language.name || next.detected_language.code || "English", confidence: next.detected_language.confidence ?? 0.8 }
        : null;
  if (!langObj || typeof langObj.detected !== "string") {
    next.language = {
      detected: String(detectedLegacy?.detected || "English"),
      confidence: clamp01(detectedLegacy?.confidence, 0.8),
    };
  } else {
    next.language = {
      detected: String(langObj.detected || "English"),
      confidence: clamp01(langObj.confidence, 0.8),
    };
  }
  if (!next.detected_language || typeof next.detected_language !== "object") {
    next.detected_language = {
      code: String(next.detected_language?.code || "").trim() || String(next.language.detected || "en").slice(0, 2).toLowerCase(),
      confidence: clamp01(next.language.confidence, 0.8),
      name: String(next.language.detected || "English"),
    };
  }

  const domainObj = (next.domain && typeof next.domain === "object" && !Array.isArray(next.domain)) ? next.domain : null;
  const legacyPrimary =
    (typeof next.legal_domain === "string" && next.legal_domain.trim()) ||
    (typeof next.domain === "string" && next.domain.trim()) ||
    "General";
  const legacySubtype = (typeof next.legal_subtype === "string" && next.legal_subtype.trim()) || "unknown";
  if (!domainObj || typeof domainObj.primary !== "string") {
    next.domain = {
      primary: legacyPrimary,
      subtype: legacySubtype,
      confidence: clamp01((Number(next.confidence_score) || Number(next.confidence) * 100) / 100, 0.6),
    };
  } else {
    next.domain = {
      primary: String(domainObj.primary || legacyPrimary || "General"),
      subtype: String(domainObj.subtype || legacySubtype || "unknown"),
      confidence: clamp01(domainObj.confidence, clamp01((Number(next.confidence_score) || Number(next.confidence) * 100) / 100, 0.6)),
    };
  }
  if (!next.legal_domain || typeof next.legal_domain !== "string") next.legal_domain = next.domain.primary;
  if (!next.legal_subtype || typeof next.legal_subtype !== "string") next.legal_subtype = next.domain.subtype;
  if (!next.domain_string && typeof next.domain === "object") next.domain_string = next.domain.primary;

  const jurisdictionObj = (next.jurisdiction && typeof next.jurisdiction === "object" && !Array.isArray(next.jurisdiction)) ? next.jurisdiction : null;
  const legacyJurisdiction =
    (typeof next.jurisdiction === "string" && next.jurisdiction.trim()) ||
    (typeof next.jurisdiction_guess === "string" && next.jurisdiction_guess.trim()) ||
    "Unknown";
  if (!jurisdictionObj || typeof jurisdictionObj.country !== "string") {
    next.jurisdiction = {
      country: /india/i.test(legacyJurisdiction) ? "India" : "Unknown",
      confidence: /india/i.test(legacyJurisdiction) ? 0.85 : 0.35,
      reason: /india/i.test(legacyJurisdiction)
        ? "Detected from available inputs/filters."
        : "No clear jurisdiction evidence in available inputs.",
    };
  } else {
    next.jurisdiction = {
      country: String(jurisdictionObj.country || "Unknown") === "India" ? "India" : "Unknown",
      confidence: clamp01(jurisdictionObj.confidence, /india/i.test(String(jurisdictionObj.country || "")) ? 0.85 : 0.35),
      reason: String(jurisdictionObj.reason || "").trim() || "Derived from available inputs.",
    };
  }
  next.jurisdiction_guess = next.jurisdiction.country;

  if (!Array.isArray(next.issue_groups)) {
    next.issue_groups = [];
  }
  if (next.issue_groups.length && typeof next.issue_groups[0]?.label === "string") {
    if (!Array.isArray(next.issues) || !next.issues.length) {
      next.issues = next.issue_groups.map((g: any) => String(g.label || "").trim()).filter(Boolean);
    }
  } else if (next.issue_groups.length && typeof next.issue_groups[0]?.title === "string") {
    const legacyGroups = next.issue_groups;
    next.issue_groups = legacyGroups.map((g: any) => ({
      label: String(g.title || "").trim(),
      confidence: g.priority === "high" ? 0.85 : g.priority === "low" ? 0.55 : 0.68,
    }));
    if (!Array.isArray(next.issues) || !next.issues.length) {
      next.issues = next.issue_groups.map((g: any) => g.label).filter(Boolean);
    }
  }

  if (!Array.isArray(next.legal_grounds)) next.legal_grounds = [];
  if (!Array.isArray(next.next_best_actions)) next.next_best_actions = [];
  if (!Array.isArray(next.clarifying_questions)) next.clarifying_questions = [];
  if (!Array.isArray(next.citations)) next.citations = [];
  next.citations = next.citations.filter((c: any) => c && typeof c.snippet === "string" && c.snippet.trim());

  if (!next.risk_assessment || typeof next.risk_assessment !== "object") {
    next.risk_assessment = {
      risk_level: "Medium",
      risk_reasons: ["Initial routing confidence is limited."],
      missing_info: [],
    };
  } else {
    next.risk_assessment = {
      risk_level: ["Low", "Medium", "High"].includes(String(next.risk_assessment.risk_level)) ? next.risk_assessment.risk_level : "Medium",
      risk_reasons: Array.isArray(next.risk_assessment.risk_reasons) ? next.risk_assessment.risk_reasons : [],
      missing_info: Array.isArray(next.risk_assessment.missing_info) ? next.risk_assessment.missing_info : [],
    };
  }

  if (!next.case_title && typeof next.title === "string") next.case_title = next.title;
  return next;
}

function normalizeSupportTokens(text: string) {
  const stop = new Set(["the", "and", "for", "with", "from", "this", "that", "case", "legal", "user", "query", "analysis", "india"]);
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 4 && !stop.has(x)),
  );
}

function hasSupportOverlap(text: string, supportTokens: Set<string>) {
  const tokens = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 4);
  return tokens.some((t) => supportTokens.has(t));
}

function enforceGroundedLegalGrounds(payload: any) {
  const citations = Array.isArray(payload?.citations) ? payload.citations : [];
  const supportText = citations.map((c: any) => String(c?.snippet || "")).join(" ");
  const supportTokens = normalizeSupportTokens(supportText);
  const grounds = Array.isArray(payload?.legal_grounds) ? payload.legal_grounds : [];
  const filtered = grounds.filter((g: any) => hasSupportOverlap(String(g || ""), supportTokens));
  if (filtered.length >= 3) {
    payload.legal_grounds = filtered.slice(0, 6);
    payload.qa_debug = { ...(payload.qa_debug || {}), unsupported_grounds_removed: grounds.length - payload.legal_grounds.length };
  } else {
    payload.qa_debug = { ...(payload.qa_debug || {}), unsupported_grounds_removed: grounds.length - filtered.length };
  }
  return payload;
}

function stampProvenance(caseId: string, agentKey: string, payload: any, caseMeta?: any) {
  const filtersApplied = (caseMeta?.filtersApplied && typeof caseMeta.filtersApplied === "object") ? caseMeta.filtersApplied : {};
  const userQueryText = String(caseMeta?.userQueryText || "");
  const inputHash = caseMeta?.inputHash || sha256(`${userQueryText}::${JSON.stringify(filtersApplied)}`);
  const docChecksumsUsed = Array.isArray(caseMeta?.docChecksumsUsed) ? [...new Set(caseMeta.docChecksumsUsed.map(String))] : [];
  return {
    ...(payload || {}),
    case_id: caseId,
    run_id: caseMeta?.runId || null,
    input_hash: inputHash,
    doc_checksums_used: docChecksumsUsed,
    filters_applied: filtersApplied,
    generated_at: new Date().toISOString(),
    model_profile: getEnv().AI_PROFILE,
    mode: payload?.mode || "fallback",
  };
}

async function upsertOutput(caseId: string, agentKey: string, payload: any) {
  await prisma.agentOutput.upsert({
    where: { caseId_agentKey: { caseId, agentKey } },
    create: { caseId, agentKey, payloadJson: payload, sourceLanguage: "en" },
    update: { payloadJson: payload, sourceLanguage: "en" },
  });
}

async function maybeUpdateCaseMetadataFromQueryParsing(caseId: string, payload: any) {
  const rawTitle = typeof payload?.case_title === "string" ? payload.case_title.trim() : "";
  const nextTitle = rawTitle ? rawTitle.slice(0, 120) : undefined;
  const domainPrimary =
    (typeof payload?.domain?.primary === "string" ? payload.domain.primary.trim() : "") ||
    (typeof payload?.legal_domain === "string" ? payload.legal_domain.trim() : "") ||
    (typeof payload?.domain === "string" ? payload.domain.trim() : "");
  const domainSubtype =
    (typeof payload?.domain?.subtype === "string" ? payload.domain.subtype.trim() : "") ||
    (typeof payload?.legal_subtype === "string" ? payload.legal_subtype.trim() : "");
  const language =
    (typeof payload?.language?.detected === "string" ? payload.language.detected.trim() : "") ||
    (typeof payload?.detected_language === "string" ? payload.detected_language.trim() : "");
  const patch: any = { updatedAt: new Date() };
  if (nextTitle) patch.title = nextTitle;
  if (domainPrimary) patch.domainPrimary = domainPrimary.slice(0, 191);
  if (domainSubtype) patch.domainSubtype = domainSubtype.slice(0, 191);
  if (language) patch.language = language.slice(0, 191);
  if (Object.keys(patch).length <= 1) return;
  await prisma.case.update({
    where: { id: caseId },
    data: patch,
  }).catch(() => undefined);
}

async function runCommonAgentInternal(
  persist: boolean,
  caseId: string,
  role: any,
  docsText: string,
  existing: Record<string, any>,
  agentKey: string,
  caseMeta?: {
    runId?: string | null;
    inputHash?: string;
    docChecksumsUsed?: string[];
    detectedLanguage?: string | null;
    language?: string | null;
    preferredLanguage?: string | null;
    filtersApplied?: any;
    filtersNotFullyApplied?: boolean;
    userQueryText?: string;
    extractedDocSnippets?: Array<{ doc_id: string; chunk_id: string; snippet: string; source_type?: string; source_label?: string }>;
    inputStats?: Record<string, any>;
    previewMode?: boolean;
  },
) {
  const env = getEnv();
  const queryText = (caseMeta as any)?.userQueryText || "";
  const ctx = {
    caseId,
    caseRole: role,
    documentsText: docsText,
    userQueryText: queryText,
    extractedDocSnippets: (caseMeta as any)?.extractedDocSnippets || [],
    existing,
    caseMeta,
  };
  let deterministicFallback: () => Promise<any>;
  switch (agentKey) {
    case "query_parsing":
      deterministicFallback = () => runQueryParsing(ctx);
      break;
    case "terms_and_policies":
      deterministicFallback = () => runTermsAndPolicies(ctx);
      break;
    case "contract_risk":
      deterministicFallback = () => runContractRisk(ctx);
      break;
    case "outcome_projection":
      deterministicFallback = () => runOutcomeProjection(ctx);
      break;
    case "policy_compliance":
      deterministicFallback = () => runPolicyCompliance(ctx);
      break;
    case "legal_drafts_validation":
      deterministicFallback = () => runLegalDraftsValidation(ctx);
      break;
    default:
      throw new Error(`Unsupported common agent: ${agentKey}`);
  }
  if (agentKey === "query_parsing" && caseMeta?.previewMode) {
    const previewContext = ((caseMeta?.extractedDocSnippets || []).slice(0, 6).map((row) => ({
      doc_id: String(row.doc_id || "live_query"),
      chunk_id: String(row.chunk_id || "preview:0"),
      snippet: String(row.snippet || "").slice(0, 320),
      source_type: row.source_type || "user_doc",
    }))).filter((row) => String(row.snippet || "").trim());
    if (!previewContext.length && String(queryText || "").trim()) {
      previewContext.push({
        doc_id: "live_query",
        chunk_id: "live_query:0",
        snippet: String(queryText || "").trim().slice(0, 320),
        source_type: "user_doc",
      });
    }
    if (!previewContext.length && String(docsText || "").trim()) {
      previewContext.push({
        doc_id: "preview_doc",
        chunk_id: "preview_doc:0",
        snippet: String(docsText || "").replace(/\s+/g, " ").trim().slice(0, 320),
        source_type: "user_doc",
      });
    }
    let previewPayload = await groundedGenerator.generateModule({
      moduleKey: agentKey,
      language: caseMeta?.language || "English",
      queryText: String(queryText || "").slice(0, 2500),
      filters: caseMeta?.filtersApplied || {},
      priorOutputs: existing,
      contextChunks: previewContext,
      deterministicFallback,
      forceLlmPolishOnRun: true,
      generationTier: "preview",
      signal: runCancellationService.getSignal(caseMeta?.runId),
    });
    previewPayload = agentKey === "query_parsing" ? normalizeQueryParsingPayload(previewPayload) : previewPayload;
    previewPayload = {
      ...previewPayload,
      mode: previewPayload?.mode || "fallback",
      qa_debug: {
        ...(previewPayload?.qa_debug || {}),
        preview_mode: true,
        preview_fast_path: previewPayload?.mode === "rag_llm" ? "fast_preview_model" : "deterministic_no_retrieval",
      },
    };
    previewPayload = applyRoleAwareCommonPayload("query_parsing", previewPayload, role);
    return stampProvenance(caseId, agentKey, previewPayload, caseMeta);
  }
  const contextChunks = await retrieveContextForModule(caseId, agentKey, docsText, existing, caseMeta);
  const payload = await groundedGenerator.generateModule({
    moduleKey: agentKey,
    language: caseMeta?.language || "English",
    queryText: String(queryText || "").slice(0, 4000),
    filters: caseMeta?.filtersApplied || {},
    priorOutputs: existing,
    contextChunks,
    deterministicFallback,
    forceLlmPolishOnRun: agentKey === "query_parsing" && !caseMeta?.previewMode,
    generationTier: "final",
    signal: runCancellationService.getSignal(caseMeta?.runId),
  });
  let finalPayload = agentKey === "query_parsing" ? normalizeQueryParsingPayload(payload) : payload;
  if (agentKey === "query_parsing") {
    finalPayload = enforceGroundedLegalGrounds(finalPayload);
  }
  if (agentKey === "query_parsing" && shouldRepairQueryParsingPayload(payload, docsText, queryText)) {
    if (env.REQUIRE_LLM_OUTPUT) {
      finalPayload = normalizeQueryParsingPayload({
        ...finalPayload,
        analysis_valid: false,
        failure_reason: finalPayload.failure_reason || "Query Parsing output needs stronger evidence signals.",
        qa_debug: {
          ...(finalPayload?.qa_debug || {}),
          quality_guard: "llm_output_too_weak",
        },
      });
    } else {
      const deterministic = await deterministicFallback();
      finalPayload = normalizeQueryParsingPayload({
        ...deterministic,
        mode: payload?.mode || deterministic?.mode || "fallback",
        fallback_reason: payload?.fallback_reason || "query_parsing_quality_guard",
      });
    }
  }
  finalPayload = applyRoleAwareCommonPayload(agentKey as CommonAgentKey, finalPayload, role);
  finalPayload = stampProvenance(caseId, agentKey, finalPayload, caseMeta);
  if (persist) {
    await upsertOutput(caseId, agentKey, finalPayload);
    if (agentKey === "query_parsing") {
      await maybeUpdateCaseMetadataFromQueryParsing(caseId, finalPayload);
    }
  }
  return finalPayload;
}

function shouldRepairQueryParsingPayload(payload: any, docsText: string, userQueryText?: string) {
  if (!payload || typeof payload !== "object") return true;
  payload = normalizeQueryParsingPayload(payload);
  const sourceText = `${userQueryText || ""} ${docsText || ""}`.trim();
  const hasInput = sourceText.length > 0;
  if (!hasInput) return false;
  const execSummary = String(payload.executive_summary || payload.executive_summary_text || payload.summary || "").trim();
  if (!execSummary || execSummary.length < 60) return true;
  if (/insufficient facts|no text|no snippets/i.test(execSummary)) return true;
  if (!(payload.language && typeof payload.language.detected === "string")) return true;
  if (!(payload.jurisdiction && typeof payload.jurisdiction.country === "string")) return true;
  if (!(payload.domain && typeof payload.domain.primary === "string" && typeof payload.domain.subtype === "string")) return true;
  if (typeof payload.case_title !== "string" || payload.case_title.trim().length < 4) return true;
  if (!Array.isArray(payload.issue_groups) || payload.issue_groups.length === 0) return true;
  if (!Array.isArray(payload.legal_grounds) || payload.legal_grounds.length < 3) return true;
  if (!Array.isArray(payload.citations) || payload.citations.length < 3) return true;
  const hasCurrent = payload.citations.some((c: any) => c?.source_type === "current_input");
  if (String(userQueryText || "").trim() && !hasCurrent) return true;
  return false;
}

function buildTerms(moduleKey: string, docsText: string, existing: Record<string, any>, role?: string, userQueryText?: string) {
  const qp = existing.query_parsing || {};
  const issues = Array.isArray(qp.issues) ? qp.issues : [];
  const qpSummary = typeof qp.summary === "string" ? qp.summary : "";
  const qpDomain = typeof qp.domain === "string" ? qp.domain : "";
  const queryTerms = (userQueryText || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12);
  const common = {
    query_parsing: [...queryTerms, ...issues, qpDomain, "facts", "issues", "jurisdiction", "dispute", "remedy"],
    terms_and_policies: [...issues, "policy", "terms", "clause", "statute", "regulation"],
    contract_risk: [...issues, "breach", "liability", "termination", "payment", "indemnity"],
    outcome_projection: [...issues, "timeline", "penalty", "damages", "deadline", "limitation"],
    policy_compliance: [...issues, "compliance", "regulation", "statute", "notice", "policy"],
    legal_drafts_validation: [...issues, "draft", "notice", "evidence", "template"],
    final_summary: [...issues, "summary", "next actions", "evidence"],
  } as Record<string, string[]>;
  if (common[moduleKey]) return common[moduleKey].filter(Boolean);
  return [moduleKey.replaceAll("_", " "), qpDomain, qpSummary, ...queryTerms, ...issues, role || "", docsText.slice(0, 120)].filter(Boolean);
}

function pickBalancedBundleHits(
  moduleKey: string,
  query: string,
  bundle: { user_doc_hits: any[]; legal_corpus_hits: any[]; merged_hits: any[] },
  limit: number,
) {
  const queryTokens = new Set(
    String(query || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 4),
  );
  const scoreHit = (hit: any) => {
    const text = String(hit?.snippet || hit?.text || "").toLowerCase();
    let overlap = 0;
    for (const token of queryTokens) {
      if (text.includes(token)) overlap += 1;
    }
    if (String(hit?.source_type || "") === "legal_corpus" && (moduleKey === "policy_compliance" || moduleKey === "outcome_projection" || moduleKey === "final_summary")) {
      overlap += 2;
    }
    if (String(hit?.source_type || "") === "user_doc") overlap += 1;
    return overlap;
  };

  const userHits = [...(bundle.user_doc_hits || [])].sort((a, b) => scoreHit(b) - scoreHit(a));
  const legalHits = [...(bundle.legal_corpus_hits || [])].sort((a, b) => scoreHit(b) - scoreHit(a));
  const wantsLegal = moduleKey === "policy_compliance" || moduleKey === "outcome_projection" || moduleKey === "terms_and_policies" || moduleKey === "final_summary";
  const legalQuota = wantsLegal ? Math.min(4, Math.floor(limit / 2), legalHits.length) : 0;
  const userQuota = Math.min(limit - legalQuota, userHits.length);
  const picked: any[] = [];
  let ui = 0;
  let li = 0;
  while (picked.length < limit && (ui < userQuota || li < legalQuota)) {
    if (ui < userQuota) picked.push(userHits[ui++]);
    if (picked.length >= limit) break;
    if (li < legalQuota) picked.push(legalHits[li++]);
  }
  const seen = new Set(picked.map((hit) => `${hit.doc_id}:${hit.chunk_id}`));
  for (const hit of bundle.merged_hits || []) {
    if (picked.length >= limit) break;
    const key = `${hit.doc_id}:${hit.chunk_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(hit);
  }
  return picked.slice(0, limit);
}

async function retrieveContextForModule(
  caseId: string,
  moduleKey: string,
  docsText: string,
  existing: Record<string, any>,
  caseMeta?: { filtersApplied?: any; userQueryText?: string; previewMode?: boolean },
) {
  const env = getEnv();
  const terms = buildTerms(moduleKey, docsText, existing, undefined, (caseMeta as any)?.userQueryText);
  const query = terms.join(" ");
  const filters = caseMeta?.filtersApplied || {};
  const requestedSourceTypes = Array.isArray(filters?.source_types) ? filters.source_types.map((x: any) => String(x || "").toLowerCase()) : [];
  const wantsLegalByFilter = requestedSourceTypes.some((s: string) =>
    ["acts & statutes", "case laws", "regulations", "legal opinions"].includes(s),
  );
  const includeLegal =
    moduleKey === "policy_compliance" ||
    moduleKey === "terms_and_policies" ||
    moduleKey === "final_summary" ||
    moduleKey === "outcome_projection" ||
    (wantsLegalByFilter && (moduleKey === "query_parsing" || moduleKey === "contract_risk" || moduleKey === "legal_drafts_validation"));
  const sourceTypes = filters?.source_types;
  const limit =
    moduleKey === "query_parsing"
      ? Math.min(Math.max(Math.min(env.RETRIEVE_TOPK, env.RAG_TOPK_USER), 3), 4)
      : includeLegal
        ? Math.max(Math.min(env.RETRIEVE_TOPK, env.RAG_TOPK_USER) + Math.min(env.RETRIEVE_TOPK, env.RAG_TOPK_LAW), 8)
        : Math.max(Math.min(env.RETRIEVE_TOPK, env.RAG_TOPK_USER), 6);
  const bundle = await retrieveBundleService.retrieveBundle({
    caseId,
    query,
    filters: { ...filters, source_types: sourceTypes },
    kUser: Math.max(3, env.RAG_TOPK_USER),
    kLegal: Math.max(0, env.RAG_TOPK_LAW),
    includeLegalCorpus: includeLegal,
  });
  return pickBalancedBundleHits(moduleKey, query, bundle, limit);
}

export const agentRunner = {
  async runCommonAgent(
    caseId: string,
    role: any,
    docsText: string,
    existing: Record<string, any>,
    agentKey: string,
    caseMeta?: {
      runId?: string | null;
      inputHash?: string;
      docChecksumsUsed?: string[];
      detectedLanguage?: string | null;
      language?: string | null;
      preferredLanguage?: string | null;
      filtersApplied?: any;
      filtersNotFullyApplied?: boolean;
      userQueryText?: string;
      extractedDocSnippets?: Array<{ doc_id: string; chunk_id: string; snippet: string; source_type?: string; source_label?: string }>;
      inputStats?: Record<string, any>;
      previewMode?: boolean;
    },
  ) {
    return runCommonAgentInternal(true, caseId, role, docsText, existing, agentKey, caseMeta);
  },

  async previewQueryParsing(
    caseId: string,
    role: any,
    docsText: string,
    caseMeta?: {
      runId?: string | null;
      inputHash?: string;
      docChecksumsUsed?: string[];
      detectedLanguage?: string | null;
      language?: string | null;
      preferredLanguage?: string | null;
      filtersApplied?: any;
      filtersNotFullyApplied?: boolean;
      userQueryText?: string;
      extractedDocSnippets?: Array<{ doc_id: string; chunk_id: string; snippet: string; source_type?: string; source_label?: string }>;
      inputStats?: Record<string, any>;
      previewMode?: boolean;
    },
  ) {
    return runCommonAgentInternal(false, caseId, role, docsText, {}, "query_parsing", caseMeta);
  },

  async runRoleAgent(
    caseId: string,
    role: any,
    docsText: string,
    common: Record<string, any>,
    agentKey: string,
    caseMeta?: {
      runId?: string | null;
      inputHash?: string;
      docChecksumsUsed?: string[];
      detectedLanguage?: string | null;
      language?: string | null;
      preferredLanguage?: string | null;
      filtersApplied?: any;
      userQueryText?: string;
      extractedDocSnippets?: Array<{ doc_id: string; chunk_id: string; snippet: string; source_type?: string; source_label?: string }>;
      inputStats?: Record<string, any>;
      previewMode?: boolean;
    },
  ) {
    const deterministicFallback = () => runRoleAgent(agentKey, { caseId, role, text: docsText, common });
    const contextChunks = await retrieveContextForModule(caseId, agentKey, docsText, common, caseMeta);
    const payload = await groundedGenerator.generateModule({
      moduleKey: agentKey,
      language: caseMeta?.language || "English",
      queryText: String((caseMeta as any)?.userQueryText || "").slice(0, 4000),
      filters: caseMeta?.filtersApplied || {},
      priorOutputs: common,
      contextChunks,
      deterministicFallback,
      generationTier: "final",
      signal: runCancellationService.getSignal(caseMeta?.runId),
    });
    const stamped = stampProvenance(caseId, agentKey, payload, caseMeta);
    await upsertOutput(caseId, agentKey, stamped);
    return stamped;
  },

  async runFinalSummary(
    caseId: string,
    common: Record<string, any>,
    roleOutputs: Record<string, any>,
    role: UserRole,
    caseMeta?: {
      runId?: string | null;
      inputHash?: string;
      docChecksumsUsed?: string[];
      detectedLanguage?: string | null;
      language?: string | null;
      preferredLanguage?: string | null;
      filtersApplied?: any;
      docsText?: string;
      userQueryText?: string;
      extractedDocSnippets?: Array<{ doc_id: string; chunk_id: string; snippet: string; source_type?: string; source_label?: string }>;
      inputStats?: Record<string, any>;
      previewMode?: boolean;
    },
  ) {
    const deterministicFallback = async () => buildFinalSummary({ common, roleOutputs });
    const contextChunks = await retrieveContextForModule(caseId, "final_summary", caseMeta?.docsText || "", { ...common, ...roleOutputs }, caseMeta);
    const payload = await groundedGenerator.generateModule({
      moduleKey: "final_summary",
      language: caseMeta?.language || "English",
      queryText: String((caseMeta as any)?.userQueryText || "").slice(0, 4000),
      filters: caseMeta?.filtersApplied || {},
      priorOutputs: { common, roleOutputs },
      contextChunks,
      deterministicFallback,
      generationTier: "final",
      signal: runCancellationService.getSignal(caseMeta?.runId),
    });
    const roleAwarePayload = applyRoleAwareCommonPayload("final_summary", payload, role);
    const stamped = stampProvenance(caseId, "final_summary", roleAwarePayload, caseMeta);
    await upsertOutput(caseId, "final_summary", stamped);
    return stamped;
  },
};
