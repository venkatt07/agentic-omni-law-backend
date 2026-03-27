import { z } from "zod";

export const citationSchema = z.object({
  doc_id: z.string(),
  chunk_id: z.string(),
  snippet: z.string(),
  source_type: z.string().optional(),
});

export const confidenceSchema = z.number().min(0).max(1);

export const queryParsingSchema = z.object({
  summary: z.string(),
  executive_summary_text: z.string().optional().default(""),
  jurisdiction_guess: z.string(),
  jurisdiction: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  domain: z.string(),
  legal_domain: z.string().nullable().optional(),
  case_type: z.string().nullable().optional(),
  detected_language: z.union([
    z.string(),
    z.object({
      code: z.string(),
      confidence: z.number().min(0).max(1),
      name: z.string().optional(),
    }),
  ]),
  filters_supported: z.object({
    jurisdiction: z.boolean(),
    legal_domain: z.boolean(),
    date_range: z.boolean(),
    source_types: z.array(z.string()),
  }),
  filters_applied: z.record(z.any()).default({}),
  issues: z.array(z.string()),
  issue_groups: z
    .array(
      z.object({
        title: z.string(),
        description: z.string(),
        priority: z.enum(["high", "medium", "low"]),
      }),
    )
    .optional()
    .default([]),
  entities: z.record(z.any()),
  key_facts: z.record(z.any()).optional().default({}),
  evidence_available: z.array(z.string()).optional().default([]),
  requested_outcomes: z.array(z.string()).optional().default([]),
  suggested_topics: z.array(z.string()),
  missing_information_questions: z.array(z.string()).optional().default([]),
  recommended_next_agents: z
    .object({
      common: z.array(z.string()),
      role_specific: z.array(z.string()),
    })
    .optional()
    .default({ common: [], role_specific: [] }),
  confidence: confidenceSchema,
  confidence_score: z.number().min(0).max(100).optional(),
  citations: z.array(citationSchema),
}).passthrough();

export const termsPoliciesSchema = z.object({
  summary: z.string(),
  applicable_policies: z.array(z.object({ name: z.string(), rationale: z.string() })),
  recommended_terms: z.array(z.object({ title: z.string(), clause_text: z.string() })),
  risk_flags: z.array(z.object({ title: z.string(), description: z.string() })),
  confidence: confidenceSchema,
  citations: z.array(citationSchema),
});

export const contractRiskSchema = z.object({
  risk_level: z.string(),
  flagged_clauses: z.array(z.string()),
  missing_clauses: z.array(z.string()),
  dispute_suggestions: z.array(z.string()),
  confidence: confidenceSchema,
  citations: z.array(citationSchema),
});

export const outcomeProjectionSchema = z.object({
  outcomes: z.object({ win: z.number(), settle: z.number(), lose: z.number() }),
  timeline_range_months: z.tuple([z.number(), z.number()]),
  cost_range: z.tuple([z.number(), z.number()]),
  key_factors: z.array(z.string()),
  deadlines: z.array(z.string()),
  confidence: confidenceSchema,
  citations: z.array(citationSchema),
});

export const policyComplianceSchema = z.object({
  summary: z.string().optional().default(""),
  compliance_score: z.number(),
  violations: z.array(z.string()),
  compliant_areas: z.array(z.string()),
  recommended_actions: z.array(z.string()),
  insufficient_sources: z.boolean().optional().default(false),
  confidence: confidenceSchema,
  citations: z.array(citationSchema),
});

export const legalDraftsSchema = z.object({
  templates_available: z.array(z.string()),
  selected_template: z.string().optional().nullable(),
  draft_text: z.string(),
  validation_checks: z.array(z.string()),
  missing_evidence: z.array(z.string()),
  confidence: confidenceSchema,
  citations: z.array(citationSchema),
});

export const genericModuleSchema = z.object({
  confidence: confidenceSchema.optional().default(0.4),
  citations: z.array(citationSchema).optional().default([]),
}).passthrough();

export const finalSummarySchema = z.object({
  pipeline: z.record(z.any()),
  consolidated_summary: z.string(),
  next_actions: z.array(z.string()),
  confidence: confidenceSchema,
  citations: z.array(citationSchema),
});
