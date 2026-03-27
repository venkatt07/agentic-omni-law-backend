import type { RoleAgentConfig } from "./roleAgentRegistry.js";

function compactRoleQueryParsingHints(queryParsingHints: any) {
  const issueGroups = Array.isArray(queryParsingHints?.issue_groups)
    ? queryParsingHints.issue_groups
        .map((row: any) => String(row?.label || row?.title || "").trim())
        .filter(Boolean)
        .slice(0, 4)
    : [];

  const keyFacts = queryParsingHints?.key_facts && typeof queryParsingHints.key_facts === "object"
    ? queryParsingHints.key_facts
    : {};

  return {
    case_title: String(queryParsingHints?.case_title || "").trim() || null,
    executive_summary: String(queryParsingHints?.executive_summary || queryParsingHints?.summary || "").trim() || null,
    legal_domain:
      String(queryParsingHints?.legal_domain || queryParsingHints?.domain?.primary || queryParsingHints?.domain || "").trim() || null,
    legal_subtype:
      String(queryParsingHints?.legal_subtype || queryParsingHints?.domain?.subtype || "").trim() || null,
    issues: Array.isArray(queryParsingHints?.issues)
      ? queryParsingHints.issues.map((item: any) => String(item || "").trim()).filter(Boolean).slice(0, 6)
      : [],
    legal_grounds: Array.isArray(queryParsingHints?.legal_grounds)
      ? queryParsingHints.legal_grounds.map((item: any) => String(item || "").trim()).filter(Boolean).slice(0, 6)
      : [],
    issue_groups: issueGroups,
    requested_outcomes: Array.isArray(queryParsingHints?.requested_outcomes)
      ? queryParsingHints.requested_outcomes.map((item: any) => String(item || "").trim()).filter(Boolean).slice(0, 4)
      : [],
    key_facts: {
      contract_date: keyFacts?.contract_date || null,
      outstanding_amount_inr: keyFacts?.outstanding_amount_inr ?? null,
      court_name: keyFacts?.court_name || null,
      forum: keyFacts?.forum || null,
      incident_date: keyFacts?.incident_date || null,
    },
  };
}

export function buildRoleAgentPrompt(params: {
  config: RoleAgentConfig;
  caseTitle: string;
  outputLang: string;
  profile: string;
  primaryText: string;
  queryParsingHints: any;
  evidenceSnippets: Array<{ doc_id: string; chunk_id: string; snippet: string; source_type: string }>;
}) {
  const { config, caseTitle, outputLang, profile, primaryText, queryParsingHints, evidenceSnippets } = params;
  const compactHints = compactRoleQueryParsingHints(queryParsingHints || {});
  const primaryCaseTextLimit = evidenceSnippets.length > 0 ? 1200 : 2400;
  const snippetBlock = evidenceSnippets
    .map((s, idx) => `${idx + 1}. [${s.doc_id}${s.chunk_id ? `:${s.chunk_id}` : ""}] ${s.snippet}`)
    .join("\n");

  return `SYSTEM:
You are a legal role assistant for a civil-law workflow.
Rules:
- Use ONLY case workspace evidence as truth.
- Query parsing is hints, never source-of-truth.
- Do NOT use legal corpus, statutes, sections, or fabricated legal citations.
- For every key factual claim include citations from evidence below.
- Citations source_type MUST be \"user_doc\" only.
- Use clear, plain English. Keep sentences short and avoid legal jargon. If a legal term is required, explain it in simple words.
- If evidence is insufficient, set unknown values to null and ask up to 3 clarifying questions.
- Never use placeholder values like "string", "string|null", "undefined", "unknown", or "N/A". Use null or omit the field instead.
- Do NOT use generic workflow filler such as "review the cited evidence", "use the strongest cited excerpts", or "verify parties/dates/amounts" unless tied to a concrete case fact.
- Do NOT write boilerplate summaries; each section must mention concrete facts, events, documents, or chronology from this case.
- Do NOT repeat the same sentence pattern or recycled advice across sections.
- If a section cannot be grounded in actual case facts, reduce analysis_valid and ask a targeted clarifying question instead of bluffing.
- Prefer exact dates, amounts, party names, document names, and event chronology from the evidence rather than paraphrased generic wording.
- Work in this order: identify the strongest case facts -> connect them to the role-specific objective -> write sections that are actionable for this exact case -> leave uncertain points explicit.
- Return strict JSON only (no markdown).

TASK:
${config.prompt_task_block}

CONTEXT:
case_title: ${caseTitle}
output_lang: ${outputLang}
profile: ${profile}
query_parsing_hints: ${JSON.stringify(compactHints, null, 2)}

PRIMARY_CASE_TEXT:
${primaryText.slice(0, primaryCaseTextLimit)}

EVIDENCE_SNIPPETS:
${snippetBlock || "(none)"}

OUTPUT_SCHEMA:
{
  "agent_key": "${config.agent_key}",
  "analysis_valid": true,
  "failure_reason": null,
  "mode": "normal",
  "sections": [{"id":"...","title":"...","content":{}}],
  "citations": [{"citation_id":"C1","source_type":"user_doc","doc_id":"...","chunk_id":"...","snippet":"..."}],
  "clarifying_questions": [],
  "qa_debug": {"profile":"${profile}","output_lang":"${outputLang}"}
}`;
}

export function buildRoleRepairPrompt(agentKey: string, modelText: string, parseError: string) {
  return `Return ONLY valid JSON for agent_key=${agentKey}.\nPrevious output:\n${modelText.slice(0, 4000)}\nValidation error:\n${parseError.slice(0, 1000)}`;
}
