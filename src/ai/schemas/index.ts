import type { ZodTypeAny } from "zod";
import {
  contractRiskSchema,
  finalSummarySchema,
  genericModuleSchema,
  legalDraftsSchema,
  outcomeProjectionSchema,
  policyComplianceSchema,
  queryParsingSchema,
  termsPoliciesSchema,
} from "./common.js";

const map: Record<string, ZodTypeAny> = {
  query_parsing: queryParsingSchema,
  terms_and_policies: termsPoliciesSchema,
  contract_risk: contractRiskSchema,
  outcome_projection: outcomeProjectionSchema,
  policy_compliance: policyComplianceSchema,
  legal_drafts_validation: legalDraftsSchema,
  final_summary: finalSummarySchema,
};

export const schemaRegistry = {
  get(moduleKey: string) {
    return map[moduleKey] || genericModuleSchema;
  },
};

