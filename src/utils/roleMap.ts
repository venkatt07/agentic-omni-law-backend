import { UserRole } from "../db/types.js";

export const ROLE_TO_FRONTEND: Record<UserRole, string> = {
  LAWYER: "Lawyer",
  LAW_STUDENT: "Law Student",
  BUSINESS_CORPORATE: "Business/Corporate",
  NORMAL_PERSON: "Normal Person",
};

export const FRONTEND_TO_ROLE: Record<string, UserRole> = {
  Lawyer: UserRole.LAWYER,
  "Law Student": UserRole.LAW_STUDENT,
  "Business/Corporate": UserRole.BUSINESS_CORPORATE,
  Individual: UserRole.NORMAL_PERSON,
  "Normal Person": UserRole.NORMAL_PERSON,
};

export const COMMON_AGENT_KEYS = [
  "query_parsing",
  "contract_risk",
  "outcome_projection",
  "policy_compliance",
  "legal_drafts_validation",
] as const;

export const ROLE_AGENT_KEYS: Record<UserRole, string[]> = {
  LAWYER: ["lawyer_strategy_action_plan", "lawyer_client_communication", "lawyer_court_process_copilot", "lawyer_case_prep", "lawyer_intern_guidance"],
  LAW_STUDENT: ["student_workflow_case_mgmt", "student_concept_learning_books", "student_exam_preparation"],
  BUSINESS_CORPORATE: ["corp_executive_decision_support", "corp_workflow_case_prep", "corp_court_process"],
  NORMAL_PERSON: ["individual_step_by_step_guidance", "individual_family_explain", "individual_cost_factor"],
};

export const ALL_ROLE_AGENT_KEYS = Array.from(
  new Set(Object.values(ROLE_AGENT_KEYS).flat()),
);
