import { getEnv } from "../config/env.js";
import { isLlmContextOverflowError, llmClient } from "./llmClient.js";
import { promptFactory } from "./prompts/index.js";
import { schemaRegistry } from "./schemas/index.js";
import { translatorService } from "../services/translator.service.js";
import { hashKey, readJsonCache, runtimeMetrics, writeJsonCache } from "./runtimeMetrics.js";
import { getGenerationProfile } from "./generationProfiles.js";

type ContextChunk = { doc_id: string; chunk_id: string; snippet: string; text?: string; source_type?: string };
const QUERY_PARSING_CACHE_VERSION = 7;
const ENABLE_QUERY_PARSING_GENERATION_CACHE = false;

function citationTermsForModule(moduleKey: string, payload: any) {
  if (moduleKey === "contract_risk") {
    return [
      ...(Array.isArray(payload?.flagged_clauses) ? payload.flagged_clauses : []),
      ...(Array.isArray(payload?.missing_clauses) ? payload.missing_clauses : []),
      ...(Array.isArray(payload?.dispute_suggestions) ? payload.dispute_suggestions : []),
    ];
  }
  if (moduleKey === "outcome_projection") {
    return [
      ...(Array.isArray(payload?.key_factors) ? payload.key_factors : []),
      ...(Array.isArray(payload?.deadlines) ? payload.deadlines : []),
    ];
  }
  if (moduleKey === "policy_compliance") {
    return [
      ...(Array.isArray(payload?.violations) ? payload.violations : []),
      ...(Array.isArray(payload?.recommended_actions) ? payload.recommended_actions : []),
      ...(Array.isArray(payload?.compliant_areas) ? payload.compliant_areas : []),
    ];
  }
  if (moduleKey === "legal_drafts_validation") {
    return [
      String(payload?.selected_template || ""),
      ...(Array.isArray(payload?.validation_checks) ? payload.validation_checks : []),
      ...(Array.isArray(payload?.missing_evidence) ? payload.missing_evidence : []),
    ];
  }
  if (moduleKey === "final_summary") {
    return [
      String(payload?.consolidated_summary || ""),
      ...(Array.isArray(payload?.next_actions) ? payload.next_actions : []),
    ];
  }
  return [];
}

function reconcileModuleCitations(moduleKey: string, payload: any, contextChunks: ContextChunk[], queryText: string) {
  const existing = Array.isArray(payload?.citations) ? payload.citations : [];
  const terms = new Set(
    normalizePackTokens([
      queryText,
      ...citationTermsForModule(moduleKey, payload),
    ].join(" ")),
  );
  const rankedContext = [...(contextChunks || [])]
    .map((chunk) => {
      const snippet = String(chunk?.snippet || chunk?.text || "").replace(/\s+/g, " ").trim();
      const lower = snippet.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (lower.includes(term)) score += 3;
      }
      if (String(chunk?.source_type || "").toLowerCase() === "legal_corpus" && (moduleKey === "policy_compliance" || moduleKey === "outcome_projection" || moduleKey === "final_summary")) {
        score += 2;
      }
      if (String(chunk?.source_type || "").toLowerCase() === "user_doc") score += 1;
      return {
        doc_id: chunk.doc_id,
        chunk_id: chunk.chunk_id,
        snippet,
        source_type: chunk.source_type || "user_doc",
        score,
      };
    })
    .filter((item) => item.snippet)
    .sort((a, b) => b.score - a.score);
  const merged = [
    ...existing.map((citation: any) => ({
      doc_id: String(citation?.doc_id || ""),
      chunk_id: String(citation?.chunk_id || ""),
      snippet: String(citation?.snippet || "").replace(/\s+/g, " ").trim(),
      source_type: String(citation?.source_type || "user_doc"),
      score: 2,
    })),
    ...rankedContext,
  ];
  const out: any[] = [];
  const seen = new Set<string>();
  const target = moduleKey === "final_summary" ? 5 : 4;
  for (const item of merged) {
    const key = `${item.source_type}:${item.doc_id}:${item.chunk_id}:${item.snippet.toLowerCase().slice(0, 120)}`;
    if (!item.snippet || seen.has(key)) continue;
    seen.add(key);
    out.push({
      doc_id: item.doc_id,
      chunk_id: item.chunk_id,
      snippet: item.snippet,
      source_type: item.source_type,
    });
    if (out.length >= target) break;
  }
  if (out.length) {
    payload.citations = out;
  }
  return payload;
}

function normalizePackTokens(text: string) {
  const stop = new Set(["the", "and", "for", "with", "from", "this", "that", "case", "legal", "query", "analysis", "under", "into", "over"]);
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 4 && !stop.has(x));
}

function scoreChunkForPacking(chunk: ContextChunk, supportTokens: Set<string>, moduleKey: string) {
  const raw = String(chunk.snippet || chunk.text || "").replace(/\s+/g, " ").trim().toLowerCase();
  const tokens = normalizePackTokens(raw);
  let overlap = 0;
  for (const token of tokens) {
    if (supportTokens.has(token)) overlap += 1;
  }
  let score = overlap * 3;
  if (String(chunk.source_type || "user_doc") === "user_doc") score += 2;
  if ((moduleKey === "policy_compliance" || moduleKey === "outcome_projection" || moduleKey === "final_summary") && String(chunk.source_type || "") === "legal_corpus") score += 2;
  if (/\b(invoice|payment|notice|termination|agreement|arbitration|damages|delay|breach|liability|jurisdiction)\b/i.test(raw)) score += 1.5;
  return score;
}

