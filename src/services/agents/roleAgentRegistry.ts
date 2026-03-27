import type { UserRole } from "../../db/types.js";

export type RoleAgentKey =
  | "lawyer_strategy_action_plan"
  | "lawyer_client_communication"
  | "lawyer_court_process_copilot"
  | "lawyer_case_prep"
  | "lawyer_intern_guidance"
  | "student_workflow_case_mgmt"
  | "student_concept_learning_books"
  | "student_exam_preparation"
  | "corp_executive_decision_support"
  | "corp_workflow_case_prep"
  | "corp_court_process"
  | "individual_step_by_step_guidance"
  | "individual_family_explain"
  | "individual_cost_factor";

export type RoleAgentConfig = {
  agent_key: RoleAgentKey;
  display_name: string;
  roles_visible: UserRole[];
  agent_kind: "role";
  preloader_steps: string[];
  supports_export_pdf: boolean;
  supports_export_docx: boolean;
  profile_default: string;
  citation_min_required: number;
  allow_legal_corpus: false;
  prompt_task_block: string;
};

const COMMON_STEPS = [
  "Build case chronology",
  "Identify issues and goals",
  "Retrieve evidence snippets",
  "Generate structured output",
  "Validate and save",
];

export const roleAgentRegistry: Record<RoleAgentKey, RoleAgentConfig> = {
  lawyer_strategy_action_plan: {
    agent_key: "lawyer_strategy_action_plan",
    display_name: "Strategy & Action Planning",
    roles_visible: ["LAWYER"],
    agent_kind: "role",
    preloader_steps: COMMON_STEPS,
    supports_export_pdf: true,
    supports_export_docx: false,
    profile_default: "standard",
    citation_min_required: 3,
    allow_legal_corpus: false,
    prompt_task_block: "Generate strategy options, burden map, action timeline (7/14/30), risk matrix, evidence gaps.",
  },
  lawyer_client_communication: {
    agent_key: "lawyer_client_communication",
    display_name: "Client Communication",
    roles_visible: ["LAWYER"],
    agent_kind: "role",
    preloader_steps: COMMON_STEPS,
    supports_export_pdf: true,
    supports_export_docx: false,
    profile_default: "standard",
    citation_min_required: 3,
    allow_legal_corpus: false,
    prompt_task_block: "Generate 2-minute summary, WhatsApp/email templates (neutral/firm/empathetic), intake checklist, FAQs.",
  },
  lawyer_court_process_copilot: {
    agent_key: "lawyer_court_process_copilot",
    display_name: "Court Process Co-pilot",
    roles_visible: ["LAWYER"],
    agent_kind: "role",
    preloader_steps: COMMON_STEPS,
    supports_export_pdf: true,
    supports_export_docx: false,
    profile_default: "standard",
    citation_min_required: 3,
    allow_legal_corpus: false,
    prompt_task_block: "Generate forum options, filing checklist, high-level stage timeline, pitfalls without fabricating court fees.",
  },
  lawyer_case_prep: {
    agent_key: "lawyer_case_prep",
    display_name: "Case Preparation",
    roles_visible: ["LAWYER"],
    agent_kind: "role",
    preloader_steps: COMMON_STEPS,
    supports_export_pdf: true,
    supports_export_docx: false,
    profile_default: "standard",
    citation_min_required: 3,
    allow_legal_corpus: false,
    prompt_task_block: "Generate chronology table, issue-to-exhibit map, witness/exhibit list, prayer/relief options.",
  },
  lawyer_intern_guidance: {
    agent_key: "lawyer_intern_guidance",
    display_name: "Intern Guidance",
    roles_visible: ["LAWYER"],
    agent_kind: "role",
    preloader_steps: COMMON_STEPS,
    supports_export_pdf: true,
    supports_export_docx: false,
    profile_default: "standard",
    citation_min_required: 0,
    allow_legal_corpus: false,
    prompt_task_block: "Generate delegation pack with tasks, research prompts, drafting assignments, QA checklist.",
  },
  student_workflow_case_mgmt: {
    agent_key: "student_workflow_case_mgmt",
    display_name: "Workflow & Case Management",
    roles_visible: ["LAW_STUDENT"],
    agent_kind: "role",
    preloader_steps: COMMON_STEPS,
    supports_export_pdf: true,
    supports_export_docx: false,
    profile_default: "standard",
    citation_min_required: 3,
    allow_legal_corpus: false,
    prompt_task_block: "Generate case brief, study checklist, issue-spotting exercise.",
  },
  student_concept_learning_books: {
    agent_key: "student_concept_learning_books",
    display_name: "Concept Learning (Books)",
    roles_visible: ["LAW_STUDENT"],
    agent_kind: "role",
    preloader_steps: COMMON_STEPS,
    supports_export_pdf: true,
    supports_export_docx: false,
    profile_default: "standard",
    citation_min_required: 3,
    allow_legal_corpus: false,
    prompt_task_block: "Generate concepts map, suggested reading topics, 7-day study plan.",
  },
  student_exam_preparation: {
    agent_key: "student_exam_preparation",
    display_name: "Exam Preparation",
    roles_visible: ["LAW_STUDENT"],
    agent_kind: "role",
    preloader_steps: COMMON_STEPS,
    supports_export_pdf: true,
    supports_export_docx: false,
    profile_default: "standard",
    citation_min_required: 3,
    allow_legal_corpus: false,
    prompt_task_block: "Generate MCQs, short notes, issue-spotting questions grounded in case facts.",
  },
  corp_executive_decision_support: {
    agent_key: "corp_executive_decision_support",
    display_name: "Executive Decision Support",
    roles_visible: ["BUSINESS_CORPORATE"],
    agent_kind: "role",
    preloader_steps: COMMON_STEPS,
    supports_export_pdf: true,
    supports_export_docx: false,
    profile_default: "standard",
    citation_min_required: 3,
    allow_legal_corpus: false,
    prompt_task_block: "Generate executive memo, options with impact, risk register, stakeholder communication points.",
  },
  corp_workflow_case_prep: {
    agent_key: "corp_workflow_case_prep",
    display_name: "Workflow & Case Preparation",
    roles_visible: ["BUSINESS_CORPORATE"],
    agent_kind: "role",
    preloader_steps: COMMON_STEPS,
    supports_export_pdf: true,
    supports_export_docx: false,
    profile_default: "standard",
    citation_min_required: 3,
    allow_legal_corpus: false,
    prompt_task_block: "Generate internal readiness checklist, approvals, negotiation playbook, RACI timeline.",
  },
  corp_court_process: {
    agent_key: "corp_court_process",
    display_name: "Court Process Co-pilot",
    roles_visible: ["BUSINESS_CORPORATE"],
    agent_kind: "role",
    preloader_steps: COMMON_STEPS,
    supports_export_pdf: true,
    supports_export_docx: false,
    profile_default: "standard",
    citation_min_required: 3,
    allow_legal_corpus: false,
    prompt_task_block: "Generate ADR/arbitration/court path summary, evidence preservation steps, counsel briefing outline.",
  },
  individual_step_by_step_guidance: {
    agent_key: "individual_step_by_step_guidance",
    display_name: "Step-by-step Legal Guidance",
    roles_visible: ["NORMAL_PERSON"],
    agent_kind: "role",
    preloader_steps: COMMON_STEPS,
    supports_export_pdf: true,
    supports_export_docx: false,
    profile_default: "standard",
    citation_min_required: 3,
    allow_legal_corpus: false,
    prompt_task_block: "Generate 5-10 plain-language steps, document checklist, short templates, realistic timeline ranges.",
  },
  individual_family_explain: {
    agent_key: "individual_family_explain",
    display_name: "Family Connect & Explain",
    roles_visible: ["NORMAL_PERSON"],
    agent_kind: "role",
    preloader_steps: COMMON_STEPS,
    supports_export_pdf: true,
    supports_export_docx: false,
    profile_default: "standard",
    citation_min_required: 3,
    allow_legal_corpus: false,
    prompt_task_block: "Generate family-friendly explanation, implications, communication dos/donts.",
  },
  individual_cost_factor: {
    agent_key: "individual_cost_factor",
    display_name: "Cost Factor",
    roles_visible: ["NORMAL_PERSON"],
    agent_kind: "role",
    preloader_steps: COMMON_STEPS,
    supports_export_pdf: true,
    supports_export_docx: false,
    profile_default: "standard",
    citation_min_required: 3,
    allow_legal_corpus: false,
    prompt_task_block: "Generate cost/time ranges with assumptions, drivers, and optimization suggestions.",
  },
};

export const roleAgentKeys = Object.keys(roleAgentRegistry) as RoleAgentKey[];

export function getRoleAgentConfig(agentKey: string): RoleAgentConfig | null {
  return (roleAgentRegistry as Record<string, RoleAgentConfig>)[agentKey] || null;
}
