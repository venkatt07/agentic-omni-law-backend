import { z } from "zod";
import type { RoleAgentKey } from "./roleAgentRegistry.js";

export const roleAgentCitationSchema = z.object({
  citation_id: z.string().min(1),
  source_type: z.literal("user_doc"),
  source_label: z.string().optional(),
  doc_id: z.string().min(1),
  chunk_id: z.string().optional(),
  snippet: z.string().min(8).max(500),
});

const sectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  content: z.any(),
});

const roleOutputBase = z.object({
  agent_key: z.string().min(1),
  analysis_valid: z.boolean(),
  failure_reason: z.string().nullable().optional(),
  mode: z.enum(["normal", "fallback"]),
  sections: z.array(sectionSchema).min(1),
  citations: z.array(roleAgentCitationSchema).default([]),
  clarifying_questions: z.array(z.string().min(1)).max(3).default([]),
  qa_debug: z.record(z.any()).optional(),
});

function keyedSchema(agentKey: RoleAgentKey, minSections: number) {
  return roleOutputBase.extend({
    agent_key: z.literal(agentKey),
    sections: z.array(sectionSchema).min(minSections),
  });
}

export const roleAgentOutputSchemas = {
  lawyer_strategy_action_plan: keyedSchema("lawyer_strategy_action_plan", 5),
  lawyer_client_communication: keyedSchema("lawyer_client_communication", 4),
  lawyer_court_process_copilot: keyedSchema("lawyer_court_process_copilot", 4),
  lawyer_case_prep: keyedSchema("lawyer_case_prep", 4),
  lawyer_intern_guidance: keyedSchema("lawyer_intern_guidance", 4),
  student_workflow_case_mgmt: keyedSchema("student_workflow_case_mgmt", 3),
  student_concept_learning_books: keyedSchema("student_concept_learning_books", 3),
  student_exam_preparation: keyedSchema("student_exam_preparation", 3),
  corp_executive_decision_support: keyedSchema("corp_executive_decision_support", 4),
  corp_workflow_case_prep: keyedSchema("corp_workflow_case_prep", 4),
  corp_court_process: keyedSchema("corp_court_process", 3),
  individual_step_by_step_guidance: keyedSchema("individual_step_by_step_guidance", 4),
  individual_family_explain: keyedSchema("individual_family_explain", 3),
  individual_cost_factor: keyedSchema("individual_cost_factor", 4),
} as const;

export function parseRoleOutput(agentKey: RoleAgentKey, payload: unknown) {
  const schema = roleAgentOutputSchemas[agentKey];
  return schema.parse(payload);
}

export type RoleAgentOutput = z.infer<typeof roleOutputBase>;