function packContextChunks(moduleKey: string, queryText: string, chunks: ContextChunk[], variant: "full" | "compact", tier: "preview" | "final") {
  const profile = getGenerationProfile(moduleKey, tier);
  const charBudget = variant === "compact" ? profile.compactContextCharBudget : profile.contextCharBudget;
  const maxChunks = variant === "compact" ? profile.compactMaxChunks : profile.maxChunks;
  const perChunkChars = variant === "compact" ? profile.compactPerChunkChars : profile.perChunkChars;
  const supportTokens = new Set(normalizePackTokens(queryText));
  const dedup = new Map<string, ContextChunk>();
  for (const chunk of chunks) {
    const raw = String(chunk.snippet || chunk.text || "").replace(/\s+/g, " ").trim();
    if (!raw) continue;
    const key = `${chunk.doc_id}:${chunk.chunk_id}:${raw.toLowerCase().slice(0, 80)}`;
    if (!dedup.has(key)) dedup.set(key, chunk);
  }
  const ranked = [...dedup.values()]
    .map((chunk) => ({ chunk, score: scoreChunkForPacking(chunk, supportTokens, moduleKey) }))
    .sort((a, b) => b.score - a.score);
  const picked: ContextChunk[] = [];
  const seenDocs = new Set<string>();
  let used = 0;
  for (const entry of ranked) {
    const source = entry.chunk.source_type || "user_doc";
    const raw = String(entry.chunk.snippet || entry.chunk.text || "").replace(/\s+/g, " ").trim();
    const docBonus = seenDocs.has(entry.chunk.doc_id) ? 0 : 1;
    const prefix = `[${String(source).toUpperCase()} ${entry.chunk.doc_id}:${entry.chunk.chunk_id}] `;
    const snippet = `${prefix}${raw.slice(0, perChunkChars)}`;
    const projected = used + snippet.length + docBonus * 10;
    if (picked.length >= maxChunks || projected > charBudget) continue;
    picked.push({ ...entry.chunk, snippet, text: undefined });
    used = projected;
    seenDocs.add(entry.chunk.doc_id);
  }
  if (!picked.length) {
    return chunks.slice(0, Math.max(1, maxChunks)).map((chunk) => ({
      ...chunk,
      snippet: String(chunk.snippet || chunk.text || "").replace(/\s+/g, " ").trim().slice(0, perChunkChars),
      text: undefined,
    }));
  }
  return picked;
}

function slimPriorOutputs(priorOutputs: Record<string, any> | undefined) {
  if (!priorOutputs || typeof priorOutputs !== "object") return undefined;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(priorOutputs).slice(0, 6)) {
    if (!v || typeof v !== "object") continue;
    out[k] = {
      summary: typeof (v as any).summary === "string" ? (v as any).summary.slice(0, 220) : undefined,
      executive_summary_text:
        typeof (v as any).executive_summary_text === "string" ? (v as any).executive_summary_text.slice(0, 220) : undefined,
      domain: (v as any).domain ?? (v as any).legal_domain ?? undefined,
      issues: Array.isArray((v as any).issues) ? (v as any).issues.slice(0, 6) : undefined,
      risk_level: (v as any).risk_level ?? undefined,
      confidence: typeof (v as any).confidence === "number" ? (v as any).confidence : undefined,
    };
  }
  return out;
}

function collectQualityWeaknesses(moduleKey: string, payload: any) {
  const weaknesses: string[] = [];
  const citations = Array.isArray(payload?.citations) ? payload.citations.filter((c: any) => String(c?.snippet || "").trim()) : [];
  if (citations.length < 3) weaknesses.push("add at least 3 grounded citations when the evidence permits");
  if (moduleKey === "terms_and_policies") {
    if (!Array.isArray(payload?.applicable_policies) || payload.applicable_policies.length < 2) weaknesses.push("identify at least 2 fact-specific policies or clause themes");
    if (!Array.isArray(payload?.risk_flags) || payload.risk_flags.length < 2) weaknesses.push("expand risk flags with concrete dispute facts");
  }
  if (moduleKey === "outcome_projection") {
    if (!Array.isArray(payload?.key_factors) || payload.key_factors.length < 3) weaknesses.push("expand key_factors using concrete evidence and chronology");
    if (!Array.isArray(payload?.deadlines) || payload.deadlines.length < 2) weaknesses.push("surface concrete deadlines or timing considerations");
  }
  if (moduleKey === "policy_compliance") {
    if (!Array.isArray(payload?.violations) || payload.violations.length < 2) weaknesses.push("expand violations using case-specific facts and evidence");
    if (!Array.isArray(payload?.recommended_actions) || payload.recommended_actions.length < 2) weaknesses.push("make recommended actions more concrete and evidence-linked");
  }
  if (moduleKey === "legal_drafts_validation") {
    if (String(payload?.draft_text || "").trim().length < 320) weaknesses.push("expand draft_text into a concrete case-ready draft");
    if (!Array.isArray(payload?.validation_checks) || payload.validation_checks.length < 2) weaknesses.push("add more draft validation checks tied to missing evidence");
  }
  if (moduleKey === "final_summary") {
    if (String(payload?.consolidated_summary || "").trim().length < 260) weaknesses.push("expand the summary with concrete agent findings and next actions");
    if (!Array.isArray(payload?.next_actions) || payload.next_actions.length < 3) weaknesses.push("provide clearer next actions");
  }
  return weaknesses;
}

