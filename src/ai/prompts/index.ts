import { groundedJsonPrompt, qualityRepairPrompt, repairJsonPrompt } from "./common.js";

const schemaHints: Record<string, string> = {
  query_parsing:
    "{summary, executive_summary_text, jurisdiction_guess, jurisdiction, state, domain, legal_domain, case_type, detected_language:{code,confidence}, filters_supported, filters_applied, issues[], issue_groups:[{title,description,priority}], key_facts, evidence_available[], requested_outcomes[], entities{}, suggested_topics[], missing_information_questions[], recommended_next_agents:{common[],role_specific[]}, confidence, confidence_score, citations[]}",
  terms_and_policies:
    "{summary, applicable_policies:[{name,rationale}], recommended_terms:[{title,clause_text}], risk_flags:[{title,description}], confidence, citations[]}",
  contract_risk:
    "{risk_level, flagged_clauses[], missing_clauses[], dispute_suggestions[], confidence, citations[]}",
  outcome_projection:
    "{outcomes:{win,settle,lose}, timeline_range_months:[min,max], cost_range:[min,max], key_factors[], deadlines[], confidence, similar_cases?[], citations[]}",
  policy_compliance:
    "{summary, compliance_score, violations[], compliant_areas[], recommended_actions[], insufficient_sources, confidence, citations[]}; cite statutes only when legal_corpus snippets are provided",
  legal_drafts_validation:
    "{templates_available[], selected_template, draft_text, validation_checks[], missing_evidence[], confidence, citations[]}",
  final_summary:
    "{pipeline, consolidated_summary, next_actions[], confidence, citations[]}",
};

export const promptFactory = {
  modulePrompt(moduleKey: string, params: Parameters<typeof groundedJsonPrompt>[0]) {
    return groundedJsonPrompt({
      ...params,
      moduleKey,
      schemaHint: schemaHints[moduleKey] || "{...module specific JSON with confidence and citations[]}",
    });
  },
  repairPrompt(moduleKey: string, broken: string) {
    return repairJsonPrompt(schemaHints[moduleKey] || "valid JSON object", broken);
  },
  qualityRepairPrompt(moduleKey: string, weaknesses: string[], currentJson: string) {
    return qualityRepairPrompt(schemaHints[moduleKey] || "valid JSON object", weaknesses, currentJson);
  },
  schemaHint(moduleKey: string) {
    return schemaHints[moduleKey] || "valid JSON object";
  },
};
