import { indexService } from "../index.service.js";
import { ROLE_AGENT_KEYS } from "../../utils/roleMap.js";
import type { UserRole } from "../../db/types.js";

type Ctx = {
  caseId: string;
  role: UserRole;
  common: Record<string, any>;
  text: string;
};

export const ROLE_AGENT_DEPENDENCIES: Record<string, string[]> = {
  lawyer_strategy_action_plan: ["query_parsing", "contract_risk", "outcome_projection"],
  lawyer_client_communication: ["query_parsing", "outcome_projection"],
  lawyer_court_process_copilot: ["query_parsing", "policy_compliance", "outcome_projection"],
  lawyer_case_prep: ["query_parsing", "contract_risk", "legal_drafts_validation"],
  lawyer_intern_guidance: ["query_parsing", "legal_drafts_validation"],
  student_workflow_case_mgmt: ["query_parsing", "outcome_projection", "policy_compliance"],
  student_concept_learning_books: ["query_parsing"],
  student_exam_preparation: ["query_parsing", "outcome_projection"],
  corp_executive_decision_support: ["query_parsing", "contract_risk", "outcome_projection", "policy_compliance"],
  corp_workflow_case_prep: ["query_parsing", "legal_drafts_validation"],
  corp_court_process: ["query_parsing", "policy_compliance", "outcome_projection"],
  individual_step_by_step_guidance: ["query_parsing", "outcome_projection", "policy_compliance"],
  individual_family_explain: ["query_parsing", "outcome_projection"],
  individual_cost_factor: ["outcome_projection", "contract_risk"],
};

function ensureDeps(agentKey: string, common: Record<string, any>) {
  const deps = ROLE_AGENT_DEPENDENCIES[agentKey] || [];
  const missing = deps.filter((d) => !common[d]);
  if (missing.length) {
    throw new Error(`Missing dependencies for ${agentKey}: ${missing.join(", ")}`);
  }
}

function citationsFrom(rows: Array<{ doc_id: string; chunk_id: string; snippet: string; source_type?: string; source_label?: string }>) {
  return rows.map((r) => ({
    doc_id: r.doc_id,
    chunk_id: r.chunk_id,
    snippet: r.snippet,
    source_type: r.source_type || "user_doc",
    source_label: r.source_label,
  }));
}

export async function runRoleAgent(agentKey: string, ctx: Ctx) {
  ensureDeps(agentKey, ctx.common);
  const hits = await indexService.retrieve(ctx.caseId, [agentKey.replaceAll("_", " "), ...(ctx.common.query_parsing?.issues || [])], 4);
  const qp = ctx.common.query_parsing;
  const cr = ctx.common.contract_risk;
  const op = ctx.common.outcome_projection;
  const ld = ctx.common.legal_drafts_validation;
  const pc = ctx.common.policy_compliance;

  const base = { confidence: 0.68, citations: citationsFrom(hits) };

  switch (agentKey) {
    case "lawyer_strategy_action_plan":
      return { checklist: ["Frame causes of action", "Map evidence to each issue", "Prioritize interim relief options"], key_questions: qp.issues, evidence_gaps: cr.missing_clauses || [], ...base };
    case "lawyer_client_communication":
      return { explanation: `Primary issues identified: ${(qp.issues || []).join(", ")}. Recommended path is evidence cleanup and timeline validation before escalation.`, next_steps: ["Share chronology", "Share notices", "Confirm desired commercial outcome"], ...base };
    case "lawyer_court_process_copilot":
    case "corp_court_process":
      return { milestones: ["Pre-filing review", "Notice/response stage", "Evidence compilation", "Hearing preparation"], process_notes: ["Track deadlines carefully", "Preserve originals"], timeline_hint: op.timeline_range_months, ...base };
    case "lawyer_case_prep":
      return { prep_checklist: ["Issue matrix", "Evidence table", "Witness list", "Draft pleadings"], key_questions: ["What breach date is provable?", "What damages are documented?"], evidence_gaps: ld.missing_evidence || [], ...base };
    case "lawyer_intern_guidance":
      return { tasks: ["Compile chronology", "Extract clauses", "Prepare citation bundle"], review_points: ["Dates", "Party names", "Amounts"], ...base };
    case "student_workflow_case_mgmt":
      return { workstream: ["Intake", "Evidence", "Drafting", "Review", "Submission"], blockers: pc.violations || [], ...base };
    case "student_concept_learning_books":
      return { concepts: qp.issues || [], reading_plan: ["Contract Act basics", "Civil procedure overview", "Evidence principles"], ...base };
    case "student_exam_preparation":
      return { topics: qp.issues || [], practice_questions: ["Identify issues", "Assess remedies", "Draft answer structure"], ...base };
    case "corp_executive_decision_support":
      return { exec_memo: `Risk level ${cr.risk_level}; likely timeline ${op.timeline_range_months?.join("-")} months; prioritize commercial settlement evaluation with evidence remediation.`, risk_impact_table: [{ area: "Liability", risk: cr.risk_level, impact: "Commercial/operational" }], ...base };
    case "corp_workflow_case_prep":
      return { preparation_steps: ["Collect contract pack", "Create issue list", "Draft escalation note"], deliverables: ld.templates_available || [], ...base };
    case "individual_step_by_step_guidance":
      return { steps: ["Collect all documents", "Write facts chronologically", "Upload/paste all materials", "Review AI outputs", "Take legal consultation"], timeline: op.timeline_range_months, docs_needed: ["Agreement", "Notices", "Invoices", "Messages"], ...base };
    case "individual_family_explain":
      return { simplified_summary: `This matter concerns ${(qp.issues || ["a legal dispute"]).join(", ")}. The likely timeline and cost depend on document strength.`, family_next_steps: ["Gather documents", "Keep expense records"], ...base };
    case "individual_cost_factor":
      return { cost_drivers: ["Lawyer fees", "Court/process fees", "Documentation effort", "Expert review if needed"], range_reasoning: `Estimated range ${op.cost_range?.join(" - ")} based on risk ${cr.risk_level}`, ...base };
    default:
      return { note: `Unsupported role agent ${agentKey}`, ...base };
  }
}

export function getRoleAgents(role: UserRole) {
  return ROLE_AGENT_KEYS[role] ?? [];
}
