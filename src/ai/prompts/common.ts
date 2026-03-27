export function groundedJsonPrompt(input: {
  moduleKey: string;
  language: string;
  schemaHint: string;
  contextChunks: Array<{ doc_id: string; chunk_id: string; source_type?: string; text?: string; snippet?: string }>;
  queryText?: string;
  filters?: any;
  priorOutputs?: Record<string, any>;
  contextCharBudget?: number;
  queryCharBudget?: number;
  priorCharBudget?: number;
}) {
  const context = input.contextChunks
    .map(
      (c, i) =>
        `[CTX ${i + 1}] doc_id=${c.doc_id} chunk_id=${c.chunk_id} source_type=${c.source_type || "user_doc"}\n${(c.text || c.snippet || "").slice(0, 1200)}`,
    )
    .join("\n\n");
  const compactContext = context.slice(0, input.contextCharBudget || 3200);
  const compactQuery = (input.queryText || "").slice(0, input.queryCharBudget || 900);
  const compactPrior = input.priorOutputs ? JSON.stringify(input.priorOutputs).slice(0, input.priorCharBudget || 1000) : "";
  const reasoningPlan =
    input.moduleKey === "query_parsing"
      ? "Work order: identify concrete facts -> infer domain/jurisdiction conservatively -> group issues -> state only grounded legal grounds -> write a case-specific executive summary."
      : input.moduleKey === "policy_compliance"
        ? "Work order: extract disputed facts -> map each issue to case evidence -> add law only from legal corpus snippets -> propose remediation tied to those facts."
        : input.moduleKey === "outcome_projection"
          ? "Work order: weigh evidence strength and timeline -> compare procedural/commercial risks -> express prediction ranges conservatively -> give fact-specific recommendations."
          : input.moduleKey === "legal_drafts_validation"
            ? "Work order: identify draft purpose -> extract parties/facts/relief from case evidence -> generate case-ready text -> flag missing inputs explicitly."
            : input.moduleKey === "contract_risk"
              ? "Work order: isolate concrete clause language -> explain the exact risk from that clause -> propose negotiation/settlement points tied to the contract text."
              : input.moduleKey === "final_summary"
                ? "Work order: synthesize what each agent established -> keep only grounded conclusions -> surface conflicts/gaps -> end with concrete next actions."
                : "Work order: identify grounded facts first, then produce the requested structured analysis without boilerplate.";
  const moduleDirectives =
    input.moduleKey === "policy_compliance"
      ? "Policy compliance constraints: Do NOT cite any law/statute unless it appears in legal_corpus context snippets. Do NOT hide missing legal-corpus evidence; explicitly state \"No corpus citation found\" and reduce confidence. Do NOT use generic violations/remediation templates; tie each item to the actual dispute facts and evidence."
      : input.moduleKey === "outcome_projection"
        ? "Outcome constraints: Do NOT claim certainty/model accuracy. Do NOT present predictions as facts. Do NOT include similar-case references unless legal_corpus case-law snippets explicitly support them. Do NOT use placeholder recommendations; every recommendation must be fact-specific."
        : input.moduleKey === "query_parsing"
          ? "Query parsing constraints: Do NOT use template/generic summary wording. Do NOT add legal grounds or legal references unless explicitly supported by context snippets."
          : input.moduleKey === "legal_drafts_validation"
            ? "Legal drafts constraints: Do NOT output template instructions, drafting meta-notes, or TODO markers. Draft text must read like a concrete case-ready draft, not a generic form."
          : "";

  return [
    `You are an internal legal analysis engine for module "${input.moduleKey}".`,
    `Return ONLY valid JSON.`,
    `Do NOT use knowledge outside the provided context.`,
    `Do NOT invent legal claims, statutes, dates, amounts, parties, or outcomes.`,
    `Do NOT ignore missing evidence. If evidence is insufficient, output low confidence and an explicit insufficient-sources message.`,
    `Do NOT use boilerplate phrases such as "this appears to be", "the matter appears to involve", or "based on the provided context".`,
    `Every major conclusion must reflect concrete facts that overlap with the user query or context snippets.`,
    `Prefer exact party names, dates, amounts, clause wording, chronology, and document references from the evidence whenever available.`,
    `If a field is unknown, use null or omit the item. Never output placeholder values such as "string", "string|null", "undefined", "unknown", or "N/A".`,
    `For arrays and lists, omit unverifiable entries instead of adding generic filler.`,
    `If you cannot ground a claim in provided facts, mark it as uncertain or omit it.`,
    `Do NOT output prose outside JSON.`,
    reasoningPlan,
    `Output language: ${input.language}.`,
    `Schema requirements: ${input.schemaHint}.`,
    moduleDirectives,
    compactQuery ? `User query/case text summary: ${compactQuery}` : "",
    input.filters ? `Filters: ${JSON.stringify(input.filters)}` : "",
    compactPrior ? `Prior outputs (JSON): ${compactPrior}` : "",
    `Context:\n${compactContext}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function repairJsonPrompt(schemaHint: string, broken: string) {
  return `Fix the following to valid JSON only. Must match schema: ${schemaHint}\n\n${broken}`;
}

export function qualityRepairPrompt(schemaHint: string, weaknesses: string[], currentJson: string) {
  return [
    `Improve the following JSON without changing the schema. Return valid JSON only.`,
    `Schema: ${schemaHint}`,
    `Fix these weaknesses: ${weaknesses.join("; ")}`,
    `Preserve grounded facts and citations. Do not invent new evidence.`,
    currentJson,
  ].join("\n\n");
}
