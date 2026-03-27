export function buildFinalSummary(input: {
  common: Record<string, any>;
  roleOutputs: Record<string, any>;
}) {
  const citationByAgent = [
    ...(input.common.query_parsing?.citations?.slice(0, 1) || []),
    ...(input.common.contract_risk?.citations?.slice(0, 2) || []),
    ...(input.common.outcome_projection?.citations?.slice(0, 1) || []),
    ...(input.common.policy_compliance?.citations?.slice(0, 1) || []),
    ...Object.values(input.roleOutputs || {}).flatMap((payload: any) => (Array.isArray(payload?.citations) ? payload.citations.slice(0, 1) : [])),
  ];
  const citations = citationByAgent.filter((citation: any, index: number, arr: any[]) => {
    const key = `${citation?.source_type || "user_doc"}:${citation?.doc_id || ""}:${citation?.chunk_id || ""}:${String(citation?.snippet || "").toLowerCase().slice(0, 120)}`;
    return key !== "user_doc:::" && arr.findIndex((item: any) => `${item?.source_type || "user_doc"}:${item?.doc_id || ""}:${item?.chunk_id || ""}:${String(item?.snippet || "").toLowerCase().slice(0, 120)}` === key) === index;
  }).slice(0, 6);

  const issues = input.common.query_parsing?.issues || [];
  const risk = input.common.contract_risk?.risk_level || "Unknown";
  const outcomes = input.common.outcome_projection?.outcomes || {};

  return {
    pipeline: {
      common_agents: Object.keys(input.common),
      role_agents: Object.keys(input.roleOutputs),
    },
    consolidated_summary: `Case analysis completed across common and role-specific modules. Key issues: ${issues.join(", ") || "n/a"}. Risk level assessed as ${risk}.`,
    next_actions: [
      "Review query parsing and risk outputs first",
      "Validate evidence gaps before acting on drafts",
      "Use role-specific guidance for execution planning",
    ],
    confidence: 0.72,
    outcomes_snapshot: outcomes,
    citations,
  };
}