function stripMarkdownFences(text: string) {
  return String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/```json/gi, "```")
    .replace(/```/g, "")
    .trim();
}

function extractBalancedJson(text: string) {
  const src = String(text || "");
  let start = -1;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "{" || ch === "[") {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const opening = src[start];
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === opening) depth += 1;
    else if (ch === closing) {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function parseJsonLoose(text: string) {
  const normalized = stripMarkdownFences(text);
  const balanced = extractBalancedJson(normalized);
  const candidates = [
    normalized,
    balanced || "",
    normalized.replace(/,\s*([}\]])/g, "$1"),
    (balanced || "").replace(/,\s*([}\]])/g, "$1"),
  ].filter(Boolean);
  let lastError: any = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("Invalid JSON response from model");
}

function stableStringify(value: any) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function stripToSingleLine(text: string) {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeSupportTokens(text: string) {
  const stop = new Set([
    "the", "and", "for", "with", "from", "this", "that", "into", "where", "when", "have", "has", "had", "been",
    "user", "case", "legal", "query", "parsing", "analysis", "india", "state", "domain", "facts", "seeks", "seek",
    "including", "context", "present", "provided", "document", "documents",
  ]);
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 4 && !stop.has(x)),
  );
}

function hasSupportOverlap(text: string, supportTokens: Set<string>) {
  if (!text || !supportTokens.size) return false;
  const itemTokens = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 4);
  return itemTokens.some((t) => supportTokens.has(t));
}

function cleanQuerySummary(summary: string) {
  return String(summary || "")
    .replace(/\bthe user is seeking seek\b/gi, "the user is seeking")
    .replace(/\bcivil-litigation\/finance dispute context is connected to\b/gi, "The dispute is connected to")
    .replace(/\bdispute context is connected to\b/gi, "The dispute is connected to")
    .replace(/\b[a-z /-]+ dispute context is connected to\b/gi, "The dispute concerns")
    .replace(/\bkey facts indicate\b/gi, "Key facts include")
    .replace(/\bkey facts include facts from the submitted inputs\b/gi, "The available facts come from the submitted inputs")
    .replace(/\bfacts from the submitted inputs\b/gi, "the submitted facts")
    .replace(/\band the query has been structured into issue groups and evidence signals for the next modules\b/gi, "")
    .replace(/\bconnected to india\b/gi, "connected to India")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function isGenericQuerySummary(summary: string) {
  const text = String(summary || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return true;
  return [
    "dispute context is connected to",
    "connected to india",
    "key facts indicate facts from the submitted inputs",
    "query has been structured into issue groups",
    "the user seeks clarification of legal options",
  ].some((pattern) => text.includes(pattern));
}

function isPromptEchoSummary(summary: string, queryText: string) {
  const summaryText = String(summary || "").toLowerCase().replace(/\s+/g, " ").trim();
  const query = String(queryText || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!summaryText || !query) return false;
  const queryLead = query.split(" ").slice(0, 12).join(" ");
  if (queryLead && summaryText.includes(queryLead)) return true;
  const promptishSignals = [
    "perform a complete legal analysis",
    "identify the parties",
    "identify the underlying transaction",
    "state what should be prepared next",
    "clearly separate what is supported",
  ];
  return promptishSignals.some((phrase) => summaryText.includes(phrase));
}

function sanitizeQueryParsingPayloadByEvidence(
  mergedPayload: any,
  basePayload: any,
  queryText: string,
  contextChunks: ContextChunk[],
) {
  const supportText = [
    String(queryText || ""),
    ...(contextChunks || []).map((c) => String(c?.snippet || c?.text || "")),
    ...(Array.isArray(mergedPayload?.citations) ? mergedPayload.citations.map((c: any) => String(c?.snippet || "")) : []),
  ].join(" ");
  const supportTokens = normalizeSupportTokens(supportText);
  const next = { ...mergedPayload };

  const cleanedSummary = cleanQuerySummary(String(next?.executive_summary_text || next?.executive_summary || next?.summary || ""));
  if (cleanedSummary) {
    next.executive_summary = cleanedSummary;
    next.executive_summary_text = cleanedSummary;
    next.summary = cleanedSummary;
  }

  const mergedGrounds = Array.isArray(next?.legal_grounds) ? next.legal_grounds : [];
  const filteredGrounds = mergedGrounds
    .map((g: any) => String(g || "").trim().toLowerCase())
    .filter(Boolean)
    .filter((g: string) => hasSupportOverlap(g, supportTokens))
    .slice(0, 6);
  const baseGrounds = Array.isArray(basePayload?.legal_grounds)
    ? basePayload.legal_grounds.map((g: any) => String(g || "").trim().toLowerCase()).filter(Boolean).slice(0, 6)
    : [];
  next.legal_grounds = filteredGrounds.length >= 2 ? [...new Set(filteredGrounds)] : [...new Set(baseGrounds)];

  const mergedIssueGroups = Array.isArray(next?.issue_groups) ? next.issue_groups : [];
  const filteredIssueGroups = mergedIssueGroups
    .filter((g: any) => {
      const title = String(g?.title || g?.label || "").trim();
      return title && hasSupportOverlap(title, supportTokens);
    })
    .slice(0, 6);
  next.issue_groups = filteredIssueGroups.length > 0
    ? filteredIssueGroups
    : (Array.isArray(basePayload?.issue_groups) ? basePayload.issue_groups : []);

  return next;
}

function mergeLlMTextIntoFallback(moduleKey: string, raw: string, fallback: any) {
  const cleaned = stripToSingleLine(raw).slice(0, 1200);
  if (!cleaned) return fallback;
  const next = { ...fallback };
  const candidate =
    cleaned
      .replace(/^(\{|\[).*(\}|\])$/s, "")
      .replace(/^json\s*[:\-]?\s*/i, "")
      .trim() || cleaned;

  const preferKeys = [
    "summary",
    "consolidated_summary",
    "explanation",
    "exec_memo",
    "draft_text",
    "simplified_summary",
    "script",
    "note",
  ];
  let applied = false;
  for (const key of preferKeys) {
    if (typeof next[key] === "string") {
      next[key] = `${next[key]} | ${candidate}`.slice(0, 2000);
      applied = true;
      break;
    }
  }
  if (!applied) {
    if (moduleKey === "final_summary" && typeof next.consolidated_summary === "string") {
      next.consolidated_summary = `${next.consolidated_summary} | ${candidate}`.slice(0, 2000);
    } else {
      next.summary = typeof next.summary === "string" ? `${next.summary} | ${candidate}`.slice(0, 2000) : candidate;
    }
  }
  next.rag_llm_assisted = true;
  return next;
}

function ensureCitationRules(moduleKey: string, payload: any) {
  const requiresLaw = moduleKey === "policy_compliance";
  const citations = Array.isArray(payload?.citations) ? payload.citations : [];
  const hasLawCitation = citations.some((c: any) => c?.source_type && c.source_type !== "user_doc");
  if (requiresLaw && (!citations.length || !hasLawCitation)) {
    payload.insufficient_sources = true;
    payload.summary = payload.summary || "Insufficient sources for grounded legal compliance analysis.";
    payload.recommended_actions = Array.isArray(payload.recommended_actions)
      ? payload.recommended_actions
      : ["Add legal corpus materials or relevant statutes and rerun analysis."];
    payload.confidence = Math.min(Number(payload.confidence || 0.2), 0.35);
    if (!hasLawCitation) {
      payload.summary = "Insufficient sources: legal corpus citations are required for grounded compliance analysis.";
    }
  }
  return payload;
}

function isInsufficientQueryParsingPayload(payload: any) {
  const text = String(payload?.executive_summary_text || payload?.summary || "").toLowerCase();
  return /insufficient facts|no text|too short|non-case input/.test(text);
}

function shouldSkipQueryParsingPolish(base: any) {
  // Query Parsing now always attempts a fast LLM refinement pass (unless insufficient input or cache hit),
  // so legal grounds/summary/classification can be improved beyond deterministic rules.
  return false;
}

function buildQueryParsingPolishPrompt(input: {
  language: string;
  queryText: string;
  base: any;
  contextChunks: ContextChunk[];
}) {
  const snippets = (input.contextChunks || [])
    .slice(0, 4)
    .map((c, i) => `[${i + 1}] (${c.source_type || "user_doc"}) ${String(c.snippet || "").slice(0, 140)}`)
    .join("\n");

  return [
    "Polish a legal query-parsing result.",
    "Return JSON only.",
    "Do NOT use any facts outside USER_QUERY_TEXT and CONTEXT_SNIPPETS.",
    "Do NOT invent statutes, legal provisions, parties, dates, amounts, locations, remedies, or citations.",
    "Do NOT use generic boilerplate openings such as 'This appears to be', 'The matter appears to involve', or other template phrasing.",
    "Do NOT repeat the same narrative theme across cases. Write a case-specific summary using concrete facts from this input only.",
    "Do NOT mention 'query parsing', 'case materials', or internal pipeline/process language in the executive summary.",
    "The executive summary must start with the concrete dispute or transaction, not with jurisdiction or domain labels.",
    "Use at least two concrete, case-specific facts when available: such as amount, contract/agreement, payment default, notice, delivery/performance issue, timeline, product, property, employment action, or family relationship detail.",
    "Avoid generic lines like 'context is connected to India', 'key facts indicate facts from the submitted inputs', or 'the user seeks clarification of legal options'.",
    "If the input is sparse, say what is missing specifically instead of using generic placeholders.",
    "Do NOT mention domestic violence, maintenance, dowry, divorce, succession/partition, or family disputes unless the provided text explicitly contains those topics.",
    "Do NOT add irrelevant legal grounds (for example invoice recovery) unless the provided text supports those facts.",
    "Do NOT return fewer than 3 citations in the final result (the system will validate grounding).",
    "Do NOT claim multiple source types unless they actually exist in the provided evidence.",
    "Do NOT change citations in this polish pass.",
    "For legal_research_authorities: prefer authorities that are grounded in legal corpus snippets when available; otherwise infer the most likely relevant Indian laws/case-law from facts.",
    "Do NOT invent fake law names. If uncertain about section/provision, keep section as null.",
    "Do NOT output explanatory prose, markdown, or code fences.",
    `Target language for narrative: ${input.language}`,
    "Do NOT change case_title or classification unless clearly supported by the provided evidence.",
    "Do NOT present uncertain facts as certain; keep cautious wording when evidence is incomplete.",
    "",
    `USER_QUERY_TEXT:\n${String(input.queryText || "(empty)").slice(0, 900)}`,
    "",
    `CONTEXT_SNIPPETS:\n${snippets || "(none)"}`,
    "",
    `CURRENT_PARSED_FIELDS:\n${JSON.stringify({
      jurisdiction: input.base?.jurisdiction ?? null,
      jurisdiction_v2: (input.base?.jurisdiction && typeof input.base.jurisdiction === "object") ? input.base.jurisdiction : null,
      state: input.base?.state ?? null,
      legal_domain: input.base?.legal_domain ?? input.base?.domain ?? null,
      domain_v2: (input.base?.domain && typeof input.base.domain === "object") ? input.base.domain : null,
      case_title: input.base?.case_title ?? null,
      case_type: input.base?.case_type ?? null,
      key_facts: input.base?.key_facts ?? {},
      requested_outcomes: input.base?.requested_outcomes ?? [],
      legal_subtype: input.base?.legal_subtype ?? null,
      legal_grounds: Array.isArray(input.base?.legal_grounds) ? input.base.legal_grounds.slice(0, 4) : [],
      legal_research_authorities: Array.isArray(input.base?.legal_research_authorities)
        ? input.base.legal_research_authorities.slice(0, 4)
        : [],
      issue_groups: Array.isArray(input.base?.issue_groups) ? input.base.issue_groups.slice(0, 4) : [],
      detected_language: input.base?.detected_language ?? null,
      filters_applied: input.base?.filters_applied ?? {},
    }).slice(0, 1800)}`,
    "",
    "Schema:",
    '{"case_title":"6-10 words Title Case (optional)","executive_summary":"2-4 sentences","executive_summary_text":"2-4 sentences (optional legacy alias)","domain":{"primary":"...","subtype":"...|unknown","confidence":0-1},"legal_domain":"...|null","legal_subtype":"...|null","jurisdiction":{"country":"India|Unknown","confidence":0-1,"reason":"..."},"case_type":"...|null","legal_grounds":["..."],"legal_research_authorities":[{"title":"...","section":"...|null","authority_type":"act|case_law|regulation|legal_opinion","relevance":"...","confidence":0-1}],"issue_groups":[{"label":"...","confidence":0-1}] OR [{"title":"...","description":"...","priority":"high|medium|low"}],"confidence_score":0-100}',
  ].join("\n");
}

async function generateTextWithOverflowRetry(
  prompt: string,
  options: { temperature?: number; max_tokens?: number; timeoutMs?: number; top_p?: number; tier?: "preview" | "final"; signal?: AbortSignal },
  compactPromptBuilder?: () => string,
) {
  try {
    return await llmClient.generateText(prompt, options);
  } catch (error) {
    if (!compactPromptBuilder || !isLlmContextOverflowError(error)) throw error;
    const compactPrompt = compactPromptBuilder();
    return await llmClient.generateText(compactPrompt, {
      ...options,
      timeoutMs: Math.min(options.timeoutMs ?? 25_000, 12_000),
      max_tokens: Math.min(options.max_tokens ?? 256, 180),
    });
  }
}

function mergeQueryParsingPolish(base: any, polish: any, queryText: string) {
  const merged = { ...base };
  if (typeof polish?.case_title === "string" && polish.case_title.trim().length >= 6) {
    merged.case_title = polish.case_title.trim().slice(0, 120);
  }
  const polishedSummary =
    (typeof polish?.executive_summary === "string" && polish.executive_summary.trim()) ||
    (typeof polish?.executive_summary_text === "string" && polish.executive_summary_text.trim()) ||
    "";
  if (polishedSummary && polishedSummary.length > 40 && !isGenericQuerySummary(polishedSummary) && !isPromptEchoSummary(polishedSummary, queryText)) {
    merged.executive_summary = polishedSummary;
    merged.executive_summary_text = polishedSummary;
    merged.summary = polishedSummary;
  }
  if (polish?.jurisdiction && typeof polish.jurisdiction === "object" && !Array.isArray(polish.jurisdiction)) {
    const country = String(polish.jurisdiction.country || "").trim();
    if (country) {
      merged.jurisdiction = {
        country: country === "India" ? "India" : "Unknown",
        confidence: Math.max(0, Math.min(1, Number(polish.jurisdiction.confidence ?? 0.5))),
        reason: String(polish.jurisdiction.reason || "Refined from provided inputs.").trim().slice(0, 220),
      };
      merged.jurisdiction_guess = merged.jurisdiction.country;
    }
  }
  if (Array.isArray(polish?.issue_groups) && polish.issue_groups.length > 0) {
    if (typeof polish.issue_groups[0]?.label === "string") {
      merged.issue_groups = polish.issue_groups
        .filter((g: any) => g && typeof g.label === "string")
        .slice(0, 6)
        .map((g: any) => ({
          title: String(g.label).trim().slice(0, 120),
          description: "",
          priority: Number(g.confidence || 0) >= 0.8 ? "high" : Number(g.confidence || 0) >= 0.6 ? "medium" : "low",
        }));
    } else {
      merged.issue_groups = polish.issue_groups
        .filter((g: any) => g && typeof g.title === "string")
        .slice(0, 6)
        .map((g: any) => ({
          title: String(g.title).trim().slice(0, 120),
          description: typeof g.description === "string" ? g.description.trim().slice(0, 320) : "",
          priority: g.priority === "high" || g.priority === "medium" || g.priority === "low" ? g.priority : "medium",
        }));
    }
  }
  if (typeof polish?.confidence_score === "number" && Number.isFinite(polish.confidence_score)) {
    const score = Math.max(1, Math.min(99, Math.round(polish.confidence_score)));
    merged.confidence_score = score;
    merged.confidence = Number((score / 100).toFixed(2));
  }
  const currentDomain = String(merged.legal_domain || merged.domain || "");
  const proposedDomain = typeof polish?.legal_domain === "string"
    ? polish.legal_domain.trim()
    : (typeof polish?.domain === "string" ? polish.domain.trim() : (typeof polish?.domain?.primary === "string" ? polish.domain.primary.trim() : ""));
  if (proposedDomain && proposedDomain.length <= 80) {
    const allow = [
      "Consumer / Service Dispute",
      "Corporate / Contract",
      "Employment",
      "Property / Family",
      "Criminal",
      "Constitutional / Public Law",
      "Civil Litigation / Finance",
      "General",
      "Commercial Contract / Supply",
    ];
    if (allow.some((x) => x.toLowerCase() === proposedDomain.toLowerCase())) {
      const normalized = allow.find((x) => x.toLowerCase() === proposedDomain.toLowerCase()) || proposedDomain;
      // Do not downgrade a specific deterministic domain to General.
      if (!(currentDomain && currentDomain.toLowerCase() !== "general" && normalized.toLowerCase() === "general")) {
        merged.domain = normalized;
        merged.legal_domain = normalized;
        if (merged.domain && typeof merged.domain === "object") {
          merged.domain.primary = normalized;
        }
      }
    }
  }
  if (polish?.domain && typeof polish.domain === "object" && !Array.isArray(polish.domain)) {
    const subtypeObj = typeof polish.domain.subtype === "string" ? polish.domain.subtype.trim() : "";
    if (subtypeObj && /^[a-z0-9_/-]+$/i.test(subtypeObj)) {
      merged.legal_subtype = subtypeObj;
      if (merged.domain && typeof merged.domain === "object") merged.domain.subtype = subtypeObj;
    }
    if (typeof polish.domain.confidence === "number" && Number.isFinite(polish.domain.confidence) && merged.domain && typeof merged.domain === "object") {
      merged.domain.confidence = Math.max(0, Math.min(1, polish.domain.confidence));
    }
  }
  if (typeof polish?.legal_subtype === "string" || polish?.legal_subtype === null) {
    const subtype = polish.legal_subtype == null ? null : String(polish.legal_subtype).trim().slice(0, 80);
    if (!subtype || /^[a-z0-9_/-]+$/i.test(subtype)) merged.legal_subtype = subtype || null;
  }
  if (typeof polish?.case_type === "string" || polish?.case_type === null) {
    const caseType = polish.case_type == null ? null : String(polish.case_type).trim().slice(0, 80);
    if (!caseType || /^[a-z0-9_/-]+$/i.test(caseType)) merged.case_type = caseType || merged.case_type || null;
  }
  if (Array.isArray(polish?.legal_grounds) && polish.legal_grounds.length > 0) {
    const grounds = polish.legal_grounds
      .map((g: any) => String(g || "").trim().toLowerCase())
      .filter(Boolean)
      .map((g: string) => g.split(/\s+/).slice(0, 12).join(" "))
      .slice(0, 6);
    if (grounds.length >= 2) merged.legal_grounds = [...new Set(grounds)];
  }
  if (Array.isArray(polish?.legal_research_authorities)) {
    const authorities = polish.legal_research_authorities
      .map((row: any) => {
        const title = String(row?.title || "").trim();
        if (!title) return null;
        const section = row?.section == null ? null : String(row.section).trim();
        const authorityTypeRaw = String(row?.authority_type || "").toLowerCase();
        const authority_type =
          authorityTypeRaw === "case_law"
            ? "case_law"
            : authorityTypeRaw === "regulation"
              ? "regulation"
              : authorityTypeRaw === "legal_opinion"
                ? "legal_opinion"
                : "act";
        const relevance = String(row?.relevance || "").trim();
        const confidence = Number(row?.confidence);
        return {
          title: title.slice(0, 180),
          section: section ? section.slice(0, 120) : null,
          authority_type,
          relevance: relevance ? relevance.slice(0, 220) : undefined,
          source: row?.source === "rag" ? "rag" : "llm",
          confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : undefined,
        };
      })
      .filter(Boolean)
      .slice(0, 5);
    if (authorities.length > 0) merged.legal_research_authorities = authorities;
  }
  if (Array.isArray(polish?.next_best_actions) && polish.next_best_actions.length > 0) {
    merged.next_best_actions = polish.next_best_actions.map((x: any) => String(x || "").trim()).filter(Boolean).slice(0, 6);
  }
  if (Array.isArray(polish?.clarifying_questions)) {
    merged.clarifying_questions = polish.clarifying_questions.map((x: any) => String(x || "").trim()).filter(Boolean).slice(0, 3);
  }
  return merged;
}

export const groundedGenerator = {
  async generateModule(params: {
    moduleKey: string;
    language: string;
    queryText: string;
    filters?: any;
    priorOutputs?: Record<string, any>;
    contextChunks: ContextChunk[];
    deterministicFallback: () => Promise<any>;
    forceLlmPolishOnRun?: boolean;
    generationTier?: "preview" | "final";
    signal?: AbortSignal;
  }) {
    const env = getEnv();
    const requireLlm = env.REQUIRE_LLM_OUTPUT === true;
    if (env.AI_MODE !== "rag_llm") {
      if (requireLlm) {
        throw new Error("LLM output is required. Set AI_MODE=rag_llm and ensure the LLM server is reachable.");
      }
      const payload = await params.deterministicFallback();
      runtimeMetrics.recordSchema("fallback");
      return { ...payload, mode: "fallback" };
    }

    const generationTier = params.generationTier === "preview" ? "preview" : "final";
    const profile = getGenerationProfile(params.moduleKey, generationTier);
    const compressedContextChunks = packContextChunks(params.moduleKey, params.queryText || "", params.contextChunks, "full", generationTier);

    if (params.moduleKey === "query_parsing") {
      const queryParsingTier = generationTier;
      const queryParsingProfile = getGenerationProfile("query_parsing", queryParsingTier);
      const queryParsingMaxTokens = queryParsingProfile.maxTokens;
      const queryParsingTimeoutMs = queryParsingProfile.timeoutMs;
      const basePayload = await params.deterministicFallback();
      const generationCacheKey = hashKey(JSON.stringify({
        v: QUERY_PARSING_CACHE_VERSION,
        moduleKey: params.moduleKey,
        language: params.language,
        queryText: params.queryText,
        filters: params.filters || {},
        contextKeys: compressedContextChunks.map((c) => [c.doc_id, c.chunk_id, c.snippet]),
        baseFingerprint: {
          domain: basePayload?.domain,
          legal_domain: basePayload?.legal_domain,
          legal_subtype: basePayload?.legal_subtype,
          case_type: basePayload?.case_type,
          issues: Array.isArray(basePayload?.issues) ? basePayload.issues.slice(0, 6) : [],
          issue_groups: Array.isArray(basePayload?.issue_groups)
            ? basePayload.issue_groups.slice(0, 4).map((g: any) => [g?.title, g?.priority])
            : [],
          legal_grounds: Array.isArray(basePayload?.legal_grounds) ? basePayload.legal_grounds.slice(0, 6) : [],
          summary: String(basePayload?.executive_summary_text || basePayload?.summary || "").slice(0, 240),
        },
      }));
      if (ENABLE_QUERY_PARSING_GENERATION_CACHE) {
        const cached = readJsonCache<any>("generation", generationCacheKey);
        if (cached && typeof cached === "object") {
          runtimeMetrics.recordCache("generation", true);
          return {
            ...cached,
            qa_debug: {
              ...(cached?.qa_debug || {}),
              llm_polish_cache_hit: true,
              llm_polish_attempted: Boolean(cached?.mode === "rag_llm"),
              query_parsing_cache_version: QUERY_PARSING_CACHE_VERSION,
              query_parsing_generation_cache_enabled: true,
            },
          };
        }
      }
      runtimeMetrics.recordCache("generation", false);
      const forceLlmPolish = requireLlm ? true : Boolean(params.forceLlmPolishOnRun);
      if (!forceLlmPolish && isInsufficientQueryParsingPayload(basePayload)) {
        runtimeMetrics.recordSchema("fallback");
        const result = {
          ...basePayload,
          mode: "fallback",
          qa_debug: {
            ...(basePayload?.qa_debug || {}),
            llm_polish_cache_hit: false,
            llm_polish_attempted: false,
            llm_polish_skipped_reason: "insufficient_query_parsing_payload",
            query_parsing_cache_version: QUERY_PARSING_CACHE_VERSION,
          },
        };
        if (ENABLE_QUERY_PARSING_GENERATION_CACHE) writeJsonCache("generation", generationCacheKey, result);
        return result;
      }
      if (!forceLlmPolish && shouldSkipQueryParsingPolish(basePayload)) {
        const result = {
          ...basePayload,
          mode: "fallback",
          fallback_reason: "query_parsing_deterministic_fast_path",
          qa_debug: {
            ...(basePayload?.qa_debug || {}),
            llm_polish_cache_hit: false,
            llm_polish_attempted: false,
            llm_polish_skipped_reason: "deterministic_fast_path",
            query_parsing_cache_version: QUERY_PARSING_CACHE_VERSION,
          },
        };
        if (ENABLE_QUERY_PARSING_GENERATION_CACHE) writeJsonCache("generation", generationCacheKey, result);
        return result;
      }
      try {
        const prompt = buildQueryParsingPolishPrompt({
          language: params.language,
          queryText: translatorService.translateText(params.queryText || "", "English"),
          base: basePayload,
          contextChunks: compressedContextChunks,
        });
        const compactRetryPrompt = () =>
          buildQueryParsingPolishPrompt({
            language: params.language,
            queryText: translatorService.translateText((params.queryText || "").slice(0, 500), "English"),
            base: {
              jurisdiction: basePayload?.jurisdiction,
              state: basePayload?.state,
              legal_domain: basePayload?.legal_domain || basePayload?.domain,
                case_type: basePayload?.case_type,
                legal_subtype: basePayload?.legal_subtype,
                key_facts: basePayload?.key_facts,
                requested_outcomes: Array.isArray(basePayload?.requested_outcomes) ? basePayload.requested_outcomes.slice(0, 4) : [],
                legal_grounds: Array.isArray(basePayload?.legal_grounds) ? basePayload.legal_grounds.slice(0, 3) : [],
                issue_groups: Array.isArray(basePayload?.issue_groups) ? basePayload.issue_groups.slice(0, 3) : [],
                detected_language: basePayload?.detected_language,
                filters_applied: basePayload?.filters_applied || {},
            },
            contextChunks: packContextChunks("query_parsing", (params.queryText || "").slice(0, queryParsingProfile.compactQueryChars), params.contextChunks, "compact", queryParsingTier),
          });
        let raw = await generateTextWithOverflowRetry(prompt, {
          temperature: queryParsingProfile.temperature,
          top_p: queryParsingProfile.topP,
          max_tokens: queryParsingMaxTokens,
          timeoutMs: queryParsingTimeoutMs,
          tier: queryParsingTier,
          signal: params.signal,
        }, compactRetryPrompt);
        let parsed: any;
        try {
          parsed = parseJsonLoose(raw);
          runtimeMetrics.recordSchema("pass");
        } catch {
          runtimeMetrics.recordSchema("repaired");
          const repairPrompt = [
            "Fix this into valid JSON only using the required schema.",
            '{"executive_summary_text":"2-4 sentences","domain":"...","legal_domain":"...|null","legal_subtype":"...|null","case_type":"...|null","legal_grounds":["..."],"issue_groups":[{"title":"...","description":"...","priority":"high|medium|low"}],"confidence_score":0-100}',
            raw,
          ].join("\n");
          raw = await generateTextWithOverflowRetry(repairPrompt, {
            temperature: 0,
            top_p: queryParsingProfile.topP,
            max_tokens: queryParsingProfile.repairMaxTokens,
            timeoutMs: queryParsingProfile.repairTimeoutMs,
            tier: queryParsingTier,
            signal: params.signal,
          }, () => repairPrompt.slice(0, 2200));
          parsed = parseJsonLoose(raw);
          runtimeMetrics.recordSchema("pass");
        }
        const merged = ensureCitationRules(
          "query_parsing",
          sanitizeQueryParsingPayloadByEvidence(
            mergeQueryParsingPolish(basePayload, parsed, params.queryText || ""),
            basePayload,
            params.queryText || "",
            compressedContextChunks,
          ),
        );
        const result = {
          ...merged,
          mode: "rag_llm",
          qa_debug: {
            ...(merged?.qa_debug || {}),
            llm_polish_cache_hit: false,
            llm_polish_attempted: true,
            llm_polish_skipped_reason: null,
            llm_polish_forced_on_run: forceLlmPolish,
            query_parsing_cache_version: QUERY_PARSING_CACHE_VERSION,
          },
        };
        if (ENABLE_QUERY_PARSING_GENERATION_CACHE) writeJsonCache("generation", generationCacheKey, result);
        return result;
      } catch (err) {
        runtimeMetrics.recordSchema("fail");
        runtimeMetrics.recordSchema("fallback");
        const result = {
          ...basePayload,
          mode: requireLlm ? "rag_llm" : "fallback",
          fallback_reason: requireLlm ? "query_parsing_llm_failed_hard_fallback" : "fast_query_parsing_polish_failed",
          qa_debug: {
            ...(basePayload?.qa_debug || {}),
            llm_polish_cache_hit: false,
            llm_polish_attempted: true,
            llm_polish_skipped_reason: null,
            llm_polish_forced_on_run: forceLlmPolish,
            query_parsing_cache_version: QUERY_PARSING_CACHE_VERSION,
            llm_polish_failed: true,
            llm_polish_error: String((err as any)?.message || err),
            llm_required_mode: requireLlm,
          },
        };
        if (ENABLE_QUERY_PARSING_GENERATION_CACHE) writeJsonCache("generation", generationCacheKey, result);
        return result;
      }
    }

    let lastRaw = "";
    try {
      const retrievalLanguage = params.language === "English" ? "English" : "English";
      const buildModulePrompt = (retryCompact = false) => promptFactory.modulePrompt(params.moduleKey, {
        moduleKey: params.moduleKey,
        language: params.language,
        contextChunks: retryCompact ? packContextChunks(params.moduleKey, params.queryText || "", params.contextChunks, "compact", generationTier) : compressedContextChunks,
        queryText: translatorService.translateText((params.queryText || "").slice(0, retryCompact ? profile.compactQueryChars : profile.queryChars), retrievalLanguage),
        filters: params.filters,
        priorOutputs: retryCompact ? slimPriorOutputs(params.priorOutputs) : params.priorOutputs,
        schemaHint: promptFactory.schemaHint(params.moduleKey),
        contextCharBudget: retryCompact ? profile.compactContextCharBudget : profile.contextCharBudget,
        queryCharBudget: retryCompact ? profile.compactQueryChars : profile.queryChars,
        priorCharBudget: profile.priorOutputsChars,
      });
      const prompt = buildModulePrompt(false);
      let raw = await generateTextWithOverflowRetry(prompt, {
        temperature: profile.temperature,
        top_p: profile.topP,
        max_tokens: profile.maxTokens,
        timeoutMs: profile.timeoutMs,
        tier: generationTier,
        signal: params.signal,
      }, () => buildModulePrompt(true));
      lastRaw = raw;
      let parsed: any;
      let validated: any;
      try {
        parsed = parseJsonLoose(raw);
        validated = schemaRegistry.get(params.moduleKey).parse(parsed);
        runtimeMetrics.recordSchema("pass");
      } catch {
        runtimeMetrics.recordSchema("repaired");
        const repair = promptFactory.repairPrompt(params.moduleKey, raw);
        raw = await generateTextWithOverflowRetry(repair, {
          temperature: 0,
          top_p: profile.topP,
          max_tokens: profile.repairMaxTokens,
          timeoutMs: profile.repairTimeoutMs,
          tier: generationTier,
          signal: params.signal,
        }, () => repair.slice(0, 2400));
        lastRaw = raw;
        parsed = parseJsonLoose(raw);
        validated = schemaRegistry.get(params.moduleKey).parse(parsed);
        runtimeMetrics.recordSchema("pass");
      }
      const weaknesses = collectQualityWeaknesses(params.moduleKey, validated);
      if (weaknesses.length) {
        const qualityRepair = promptFactory.qualityRepairPrompt(params.moduleKey, weaknesses, JSON.stringify(validated).slice(0, 12000));
        const qualityRaw = await generateTextWithOverflowRetry(qualityRepair, {
          temperature: Math.max(0.02, profile.temperature * 0.6),
          top_p: profile.topP,
          max_tokens: profile.repairMaxTokens,
          timeoutMs: profile.repairTimeoutMs,
          tier: generationTier,
          signal: params.signal,
        }, () => qualityRepair.slice(0, 2600));
        lastRaw = qualityRaw;
        const qualityParsed = parseJsonLoose(qualityRaw);
        validated = schemaRegistry.get(params.moduleKey).parse(qualityParsed);
      }
      validated = reconcileModuleCitations(params.moduleKey, validated, compressedContextChunks, params.queryText || "");
      validated = ensureCitationRules(params.moduleKey, validated);
      validated.mode = "rag_llm";
      validated.qa_debug = {
        ...(validated?.qa_debug || {}),
        generation_profile: {
          temperature: profile.temperature,
          top_p: profile.topP,
          max_tokens: profile.maxTokens,
          timeout_ms: profile.timeoutMs,
        },
      };
      return validated;
    } catch (error: any) {
      const payload = await params.deterministicFallback();
      runtimeMetrics.recordSchema("fail");
      runtimeMetrics.recordSchema("fallback");
      const llmEndpointReachable = getEnv().AI_MODE === "rag_llm";
      const merged = mergeLlMTextIntoFallback(params.moduleKey, lastRaw, payload);
      // If LLM path is active but schema failed, keep response schema-safe and mark it as model-assisted.
      return {
        ...merged,
        mode: llmEndpointReachable ? "rag_llm" : "fallback",
        fallback_reason: requireLlm ? "llm_required_schema_invalid_or_timeout" : "schema_invalid_or_timeout",
        qa_debug: {
          ...(merged?.qa_debug || {}),
          llm_generation_failed: true,
          llm_generation_error: String(error?.message || error),
          llm_required_mode: requireLlm,
        },
      };
    }
  },
};
