import type { UserRole } from "../../db/types.js";
import { indexService } from "../index.service.js";
import type { Citation } from "../../types/api.js";
import { detectLanguageInfo } from "../../utils/language.js";
import { llmClient } from "../../ai/llmClient.js";
import { getEnv } from "../../config/env.js";

type Context = {
  caseId: string;
  caseRole: UserRole;
  documentsText: string;
  userQueryText?: string;
  extractedDocSnippets?: Array<{ doc_id: string; chunk_id: string; snippet: string; source_type?: string; source_label?: string }>;
  existing: Record<string, any>;
  caseMeta?: {
    detectedLanguage?: string | null;
    preferredLanguage?: string | null;
    filtersApplied?: any;
    filtersNotFullyApplied?: boolean;
    inputStats?: Record<string, any>;
  };
};

type LegalResearchAuthority = {
  title: string;
  section?: string | null;
  authority_type?: "act" | "case_law" | "regulation" | "legal_opinion";
  relevance?: string;
  source?: "rag" | "llm";
  confidence?: number;
};

function getRoleAudienceLabel(role: UserRole) {
  switch (role) {
    case "LAWYER":
      return "lawyer";
    case "LAW_STUDENT":
      return "law student";
    case "BUSINESS_CORPORATE":
      return "business / corporate user";
    case "NORMAL_PERSON":
      return "normal person";
    default:
      return "user";
  }
}

function getRolePerspectiveLine(role: UserRole, topic: "query" | "risk" | "outcome" | "compliance" | "drafts" | "terms") {
  const roleLabel = getRoleAudienceLabel(role);
  const topicMap: Record<string, Record<UserRole, string>> = {
    query: {
      LAWYER: "For a lawyer, the output prioritizes case framing, evidence gaps, and the next litigation-facing moves.",
      LAW_STUDENT: "For a law student, the output emphasizes issue spotting, doctrine mapping, and structured understanding of the file.",
      BUSINESS_CORPORATE: "For a business / corporate user, the output emphasizes risk visibility, business impact, and decision readiness.",
      NORMAL_PERSON: "For a normal person, the output emphasizes plain-language understanding, practical next steps, and document readiness.",
    },
    risk: {
      LAWYER: "For a lawyer, the risk view focuses on clause attack points, notice posture, and settlement leverage.",
      LAW_STUDENT: "For a law student, the risk view focuses on why the clauses matter and how to analyze them in a structured way.",
      BUSINESS_CORPORATE: "For a business / corporate user, the risk view focuses on exposure, escalation points, and control actions.",
      NORMAL_PERSON: "For a normal person, the risk view focuses on what the dangerous terms mean and what to check first.",
    },
    outcome: {
      LAWYER: "For a lawyer, the outcome view focuses on filing posture, evidentiary strength, and realistic forum strategy.",
      LAW_STUDENT: "For a law student, the outcome view focuses on why the case may win, settle, or weaken.",
      BUSINESS_CORPORATE: "For a business / corporate user, the outcome view focuses on commercial exposure, recovery chances, and decision trade-offs.",
      NORMAL_PERSON: "For a normal person, the outcome view focuses on likely result, timeline, and practical next action.",
    },
    compliance: {
      LAWYER: "For a lawyer, the compliance view focuses on notice defects, documentary gaps, and legally material deviations.",
      LAW_STUDENT: "For a law student, the compliance view focuses on how the compliance issues connect to legal reasoning.",
      BUSINESS_CORPORATE: "For a business / corporate user, the compliance view focuses on control failures, approval gaps, and remediation priority.",
      NORMAL_PERSON: "For a normal person, the compliance view focuses on what appears missing, risky, or important to fix now.",
    },
    drafts: {
      LAWYER: "For a lawyer, the drafts view focuses on drafting posture, relief framing, and evidence-backed notice structure.",
      LAW_STUDENT: "For a law student, the drafts view focuses on understanding the draft structure and why each section matters.",
      BUSINESS_CORPORATE: "For a business / corporate user, the drafts view focuses on business-safe communication and escalation wording.",
      NORMAL_PERSON: "For a normal person, the drafts view focuses on a simple and usable drafting path.",
    },
    terms: {
      LAWYER: "For a lawyer, the terms view focuses on enforceability, drafting leverage, and dispute-ready clause language.",
      LAW_STUDENT: "For a law student, the terms view focuses on understanding the function of each clause and policy point.",
      BUSINESS_CORPORATE: "For a business / corporate user, the terms view focuses on operational clarity, approvals, and commercial safeguards.",
      NORMAL_PERSON: "For a normal person, the terms view focuses on readable protections and practical safeguards.",
    },
  };
  return topicMap[topic]?.[role] || `The output is tailored for the ${roleLabel}.`;
}

function appendRolePerspective(summary: string, role: UserRole, topic: "query" | "risk" | "outcome" | "compliance" | "drafts" | "terms") {
  const base = String(summary || "").trim();
  const line = getRolePerspectiveLine(role, topic);
  return base ? `${base} ${line}` : line;
}

function prependRoleItems(role: UserRole, values: string[], topic: "query" | "risk" | "outcome" | "compliance" | "drafts" | "terms") {
  const extraMap: Record<string, Record<UserRole, string[]>> = {
    query: {
      LAWYER: ["Validate cause of action, relief strategy, and evidentiary gaps before downstream filings."],
      LAW_STUDENT: ["Map the facts to legal issues and note which facts support each issue."],
      BUSINESS_CORPORATE: ["Separate legal risk from business impact before deciding escalation."],
      NORMAL_PERSON: ["Keep the next steps simple: gather the main papers, dates, and proof first."],
    },
    risk: {
      LAWYER: ["Test the strongest clause challenge points and notice failures first."],
      LAW_STUDENT: ["Note why each flagged clause changes legal risk."],
      BUSINESS_CORPORATE: ["Prioritize the clauses that affect money, delay, and escalation exposure."],
      NORMAL_PERSON: ["Check the most dangerous terms first before taking action."],
    },
    outcome: {
      LAWYER: ["Compare filing leverage versus settlement leverage using the strongest documents first."],
      LAW_STUDENT: ["Track which evidence improves the case outcome and which gaps weaken it."],
      BUSINESS_CORPORATE: ["Use the outcome range to guide commercial decision-making and reserve planning."],
      NORMAL_PERSON: ["Focus on what can improve your chances before spending more time or money."],
    },
    compliance: {
      LAWYER: ["Recheck notice chain, approvals, and missing supporting records."],
      LAW_STUDENT: ["Link each compliance issue to the legal consequence it may create."],
      BUSINESS_CORPORATE: ["Fix the highest-impact control gap first, then document remediation."],
      NORMAL_PERSON: ["Fix the clearest missing step or document first."],
    },
    drafts: {
      LAWYER: ["Sharpen relief language and attach the strongest documentary support."],
      LAW_STUDENT: ["Use the draft structure to understand how legal facts are turned into submissions."],
      BUSINESS_CORPORATE: ["Keep the draft commercially clear, measured, and approval-ready."],
      NORMAL_PERSON: ["Use simple wording and keep the draft focused on the key facts and request."],
    },
    terms: {
      LAWYER: ["Tighten enforceability, forum, and remedy language before relying on the terms."],
      LAW_STUDENT: ["Study what each clause is trying to control and why that matters in disputes."],
      BUSINESS_CORPORATE: ["Prefer terms that reduce ambiguity, approval gaps, and recovery delays."],
      NORMAL_PERSON: ["Look for simple protections around payment, notice, and dispute handling."],
    },
  };
  return [...(extraMap[topic]?.[role] || []), ...(values || [])].slice(0, Math.max(values.length, 3));
}

function applyRoleAwareLabel(role: UserRole) {
  switch (role) {
    case "LAWYER":
      return "professional_legal";
    case "LAW_STUDENT":
      return "learning_focused";
    case "BUSINESS_CORPORATE":
      return "decision_support";
    case "NORMAL_PERSON":
      return "plain_language";
    default:
      return "general";
  }
}

function isPlaceholderAuthorityValue(value: unknown) {
  const normalized = String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  return normalized === "string" || normalized === "string|null" || normalized === "null" || normalized === "undefined";
}

function getCitations(rows: Array<{ doc_id: string; chunk_id: string; snippet: string; source_type?: string; source_label?: string }>): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const r of rows) {
    const normalizedSnippet = String(r.snippet || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
    const key = normalizedSnippet
      ? `${r.source_type || "user_doc"}::${r.doc_id || ""}::${normalizedSnippet}`
      : `${r.source_type || "user_doc"}::${r.doc_id || ""}::${r.chunk_id || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      doc_id: r.doc_id,
      chunk_id: r.chunk_id,
      snippet: r.snippet,
      source_type: r.source_type || "user_doc",
      source_label: r.source_label,
    });
  }
  return out;
}

function normalizeCitationTerms(values: Array<string | null | undefined>) {
  const stop = new Set(["case", "legal", "analysis", "document", "documents", "issue", "issues", "summary", "draft"]);
  return [...new Set(
    values
      .flatMap((value) =>
        String(value || "")
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .split(/\s+/)
          .map((token) => token.trim())
          .filter((token) => token.length >= 4 && !stop.has(token)),
      ),
  )];
}

function pickModuleCitations(
  moduleKey: string,
  rows: Array<{ doc_id: string; chunk_id: string; snippet: string; source_type?: string; source_label?: string }>,
  extras: Array<string | null | undefined> = [],
  target = 4,
): Citation[] {
  const base = getCitations(rows);
  if (!base.length) return base;
  const moduleTermsMap: Record<string, string[]> = {
    terms_and_policies: ["policy", "terms", "clause", "regulation", "notice", "obligation"],
    contract_risk: ["liability", "termination", "payment", "indemnity", "breach", "cure", "jurisdiction"],
    outcome_projection: ["timeline", "deadline", "damages", "notice", "delay", "settlement", "evidence"],
    policy_compliance: ["compliance", "policy", "regulation", "statute", "approval", "notice", "obligation"],
    legal_drafts_validation: ["notice", "draft", "demand", "termination", "payment", "relief", "evidence"],
  };
  const terms = new Set(normalizeCitationTerms([...(moduleTermsMap[moduleKey] || []), ...extras]));
  const scored = base
    .map((citation, index) => {
      const snippet = String(citation.snippet || "").toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (snippet.includes(term)) score += 3;
      }
      if (String(citation.source_type || "").toLowerCase() === "legal_corpus" && (moduleKey === "policy_compliance" || moduleKey === "outcome_projection")) {
        score += 2;
      }
      score += Math.max(0, 1 - index * 0.05);
      return { citation, score };
    })
    .sort((a, b) => b.score - a.score);
  const picked: Citation[] = [];
  const seenDocs = new Set<string>();
  for (const entry of scored) {
    const citation = entry.citation;
    if (picked.length >= target) break;
    if (!seenDocs.has(citation.doc_id) || picked.length < 2) {
      picked.push(citation);
      seenDocs.add(citation.doc_id);
    }
  }
  for (const entry of scored) {
    if (picked.length >= target) break;
    if (!picked.some((citation) => citation.doc_id === entry.citation.doc_id && citation.chunk_id === entry.citation.chunk_id)) {
      picked.push(entry.citation);
    }
  }
  return dedupeCitationsStrict(picked).slice(0, target);
}

function dedupeCitationsStrict(citations: Citation[]) {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of citations || []) {
    const norm = String(c.snippet || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 180);
    const key = c.doc_id && c.chunk_id
      ? `${c.source_type || "user_doc"}::${c.doc_id}::${c.chunk_id}`
      : `${c.source_type || "user_doc"}::${norm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function limitQueryParsingCitations(citations: Citation[], hasUserText: boolean) {
  const deduped = dedupeCitationsStrict(citations);
  if (!deduped.length) return deduped;
  const current = deduped.filter((c) => String(c.source_type || "").toLowerCase() === "current_input");
  const user = deduped.filter((c) => {
    const t = String(c.source_type || "user_doc").toLowerCase();
    return t === "user_doc" || t === "documents";
  });
  const legal = deduped.filter((c) => String(c.source_type || "").toLowerCase() === "legal_corpus");
  const ordered = [...current, ...legal, ...user, ...deduped];
  const uniq = dedupeCitationsStrict(ordered);
  const target = hasUserText ? (legal.length > 0 ? 5 : 4) : (legal.length > 0 ? 4 : 3);
  const picked = uniq.slice(0, target);
  if (legal.length > 0 && !picked.some((c) => String(c.source_type || "").toLowerCase() === "legal_corpus")) {
    const firstLegal = legal[0];
    if (firstLegal) {
      if (picked.length < target) picked.push(firstLegal);
      else picked[picked.length - 1] = firstLegal;
    }
  }
  return dedupeCitationsStrict(picked).slice(0, target);
}

function isLikelyInstructionOrUiSnippet(value: string) {
  const s = String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!s) return false;
  const noisySignals = [
    "run query parsing",
    "uploaded documents",
    "analysis results",
    "prompt actions",
    "use template",
    "paste text",
    "view all",
    "agent ->",
    "case outcome agent",
    "query parsing agent",
    "qa debug",
    "back to query parsing",
  ];
  if (noisySignals.some((x) => s.includes(x))) return true;
  const tokenCount = s.split(" ").filter(Boolean).length;
  const punctuation = (s.match(/[.,:;()[\]{}<>]/g) || []).length;
  return tokenCount >= 10 && punctuation <= 1 && /\b(click|open|run|upload)\b/.test(s);
}

function countConcreteFactSignals(value: string) {
  const s = normalizeForParsing(value).toLowerCase().replace(/\s+/g, " ").trim();
  if (!s) return 0;
  let score = 0;
  if (/(?:rs\.?|inr|₹|\brupees?\b)\s*\d|\b\d[\d,]{3,}\b/.test(s)) score += 1;
  if (/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4})\b/.test(s)) score += 1;
  if (/\b(?:invoice|purchase order|po\b|work order|email|whatsapp|notice|contract|agreement|bank statement|challan)\b/.test(s)) score += 1;
  if (/\b(?:vendor|supplier|buyer|customer|landlord|tenant|employer|employee|company|brother|mother|daughter|son|wife|husband)\b/.test(s)) score += 1;
  if (/\b(?:delayed|defaulted|terminated|refused|deducted|withheld|damaged|defective|harassed|threatened|vacated|handover|breach)\b/.test(s)) score += 1;
  return score;
}

function detectPromptTemplateQuery(value: string) {
  const s = normalizeForParsing(value).toLowerCase().replace(/\s+/g, " ").trim();
  if (!s) return { likelyTemplate: false, score: 0, phraseHits: [] as string[], concreteFacts: 0 };
  const templatePhrases = [
    "perform a complete legal analysis",
    "complete legal analysis of a vendor",
    "identify the parties",
    "identify the underlying transaction",
    "scope of work or arrangement",
    "possible breach points",
    "likely obligations of each side",
    "possible liability exposure",
    "evidence gaps",
    "probable outcome",
    "strongest settlement or litigation path",
    "if terms such as limitation of liability",
    "also state what should be prepared next",
    "clearly separate what is supported",
    "create a contract dispute study brief",
    "identify the main legal issues",
  ];
  const phraseHits = templatePhrases.filter((phrase) => s.includes(phrase));
  const instructionLead = /^(perform|create|draft|prepare|assess|analyze|analyse|review|identify|summarize|give)\b/.test(s);
  const commaCount = (s.match(/,/g) || []).length;
  const tokenCount = s.split(" ").filter(Boolean).length;
  const concreteFacts = countConcreteFactSignals(s);
  let score = phraseHits.length;
  if (instructionLead) score += 2;
  if (tokenCount >= 35 && commaCount >= 6) score += 1;
  if (concreteFacts === 0) score += 2;
  else if (concreteFacts === 1) score += 1;
  return {
    likelyTemplate: score >= 5 && phraseHits.length >= 2,
    score,
    phraseHits,
    concreteFacts,
  };
}

function ensureMinQueryParsingCitations(primary: Citation[], queryText: string, minCount = 3) {
  const base = dedupeCitationsStrict(primary || []);
  if (base.length >= minCount) return base;
  const augmented = dedupeCitationsStrict([...base, ...fallbackQueryCitations(queryText)]);
  return augmented.slice(0, Math.max(minCount, 3));
}

function sanitizeIndiaJurisdictionStatuteMentions(text: string, legalCorpusCitations: Citation[] = []) {
  const supported = legalCorpusCitations.some((c) =>
    /civil code\s*1950\.5|21-?day return rule|2x damages/i.test(String(c.snippet || "")),
  );
  if (supported) return String(text || "");
  return String(text || "")
    .replace(/\bCivil Code\s*1950\.5\b/gi, "")
    .replace(/\b21-?day return rule\b/gi, "")
    .replace(/\b2x damages\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

function buildPlainLegalGrounds(input: {
  domain: string;
  text: string;
  issueGroups: Array<{ title: string; description: string; priority: "high" | "medium" | "low" }>;
  evidenceAvailable: string[];
}) {
  const results: string[] = [];
  const normalizeGroundKey = (v: string) => String(v || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const push = (value: string) => {
    const clean = String(value || "").trim().toLowerCase();
    if (!clean) return;
    const capped = clean.split(/\s+/).slice(0, 12).join(" ");
    const key = normalizeGroundKey(capped);
    if (!key) return;
    const hasEquivalent = results.some((r) => {
      const rk = normalizeGroundKey(r);
      return rk === key || rk.includes(key) || key.includes(rk);
    });
    if (!hasEquivalent) results.push(capped);
  };
  const t = normalizeForParsing(input.text).toLowerCase();
  if ((input.domain || "").toLowerCase().includes("property")) {
    if (/(landlord|tenant|rent|lease|vacat|handover|possession)/.test(t)) push("tenancy possession and handover facts");
    if (/(deposit|security deposit|refund|deduct|deduction)/.test(t)) push("security deposit refund / deduction dispute");
    if (/(painting|damage|repair|wear and tear)/.test(t)) push("damage deduction justification and proof");
    if ((input.evidenceAvailable || []).length > 0) push("evidence sufficiency and chronology");
  }
  if ((input.domain || "").toLowerCase().includes("consumer")) {
    if (/(defect|defective|faulty|non[- ]?conforming|damaged|broken|issue)/.test(t)) push("defective/non-conforming goods");
    if (/(refund|replacement|replace|return denied|refund denied)/.test(t)) push("refund/replacement denial");
    if (/(warranty|service center|service centre|repair refusal|service refusal)/.test(t)) push("warranty/service refusal");
    if (/(delivery|delay|late|misrepresentation|wrong product)/.test(t)) push("delivery delay / misrepresentation");
    if ((input.evidenceAvailable || []).length > 0) push("evidence sufficiency & chronology");
  }
  if ((input.domain || "").toLowerCase().includes("civil litigation / finance")) {
    if (/(loan|installment|instalment|default)/.test(t)) push("loan repayment default and recovery dispute");
    if (/(harass|harassment|restrain|public roads|residence|illegal approach)/.test(t)) push("unlawful debt recovery harassment allegations");
    if (/(threat|dire consequences|antisocial|anti social|henchmen|intimidat)/.test(t)) push("threat/intimidation and safety concerns");
    if (/(injunction|permanent injunction|order xxxix|section 151|cpc)/.test(t)) push("injunction relief against extra-legal recovery actions");
    if ((input.evidenceAvailable || []).length > 0) push("evidence sufficiency and chronology");
  }
  for (const group of input.issueGroups || []) {
    if (results.length >= 6) break;
    const title = String(group.title || "");
    if (/\b(section|act|code)\b/i.test(title)) continue;
    push(title);
  }
  while (results.length < 3) {
    if ((input.domain || "").toLowerCase().includes("consumer")) {
      ["consumer remedy assessment", "evidence sufficiency & chronology", "refund/replacement viability"].forEach(push);
    } else {
      ["facts clarification required", "evidence sufficiency & chronology", "relief and timeline assessment"].forEach(push);
    }
    if (results.length >= 3) break;
  }
  return results.slice(0, 6);
}

function extractStatuteMentionFromSnippet(snippet: string) {
  const text = String(snippet || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const pattern =
    /\b(section|sec\.?)\s+\d+[a-z]?(?:\(\d+\))?(?:\s*(?:of|under)\s+the\s+[a-z][a-z\s,&.-]{4,80}?(?:act|code|rules?)(?:,\s*\d{4})?)?/i;
  const match = text.match(pattern);
  if (!match) return null;
  return match[0].replace(/\s+/g, " ").trim();
}

function enrichGroundsWithCorpusEvidence(baseGrounds: string[], citations: Citation[]) {
  const out = [...(baseGrounds || [])];
  const seen = new Set(out.map((g) => String(g || "").toLowerCase().trim()));
  const legalMentions = (citations || [])
    .filter((c) => String(c?.source_type || "").toLowerCase() === "legal_corpus")
    .map((c) => extractStatuteMentionFromSnippet(String(c?.snippet || "")))
    .filter(Boolean) as string[];
  for (const mention of legalMentions.slice(0, 3)) {
    const grounded = `applicability of ${mention}`;
    const key = grounded.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(grounded);
  }
  return out.slice(0, 7);
}

function normalizeAuthorityType(raw: unknown): LegalResearchAuthority["authority_type"] {
  const v = String(raw || "").toLowerCase();
  if (v.includes("case")) return "case_law";
  if (v.includes("regulation") || v.includes("rule")) return "regulation";
  if (v.includes("opinion")) return "legal_opinion";
  return "act";
}

function extractSectionMention(text: string) {
  const m = String(text || "")
    .replace(/\s+/g, " ")
    .match(/\b(?:section|sec\.?)\s+\d+[a-z]?(?:\(\d+\))?(?:\s*(?:of|under)\s+the\s+[a-z][a-z\s,&.-]{4,90}?)?/i);
  return m ? m[0].replace(/\s+/g, " ").trim() : null;
}

function extractAuthorityTitle(text: string) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return null;
  const actMatch = value.match(/\b[A-Za-z][A-Za-z&().,\s-]{3,120}\s(?:Act|Code|Rules?|Regulations?)(?:,\s*\d{4})?\b/);
  if (actMatch?.[0]) return actMatch[0].replace(/\s+/g, " ").trim();
  const caseMatch = value.match(/\b[A-Za-z][A-Za-z .,&'-]{2,80}\s+v(?:s\.?|\.?)\s+[A-Za-z][A-Za-z .,&'-]{2,80}(?:\s*\(\d{4}\))?/i);
  if (caseMatch?.[0]) return caseMatch[0].replace(/\s+/g, " ").trim();
  return null;
}

function titleFromDocId(docId: string) {
  const clean = String(docId || "")
    .replace(/^legal:/i, "")
    .replace(/\.[a-z0-9]{1,6}$/i, "")
    .replace(/[\/\\]/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  return clean
    .split(" ")
    .map((w) => (w.length <= 2 ? w.toUpperCase() : `${w[0].toUpperCase()}${w.slice(1).toLowerCase()}`))
    .join(" ")
    .trim();
}

function dedupeLegalResearchAuthorities(items: LegalResearchAuthority[]) {
  const out: LegalResearchAuthority[] = [];
  const seen = new Set<string>();
  for (const item of items || []) {
    const title = String(item?.title || "").trim();
    if (!title) continue;
    const key = `${title.toLowerCase()}::${String(item?.section || "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(0, 5);
}

function buildLegalResearchAuthoritiesFromCitations(citations: Citation[]) {
  const legalRows = (citations || []).filter((c) => String(c?.source_type || "").toLowerCase() === "legal_corpus");
  const parsed = legalRows.map((c) => {
    const snippet = String(c?.snippet || "").replace(/\s+/g, " ").trim();
    const titleFromSnippet = extractAuthorityTitle(snippet);
    const title = titleFromSnippet || titleFromDocId(String(c?.doc_id || "")) || "Relevant Legal Authority";
    const section = extractSectionMention(snippet);
    return {
      title,
      section,
      authority_type: normalizeAuthorityType(c?.source_label || c?.source_type),
      relevance: snippet ? trimToMaxWords(snippet, 30) : undefined,
      source: "rag" as const,
      confidence: 0.86,
    };
  });
  return dedupeLegalResearchAuthorities(parsed).slice(0, 5);
}

function safeParseJsonLoose(raw: string): any | null {
  const stripMarkdownFences = (text: string) =>
    String(text || "")
      .replace(/^\uFEFF/, "")
      .replace(/```json/gi, "```")
      .replace(/```/g, "")
      .trim();
  const extractBalancedJson = (text: string) => {
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
  };
  try {
    const normalized = stripMarkdownFences(raw);
    const balanced = extractBalancedJson(normalized);
    const candidates = [
      normalized,
      balanced || "",
      normalized.replace(/,\s*([}\]])/g, "$1"),
      (balanced || "").replace(/,\s*([}\]])/g, "$1"),
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate);
      } catch {}
    }
    return null;
  } catch {
    return null;
  }
}

function buildLegalCorpusRetrievalTerms(input: {
  queryText: string;
  domain: string;
  subtype?: string | null;
  issues: string[];
}) {
  const domain = String(input.domain || "").toLowerCase();
  const subtype = String(input.subtype || "").toLowerCase();
  const baseTokens = normalizeForParsing(input.queryText || "")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 4)
    .slice(0, 14);
  const issueTokens = (input.issues || [])
    .flatMap((t) => String(t || "").toLowerCase().split(/\s+/))
    .filter((t) => t.length >= 4)
    .slice(0, 12);
  const domainAnchors: string[] = [];
  if (domain.includes("commercial contract") || domain.includes("corporate") || domain.includes("contract")) {
    domainAnchors.push(
      "indian contract act 1872",
      "specific relief act 1963",
      "arbitration and conciliation act 1996",
      "sale of goods act 1930",
      "contract damages breach injunction",
    );
  } else if (domain.includes("consumer")) {
    domainAnchors.push(
      "consumer protection act 2019",
      "deficiency in service refund replacement",
      "e commerce consumer dispute",
    );
  } else if (domain.includes("employment")) {
    domainAnchors.push(
      "industrial disputes act 1947",
      "payment of wages act 1936",
      "payment of gratuity act 1972",
      "provident fund act",
    );
  } else if (domain.includes("property") || subtype.includes("tenancy") || subtype.includes("partition")) {
    domainAnchors.push(
      "transfer of property act 1882",
      "registration act 1908",
      "indian succession act 1925",
      "specific relief act injunction possession",
    );
  } else if (domain.includes("civil litigation / finance") || domain.includes("civil litigation")) {
    domainAnchors.push(
      "code of civil procedure order xxxix section 151",
      "specific relief act injunction",
      "civil remedy damages",
    );
  }
  return [...new Set([
    ...baseTokens,
    ...issueTokens,
    ...domainAnchors,
    "india law",
    "section",
    "act",
    "case law",
    "judgment",
    "remedies",
  ])].slice(0, 28);
}

async function generateLegalResearchAuthoritiesLlmFallback(input: {
  queryText: string;
  summary: string;
  domain: string;
  subtype?: string | null;
  jurisdiction: string | null;
  issueGroups: Array<{ title: string; description: string; priority: "high" | "medium" | "low" }>;
  legalCorpusCitations: Citation[];
}) {
  if (getEnv().AI_MODE !== "rag_llm") return [];
  const prompt = [
    "Return JSON only.",
    "Task: suggest the most relevant legal authorities for the given legal dispute.",
    "Use the provided facts and legal context. Prefer Indian authorities unless jurisdiction says otherwise.",
    "If legal corpus snippets are present, prioritize those authorities. If absent/sparse, infer likely authorities from dispute facts.",
    "Never invent fake or unknown law names. If unsure of section number, set section to null.",
    "Write relevance in clear, plain English with short sentences.",
    "Keep each relevance line factual and <= 24 words.",
    "",
    `JURISDICTION: ${input.jurisdiction || "Unknown"}`,
    `DOMAIN: ${input.domain || "General"}`,
    `SUBTYPE: ${String(input.subtype || "unknown")}`,
    `SUMMARY: ${String(input.summary || "").slice(0, 1200)}`,
    `QUERY: ${String(input.queryText || "").slice(0, 1200)}`,
    `ISSUES: ${(input.issueGroups || []).map((g) => String(g?.title || "").trim()).filter(Boolean).slice(0, 8).join(" | ")}`,
    "",
    `LEGAL_CORPUS_SNIPPETS:\n${(input.legalCorpusCitations || []).slice(0, 6).map((c, i) => `[${i + 1}] ${String(c.snippet || "").slice(0, 220)}`).join("\n") || "(none)"}`,
    "",
    "Schema:",
    '{"legal_research_authorities":[{"title":"Indian Contract Act, 1872","section":"Section 73","authority_type":"act|case_law|regulation|legal_opinion","relevance":"Damages for breach may apply where the dispute concerns non-payment or supply default.","confidence":0.72}]}',
  ].join("\n");

  try {
    const raw = await llmClient.generateText(prompt, {
      tier: "final",
      max_tokens: 320,
      temperature: 0.05,
      timeoutMs: 12_000,
    });
    const parsed = safeParseJsonLoose(raw);
    const list = Array.isArray(parsed?.legal_research_authorities) ? parsed.legal_research_authorities : [];
    const normalized: LegalResearchAuthority[] = list
      .map((row: any) => {
        const title = String(row?.title || "").trim();
        const section = row?.section == null ? null : String(row.section).trim();
        const relevance = String(row?.relevance || "").trim();
        const confidence = Number(row?.confidence);
        if (!title || isPlaceholderAuthorityValue(title)) return null;
        if (section && isPlaceholderAuthorityValue(section)) return null;
        if (relevance && isPlaceholderAuthorityValue(relevance)) return null;
        return {
          title: title.slice(0, 180),
          section: section ? section.slice(0, 120) : null,
          authority_type: normalizeAuthorityType(row?.authority_type),
          relevance: relevance ? relevance.slice(0, 220) : undefined,
          source: "llm" as const,
          confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.62,
        };
      })
      .filter(Boolean) as LegalResearchAuthority[];
    return dedupeLegalResearchAuthorities(normalized).slice(0, 5);
  } catch {
    return [];
  }
}

function filterIrrelevantQueryParsingGrounds(grounds: string[], evidenceText: string) {
  const t = normalizeForParsing(evidenceText || "").toLowerCase();
  const allowFamily = /(domestic violence|maintenance|dowry|divorce|custody|succession|partition|family dispute|matrimonial)/.test(t);
  const allowInvoiceRecovery = /(invoice|invoices|outstanding amount|payment due|ledger|invoice recovery)/.test(t);
  const allowPropertyTitleReview = /(mortgage|encumbrance|title deed|title document|registration|sale deed|loan against property|property papers)/.test(t);
  return (grounds || []).filter((g) => {
    const x = String(g || "").toLowerCase();
    if (!allowFamily && /(domestic violence|maintenance|dowry|divorce|succession|partition|family)/.test(x)) return false;
    if (!allowInvoiceRecovery && /invoice recovery/.test(x)) return false;
    if (!allowPropertyTitleReview && /(property title|encumbrance review)/.test(x)) return false;
    return true;
  });
}

function filterIrrelevantQueryParsingIssueGroups(
  groups: Array<{ title: string; description: string; priority: "high" | "medium" | "low" }>,
  evidenceText: string,
) {
  const t = normalizeForParsing(evidenceText || "").toLowerCase();
  if (!t.trim()) return groups;
  const supportTokens = new Set(t.split(/\s+/).map((token) => token.trim()).filter((token) => token.length >= 4));
  const filtered = (groups || []).filter((group) => {
    const groupText = normalizeForParsing(`${group.title} ${group.description}`).toLowerCase();
    const overlap = groupText
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 && supportTokens.has(token)).length;
    return overlap >= 1;
  });
  return filtered.length >= 2 ? filtered : groups.slice(0, Math.min(groups.length, 3));
}

function hasStatuteLikeReference(text: string) {
  return /\b(section|sec\.|act|code|order\s+[ivxlcdm]+)\b/i.test(String(text || ""));
}

function stripStatuteLikeReference(text: string) {
  return String(text || "")
    .replace(/\bsection\s+\d+[a-z]?\b/gi, "")
    .replace(/\bsec\.?\s+\d+[a-z]?\b/gi, "")
    .replace(/\border\s+[ivxlcdm]+\b/gi, "")
    .replace(/\b[a-z ]+ act,?\s*\d{4}\b/gi, "")
    .replace(/\b[a-z ]+ code\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

function splitSentences(text: string) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!??])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizedForComparison(text: string) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isInstructionHeavyQueryText(text: string) {
  const value = normalizedForComparison(text);
  if (!value) return false;
  const instructionPhrases = [
    "perform a complete legal analysis",
    "analyze this",
    "assess this",
    "identify the parties",
    "identify the underlying transaction",
    "identify the key contract terms",
    "state what should be prepared next",
    "clearly separate",
    "if terms such as",
    "also state",
  ];
  const instructionHits = instructionPhrases.reduce((acc, phrase) => acc + (value.includes(phrase) ? 1 : 0), 0);
  const commaCount = (value.match(/,/g) || []).length;
  return instructionHits >= 2 || commaCount >= 6;
}

function normalizedSentenceKey(sentence: string) {
  return sentence
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeNearDuplicateSentences(sentences: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of sentences) {
    const key = normalizedSentenceKey(s);
    if (!key) continue;
    if (seen.has(key)) continue;
    const isNearDup = out.some((existing) => {
      const a = normalizedSentenceKey(existing);
      return a && (a.includes(key) || key.includes(a));
    });
    if (isNearDup) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function repeatedBigramCount(text: string) {
  const tokens = normalizedSentenceKey(text).split(" ").filter(Boolean);
  const counts = new Map<string, number>();
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const bg = `${tokens[i]} ${tokens[i + 1]}`;
    counts.set(bg, (counts.get(bg) || 0) + 1);
  }
  let repeated = 0;
  for (const [, count] of counts) {
    if (count > 1) repeated += count - 1;
  }
  return repeated;
}

function cleanupRepeatedPhrases(text: string) {
  let value = String(text || "");
  value = value
    .replace(/\bsend legal notice and send legal notice\b/gi, "send legal notice")
    .replace(/\bfile a case and file a case\b/gi, "file a case")
    .replace(/\bthe user is seeking\s+([^.,;]+)\s+and\s+\1\b/gi, "the user is seeking $1")
    .replace(/\bthe user seeks seek\b/gi, "the user seeks");
  // Remove boilerplate summary framing so summaries stay case-specific.
  value = value
    .replace(/^This appears to be a[n]?\s+/i, "")
    .replace(/^This appears to be\s+/i, "")
    .replace(/^The matter appears to involve\s+/i, "")
    .replace(/\bconnected to the stated jurisdiction\b/gi, "")
    .replace(/\bdispute facts extracted from the user query and case materials\b/gi, "facts from the submitted inputs");
  return value.replace(/\s+/g, " ").trim();
}

function removeDomainHallucinationTerms(summary: string, domain: string, subtype?: string | null) {
  let out = summary;
  const lowerDomain = String(domain || "").toLowerCase();
  const lowerSubtype = String(subtype || "").toLowerCase();
  const isFamilyMaintenance = lowerSubtype.includes("family_maintenance_dv");
  const isFamilyDivorce = lowerSubtype.includes("family_divorce_custody") || lowerSubtype.includes("family_marriage_dispute");
  const propertySuccession = lowerSubtype.includes("property_partition_succession");
  if ((isFamilyMaintenance || isFamilyDivorce) && !propertySuccession) {
    out = out.replace(/\bsuccession(?: and property-ownership)?\b/gi, "family");
    out = out.replace(/\bproperty-ownership\b/gi, "family");
    out = out.replace(/\bpartition\b/gi, "family dispute");
  }
  if (!lowerDomain.includes("property") && !propertySuccession) {
    out = out.replace(/\bsuccession\b/gi, "rights");
    out = out.replace(/\binheritance\b/gi, "rights");
  }
  return out.replace(/\s+/g, " ").trim();
}

function polishExecutiveSummaryText(summary: string, opts: {
  factSentence?: string;
  disputeSentence?: string;
  askSentence?: string;
  urgencySentence?: string;
}) {
  let sentences = dedupeNearDuplicateSentences(splitSentences(cleanupRepeatedPhrases(summary)));

  // Ensure structure order: facts -> dispute -> asks -> urgency
  const structured = [opts.factSentence, opts.disputeSentence, opts.askSentence, opts.urgencySentence]
    .filter(Boolean)
    .map((s) => String(s).trim())
    .filter(Boolean);

  if (structured.length) {
    const merged = [...structured, ...sentences];
    sentences = dedupeNearDuplicateSentences(merged);
  }

  sentences = sentences.slice(0, 4);
  if (sentences.length > 2) {
    // keep 2-4 sentences max; if too many short fragments, compress to 3
    const compact: string[] = [];
    for (const s of sentences) {
      if (compact.length && compact[compact.length - 1].length < 60 && s.length < 80 && compact.length >= 2) {
        compact[compact.length - 1] = `${compact[compact.length - 1].replace(/[.?]\s*$/, "")}; ${s}`;
      } else {
        compact.push(s);
      }
    }
    sentences = compact.slice(0, 4);
  }
  if (sentences.length < 2 && structured.length >= 2) {
    sentences = structured.slice(0, 2);
  }
  // Keep at most one ask sentence to avoid repetitive "The user seeks..." lines.
  let seenAsk = false;
  sentences = sentences.filter((s) => {
    if (!/\bthe user seeks\b/i.test(s)) return true;
    if (seenAsk) return false;
    seenAsk = true;
    return true;
  });
  let output = cleanupRepeatedPhrases(sentences.join(" ").trim());
  // Final anti-template cleanup for repetitive deterministic phrasing.
  output = output
    .replace(/\bThis appears to be a[n]?\b/gi, "")
    .replace(/\bThis appears to be\b/gi, "")
    .replace(/\bThe matter appears to involve\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (repeatedBigramCount(output) > 3) {
    output = dedupeNearDuplicateSentences(splitSentences(output)).slice(0, 4).join(" ");
    output = cleanupRepeatedPhrases(output);
  }
  // Normalize sentence casing for professional readability.
  output = output.replace(/(^|[.!?]\s+)([a-z])/g, (_m, p1, p2) => `${p1}${String(p2).toUpperCase()}`);
  return output;
}

function looksLikeDeterministicTemplateSummary(summary: string) {
  const text = normalizedSentenceKey(summary);
  if (!text) return true;
  return [
    "dispute context is connected to",
    "key facts indicate",
    "the user seeks",
    "facts from the submitted inputs",
    "civil litigation finance dispute context",
    "consumer service dispute context",
    "employment dispute context",
  ].some((pattern) => text.includes(pattern));
}

function cleanEvidenceSentence(text: string) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/^[^a-z0-9\u0900-\u0d7f]+/i, "")
    .replace(/\bverification\b/gi, "")
    .replace(/\bpleased to consider\b/gi, "")
    .replace(/\bin default of your appearance\b/gi, "")
    .replace(/\bappear in court\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function evidenceLedExecutiveSummary(input: {
  citations: Citation[];
  domain: string;
  jurisdiction: string | null;
  state: string | null;
  issueGroups: Array<{ title: string; description: string; priority: "high" | "medium" | "low" }>;
  requestedOutcomes: string[];
}) {
  const evidenceLines = dedupeNearDuplicateSentences(
    (input.citations || [])
      .filter((c) => String(c?.source_type || "").toLowerCase() === "user_doc")
      .map((c) => cleanEvidenceSentence(String(c?.snippet || "")))
      .filter((line) => line.length >= 28),
  ).slice(0, 2);
  const issueLine = (input.issueGroups || [])
    .slice(0, 2)
    .map((group) => String(group?.title || "").trim())
    .filter(Boolean)
    .join(" and ");
  const requested = [...new Set((input.requestedOutcomes || []).map((x) => String(x || "").replaceAll("_", " ").trim()).filter(Boolean))].slice(0, 2);
  const location = [input.state, input.jurisdiction].filter(Boolean).join(", ");
  const summaryParts: string[] = [];
  if (evidenceLines[0]) {
    summaryParts.push(`${trimToMaxWords(evidenceLines[0], 28).replace(/[.;,:-]*$/, "")}.`);
  }
  if (evidenceLines[1]) {
    summaryParts.push(`${trimToMaxWords(evidenceLines[1], 26).replace(/[.;,:-]*$/, "")}.`);
  } else if (issueLine) {
    summaryParts.push(`The uploaded material currently supports issues around ${issueLine}.`);
  }
  if (requested.length) {
    summaryParts.push(`The record points toward next-step needs around ${requested.join(" and ")}.`);
  } else if (location) {
    summaryParts.push(`The present record is being assessed in the context of ${location}.`);
  } else {
    summaryParts.push(`The uploaded material is currently classified under ${input.domain}.`);
  }
  return polishExecutiveSummaryText(summaryParts.join(" "), {
    factSentence: summaryParts[0],
    disputeSentence: summaryParts[1],
    askSentence: summaryParts[2],
  });
}

function fallbackQueryCitations(queryText: string): Citation[] {
  const normalized = String(queryText || "").trim();
  if (!normalized) return [];
  if (isLikelyInstructionOrUiSnippet(normalized) || detectPromptTemplateQuery(normalized).likelyTemplate) return [];
  const parts = normalized
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((line) => line.match(/.{1,220}/g) || []);
  return parts.slice(0, 3).map((snippet, idx) => ({
    doc_id: "live_query",
    chunk_id: `live_query:${idx}`,
    snippet,
    source_type: "user_doc",
    source_label: "User Query",
  }));
}

function fallbackDocTextCitations(docsText: string, docId = "user_doc"): Citation[] {
  const normalized = String(docsText || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const chunks = (normalized.match(/.{1,220}(?:\s|$)/g) || [])
    .map((s) => s.trim())
    .filter(Boolean);
  return chunks.slice(0, 4).map((snippet, idx) => ({
    doc_id: docId,
    chunk_id: `doc_fallback:${idx}`,
    snippet,
    source_type: "user_doc",
    source_label: "USER_DOC",
  }));
}

function trimToMaxWords(text: string, maxWords = 25) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, maxWords)
    .join(" ");
}

function toStrictQueryCitations(
  citations: Citation[],
  queryText: string,
  seededSnippets?: Array<{ doc_id: string; chunk_id: string; snippet: string; source_type?: string }>,
) {
  const currentInputAllowed = Boolean(queryText.trim())
    && !isLikelyInstructionOrUiSnippet(queryText)
    && !detectPromptTemplateQuery(queryText).likelyTemplate;
  const out = (citations || []).map((c: any) => {
    const sourceTypeRaw = String(c.source_type || "user_doc").toLowerCase();
    const isCurrent = String(c.doc_id || "").startsWith("live_query");
    const normalizedSourceType = isCurrent
      ? "current_input"
      : (sourceTypeRaw === "legal_corpus" ? "legal_corpus" : "user_doc");
    return {
      source_type: normalizedSourceType,
      doc_id: isCurrent ? null : String(c.doc_id || ""),
      page: null,
      offset_start: null,
      offset_end: null,
      snippet: trimToMaxWords(c.snippet || "", 25),
      source_label: c.source_label || undefined,
    };
  }).filter((c: any) => {
    if (!c.snippet) return false;
    if (isLikelyInstructionOrUiSnippet(c.snippet)) return false;
    if (String(c.source_type || "").toLowerCase() === "current_input" && detectPromptTemplateQuery(String(c.snippet || "")).likelyTemplate) return false;
    return true;
  });
  const hasCurrent = out.some((c: any) => c.source_type === "current_input");
  const hasUserDoc = out.some((c: any) => c.source_type === "user_doc");
  if (currentInputAllowed && !hasCurrent) {
    out.unshift({
      source_type: "current_input",
      doc_id: null,
      page: null,
      offset_start: null,
      offset_end: null,
      snippet: trimToMaxWords(queryText, 25),
      source_label: "CURRENT_INPUT",
    });
  }
  if (Array.isArray(seededSnippets) && seededSnippets.length && !hasUserDoc) {
    const docSnippet = seededSnippets.find((s) => !String(s.doc_id || "").startsWith("live_query"));
    if (docSnippet?.snippet) {
      out.push({
        source_type: "user_doc",
        doc_id: String(docSnippet.doc_id || ""),
        page: null,
        offset_start: null,
        offset_end: null,
        snippet: trimToMaxWords(docSnippet.snippet, 25),
        source_label: "USER_DOC",
      });
    }
  }
  const dedup: any[] = [];
  const seen = new Set<string>();
  for (const c of out) {
    const k = `${c.source_type}:${c.doc_id || ""}:${String(c.snippet || "").toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(c);
  }
  return dedup.slice(0, Math.max(3, Math.min(5, dedup.length)));
}

function titleCaseWords(text: string) {
  return String(text || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function inferCaseTitle(input: { domain: string; subtype?: string | null; queryText: string; state?: string | null; keyFacts?: any; titleHint?: string | null }) {
  const titleHint = String(input.titleHint || "").trim();
  if (titleHint) return titleHint.slice(0, 96);
  const q = normalizeForParsing(input.queryText || "").toLowerCase();
  const subtype = String(input.subtype || "").toLowerCase();
  const domain = String(input.domain || "").toLowerCase();
  const amount = (input.keyFacts?.outstanding_amount_inr != null && Number.isFinite(input.keyFacts?.outstanding_amount_inr))
    ? `INR ${Number(input.keyFacts.outstanding_amount_inr).toLocaleString("en-IN")}`
    : "";

  const subtypeTitles: Record<string, string> = {
    tenancy_deposit: "Tenancy Deposit Refund Dispute",
    consumer_defect_refund: "Consumer Defect and Refund Dispute",
    civil_injunction_finance: "Civil Injunction and Finance Dispute",
    commercial_contract_supply: "Commercial Contract and Supply Dispute",
  };
  const subtypeKey = Object.keys(subtypeTitles).find((k) => subtype.includes(k));
  let coreTitle = subtypeKey
    ? subtypeTitles[subtypeKey]
    : domain.includes("consumer")
      ? "Consumer Service Dispute"
      : domain.includes("contract")
        ? "Commercial Contract Dispute"
        : domain.includes("employment")
          ? "Employment Dues and Termination Dispute"
          : domain.includes("property")
            ? "Property and Tenancy Dispute"
            : domain.includes("civil litigation / finance")
              ? "Civil Finance Dispute"
              : "Civil Dispute";

  const titleAddons: Array<[RegExp, string]> = [
    [/\binjunction\b/, "Injunction Relief"],
    [/\bdeposit\b/, "Deposit Recovery"],
    [/\brefund\b/, "Refund Claim"],
    [/\bpayment|invoice|outstanding\b/, "Payment Recovery"],
    [/\bdefect|warranty|replacement\b/, "Product Defect"],
    [/\bharass|harassment\b/, "Harassment Allegation"],
  ];
  const addon = titleAddons.find(([re]) => re.test(q))?.[1] || "";
  if (addon && !coreTitle.toLowerCase().includes(addon.toLowerCase())) {
    coreTitle = `${coreTitle} - ${addon}`;
  }

  const suffix = input.state
    ? ` - ${titleCaseWords(String(input.state).trim())}`
    : amount
      ? ` - ${amount}`
      : "";
  const maxBaseLen = Math.max(24, 96 - suffix.length);
  const base = titleCaseWords(coreTitle).replace(/\s+/g, " ").trim().slice(0, maxBaseLen);
  return `${base}${suffix}`.slice(0, 96);
}

type LegalDocumentProfile = {
  document_kind: string | null;
  court_name: string | null;
  case_numbers: string[];
  parties: Array<{ name: string; role: string }>;
  reliefs_claimed: string[];
  filing_stage: string | null;
  dispute_summary: string | null;
  issue_hints: string[];
  legal_ground_hints: string[];
  title_hint: string | null;
  state_hint: string | null;
  prefers_doc_summary: boolean;
};

function splitLinesForLegalExtraction(text: string) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((line) => normalizeForParsing(line).replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function dedupeStringsCaseInsensitive(values: string[], limit = 6) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values || []) {
    const clean = String(value || "").replace(/\s+/g, " ").trim();
    const key = clean
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeWhitespaceInline(text: string) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function extractDocumentSection(text: string, startPattern: RegExp, stopPatterns: RegExp[], maxChars = 3200) {
  const raw = String(text || "");
  const start = raw.search(startPattern);
  if (start < 0) return "";
  const tail = raw.slice(start);
  let end = tail.length;
  for (const stopPattern of stopPatterns) {
    const stopIndex = tail.slice(1).search(stopPattern);
    if (stopIndex >= 0) end = Math.min(end, stopIndex + 1);
  }
  return tail.slice(0, Math.min(end, maxChars)).trim();
}

function extractBriefFactsSection(text: string) {
  return extractDocumentSection(
    text,
    /\bbrief facts of the case\s*:?\b/i,
    [
      /\b(?:cause of action|jurisdiction|res-judicata|court fee|prayer|verification)\b/i,
    ],
    3600,
  );
}

function extractPrayerSection(text: string) {
  return extractDocumentSection(
    text,
    /\b(?:\d+\.\s*)?prayer\s*:?\b/i,
    [
      /\b(?:verification|filed by|advocate for the plaintiff|duplicate copy of plaint|schedule of property|annexure)\b/i,
    ],
    2400,
  );
}

function parseAmountNumber(raw: string) {
  const numeric = Number(String(raw || "").replace(/,/g, "").replace(/\/-$/, "").trim());
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizePartyRole(raw: string) {
  const value = String(raw || "").toLowerCase();
  const ordinalMatch = value.match(/\b(\d+(?:st|nd|rd|th))\s+(respondent|defendant)\b/);
  if (ordinalMatch) return `${ordinalMatch[1]} ${titleCaseWords(ordinalMatch[2])}`;
  if (value.includes("petitioner")) return "Petitioner";
  if (value.includes("plaintiff")) return "Plaintiff";
  if (value.includes("respondent")) return "Respondent";
  if (value.includes("defendant")) return "Defendant";
  if (value.includes("complainant")) return "Complainant";
  if (value.includes("appellant")) return "Appellant";
  if (value.includes("opposite party")) return "Opposite Party";
  return titleCaseWords(value || "Party");
}

function sanitizePartyCandidate(value: string) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[,;:.\- ]+|[,;:.\- ]+$/g, "")
    .replace(/^\b(to|between|and)\b\s*/i, "")
    .replace(/\b(petitioner|plaintiff|respondent|defendant|complainant|appellant|opposite party)(?:s)?(?:\/[a-z]+)?\b/gi, "")
    .replace(/\b(and|vs\.?|versus|against)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function isWeakPartyCandidate(value: string) {
  const clean = sanitizePartyCandidate(value);
  if (!clean || clean.length < 3) return true;
  if (!/[a-z]/i.test(clean)) return true;
  if (clean === clean.toLowerCase() && !/\b(bank|limited|ltd|private|pvt|technologies|finance|services|card)\b/i.test(clean)) return true;
  if (/\b(court|judge|petition|plaint|notice|affidavit|application|ia no|os no|case no|prayer)\b/i.test(clean)) return true;
  if (/\b(filed on behalf|process memo|advocate for|advocates for|duplicate copy|behalf of the)\b/i.test(clean)) return true;
  if (/^(to the|before the|in the court)/i.test(clean)) return true;
  return false;
}

function isLikelyAddressLine(value: string) {
  const line = normalizeWhitespaceInline(value);
  if (!line) return true;
  if (/\b(bank|finance|technologies|limited|ltd|private|pvt|services)\b/i.test(line)) return false;
  if (/^(email|e-mail|ph|phone|mobile|pin|pincode)\b/i.test(line)) return true;
  if (/\b(survey no|plot no|unit\b|floor\b|sector\b|road\b|rd\b|street\b|lane\b|nagar\b|complex\b|tower\b|office\b|branch\b|village\b|mandal\b|district\b|near\b|old\b|west bay\b|baner\b|mumbai\b|pune\b|guruh?gram\b|gurugram\b|chennai\b|thrissur\b|vadodara\b|maharashtra\b|haryana\b|kerala\b|tamil nadu\b|gujarat\b|india\b)\b/i.test(line)) return true;
  if (/\b\d{5,6}\b/.test(line)) return true;
  return false;
}

function extractRespondentNameFromBlock(blockText: string) {
  const lines = String(blockText || "")
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((line) => normalizeWhitespaceInline(line))
    .filter(Boolean);
  const candidateLines = lines
    .map((line) => line.replace(/^to\b\s*/i, "").replace(/^the manager,?\s*/i, "").replace(/^manager,?\s*/i, "").trim())
    .filter(Boolean);
  if (!candidateLines.length) return "";
  const informative = candidateLines.filter((line) => !isLikelyAddressLine(line));
  const compactEntityLine = (line: string) => {
    const segments = line.split(",").map((segment) => normalizeWhitespaceInline(segment)).filter(Boolean);
    const kept: string[] = [];
    for (const segment of segments) {
      if (kept.length >= 2) break;
      if (isLikelyAddressLine(segment)) break;
      kept.push(segment);
      if (/\b(bank|finance|technologies|limited|ltd|private|pvt|services)\b/i.test(segment)) break;
    }
    return kept.join(", ");
  };
  const primary = compactEntityLine(informative[0] || candidateLines[0]);
  const secondary = compactEntityLine(informative[1] || "");
  const normalizeInstitutionSurface = (value: string) => sanitizePartyCandidate(value)
    .replace(/\b(and\s+\d+\s+other)\b/gi, "")
    .replace(/\bthe manager\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const primaryClean = normalizeInstitutionSurface(primary);
  const secondaryClean = normalizeInstitutionSurface(secondary);
  if (!secondaryClean) return primaryClean;
  if (secondaryClean.toLowerCase().includes(primaryClean.toLowerCase())) return secondaryClean;
  if (/^(rbl bank|csb bank limited|axis bank ltd|icici bank towers?|bajaj finance limited|bajaj finserv)\b/i.test(secondaryClean)) return secondaryClean;
  if (/^(rbl bank|csb bank|axis|icici|bajaj finserv)\b/i.test(primaryClean) && /\b(bank|finance|technologies|limited|ltd|private|pvt|services)\b/i.test(secondaryClean)) {
    return `${primaryClean} / ${secondaryClean}`.replace(/\s+/g, " ").trim();
  }
  if (/^(one card|jupitar|axis|icici|rbl bank|bajaj finserv)\b/i.test(primaryClean) || /\b(bank|finance|technologies|limited|ltd|services|private)\b/i.test(secondaryClean)) {
    return `${primaryClean} / ${secondaryClean}`.replace(/\s+/g, " ").trim();
  }
  return primaryClean;
}

function extractPartiesFromLegalDocument(text: string) {
  const lines = splitLinesForLegalExtraction(text);
  const out: Array<{ name: string; role: string }> = [];
  const push = (nameRaw: string, roleRaw: string) => {
    const role = normalizePartyRole(roleRaw);
    const name = sanitizePartyCandidate(nameRaw);
    if (isWeakPartyCandidate(name)) return;
    const key = `${role.toLowerCase()}::${name.toLowerCase()}`;
    if (out.some((item) => `${item.role.toLowerCase()}::${item.name.toLowerCase()}` === key)) return;
    out.push({ name, role });
  };

  const normalized = normalizeForParsing(text).replace(/\s+/g, " ");
  const betweenMatch = normalized.match(/\bBetween:\s*(.+?)\s*\.*\s*(Petitioner\/Plaintiff|Plaintiff|Petitioner)\b/i);
  if (betweenMatch) push(betweenMatch[1], betweenMatch[2]);
  const respondentBlocks = [...String(text || "").matchAll(/\bTo\s+([\s\S]{20,320}?)\.\.\.\s*(\d+(?:st|nd|rd|th))\s+Respondent\b/gi)];
  if (respondentBlocks.length) {
    for (const match of respondentBlocks.slice(0, 6)) {
      const respondentName = extractRespondentNameFromBlock(match[1]);
      if (respondentName) push(respondentName, `${match[2]} Respondent`);
    }
  } else {
    const andMatch = normalized.match(/\bAnd\s+(.+?)\s*\.*\s*(Respondents?\/Defendants?|Respondent\/Defendant|Respondent|Defendant)\b/i);
    if (andMatch) push(andMatch[1], andMatch[2]);
  }
  for (const match of normalized.matchAll(/\b(\d+(?:st|nd|rd|th)\s+DEFENDANT)\s*:\s*([^.:]{6,180})/gi)) {
    push(match[2], match[1]);
  }

  const inlineRolePatterns = respondentBlocks.length
    ? [
        /(.+?)\s+(petitioner\/plaintiff|petitioner|plaintiff)\b/i,
        /(.+?)\s+(complainant|appellant|opposite party)\b/i,
      ]
    : [
        /(.+?)\s+(petitioner\/plaintiff|petitioner|plaintiff)\b/i,
        /(.+?)\s+(respondents?\/defendants?|respondent\/defendant|respondent|defendant)\b/i,
        /(.+?)\s+(complainant|appellant|opposite party)\b/i,
      ];
  for (const line of lines) {
    for (const pattern of inlineRolePatterns) {
      const match = line.match(pattern);
      if (!match) continue;
      push(match[1], match[2]);
    }
  }

  const roleLinePattern = respondentBlocks.length
    ? /\b(petitioner\/plaintiff|petitioner|plaintiff|complainant|appellant|opposite party)\b/i
    : /\b(petitioner\/plaintiff|petitioner|plaintiff|respondents?\/defendants?|respondent\/defendant|respondent|defendant|complainant|appellant|opposite party)\b/i;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(roleLinePattern);
    if (!match) continue;
    const inlineSuffix = sanitizePartyCandidate(line.replace(roleLinePattern, ""));
    if (inlineSuffix && !isWeakPartyCandidate(inlineSuffix)) {
      push(inlineSuffix, match[1]);
      continue;
    }
    const previous = lines[index - 1] || "";
    const next = lines[index + 1] || "";
    if (!isWeakPartyCandidate(previous)) push(previous, match[1]);
    else if (!isWeakPartyCandidate(next)) push(next, match[1]);
  }

  const cleaned = respondentBlocks.length
    ? out.filter((item) => !/defendant/i.test(item.role))
    : out;
  const normalizedParties: Array<{ name: string; role: string }> = [];
  let seenPrimaryClaimant = false;
  for (const item of cleaned) {
    if (/^(petitioner|plaintiff)$/i.test(item.role)) {
      if (seenPrimaryClaimant) continue;
      seenPrimaryClaimant = true;
    }
    normalizedParties.push(item);
  }
  return normalizedParties.slice(0, 8);
}

function extractCourtName(text: string) {
  const lines = splitLinesForLegalExtraction(text);
  const start = lines.findIndex((line) => /\b(in the court of|before the)\b/i.test(line));
  if (start >= 0) {
    const block = lines
      .slice(start, start + 4)
      .filter((line) => !/\b(i\.a\. notice|i\.a\. no\b|o\.s\.?no\b|between:|to)\b/i.test(line) && !/^in$/i.test(line))
      .join(" ")
      .replace(/\s+/g, " ")
      .replace(/\s+in$/i, "")
      .trim();
    if (block) return block;
  }
  const normalized = normalizeForParsing(text);
  const courtMatch =
    normalized.match(/\b(in the court of[^.\n]{10,180})/i)?.[1] ||
    normalized.match(/\b(before the [^.\n]{10,180})/i)?.[1] ||
    null;
  return courtMatch ? courtMatch.replace(/\s+/g, " ").trim() : null;
}

function extractCaseNumbers(text: string) {
  const values: string[] = [];
  const formatRef = (label: string, serial?: string | null, year?: string | null) => {
    const serialClean = normalizeWhitespaceInline(String(serial || "").replace(/^[,.: -]+|[,.: -]+$/g, ""));
    const yearClean = String(year || "").trim();
    if (serialClean && yearClean) return `${label} No. ${serialClean} of ${yearClean}`;
    if (serialClean) return `${label} No. ${serialClean}`;
    if (yearClean) return `${label} No. of ${yearClean}`;
    return `${label} No.`;
  };
  const lines = splitLinesForLegalExtraction(text);
  const normalizeLineRef = (line: string, label: string) => {
    const serial = line.match(/\bno\.?\s*([0-9./-]+)\b/i)?.[1] || null;
    const year = line.match(/\bof\s*(\d{4})\b/i)?.[1] || null;
    return formatRef(label, serial, year);
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/\bi\.a\. notice\b/i.test(line)) continue;
    if (/\b(?:i\.?\s*a\.?|ia)\s*no\.?\b/i.test(line)) {
      const iaRef = normalizeLineRef(line, "I.A.");
      const next = lines[index + 1] || "";
      const nextNext = lines[index + 2] || "";
      if (/^in$/i.test(next) && /\b(?:o\.?\s*s\.?|os)\s*no\.?\b/i.test(nextNext)) {
        values.push(`${iaRef} in ${normalizeLineRef(nextNext, "O.S.")}`);
        index += 2;
        continue;
      }
      values.push(iaRef);
      continue;
    }
    if (/\b(?:o\.?\s*s\.?|os)\s*no\.?\b/i.test(line)) {
      values.push(normalizeLineRef(line, "O.S."));
      continue;
    }
    if (/\b(?:c\.?\s*s\.?|cs)\s*no\.?\b/i.test(line)) values.push(normalizeLineRef(line, "C.S."));
    else if (/\b(?:w\.?\s*p\.?|wp)\s*no\.?\b/i.test(line)) values.push(normalizeLineRef(line, "W.P."));
    else if (/\b(?:c\.?r\.?p\.?|crp)\s*no\.?\b/i.test(line)) values.push(normalizeLineRef(line, "C.R.P."));
    else if (/\b(?:c\.?m\.?a\.?|cma)\s*no\.?\b/i.test(line)) values.push(normalizeLineRef(line, "C.M.A."));
  }
  const deduped = dedupeStringsCaseInsensitive(values, 6);
  const combined = deduped.filter((item) => /\bin O\.S\./i.test(item));
  return combined.length ? combined : deduped;
}

function detectLegalDocumentKind(text: string) {
  const lower = normalizeForParsing(text).toLowerCase();
  if (/\b(plaintiff|defendant|petitioner|respondent|prayer|relief sought|petition for|plaint)\b/.test(lower) && /\b(court|judge|jurisdiction)\b/.test(lower)) return "court_pleading";
  if (/\b(order|judgment|decree|pronounced)\b/.test(lower) && /\b(court|judge|justice)\b/.test(lower)) return "court_order_or_judgment";
  if (/\b(legal notice|demand notice|notice under|you are hereby called upon)\b/.test(lower)) return "legal_notice";
  if (/\b(reply notice|reply to the notice|without prejudice)\b/.test(lower)) return "reply_notice";
  if (/\b(consumer complaint|complainant|opposite party)\b/.test(lower)) return "complaint";
  if (/\b(affidavit|sworn|solemnly affirm)\b/.test(lower)) return "affidavit";
  if (/\b(agreement|this agreement|whereas|party of the first part|party of the second part)\b/.test(lower)) return "contract_or_agreement";
  if (/\b(invoice|ledger|statement of account|purchase order)\b/.test(lower)) return "commercial_record";
  return null;
}

function extractReliefsFromLegalDocument(text: string, requestedOutcomes: string[] = []) {
  const lower = normalizeForParsing(text).toLowerCase();
  const reliefs: string[] = [];
  const prayerSection = normalizeForParsing(extractPrayerSection(text)).replace(/\s+/g, " ");
  const push = (value: string) => {
    const clean = String(value || "").replace(/\s+/g, " ").trim();
    const key = clean.toLowerCase().replace(/[_-]+/g, " ");
    if (!clean) return;
    if (reliefs.some((item) => item.toLowerCase().replace(/[_-]+/g, " ").trim() === key)) return;
    reliefs.push(clean);
  };
  if (/\bpermanent injunction\b/.test(prayerSection) && /\bpeaceful possession and enjoyment\b/.test(prayerSection)) {
    push("permanent injunction restraining interference with peaceful possession and enjoyment of the plaint schedule property");
  } else if (/\b(interim injunction|temporary injunction|permanent injunction|restrain)\b/.test(lower)) {
    push("injunction / restraint relief");
  }
  if (/\bpetition for interim injunction\b/.test(lower) || /\bi\.a\. notice\b/.test(lower)) push("interim injunction in the connected I.A. proceedings");
  if (/\bcosts of the suit\b/.test(prayerSection)) push("costs of the suit");
  if (/\b(recovery of amount|recover|payment due|outstanding amount|loan recovery)\b/.test(lower)) push("payment / amount recovery");
  if (/\b(refund)\b/.test(lower)) push("refund claim");
  if (/\b(replacement)\b/.test(lower)) push("replacement relief");
  if (/\b(compensation|damages)\b/.test(lower)) push("compensation / damages");
  if (/\b(declaration|declare)\b/.test(lower)) push("declaratory relief");
  if (!reliefs.some((item) => /peaceful possession|injunction/i.test(item)) && /\b(possession|handover possession|vacate)\b/.test(lower)) push("possession-related relief");
  if (/\b(eviction)\b/.test(lower)) push("eviction relief");
  if (/\b(partition)\b/.test(lower)) push("partition relief");
  if (/\b(maintenance)\b/.test(lower)) push("maintenance support");
  if (/\b(specific performance)\b/.test(lower)) push("specific performance");
  for (const outcome of requestedOutcomes || []) {
    const normalizedOutcome = String(outcome || "").replaceAll("_", " ").trim().toLowerCase();
    const mapped =
      normalizedOutcome === "seek injunction relief" ? "injunction / restraint relief" :
      normalizedOutcome === "payment recovery" ? "payment / amount recovery" :
      normalizedOutcome === "damages or compensation" ? "compensation / damages" :
      normalizedOutcome;
    push(mapped);
  }
  const normalizedReliefs = reliefs.filter((item) =>
    !(item === "injunction / restraint relief" && reliefs.some((other) => other !== item && /permanent injunction/i.test(other)))
  );
  return normalizedReliefs.slice(0, 6);
}

function extractProceduralStage(text: string, documentKind: string | null) {
  const lower = normalizeForParsing(text).toLowerCase();
  const hasIaNotice = /\bi\.a\. notice\b/.test(lower);
  const hasPlaint = /\bduplicate copy of plaint\b|\bplaint filed on behalf of\b|\bprayer:\b/.test(lower);
  if (hasIaNotice && hasPlaint) return "civil suit with connected interim injunction proceedings";
  if (/\b(interim injunction|temporary injunction|urgent interim relief)\b/.test(lower)) return "interim relief stage";
  if (/\b(plaint filed|petition filed|complaint filed|filed on behalf of the plaintiff|filed on behalf of the petitioner)\b/.test(lower)) return "initial filing stage";
  if (documentKind === "court_order_or_judgment") return "order / judgment stage";
  if (/\b(legal notice|demand notice|reply notice)\b/.test(lower)) return "pre-litigation notice stage";
  if (/\b(counter|written statement|reply affidavit|objection)\b/.test(lower)) return "response / counter stage";
  if (/\b(appeal|revision)\b/.test(lower)) return "appellate / revision stage";
  return null;
}

function extractDisputeSummary(text: string, domain: string) {
  const rawCompact = String(text || "").replace(/\s+/g, " ").trim();
  const normalized = normalizeForParsing(text).replace(/\s+/g, " ");
  const briefFactsSection = normalizeForParsing(extractBriefFactsSection(text)).replace(/\s+/g, " ");
  if (briefFactsSection) {
    const totalMatch = normalized.match(/\btotal\s+([0-9,]+(?:\.\d+)?)/i);
    const totalBorrowed = totalMatch ? parseAmountNumber(totalMatch[1]) : null;
    const lendersMatch = normalized.match(/\b(\d+)\.\s+[a-z].+?\btotal\b/i);
    const lenderCount = lendersMatch ? Number(lendersMatch[1]) : null;
    if (/\bborrowed loans?\b/.test(briefFactsSection) && /\bharass|illegal approach|public roads|residence\b/.test(briefFactsSection)) {
      const amountPart = totalBorrowed ? ` involving roughly INR ${Math.round(totalBorrowed).toLocaleString("en-IN")}` : "";
      const lenderPart = lenderCount && lenderCount > 1 ? ` from ${lenderCount} lending institutions` : "";
      return `The plaintiff says he borrowed loans${lenderPart}${amountPart}, later defaulted after business loss, and is now facing alleged unlawful recovery harassment at his residence and in public places.`;
    }
    return trimToMaxWords(briefFactsSection.replace(/^brief facts of the case\s*:?\s*/i, ""), 42);
  }
  const affidavitFactsMatch =
    rawCompact.match(/\bi respectfully submit that\s*(.+?)(?:\bas there is no other way|\bhence this suit arose|\bprayer\b)/i) ||
    normalized.match(/\bi respectfully submit that\s*(.+?)(?:\bas there is no other way|\bhence this suit arose|\bprayer\b)/i);
  if (affidavitFactsMatch?.[1]) {
    return trimToMaxWords(affidavitFactsMatch[1], 36);
  }
  const grievanceMatch =
    rawCompact.match(/\bborrowed loans? from the defendants?.+?(?:illegal manner|harassing.+?loan installments.+?residence)/i) ||
    normalized.match(/\bborrowed loans? from the defendants?.+?(?:illegal manner|harassing.+?loan installments.+?residence)/i);
  if (grievanceMatch?.[0]) {
    return trimToMaxWords(grievanceMatch[0], 34);
  }
  const lines = splitLinesForLegalExtraction(text);
  const candidate = lines.find((line) =>
    line.length >= 30 &&
    line.length <= 220 &&
    !/\b(in the court of|before the|petitioner|plaintiff|respondent|defendant|ia no|os no|case no|prayer|verification)\b/i.test(line) &&
    /\b(loan|payment|refund|replacement|property|partition|maintenance|termination|salary|harassment|injunction|notice|breach|defect|consumer|rent|deposit|possession|eviction)\b/i.test(line),
  );
  if (candidate) return trimToMaxWords(candidate, 28);
  return domain ? `${domain} dispute identified from the uploaded legal document.` : null;
}

function buildDocumentIssueHints(profile: LegalDocumentProfile, domain: string) {
  const lowerReliefs = profile.reliefs_claimed.map((item) => item.toLowerCase());
  const hints: string[] = [];
  if (profile.document_kind === "legal_notice" || profile.document_kind === "reply_notice") hints.push("Pre-litigation notice and demand strategy");
  if (lowerReliefs.some((item) => item.includes("injunction"))) hints.push("Civil injunction and urgent interim relief");
  if (lowerReliefs.some((item) => item.includes("payment") || item.includes("recovery"))) hints.push("Outstanding payments and invoice recovery");
  if (lowerReliefs.some((item) => item.includes("refund") || item.includes("replacement"))) hints.push("Refund / replacement remedy strategy");
  if (lowerReliefs.some((item) => item.includes("maintenance"))) hints.push("Family maintenance and support relief");
  if (lowerReliefs.some((item) => item.includes("partition"))) hints.push("Partition and succession rights of legal heirs");
  if (lowerReliefs.some((item) => item.includes("eviction"))) hints.push("Tenancy rights, possession handover, and landlord obligations");
  else if (lowerReliefs.some((item) => item.includes("possession"))) hints.push("Possession and property-protection relief");
  if (lowerReliefs.some((item) => item.includes("damages") || item.includes("compensation"))) hints.push("Interest and damages computation");
  if (profile.court_name || profile.case_numbers.length > 0) hints.push("Procedural posture and relief framing");
  if (!hints.length && domain) hints.push(`${domain} document review and issue framing`);
  return dedupeStringsCaseInsensitive(hints, 6);
}

function buildDocumentGroundHints(profile: LegalDocumentProfile, domain: string) {
  const out: string[] = [];
  const push = (value: string) => {
    if (!value) return;
    if (out.some((item) => item.toLowerCase() === value.toLowerCase())) return;
    out.push(value);
  };
  for (const issue of profile.issue_hints || []) {
    push(issue.toLowerCase());
  }
  if (profile.filing_stage) push(profile.filing_stage);
  if (profile.document_kind === "court_pleading") push("court pleading and relief analysis");
  if (profile.document_kind === "legal_notice") push("pre litigation notice compliance");
  if (!out.length && domain) push(`${domain.toLowerCase()} issue review`);
  return out.slice(0, 7);
}

function buildDocumentProfileTitle(profile: LegalDocumentProfile, domain: string, state: string | null) {
  const firstRole = profile.parties[0]?.role || "";
  const firstName = profile.parties[0]?.name || "";
  const secondRole = profile.parties[1]?.role || "";
  const injunctionLabel = profile.reliefs_claimed.some((item) => /permanent injunction/i.test(item))
    ? "Permanent Injunction"
    : profile.reliefs_claimed.some((item) => /injunction/i.test(item))
      ? "Injunction Relief"
      : "";
  if (profile.court_name && profile.case_numbers[0]) {
    return `${titleCaseWords(profile.document_kind === "court_order_or_judgment" ? "Court Order / Judgment" : "Court Case")}${injunctionLabel ? ` - ${injunctionLabel}` : ""} - ${profile.case_numbers[0]}`.slice(0, 96);
  }
  if (firstName && secondRole) {
    return `${firstRole || "Party"} vs ${secondRole}`.replace(/\s+/g, " ").trim().slice(0, 96);
  }
  if (profile.document_kind === "legal_notice") return `Legal Notice Review${state ? ` - ${state}` : ""}`.slice(0, 96);
  if (profile.document_kind === "court_pleading") return `${titleCaseWords(domain || "Civil Dispute")} Pleading`.slice(0, 96);
  return "";
}

function buildLegalDocumentProfile(input: {
  text: string;
  domain: string;
  subtype?: string | null;
  state?: string | null;
  requestedOutcomes?: string[];
}) {
  const court_name = extractCourtName(input.text);
  const case_numbers = extractCaseNumbers(input.text);
  const document_kind = detectLegalDocumentKind(input.text);
  const parties = extractPartiesFromLegalDocument(input.text);
  const reliefs_claimed = extractReliefsFromLegalDocument(input.text, input.requestedOutcomes || []);
  const filing_stage = extractProceduralStage(input.text, document_kind);
  const dispute_summary = extractDisputeSummary(input.text, input.domain);
  const state_hint = detectState(input.text, null) || input.state || null;
  const issue_hints = buildDocumentIssueHints({
    document_kind,
    court_name,
    case_numbers,
    parties,
    reliefs_claimed,
    filing_stage,
    dispute_summary,
    issue_hints: [],
    legal_ground_hints: [],
    title_hint: null,
    state_hint,
    prefers_doc_summary: false,
  }, input.domain);
  const legal_ground_hints = buildDocumentGroundHints({
    document_kind,
    court_name,
    case_numbers,
    parties,
    reliefs_claimed,
    filing_stage,
    dispute_summary,
    issue_hints,
    legal_ground_hints: [],
    title_hint: null,
    state_hint,
    prefers_doc_summary: false,
  }, input.domain);
  const title_hint = buildDocumentProfileTitle({
    document_kind,
    court_name,
    case_numbers,
    parties,
    reliefs_claimed,
    filing_stage,
    dispute_summary,
    issue_hints,
    legal_ground_hints,
    title_hint: null,
    state_hint,
    prefers_doc_summary: false,
  }, input.domain, state_hint);
  return {
    document_kind,
    court_name,
    case_numbers,
    parties,
    reliefs_claimed,
    filing_stage,
    dispute_summary,
    issue_hints,
    legal_ground_hints,
    title_hint,
    state_hint,
    prefers_doc_summary: Boolean(document_kind && document_kind !== "commercial_record"),
  } satisfies LegalDocumentProfile;
}

function mergeIssueGroupsWithDocumentHints(
  groups: Array<{ title: string; description: string; priority: "high" | "medium" | "low" }>,
  profile: LegalDocumentProfile,
) {
  const extras = (profile.issue_hints || []).map((title) => ({
    title,
    description: profile.dispute_summary || `Issue inferred from the uploaded ${profile.document_kind || "legal"} document.`,
    priority: /injunction|recovery|refund|maintenance|partition|eviction|possession/i.test(title) ? "high" as const : "medium" as const,
  }));
  const merged = [...(groups || []), ...extras];
  const seen = new Set<string>();
  return merged.filter((group) => {
    const key = String(group.title || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

function mergeLegalGroundsWithDocumentHints(grounds: string[], profile: LegalDocumentProfile) {
  return dedupeStringsCaseInsensitive([...(grounds || []), ...(profile.legal_ground_hints || [])], 7);
}

function enrichKeyFactsWithDocumentProfile(
  keyFacts: ReturnType<typeof extractKeyFacts>,
  profile: LegalDocumentProfile,
  state: string | null,
) {
  return {
    ...keyFacts,
    location: state || profile.state_hint || null,
    court_name: profile.court_name,
    case_numbers: profile.case_numbers,
    document_kind: profile.document_kind,
    filing_stage: profile.filing_stage,
    dispute_summary: profile.dispute_summary,
    reliefs_claimed: profile.reliefs_claimed,
    detailed_parties: profile.parties,
  };
}

function buildDocumentAwareExecutiveSummary(input: {
  profile: LegalDocumentProfile;
  domain: string;
  jurisdiction: string | null;
  state: string | null;
  requestedOutcomes: string[];
  inputMode?: string;
}) {
  const profile = input.profile;
  if (!profile.document_kind && !profile.court_name && !profile.reliefs_claimed.length && !profile.dispute_summary) return "";
  const location = [input.state || profile.state_hint, input.jurisdiction].filter(Boolean).join(", ");
  const partySummary = profile.parties.length
    ? profile.parties.slice(0, 2).map((party) => `${party.role}${party.name ? ` ${party.name}` : ""}`).join(" against ")
    : "";
  const kindLabel =
    profile.document_kind === "court_order_or_judgment" ? "court order/judgment" :
    profile.document_kind === "court_pleading" ? "court pleading" :
    profile.document_kind === "legal_notice" ? "legal notice" :
    profile.document_kind === "reply_notice" ? "reply notice" :
    profile.document_kind === "complaint" ? "complaint" :
    profile.document_kind === "affidavit" ? "affidavit" :
    profile.document_kind === "contract_or_agreement" ? "agreement/contract" :
    "legal case document";
  const inputMode = String(input.inputMode || "");
  const isPromptOnly = inputMode === "prompt_only";
  const summarySafeCourt = trimToMaxWords(String(profile.court_name || "").replace(/\s+in$/i, "").replace(/[.,;:\s]+$/g, ""), 22);
  const rawCaseRef = String(profile.case_numbers[0] || "").trim();
  const summarySafeCaseRef =
    /\bI\.A\. No\. of (\d{4}) in O\.S\. No\. of (\d{4})\b/i.test(rawCaseRef)
      ? `the connected IA and OS proceedings for ${rawCaseRef.match(/\d{4}/)?.[0] || "the current year"}`
      : rawCaseRef.replace(/I\.A\./g, "IA").replace(/O\.S\./g, "OS").replace(/\bNo\./g, "No");
  const factSentence = profile.court_name
    ? (isPromptOnly
        ? `The submitted case query references ${summarySafeCourt}${summarySafeCaseRef ? ` and relates to ${summarySafeCaseRef}` : ""}.`
        : `The uploaded ${kindLabel} is from ${summarySafeCourt}${summarySafeCaseRef ? ` and relates to ${summarySafeCaseRef}` : ""}.`)
    : (isPromptOnly
        ? `The submitted case query appears to describe a ${input.domain || "legal dispute"}.`
        : `The uploaded material appears to be a ${kindLabel} concerning ${input.domain || "a legal dispute"}.`);
  const summaryLower = String(profile.dispute_summary || "").toLowerCase();
  const amount = Number((profile as any)?.dispute_amount_inr || 0);
  const disputeSentence = /borrowed loans?|loan installments?|harass|residence|public roads/.test(summaryLower)
    ? `The plaint alleges loan-installment defaults after business loss, followed by unlawful recovery harassment at the plaintiff's residence and public places${amount > 0 ? `, with the pleaded borrowing exposure around INR ${amount.toLocaleString("en-IN")}` : ""}.`
    : /refund|replacement|defect|warranty/.test(summaryLower)
      ? "The complaint alleges a consumer defect / service failure and seeks a refund or replacement remedy."
      : /termination|salary|gratuity|pf|employment/.test(summaryLower)
        ? "The filing alleges employment-related termination or dues issues requiring review of process and recoverable claims."
        : /partition|succession|heir|property share/.test(summaryLower)
          ? "The filing concerns property / succession rights and seeks court-backed clarification of competing claims."
          : profile.dispute_summary
            ? `${profile.dispute_summary.replace(/[.;,:-]*$/, "")}.`
            : partySummary
      ? `The extracted record identifies ${partySummary}.`
      : `The current record is being mapped under ${input.domain || "the current dispute"}.`;
  const reliefSentence = profile.reliefs_claimed.length
    ? `Relief sought appears to include ${profile.reliefs_claimed.slice(0, 3).map((item) => item.replace(/I\.A\./g, "IA")).join(", ")}.`
    : input.requestedOutcomes.length
      ? `The likely requested outcome is ${input.requestedOutcomes.slice(0, 2).join(" and ").replaceAll("_", " ")}.`
      : location
        ? `The matter is being assessed in the context of ${location}.`
        : "";
  return polishExecutiveSummaryText([factSentence, disputeSentence, reliefSentence].filter(Boolean).join(" "), {
    factSentence,
    disputeSentence,
    askSentence: reliefSentence || undefined,
  });
}

function buildQueryParsingCorePayload(input: {
  queryText: string;
  languageCode: string;
  languageName: string;
  languageConfidence: number;
  jurisdiction: string | null;
  legalDomain: string;
  legalSubtype?: string | null;
  domainConfidence: number;
  execSummary: string;
  legalGrounds: string[];
  issueGroups: Array<{ title: string; description: string; priority: "high" | "medium" | "low" }>;
  keyFactsLegacy: any;
  state?: string | null;
  requestedOutcomes: string[];
  confidenceScore: number;
  confidenceBase: number;
  citationsStrict: Array<any>;
  clarifyingQuestions: string[];
  documentProfile?: LegalDocumentProfile | null;
}) {
  const subtype = input.legalSubtype || "unknown";
  const documentProfile = input.documentProfile || null;
  const partyRoles: Array<{ name: string | null; role: string }> = documentProfile?.parties?.length
    ? documentProfile.parties.slice(0, 6).map((party) => ({ name: party.name || null, role: party.role || "Unknown" }))
    : [];
  if (!partyRoles.length) {
    if (/\blandlord\b/i.test(input.queryText)) partyRoles.push({ name: null, role: "Landlord" });
    if (/\btenant\b/i.test(input.queryText)) partyRoles.push({ name: null, role: "Tenant" });
    if (/\bemployer|company\b/i.test(input.queryText)) partyRoles.push({ name: null, role: "Employer" });
    if (/\bemployee\b/i.test(input.queryText)) partyRoles.push({ name: null, role: "Employee" });
  }
  if (!partyRoles.length) partyRoles.push({ name: null, role: "Unknown" });
  const amounts = input.keyFactsLegacy?.outstanding_amount_inr != null
    ? [{ value: `INR ${Number(input.keyFactsLegacy.outstanding_amount_inr).toLocaleString("en-IN")}`, context: "mentioned dispute amount" }]
    : [];
  const dates = input.keyFactsLegacy?.contract_date ? [{ value: String(input.keyFactsLegacy.contract_date), context: "mentioned date" }] : [];
  const enrichedDates = dedupeStringsCaseInsensitive([
    ...dates.map((row) => String(row.value || "")),
    ...((input.keyFactsLegacy?.case_numbers || []) as string[]),
  ]);
  const missingInfo = [
    !amounts.length ? "Exact amount in dispute not confirmed" : null,
    !input.state ? "Location/state not clearly stated" : null,
    input.citationsStrict.length < 3 ? "Limited evidence snippets available" : null,
    documentProfile?.parties?.length ? null : "Party names/roles need verification",
  ].filter(Boolean) as string[];
  const riskText = [
    input.queryText || "",
    documentProfile?.dispute_summary || "",
    documentProfile?.filing_stage || "",
    ...(documentProfile?.reliefs_claimed || []),
    ...(input.legalGrounds || []),
    ...(input.issueGroups || []).map((group) => `${group.title || ""} ${group.description || ""}`),
    ...(Array.isArray(input.keyFactsLegacy?.threats) ? input.keyFactsLegacy.threats : []),
  ].join(" ");
  const normalizedText = normalizeForParsing(riskText).toLowerCase();
  const issueLabels = (input.issueGroups || []).map((g) => String(g?.title || "").toLowerCase()).join(" | ");
  const hasHarassmentSignal =
    /(harass|harassment|illegal approach|recovery agent|public roads|residence)/.test(normalizedText) ||
    /harassment|extra-legal|misconduct|threat/i.test(issueLabels);
  const hasThreatSignal =
    /(threat|threaten|dire consequences|intimidat|anti social|antisocial|henchmen)/.test(normalizedText) ||
    /threat|intimidation/i.test(issueLabels);
  const hasInjunctionSignal =
    /(injunction|permanent injunction|order xxxix|section 151|urgent relief|interim relief|cpc)/.test(normalizedText) ||
    /injunction|urgent interim relief/i.test(issueLabels);
  const hasPaymentDefaultSignal = /(loan|installment|instalment|default|outstanding)/.test(normalizedText);
  const respondentCount = (documentProfile?.parties || []).filter((party) => /(respondent|defendant)/i.test(String(party?.role || ""))).length;
  const hasMultiCounterpartyPressure = respondentCount >= 3;
  const hasUrgentCourtPosture = /(interim|injunction)/i.test(String(documentProfile?.filing_stage || ""));
  const hasWeakEvidence = input.citationsStrict.length < 3;
  const highAmount = Number(input.keyFactsLegacy?.outstanding_amount_inr || 0) >= 500000;
  let riskScore = 0;
  if (hasHarassmentSignal) riskScore += 1;
  if (hasThreatSignal) riskScore += 2;
  if (hasInjunctionSignal) riskScore += 1;
  if (hasPaymentDefaultSignal) riskScore += 1;
  if (highAmount) riskScore += 1;
  if (hasMultiCounterpartyPressure) riskScore += 1;
  if (hasUrgentCourtPosture) riskScore += 1;
  if (hasWeakEvidence) riskScore += 1;
  if (input.confidenceScore < 35) riskScore += 2;
  else if (input.confidenceScore < 60) riskScore += 1;
  let riskLevel: "Low" | "Medium" | "High" = riskScore >= 6 ? "High" : riskScore >= 3 ? "Medium" : "Low";
  if (riskLevel === "Low" && ((hasHarassmentSignal && hasInjunctionSignal) || (hasUrgentCourtPosture && hasPaymentDefaultSignal))) {
    riskLevel = "Medium";
  }
  if (
    riskLevel === "High" &&
    !hasThreatSignal &&
    !hasWeakEvidence &&
    documentProfile?.document_kind === "court_pleading" &&
    (hasHarassmentSignal || hasInjunctionSignal)
  ) {
    riskLevel = "Medium";
  }
  const riskReasons = [
    hasHarassmentSignal ? "Allegations indicate possible extra-legal recovery harassment behavior." : null,
    hasThreatSignal ? "Threat/intimidation language suggests possible escalation risk." : null,
    hasInjunctionSignal ? "Injunction/interim-relief request indicates urgency and potential irreparable harm concerns." : null,
    hasPaymentDefaultSignal ? "Loan/installment default context creates active recovery pressure." : null,
    hasMultiCounterpartyPressure ? `Multiple respondents/counterparties (${respondentCount}) increase coordination and litigation pressure.` : null,
    hasUrgentCourtPosture ? "The current court posture indicates active interim-relief proceedings." : null,
    highAmount ? "The dispute amount is materially high relative to normal early-routing thresholds." : null,
    hasWeakEvidence ? "Evidence snippets are limited, reducing certainty and increasing execution risk." : null,
    input.confidenceScore < 60 ? "Classification confidence is not high; verification is recommended before downstream action." : null,
    documentProfile?.filing_stage ? `Procedural posture indicates ${documentProfile.filing_stage}.` : null,
  ].filter(Boolean) as string[];
  return {
    case_title: inferCaseTitle({
      domain: input.legalDomain,
      subtype,
      queryText: input.queryText,
      state: input.state || null,
      keyFacts: input.keyFactsLegacy,
      titleHint: documentProfile?.title_hint || null,
    }),
    language: { detected: input.languageName || "English", confidence: Number(input.languageConfidence.toFixed(3)) },
    jurisdiction: {
      country: input.jurisdiction === "India" ? "India" : "Unknown",
      confidence: Number((input.jurisdiction === "India" ? 0.88 : 0.35).toFixed(3)),
      reason: input.jurisdiction === "India" ? "Detected from user text/doc context or selected filters." : "No clear India indicator found in the available inputs.",
    },
    domain: {
      primary: input.legalDomain || "General",
      subtype: subtype,
      confidence: Number((subtype === "unknown" ? Math.min(input.domainConfidence, 0.45) : input.domainConfidence).toFixed(3)),
    },
    executive_summary: splitSentences(input.execSummary).slice(0, 4).join(" "),
    legal_grounds: (input.legalGrounds || []).slice(0, 7),
    issue_groups: (input.issueGroups || []).slice(0, 6).map((g) => ({
      label: String(g.title || "").trim(),
      confidence: g.priority === "high" ? 0.85 : g.priority === "medium" ? 0.68 : 0.55,
    })),
    key_facts: {
      contract_date: input.keyFactsLegacy?.contract_date || null,
      payment_terms: input.keyFactsLegacy?.payment_terms || null,
      delivery_terms: input.keyFactsLegacy?.delivery_terms || null,
      outstanding_amount_inr: input.keyFactsLegacy?.outstanding_amount_inr ?? null,
      delay_days_range: input.keyFactsLegacy?.delay_days_range || null,
      arbitration_clause: input.keyFactsLegacy?.arbitration_clause || { present: false, seat: null, language: null },
      interest_clause: input.keyFactsLegacy?.interest_clause || { present: false, rate_pa: null },
      threats: Array.isArray(input.keyFactsLegacy?.threats) ? input.keyFactsLegacy.threats : [],
      parties: partyRoles,
      amounts,
      dates: enrichedDates.map((value) => ({ value, context: "extracted date / case reference" })),
      location: input.state || documentProfile?.state_hint || null,
      requested_outcome: (input.requestedOutcomes || []).slice(0, 6),
      court_name: documentProfile?.court_name || null,
      case_numbers: documentProfile?.case_numbers || [],
      document_kind: documentProfile?.document_kind || null,
      filing_stage: documentProfile?.filing_stage || null,
      dispute_summary: documentProfile?.dispute_summary || null,
      reliefs_claimed: documentProfile?.reliefs_claimed || [],
      detailed_parties: documentProfile?.parties || [],
    },
    risk_assessment: {
      risk_level: riskLevel,
      risk_reasons: (riskReasons.length
        ? riskReasons
        : [
            "Initial classification is based on user-provided facts and available snippets.",
            input.citationsStrict.length >= 3 ? "Multiple evidence snippets support routing." : "Limited evidence snippets reduce certainty.",
          ]).slice(0, 4),
      missing_info: missingInfo.slice(0, 5),
    },
    next_best_actions: [
      documentProfile?.document_kind === "court_pleading"
        ? "Confirm the exact court, case number, parties, and reliefs from the filing."
        : "Confirm parties, timeline, and exact dispute amount in one paragraph.",
      "Upload the main contract/notice/pleading/order/chat evidence for this case.",
      "Verify jurisdiction/location details before running downstream agents.",
      "State the exact remedy sought (refund, replacement, payment, injunction, declaration, possession, etc.).",
    ].slice(0, 6),
    citations: input.citationsStrict.slice(0, Math.max(3, input.citationsStrict.length)),
    clarifying_questions: (subtype === "unknown" || missingInfo.length > 0 ? input.clarifyingQuestions.slice(0, 3) : []).slice(0, 3),
  };
}

function isLikelyMeaningfulCaseQuery(text: string) {
  const normalized = normalizeForParsing(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s?]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  const hasIndic = /[\u0900-\u097f\u0980-\u09ff\u0a00-\u0a7f\u0a80-\u0aff\u0b00-\u0bff\u0c00-\u0cff\u0d00-\u0d7f\u0600-\u06ff]/.test(normalized);
  if (normalized.length < (hasIndic ? 18 : 25)) return false;
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length < (hasIndic ? 2 : 3)) return false;
  if (detectPromptTemplateQuery(normalized).likelyTemplate) return false;
  const legalSignals = [
    "contract", "agreement", "invoice", "payment", "delay", "notice", "termination", "dispute", "case",
    "arbitration", "supplier", "distributor", "tenant", "employment", "property", "legal", "court",
    "refund", "replacement", "warranty", "consumer", "service", "complaint", "loan", "installment",
    "landlord", "lease", "rent", "deposit", "security deposit", "vacated", "handover", "whatsapp",
    "painting", "deduct", "deduction", "owner",
  ];
  if (legalSignals.some((s) => normalized.includes(s))) return true;
  return normalized.length >= (hasIndic ? 22 : 35);
}

function hasSubstantialSubmittedInput(text: string) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (detectPromptTemplateQuery(raw).likelyTemplate) return false;
  const hasIndicOrArabic = /[\u0600-\u06ff\u0900-\u097f\u0980-\u09ff\u0a00-\u0a7f\u0a80-\u0aff\u0b00-\u0bff\u0c00-\u0cff\u0d00-\u0d7f]/.test(raw);
  const normalized = normalizeForParsing(raw)
    .replace(/\s+/g, " ")
    .trim();
  const tokenCount = normalized.split(/\s+/).filter(Boolean).length;
  const compactLen = normalized.replace(/\s+/g, "").length;

  if (hasIndicOrArabic) {
    // Indian-language queries can be shorter in token count but still meaningful.
    return compactLen >= 18 || tokenCount >= 3;
  }
  if (compactLen >= 25 || tokenCount >= 4) return true;
  // Permit short but concrete English disputes (e.g., landlord deposit / refund / harassment cases)
  const lowered = normalized.toLowerCase();
  const concreteShortCaseSignals = [
    "landlord", "tenant", "rent", "deposit", "refund", "replacement", "warranty", "service center",
    "termination", "salary", "pf", "gratuity", "will", "partition", "brother", "mother", "property",
    "loan", "harassing", "police", "bail", "fir", "notice", "court",
  ];
  if (tokenCount >= 3 && concreteShortCaseSignals.some((s) => lowered.includes(s))) return true;
  return false;
}

function normalizeForParsing(text: string) {
  return (text || "")
    .replace(/\uFFFD/g, "")
    .replace(/₹/g, "?")
    .replace(/–|—/g, "�")
    .replace(/\u091a\u0947\u0928\u094d\u0928\u0908/g, "Chennai")
    .replace(/\u0924\u092e\u093f\u0932\s+\u0928\u093e\u0921\u0941/g, "Tamil Nadu")
    .replace(/\u0915\u0949?\u0928\u094d\u091f\u094d\u0930\u0948\u0915\u094d\u091f/g, "contract")
    .replace(/\u0938\u092a\u094d\u0932\u093e\u0908/g, "supply")
    .replace(/\u0921\u093f\u0938\u094d\u091f\u094d\u0930\u0940\u092c\u094d\u092f\u0942\u091f\u0930/g, "distributor")
    .replace(/\u0907\u0928\u0935\u0949?\u0907\u0938/g, "invoice")
    .replace(/\u092d\u0941\u0917\u0924\u093e\u0928/g, "payment")
    .replace(/\u0926\u0947\u0930\u0940/g, "delay")
    .replace(/\u092c\u0915\u093e\u092f\u093e/g, "outstanding")
    .replace(/\u0906\u0930\u094d\u092c\u093f\u091f\u094d\u0930\u0947\u0936\u0928/g, "arbitration")
    .replace(/\u0915\u094d\u0932\u0949?\u091c/g, "clause")
    .replace(/\u0938\u0940\u091f/g, "seat")
    .replace(/\u092d\u093e\u0937\u093e/g, "language")
    .replace(/\u0907\u0902\u0917\u094d\u0932\u093f\u0936/g, "English")
    .replace(/\u0907\u0902\u091f\u0930\u0947\u0938\u094d\u091f/g, "interest")
    .replace(/\u091f\u0930\u094d\u092e\u093f\u0928\u0947\u091f/g, "terminate")
    .replace(/\u092c\u094d\u0932\u0948\u0915\u0932\u093f\u0938\u094d\u091f/g, "blacklist")
    .replace(/\u0935\u094d\u0939\u093e\u091f\u094d\u0938\u090f\u092a/g, "whatsapp")
    .replace(/\u0908\u092e\u0947\u0932/g, "email")
    .replace(/\u091a\u093e\u0932\u093e\u0928/g, "challan")
    .replace(/\u092c\u0948\u0902\u0915\s+\u0938\u094d\u091f\u0947\u091f\u092e\u0947\u0902\u091f/g, "bank statement")
    .replace(/\u0932\u0940\u0917\u0932\s+\u0928\u094b\u091f\u093f\u0938/g, "legal notice")
    .replace(/\u0905\u0917\u0938\u094d\u0924/g, "Aug")
    .replace(/\u0928\u0935\u0902\u092c\u0930|\u0928\u0935\u092e\u094d\u092c\u0930/g, "Nov")
    // Urdu / Arabic-script cues (encoding-safe via Unicode ranges / mixed-script tokens)
    .replace(/[\u062c\u062c][\u0646\u0646][\u0648\u0648][\u0631\u0631][\u06cc\u064a]/g, "Jan")
    .replace(/[\u0641\u0641][\u0631\u0631][\u0648\u0648][\u0631\u0631][\u06cc\u064a]/g, "Feb")
    .replace(/[\u0645\u0645][\u0627\u0627][\u0631\u0631][\u0686\u0686]/g, "Mar")
    .replace(/[\u0627\u0627][\u067e\u067e][\u0631\u0631][\u06cc\u064a][\u0644\u0644]/g, "Apr")
    .replace(/[\u0645\u0645][\u0626\u0626\u06d2\u06d2]/g, "May")
    .replace(/[\u062c\u062c][\u0648\u0648][\u0646\u0646]/g, "Jun")
    .replace(/[\u062c\u062c][\u0648\u0648][\u0644\u0644][\u0627\u0627][\u0626\u0626\u06d2\u06d2]/g, "Jul")
    .replace(/[\u0627\u0627][\u06af\u06af][\u0633\u0633][\u062a\u062a]/g, "Aug")
    .replace(/[\u0633\u0633][\u067e\u067e][\u062a\u062a][\u0645\u0645][\u0628\u0628][\u0631\u0631]/g, "Sep")
    .replace(/[\u0627\u0627][\u06a9\u06a9][\u062a\u062a][\u0648\u0648][\u0628\u0628][\u0631\u0631]/g, "Oct")
    .replace(/[\u0646\u0646][\u0648\u0648][\u0645\u0645][\u0628\u0628][\u0631\u0631]/g, "Nov")
    .replace(/[\u062f\u062f][\u0633\u0633][\u0645\u0645][\u0628\u0628][\u0631\u0631]/g, "Dec")
    .replace(/[\u0622\u0627]?\s*[\u0646\u0646]\s*[\u0644\u0644][\u0627\u0627][\u0626\u0626\u06d2\u06d2][\u0646\u0646]/g, "online")
    .replace(/[\u0644\u0644][\u06cc\u064a][\u067e\u067e]\s*[\u0679\u0679][\u0627\u0627][\u067e\u067e]/g, "laptop")
    .replace(/[\u0645\u0645][\u0648\u0648][\u0628\u0628][\u0627\u0627][\u0626\u0626\u06d2\u06d2][\u0644\u0644]/g, "mobile")
    .replace(/[\u062e\u062e][\u0631\u0631][\u06cc\u064a][\u062f\u062f][\u0627\u0627]/g, "bought")
    .replace(/[\u0688\u0688][\u0644\u0644][\u06cc\u064a][\u0648\u0648][\u0631\u0631][\u06cc\u064a]/g, "delivery")
    .replace(/[\u0631\u0631][\u06cc\u064a][\u0641\u0641][\u0646\u0646][\u0688\u0688]/g, "refund")
    .replace(/[\u0631\u0631][\u06cc\u064a][\u067e\u067e][\u0644\u0644][\u06cc\u064a][\u0633\u0633]/g, "replacement")
    .replace(/[\u0648\u0648][\u0627\u0627][\u0631\u0631][\u0646\u0646][\u0679\u0679][\u06cc\u064a]/g, "warranty")
    .replace(/[\u0633\u0633][\u0631\u0631][\u0648\u0648][\u0633\u0633].{0,3}[\u0633\u0633][\u06cc\u064a][\u0646\u0646][\u0679\u0679][\u0631\u0631]/g, "service center")
    .replace(/[\u062e\u062e][\u0631\u0631][\u0627\u0627][\u0628\u0628][\u06cc\u064a]|\u062e\u0631\u0627\u0628\u06cc/g, "defect")
    .replace(/[\u0634\u0634][\u06a9\u06a9][\u0627\u0627][\u06cc\u064a][\u062a\u062a]/g, "complaint")
    .replace(/[\u0642\u0642][\u0633\u0633][\u0637\u0637]|\u0627\u0642\u0633\u0627\u0637/g, "installment")
    .replace(/[\u0642\u0642][\u0631\u0631][\u0636\u0636]|\u0644\u0648\u0646/g, "loan")
    .replace(/[\u06c1\u06c1][\u0631\u0631][\u0627\u0627][\u0633\u0633].{0,3}[\u06ba\u0646]|\u062f\u06be\u0645\u06a9[\u06cc\u064a]/g, "harassing")
    .replace(/\b151\b|\u0633\u06cc\u06a9\u0634\u0646\s*151/gi, "section 151")
    .replace(/order\s*39|order\s*xxxix|\u0622\u0631\u0688\u0631\s*39/gi, "order xxxix")
    .replace(/[\u0639\u0639][\u062f\u062f][\u0627\u0627][\u0644\u0644][\u062a\u062a]/g, "court")
    .replace(/\u062d\u06cc\u062f\u0631\u0622\u0628\u0627\u062f/g, "Hyderabad")
    .replace(/\u0628\u06cc\u0646\u06af\u0644\u0648\u0631|\u0628\u0646\u06af\u0644\u0648\u0631/g, "Bengaluru")
    .replace(/\u0648\u062c\u06d2\u0648\u0627\u0691\u06c1|\u0648\u062c\u06d2\u0648\u0627\u0691\u0627/g, "Vijayawada")
    .replace(/\u0622\u0646\u062f\u06be\u0631\u0627\s*\u067e\u0631\u062f\u06cc\u0634/g, "Andhra Pradesh");
}

function topIssues(text: string) {
  const issues: string[] = [];
  const q = normalizeForParsing(text).toLowerCase();
  if (q.includes("breach")) issues.push("breach of contract");
  if (q.includes("delay") || q.includes("deadline")) issues.push("timeline delay");
  if (q.includes("penalty") || q.includes("interest")) issues.push("penalty or interest exposure");
  if (q.includes("termination")) issues.push("termination rights");
  if (q.includes("payment") || q.includes("outstanding")) issues.push("payment dispute");
  if (q.includes("arbitration")) issues.push("arbitration clause strategy");
  if (q.includes("will") || q.includes("fake will")) issues.push("will authenticity dispute");
  if (q.includes("partition")) issues.push("partition rights");
  if (q.includes("succession") || q.includes("inheritance") || q.includes("daughter")) issues.push("succession and heirship rights");
  if (q.includes("property") || q.includes("residential property") || q.includes("house")) issues.push("property title and share determination");
  if (q.includes("loan") || q.includes("mortgage")) issues.push("property-linked loan liability");
  if (q.includes("performance issue") || q.includes("written warning") || (q.includes("terminated") && q.includes("performance"))) issues.push("wrongful termination procedure");
  if (q.includes("full & final") || q.includes("full and final") || q.includes("dues")) issues.push("full and final settlement dues");
  if (q.includes("pf") || q.includes("gratuity")) issues.push("statutory dues delay (pf / gratuity)");
  if (q.includes("hr") || q.includes("manager") || q.includes("abusive language") || q.includes("threatened")) issues.push("workplace misconduct evidence");
  if (q.includes("refund") || q.includes("replacement")) issues.push("refund / replacement remedy");
  if (q.includes("defect") || q.includes("warranty") || q.includes("service center")) issues.push("product defect and warranty service failure");
  if (q.includes("online") || q.includes("purchase")) issues.push("consumer purchase transaction evidence");
  if (q.includes("loan") || q.includes("installment")) issues.push("loan installment dispute");
  if (q.includes("harassing") || q.includes("harassment")) issues.push("harassing recovery conduct");
  if (q.includes("injunction") || q.includes("order xxxix") || q.includes("section 151") || q.includes("permanent injunction")) issues.push("civil injunction and urgent relief strategy");
  const uniq = [...new Set(issues)];
  return uniq.length ? uniq : ["facts clarification required"];
}

function detectDomain(text: string) {
  const q = normalizeForParsing(text).toLowerCase();
  const buckets: Array<{ domain: string; terms: string[]; score: number }> = [
    { domain: "Consumer / Service Dispute", score: 0, terms: ["consumer", "complaint", "purchase", "bought", "online", "online order", "laptop", "mobile", "defect", "refund", "replacement", "warranty", "service center", "repair", "seller"] },
    { domain: "Corporate / Contract", score: 0, terms: ["contract", "agreement", "breach", "vendor", "supplier", "distributor", "purchase order", "invoice", "outstanding", "termination", "payment", "arbitration"] },
    { domain: "Employment", score: 0, terms: ["employment", "employee", "salary", "termination", "terminated", "termination letter", "hr", "harassment", "gratuity", "pf", "full and final", "full & final", "manager", "performance issues"] },
    { domain: "IP Law", score: 0, terms: ["trademark", "copyright", "patent", "infringement", "ip", "license", "licensing"] },
    { domain: "Property / Family", score: 0, terms: ["tenant", "tenancy", "lease", "rent", "property", "landlord", "eviction", "will", "partition", "succession", "inheritance", "heir", "daughter", "mother", "probate", "house", "loan linked to house", "maintenance", "marriage"] },
    { domain: "Criminal", score: 0, terms: ["fir", "bail", "police", "ipc", "arrest", "charge sheet", "crime"] },
    { domain: "Constitutional / Public Law", score: 0, terms: ["writ", "article 14", "article 226", "high court", "supreme court", "public authority", "fundamental rights"] },
    { domain: "Civil Litigation", score: 0, terms: ["civil", "suit", "injunction", "permanent injunction", "order xxxix", "section 151", "cpc", "damages", "notice", "cause of action", "loan", "installment", "harassing", "court"] },
  ];
  for (const bucket of buckets) for (const term of bucket.terms) if (q.includes(term)) bucket.score += term.includes(" ") ? 2 : 1;
  buckets.sort((a, b) => b.score - a.score);
  const top = buckets[0];
  return top?.score && top.score >= 1 ? top.domain : "General";
}

function classifyDomainDetailed(text: string) {
  const q = normalizeForParsing(text).toLowerCase();
  const score = (terms: string[]) => terms.reduce((acc, term) => acc + (q.includes(term) ? (term.includes(" ") ? 2 : 1) : 0), 0);
  const consumerScore = score(["consumer", "complaint", "purchase", "bought", "online", "online order", "laptop", "mobile", "defect", "refund", "replacement", "warranty", "service center", "repair", "seller", "opposite party"]);
  const contractScore = score(["contract", "agreement", "breach", "vendor", "supplier", "distributor", "purchase order", "invoice", "outstanding", "termination", "payment", "arbitration", "clause", "specific performance"]);
  const employmentScore = score(["employment", "employee", "salary", "termination", "terminated", "hr", "gratuity", "pf", "full and final", "full & final", "manager", "performance issues", "notice period", "labour"]);
  const propertyFamilyScore = score([
    "property", "partition", "succession", "inheritance", "will", "house", "family", "daughter", "mother", "brother",
    "maintenance", "domestic violence", "marriage", "custody", "divorce", "declaration", "possession", "eviction",
    "landlord", "tenant", "tenancy", "lease", "rent", "deposit", "security deposit", "vacated", "handover", "deduct", "deduction", "painting",
  ]);
  const criminalScore = score(["fir", "bail", "police", "ipc", "arrest", "charge sheet", "crime"]);
  const constitutionalScore = score(["writ", "article 14", "article 226", "high court", "supreme court", "public authority", "fundamental rights"]);
  const civilFinanceInjunctionScore = score(["civil", "suit", "injunction", "permanent injunction", "order xxxix", "section 151", "cpc", "loan", "installment", "harassing", "recovery agent", "court", "petition", "plaintiff", "defendant", "petitioner", "respondent", "declaration", "damages", "recovery"]);

  const domainCandidates = [
    { domain: "Consumer / Service Dispute", score: consumerScore },
    { domain: "Corporate / Contract", score: contractScore },
    { domain: "Employment", score: employmentScore },
    { domain: "Property / Family", score: propertyFamilyScore },
    { domain: "Criminal", score: criminalScore },
    { domain: "Constitutional / Public Law", score: constitutionalScore },
    { domain: "Civil Litigation / Finance", score: civilFinanceInjunctionScore },
  ].sort((a, b) => b.score - a.score);

  const top = domainCandidates[0];
  const second = domainCandidates[1];
  const domain = top && top.score > 0 ? top.domain : "General";
  const domainConfidence = top && top.score > 0 ? Math.min(0.98, 0.55 + top.score * 0.08 - Math.max(0, (second?.score || 0) - 1) * 0.03) : 0.2;

  let subtype: string | null = null;
  if (domain === "Property / Family") {
    const hasMaintenanceDv = /\b(maintenance|domestic violence|dv|abuse|abusive|police|medical report|medical reports|protection order)\b/.test(q)
      || /(\u0d2e\u0d46\u0d2f\u0d3f\u0d28\u0d4d\u0d31\u0d28\u0d28\u0d4d\u0d38\u0d4d|\u0d17\u0d3e\u0d39\u0d3f\u0d15 \u0d2a\u0d40\u0d21\u0d28\u0d02)/.test(q); // Malayalam hints
    const hasDivorceCustody = /\b(divorce|custody|visitation|child custody|separation)\b/.test(q);
    const hasMarriage = /\b(marriage|marital|spouse|husband|wife)\b/.test(q);
    const hasSuccessionPartition = /\b(will|partition|succession|inheritance|heir|property share|share in property|probate)\b/.test(q);
    const hasPropertyTitle = /\b(title|encumbrance|mutation|registration|sale deed|possession)\b/.test(q);
    const hasTenancyDeposit = /\b(landlord|tenant|lease|rent|deposit|security deposit|vacat(?:e|ed)?|handover|painting|deduct(?:ion)?)\b/.test(q);

    if (hasMaintenanceDv) subtype = "family_maintenance_dv";
    else if (hasDivorceCustody) subtype = "family_divorce_custody";
    else if (hasMarriage) subtype = "family_marriage_dispute";
    else if (hasSuccessionPartition) subtype = "property_partition_succession";
    else if (hasTenancyDeposit) subtype = "tenancy_deposit_refund_dispute";
    else if (hasPropertyTitle || q.includes("property") || q.includes("house")) subtype = "property_title_dispute";
  } else if (domain === "Employment") {
    if (/\b(pf|gratuity|full and final|full & final|salary dues|dues)\b/.test(q)) subtype = "employment_dues";
    else subtype = "employment_termination";
  } else if (domain === "Corporate / Contract") {
    subtype = "contract_payment_dispute";
  } else if (domain === "Consumer / Service Dispute") {
    subtype = "consumer_defect_refund";
  } else if (domain === "Civil Litigation / Finance") {
    if (/\b(injunction|permanent injunction|order xxxix|section 151|cpc)\b/.test(q)) subtype = "civil_injunction_finance";
    else if (/\b(loan|installment|harassing|recovery agent)\b/.test(q)) subtype = "loan_harassment_civil_relief";
    else subtype = "civil_finance_dispute";
  } else if (domain === "Criminal") {
    subtype = "criminal_complaint_matter";
  }

  return { domain, subtype, domainConfidence: Number(Math.max(0.2, Math.min(0.99, domainConfidence)).toFixed(3)) };
}

function languageCodeFromName(name?: string | null) {
  const value = String(name || "").toLowerCase();
  if (value.includes("hindi")) return "hi";
  if (value.includes("tamil")) return "ta";
  if (value.includes("telugu")) return "te";
  if (value.includes("bengali")) return "bn";
  if (value.includes("english")) return "en";
  return "en";
}

function parseDateToIso(text: string): string | null {
  const normalized = normalizeForParsing(text);
  const m = normalized.match(/\b(\d{1,2})\s+([A-Za-z]{3,16})\s+(\d{4})\b/);
  if (!m) return null;
  const [, dayRaw, monthRaw, yearRaw] = m;
  const monthMap: Record<string, string> = { jan: "01", january: "01", feb: "02", february: "02", mar: "03", march: "03", apr: "04", april: "04", may: "05", jun: "06", june: "06", jul: "07", july: "07", aug: "08", august: "08", sep: "09", sept: "09", september: "09", oct: "10", october: "10", nov: "11", november: "11", dec: "12", december: "12" };
  const month = monthMap[monthRaw.toLowerCase()];
  if (!month) return null;
  return `${yearRaw}-${String(Number(dayRaw)).padStart(2, "0")}-${month}`.replace(/-(\d{2})-(\d{2})$/, (_, d, m2) => `-${m2}-${d}`);
}

function parseInrAmount(text: string): number | null {
  const normalized = normalizeForParsing(text);
  const totals = [...normalized.matchAll(/\btotal\s+([\d,]+(?:\.\d+)?)/ig)]
    .map((match) => parseAmountNumber(match[1]))
    .filter((value): value is number => value != null && value >= 1000)
    .sort((a, b) => b - a);
  if (totals.length) return Math.round(totals[0]);
  const rupee = normalized.match(/(?:\u20B9|rs\.?|inr|rupees?)\s*([\d,]+(?:\.\d+)?)/i);
  if (!rupee) return null;
  const numeric = Number(String(rupee[1]).replace(/,/g, ""));
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function parseDelayRange(text: string): string | null {
  const m = normalizeForParsing(text).match(/(\d{1,3})\s*(?:-|–|—)\s*(\d{1,3})\s*(?:days?)/i);
  if (!m) return null;
  return `${m[1]}-${m[2]} days`;
}

function extractKeyFacts(text: string) {
  const normalized = normalizeForParsing(text);
  const lower = normalized.toLowerCase();
  const paymentTermsMatch = normalized.match(/pay within\s+(\d+\s+days?[^.]{0,80})/i) || normalized.match(/(\d+\s+days?[^.]{0,80}(?:invoice|payment))/i);
  const deliveryTermsMatch = normalized.match(/(?:deliver|delivery)\s+([^.]*)/i);
  const arbitrationPresent = /\barbitration(?: clause)?\b/i.test(normalized);
  const arbitrationSeat = normalized.match(/seat\s*:\s*([A-Za-z ]{2,40})/i)?.[1]?.trim() || null;
  const arbitrationLanguage = normalized.match(/language\s*:\s*([A-Za-z ]{2,20})/i)?.[1]?.trim() || null;
  const interestRate = normalized.match(/interest(?: clause)?(?: of)?\s*(\d+(?:\.\d+)?)\s*%\s*p\.?a\.?/i)?.[1] || null;
  const threats: string[] = [];
  if (lower.includes("terminate") || lower.includes("termination")) threats.push("termination");
  if (lower.includes("blacklist")) threats.push("blacklisting");
  if (/(threat|threaten|dire consequences|intimidat)/.test(lower)) threats.push("threat/intimidation");
  if (/(harass|harassment|illegal approach|anti social|antisocial|henchmen|recovery agent)/.test(lower)) threats.push("harassment");
  return {
    contract_date: parseDateToIso(normalized),
    payment_terms: paymentTermsMatch ? paymentTermsMatch[1].trim() : null,
    delivery_terms: deliveryTermsMatch ? deliveryTermsMatch[1].trim() : null,
    outstanding_amount_inr: parseInrAmount(normalized),
    delay_days_range: parseDelayRange(normalized),
    arbitration_clause: { present: arbitrationPresent, seat: arbitrationSeat, language: arbitrationLanguage },
    interest_clause: { present: Boolean(interestRate), rate_pa: interestRate ? `${interestRate}%` : null },
    threats: [...new Set(threats)],
  };
}

function extractEvidenceAvailable(text: string) {
  const lower = normalizeForParsing(text).toLowerCase();
  const items = [
    ["emails", ["email", "emails"]],
    ["whatsapp", ["whatsapp", "whats app"]],
    ["invoices", ["invoice", "invoices"]],
    ["delivery_challans", ["challan", "challans", "delivery challan"]],
    ["bank_statements", ["bank statement", "bank statements"]],
    ["purchase_orders", ["purchase order", "purchase orders", "po "]],
    ["photos_videos", ["video", "videos", "photo", "photos", "recording"]],
    ["handover_records", ["handover", "vacated", "vacate", "possession handover"]],
  ] as const;
  return items.filter(([, kws]) => kws.some((k) => lower.includes(k))).map(([key]) => key);
}

function extractRequestedOutcomes(text: string) {
  const lower = normalizeForParsing(text).toLowerCase();
  const out: string[] = [];
  if (lower.includes("legal notice")) out.push("send_legal_notice");
  if ((lower.includes("urgent order") || lower.includes("injunction") || lower.includes("stop termination")) && (lower.includes("terminate") || lower.includes("termination"))) out.push("stop_termination_urgent_order");
  if (lower.includes("partition")) out.push("partition_rights_assessment");
  if (lower.includes("will is fake") || lower.includes("fake will") || (lower.includes("will") && lower.includes("not shown"))) out.push("will_authenticity_challenge");
  if (lower.includes("which court") || lower.includes("file a case") || lower.includes("should i file")) out.push("forum_and_case_strategy");
  if (lower.includes("settlement")) out.push("settlement_options");
  if (lower.includes("draft legal notice") || lower.includes("legal notice")) out.push("send_legal_notice");
  if (lower.includes("pf") || lower.includes("gratuity")) out.push("recover_statutory_dues");
  if (lower.includes("refund")) out.push("refund_claim");
  if (lower.includes("deposit") || lower.includes("security deposit")) out.push("security_deposit_refund_assessment");
  if (lower.includes("replacement")) out.push("replacement_claim");
  if (lower.includes("consumer complaint") || (lower.includes("consumer") && lower.includes("complaint"))) out.push("consumer_forum_complaint");
  if (lower.includes("injunction") || lower.includes("permanent injunction")) out.push("seek_injunction_relief");
  if (lower.includes("declaration") || lower.includes("declare")) out.push("declaratory_relief");
  if (lower.includes("specific performance")) out.push("specific_performance");
  if (lower.includes("possession")) out.push("possession_relief");
  if (lower.includes("eviction")) out.push("eviction_relief");
  if (lower.includes("maintenance")) out.push("maintenance_claim");
  if (lower.includes("damages") || lower.includes("compensation")) out.push("damages_or_compensation");
  if (lower.includes("recovery of amount") || lower.includes("recover the amount") || lower.includes("recovery suit")) out.push("payment_recovery");
  if (lower.includes("time") || lower.includes("timeline")) out.push("timeline_estimate");
  if (lower.includes("cost")) out.push("cost_estimate");
  return out;
}

function detectState(text: string, fallback?: any) {
  const normalized = normalizeForParsing(text);
  const explicit = normalized.match(/\b(chennai|tamil nadu|delhi|mumbai|maharashtra|karnataka|bengaluru|bangalore|hyderabad|telangana)\b/i)?.[1];
  const explicitExtended = normalized.match(/\b(vijayawada|andhra pradesh)\b/i)?.[1];
  if (explicitExtended) {
    const v = explicitExtended.toLowerCase();
    if (v === "vijayawada" || v === "andhra pradesh") return "Andhra Pradesh";
  }
  if (explicit) {
    const v = explicit.toLowerCase();
    if (v === "chennai" || v === "tamil nadu") return "Tamil Nadu";
    if (v === "mumbai" || v === "maharashtra") return "Maharashtra";
    if (v === "delhi") return "Delhi";
    if (v === "bengaluru" || v === "bangalore" || v === "karnataka") return "Karnataka";
    if (v === "hyderabad" || v === "telangana") return "Telangana";
  }
  return fallback?.state || null;
}

function normalizeFiltersApplied(filtersApplied: any, inferred: { jurisdiction: string | null; state: string | null; domain: string | null }) {
  const applied = filtersApplied && typeof filtersApplied === "object" ? { ...filtersApplied } : {};
  return {
    jurisdiction: applied.jurisdiction ?? inferred.jurisdiction,
    state: applied.state ?? inferred.state,
    legal_domain: applied.legal_domain ?? inferred.domain,
    date_range: applied.date_range ?? null,
    source_types: Array.isArray(applied.source_types) ? applied.source_types : [],
  };
}

function buildIssueGroups(text: string, issues: string[]) {
  const lower = normalizeForParsing(text).toLowerCase();
  const candidates = [
    { match: ["payment", "outstanding", "invoice"], title: "Outstanding payments and invoice recovery", description: "Delayed invoice payments and accumulation of unpaid dues require recovery strategy and evidence alignment.", priority: "high" as const },
    { match: ["delay", "deliver", "units/month"], title: "Performance and delivery timeline breaches", description: "Contractual delivery and/or performance timelines appear to be disputed or breached.", priority: "high" as const },
    { match: ["termination", "blacklist"], title: "Termination and business continuity threats", description: "Counterparty threats of termination/blacklisting create immediate commercial risk and possible urgent relief needs.", priority: "high" as const },
    { match: ["arbitration", "seat"], title: "Dispute resolution clause strategy", description: "Arbitration clause terms (seat/language/procedure) affect forum, notice strategy, and timeline.", priority: "medium" as const },
    { match: ["interest", "% p.a"], title: "Interest and damages computation", description: "Late-payment interest and damages quantification need clause validation and calculation support.", priority: "medium" as const },
    { match: ["whatsapp", "email", "bank statement", "challan", "purchase order"], title: "Evidence sufficiency and chronology", description: "Available communications and transaction documents should be organized into a clear chronology for downstream modules.", priority: "medium" as const },
    { match: ["fake will", "forged will", "probate", "testament", "succession will"], title: "Will authenticity and challenge strategy", description: "The alleged will must be examined for execution, attestation, disclosure, and challenge grounds if authenticity is disputed.", priority: "high" as const },
    { match: ["partition", "daughter", "mother", "heir", "succession"], title: "Partition and succession rights of legal heirs", description: "Shares of surviving family members and succession rights need clarification before partition or declaratory proceedings.", priority: "high" as const },
    { match: ["property", "residential property", "house"], title: "Property title, possession, and encumbrance review", description: "Title records, possession status, and encumbrances on the residential property require verification.", priority: "medium" as const },
    { match: ["landlord", "tenant", "lease", "rent"], title: "Tenancy rights, possession handover, and landlord obligations", description: "Tenancy terms, possession handover status, and post-vacation obligations should be assessed against communications and agreement terms.", priority: "high" as const },
    { match: ["deposit", "security deposit", "deduct", "deduction", "painting"], title: "Security deposit refund and deduction justification", description: "Deposit refund delay and proposed deductions (including painting/damages) require proof, reasonableness review, and tenancy-document correlation.", priority: "high" as const },
    { match: ["video", "whatsapp", "handover"], title: "Handover evidence and post-vacation chronology", description: "Handover video and communications should be organized to establish property condition and timeline at vacating.", priority: "medium" as const },
    { match: ["mortgage", "loan against property", "encumbrance"], title: "Loan liability linked to property", description: "Outstanding loans or encumbrances may affect partition feasibility, valuation, and interim relief options.", priority: "medium" as const },
    { match: ["termination", "performance issue", "written warning"], title: "Termination process and performance-ground challenge", description: "Termination based on alleged performance issues may require review of warnings, appraisals, internal process, and documented grounds.", priority: "high" as const },
    { match: ["full & final", "full and final", "dues", "salary"], title: "Full and final settlement dues recovery", description: "Pending salary/dues and settlement components need breakup verification and recovery sequencing.", priority: "high" as const },
    { match: ["pf", "gratuity"], title: "Statutory employment dues (PF / gratuity) delay", description: "PF transfer and gratuity delays require document collection and statutory compliance follow-up strategy.", priority: "high" as const },
    { match: ["abusive language", "workplace", "employee", "hr", "threatened by manager", "screenshots"], title: "Workplace misconduct evidence and escalation posture", description: "Screenshots and communications may support grievance/escalation and strengthen factual chronology for negotiations or proceedings.", priority: "medium" as const },
    { match: ["consumer", "laptop", "mobile", "online", "purchase"], title: "Consumer purchase transaction and seller obligations", description: "Online purchase details, seller obligations, and transaction records need to be organized for consumer remedy evaluation.", priority: "high" as const },
    { match: ["defect", "warranty", "service center", "repair"], title: "Product defect, warranty, and service failure", description: "Defect evidence and warranty/service center interactions are central to refund/replacement and complaint strategy.", priority: "high" as const },
    { match: ["refund", "replacement"], title: "Refund / replacement remedy strategy", description: "The case requires a clear consumer remedy path for replacement or refund supported by invoice and complaint trail.", priority: "high" as const },
    { match: ["loan", "installment", "harassing", "recovery agent"], title: "Loan installment dispute and harassment allegations", description: "Installment defaults and alleged harassment by recovery/defendant parties require civil relief and evidence mapping.", priority: "high" as const },
    { match: ["injunction", "permanent injunction", "order xxxix", "section 151", "cpc"], title: "Civil injunction and urgent interim relief", description: "Urgent civil relief strategy under injunction / CPC procedural grounds should be evaluated based on immediate harm and evidence.", priority: "high" as const },
    { match: ["declaration", "declare", "rights"], title: "Declaratory relief and rights determination", description: "The pleadings appear to seek declaration of rights or status that should be aligned with supporting documents and forum strategy.", priority: "medium" as const },
    { match: ["specific performance"], title: "Specific performance and contractual enforcement", description: "The matter may require assessment of enforceability, readiness, and relief for specific performance.", priority: "high" as const },
    { match: ["possession", "eviction"], title: "Possession, eviction, and occupancy relief", description: "Possession or eviction relief requires careful review of title, occupation status, and procedural requirements.", priority: "high" as const },
    { match: ["damages", "compensation"], title: "Damages and compensation claim framing", description: "Quantification, causation, and documentary support for damages or compensation should be assessed before downstream analysis.", priority: "medium" as const },
    { match: ["legal notice", "demand notice", "reply notice"], title: "Notice compliance and pre-litigation posture", description: "Notice wording, service proof, and response posture are central to pre-litigation strategy and downstream drafting.", priority: "medium" as const },
  ];
  const groups = candidates.filter((c) => c.match.some((m) => lower.includes(m)));
  if (!groups.length) {
    return issues.slice(0, 4).map((issue, idx) => {
      const priority: "high" | "medium" = idx === 0 ? "high" : "medium";
      return {
      title: issue.replace(/\b\w/g, (ch) => ch.toUpperCase()),
      description: `Issue identified from the provided case text: ${issue}.`,
      priority,
    };
    });
  }
  const seen = new Set<string>();
  return groups
    .filter((g) => {
      const key = g.title.toLowerCase().replace(/&/g, "and").replace(/\s+/g, " ").trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((g) => ({ title: g.title, description: g.description, priority: g.priority }))
    .slice(0, 6);
}

function buildRelevantQueryTokens(queryText: string) {
  return [...new Set(
    normalizeForParsing(queryText)
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z\u0900-\u097f\u0980-\u09ff\u0b80-\u0bff\u0c00-\u0c7f0-9?]/g, ""))
      .filter((t) => t.length >= 3)
      .slice(0, 24),
  )];
}

function filterRelevantHitsForQuery(hits: Array<any>, queryText: string) {
  const tokens = buildRelevantQueryTokens(queryText);
  const sanitizedHits = (hits || []).filter((h) => !isLikelyInstructionOrUiSnippet(String(h?.snippet || "")));
  if (!tokens.length) return sanitizedHits;
  const normalizedQuery = normalizeForParsing(queryText);
  const latinRatio =
    normalizedQuery.length > 0
      ? (normalizedQuery.match(/[A-Za-z]/g)?.length || 0) / normalizedQuery.length
      : 0;
  const scored = sanitizedHits.map((h) => {
    const snippet = normalizeForParsing(String(h.snippet || "")).toLowerCase();
    const overlap = tokens.reduce((acc, t) => acc + (snippet.includes(t) ? 1 : 0), 0);
    const snippetLatinRatio =
      snippet.length > 0 ? (snippet.match(/[a-z]/g)?.length || 0) / snippet.length : 0;
    const scriptMismatchPenalty = latinRatio > 0.55 && snippetLatinRatio < 0.1 ? 2 : 0;
    return { h, overlap, score: overlap - scriptMismatchPenalty };
  });
  const minOverlap = tokens.length >= 8 ? 2 : 1;
  const positive = scored
    .filter((x) => x.overlap >= minOverlap && x.score > 0)
    .sort((a, b) => b.score - a.score || b.overlap - a.overlap)
    .map((x) => x.h);
  return positive.length ? positive : [];
}

function deriveCaseType(domain: string, text: string, subtype?: string | null) {
  if (subtype) return subtype;
  const lower = normalizeForParsing(text).toLowerCase();
  if (domain.toLowerCase().includes("contract") && (lower.includes("payment") || lower.includes("invoice") || lower.includes("outstanding"))) return "contract_payment_dispute";
  if (domain.toLowerCase().includes("employment")) return "employment_dispute";
  if (domain.toLowerCase().includes("property") || domain.toLowerCase().includes("family")) return "property_family_dispute";
  if (domain.toLowerCase().includes("consumer")) return "consumer_service_dispute";
  if (domain.toLowerCase().includes("criminal")) return "criminal_complaint_matter";
  return "civil_dispute_general";
}

function detectLikelyNonLegalCaseInput(text: string) {
  const lower = normalizeForParsing(text || "").toLowerCase();
  if (!lower.trim()) {
    return { likelyNonLegal: false, legalSignals: 0, nonLegalSignals: 0, reasons: [] as string[] };
  }
  const tokens = lower.split(/\s+/).filter((t) => t.length >= 2);
  const legalTerms = [
    "dispute", "breach", "contract", "agreement", "invoice", "payment", "refund", "notice", "claim", "damages",
    "arbitration", "tenant", "landlord", "property", "family", "maintenance", "termination", "salary", "employment",
    "police", "complaint", "cheque", "loan", "harassment", "possession", "partition", "eviction", "legal", "court",
    "plaintiff", "defendant", "petitioner", "respondent", "jurisdiction", "civil suit", "written statement", "replication",
    "affidavit", "injunction", "recovery suit", "honble", "high court", "district court",
  ];
  const nonLegalTerms = [
    "assignment", "assessment", "framework", "anomaly", "algorithm", "dataset", "training", "accuracy", "model",
    "classification", "project", "module", "feature", "implementation", "architecture", "system design", "poll room",
    "real-time", "api", "frontend", "backend", "university", "student", "semester", "marks", "rubric", "evaluation",
  ];
  const caseNarrativeTerms = [
    "party", "parties", "petitioner", "respondent", "plaintiff", "defendant", "accused", "complainant",
    "happened", "occurred", "served", "defaulted", "breached", "terminated", "withheld", "refused",
    "agreement", "contract", "invoice", "notice", "evidence", "documents", "communications", "whatsapp",
    "relief", "injunction", "damages", "recovery", "refund", "replacement",
    "written statement", "replication", "jurisdiction", "annexure", "pleading", "suit",
  ];
  const timelineTerms = ["date", "dated", "timeline", "month", "year", "days", "since", "before", "after"];
  const formalLegalDocSignals = [
    "in the high court",
    "in the court of",
    "ordinary original civil jurisdiction",
    "cs(os)",
    "plaintiff",
    "defendant",
    "petitioner",
    "respondent",
    "jurisdiction",
    "written statement",
    "replication",
    "affidavit",
  ].filter((t) => lower.includes(t)).length;
  const legalSignals = legalTerms.filter((t) => lower.includes(t)).length;
  const nonLegalSignals = nonLegalTerms.filter((t) => lower.includes(t)).length;
  const caseNarrativeSignals = caseNarrativeTerms.filter((t) => lower.includes(t)).length;
  const timelineSignals = timelineTerms.filter((t) => lower.includes(t)).length;
  const reasons = [
    nonLegalSignals >= 1 ? "non-legal/technical/academic terms detected" : null,
    legalSignals === 0 ? "no clear legal dispute terms detected" : null,
    caseNarrativeSignals === 0 ? "no case narrative/remedy terms detected" : null,
  ].filter(Boolean) as string[];
  const likelyNonLegalByTerms = nonLegalSignals >= 3 && legalSignals === 0 && formalLegalDocSignals === 0;
  const likelyNonLegalByNoCaseNarrative =
    legalSignals === 0 &&
    caseNarrativeSignals === 0 &&
    timelineSignals === 0 &&
    formalLegalDocSignals === 0 &&
    tokens.length >= 16;
  const likelyNonLegal = likelyNonLegalByTerms || likelyNonLegalByNoCaseNarrative;
  return { likelyNonLegal, legalSignals, nonLegalSignals, caseNarrativeSignals, timelineSignals, formalLegalDocSignals, reasons };
}

function detectLikelyMixedCaseBundleInput(text: string) {
  const lower = normalizeForParsing(text || "").toLowerCase();
  if (!lower.trim()) return { likelyMixed: false, repeatedCaseMarkers: 0, hasTenancy: false, hasCommercial: false };
  const repeatedCaseMarkers =
    (lower.match(/\bcase file\b/g) || []).length +
    (lower.match(/\bparties:\b/g) || []).length +
    (lower.match(/\bagreement date:\b/g) || []).length;
  const tenancySignals = ["tenant", "landlord", "security deposit", "vacating", "rental agreement", "rent"];
  const commercialSignals = ["vendor", "erp", "implementation", "milestones", "change order", "liquidated damages"];
  const hasTenancy = tenancySignals.filter((s) => lower.includes(s)).length >= 2;
  const hasCommercial = commercialSignals.filter((s) => lower.includes(s)).length >= 2;
  const likelyMixed = repeatedCaseMarkers >= 5 || (hasTenancy && hasCommercial);
  return { likelyMixed, repeatedCaseMarkers, hasTenancy, hasCommercial };
}

function detectLowSignalQueryInput(text: string) {
  const raw = String(text || "").trim();
  const normalized = normalizeForParsing(raw).toLowerCase();
  const compact = normalized.replace(/\s+/g, "");
  const alphaNum = compact.replace(/[^a-z0-9\u0900-\u0d7f]/g, "");
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const uniqueTokens = new Set(tokens);
  const uniqueChars = new Set(alphaNum.split(""));
  const vowelCount = (alphaNum.match(/[aeiou]/g) || []).length;
  const legalHints = [
    "dispute", "agreement", "contract", "refund", "tenant", "landlord", "notice", "payment", "claim", "property",
    "employment", "salary", "loan", "harassment", "consumer", "warranty", "breach", "termination", "invoice",
  ].filter((t) => normalized.includes(t)).length;

  const reasons: string[] = [];
  if (!alphaNum) reasons.push("no meaningful alphanumeric text");
  if (compact.length > 0 && compact.length < 12 && legalHints === 0) reasons.push("very short text without legal keywords");
  if (tokens.length <= 2 && uniqueTokens.size <= 2 && legalHints === 0) reasons.push("too few meaningful words");
  if (alphaNum.length >= 6 && uniqueChars.size <= 4 && legalHints === 0) reasons.push("repetitive character pattern");
  if (alphaNum.length >= 8 && vowelCount <= 1 && legalHints === 0 && /^[a-z]+$/.test(alphaNum)) reasons.push("likely random/gibberish latin text");

  const likelyLowSignal =
    reasons.length > 0 &&
    legalHints === 0 &&
    (compact.length < 24 || tokens.length <= 3 || uniqueChars.size <= 5);

  return {
    likelyLowSignal,
    legalHints,
    reasons,
    stats: {
      compact_length: compact.length,
      token_count: tokens.length,
      unique_token_count: uniqueTokens.size,
      unique_char_count: uniqueChars.size,
      vowel_count: vowelCount,
    },
  };
}

function executiveSummaryText(input: { queryText: string; domain: string; subtype?: string | null; jurisdiction: string | null; state: string | null; keyFacts: ReturnType<typeof extractKeyFacts>; outcomes: string[] }) {
  const cleanedQuery = normalizeForParsing(input.queryText);
  const instructionHeavyQuery = isInstructionHeavyQueryText(cleanedQuery);
  const querySentences = splitSentences(cleanedQuery)
    .map((s) => String(s || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((s) => s.length >= 18)
    .filter((s) => !/^(analyze|assess|review|evaluate|identify|determine|explain|provide|prepare|state|check)\b/i.test(s));
  const leadQuerySentence = instructionHeavyQuery ? "" : (querySentences[0] || "");
  const facts = [];
  if (input.keyFacts.contract_date) facts.push(`contract dated ${input.keyFacts.contract_date}`);
  if (input.keyFacts.outstanding_amount_inr) facts.push(`outstanding amount of INR ${input.keyFacts.outstanding_amount_inr.toLocaleString("en-IN")}`);
  if (input.keyFacts.delay_days_range) facts.push(`payment delays of ${input.keyFacts.delay_days_range}`);
  if (input.keyFacts.payment_terms) facts.push(`payment terms of ${input.keyFacts.payment_terms}`);
  if (input.keyFacts.delivery_terms) facts.push(`delivery/performance terms of ${input.keyFacts.delivery_terms}`);
  const lower = normalizeForParsing(input.queryText).toLowerCase();
  const partiesFacts = [
    lower.includes("vendor") ? "a vendor relationship is described" : "",
    lower.includes("supplier") ? "a supplier relationship is described" : "",
    lower.includes("service provider") || lower.includes("service agreement") ? "a service arrangement is described" : "",
    lower.includes("buyer") || lower.includes("client") || lower.includes("customer") ? "the counterparty relationship is described in commercial terms" : "",
    lower.includes("invoice") || lower.includes("invoices") ? "invoice-based payment claims are mentioned" : "",
    lower.includes("notice") || lower.includes("legal notice") ? "notice-related issues are raised" : "",
    lower.includes("breach") ? "breach allegations are raised" : "",
    lower.includes("default") || lower.includes("non-payment") || lower.includes("payment default") ? "default or non-payment is central to the dispute" : "",
  ].filter(Boolean);
  const factLine = facts.length
    ? facts.join(", ")
    : partiesFacts.length
      ? partiesFacts.join(", ")
      : leadQuerySentence
        ? trimToMaxWords(leadQuerySentence, 22)
    : input.domain.toLowerCase().includes("property")
      ? "succession and property-ownership facts extracted from the user query and case materials"
      : "dispute facts extracted from the user query and case materials";
  const location = [input.state, input.jurisdiction].filter(Boolean).join(", ") || "the stated jurisdiction";
  const wants = input.outcomes.length ? [...new Set(input.outcomes)].join(" and ").replaceAll("_", " ") : "clarification of legal options";
  const urgent = input.keyFacts.threats.length ? `Urgency is elevated because the counterparty is threatening ${input.keyFacts.threats.join(" and ")}.` : "";
  const baseLocation = [input.state, input.jurisdiction].filter(Boolean).join(", ") || "the stated jurisdiction";
  const factsSentence = leadQuerySentence
    ? `${trimToMaxWords(leadQuerySentence, 24)}.`
    : `${input.domain} dispute concerns matters connected to ${baseLocation}.`;
  const disputeSentence = facts.length
    ? `Key facts include ${factLine}.`
    : partiesFacts.length
      ? `Key facts indicate ${factLine}.`
      : leadQuerySentence
        ? `The submitted matter indicates ${factLine}.`
    : input.domain.toLowerCase().includes("property")
      ? "Key facts indicate a property and succession dispute requiring document review."
      : "Key dispute facts are extracted from the submitted case description.";
  const askSentence = `The user is seeking ${wants}.`;
  const urgencySentence = urgent || undefined;
  if (String(input.subtype || "").includes("family_maintenance_dv")) {
    const dvFacts = [
      lower.includes("maintenance") ? "maintenance support is requested" : "",
      lower.includes("domestic violence") || lower.includes("dv") ? "domestic violence allegations are raised" : "",
      lower.includes("abuse") || lower.includes("abusive") ? "abuse/harassment is alleged" : "",
      lower.includes("police") ? "police involvement is mentioned" : "",
      lower.includes("medical") ? "medical evidence/reports are referenced" : "",
    ].filter(Boolean).join(", ");
    let summary = polishExecutiveSummaryText(
      `Family maintenance/domestic-violence dispute context is connected to ${location}. Key facts indicate ${dvFacts || "family relationship conflict and support-related issues"}. The user seeks ${wants}, including immediate protection/maintenance options and procedural next steps.${urgent ? ` ${urgent}` : ""}`,
      {
        factSentence: `Family maintenance/domestic-violence dispute context is connected to ${location}.`,
        disputeSentence: `Key facts indicate ${dvFacts || "family relationship conflict and support-related issues"}.`,
        askSentence: `The user seeks ${wants}.`,
        urgencySentence,
      },
    );
    return removeDomainHallucinationTerms(summary, input.domain, input.subtype);
  }
  if (input.domain.toLowerCase().includes("property")) {
    if (String(input.subtype || "").includes("tenancy_deposit_refund_dispute")) {
      const tenancyFacts = [
        lower.includes("landlord") ? "landlord-tenant relationship is stated" : "",
        lower.includes("deposit") ? "security deposit refund is disputed" : "",
        lower.includes("vacated") || lower.includes("handover") ? "vacation/handover is claimed completed" : "",
        lower.includes("painting") || lower.includes("deduct") ? "landlord deduction for painting/damages is disputed" : "",
        lower.includes("whatsapp") ? "WhatsApp communications are available" : "",
        lower.includes("video") ? "handover video evidence is referenced" : "",
      ].filter(Boolean);
      const line = tenancyFacts.length ? tenancyFacts.join(", ") : factLine;
      const summary = polishExecutiveSummaryText(
        `Tenancy/security-deposit dispute context is connected to ${location}. Key facts indicate ${line}. The user seeks ${wants}, including refund/deduction assessment, evidence-based notice strategy, and next procedural steps.${urgent ? ` ${urgent}` : ""}`,
        {
          factSentence: `Tenancy/security-deposit dispute context is connected to ${location}.`,
          disputeSentence: `Key facts indicate ${line}.`,
          askSentence: `The user seeks ${wants}, including refund/deduction assessment and next procedural steps.`,
          urgencySentence,
        },
      );
      return removeDomainHallucinationTerms(summary, input.domain, input.subtype);
    }
    const familyFlags = [
      lower.includes("mother") ? "mother is alive" : "",
      lower.includes("brother") ? "elder brother claims a will" : "",
      lower.includes("daughter") ? "user identifies as a daughter/legal heir" : "",
      lower.includes("2022") && lower.includes("died") ? "death year appears to be 2022" : "",
    ].filter(Boolean);
    const familyLine = familyFlags.length ? ` Key family/succession facts include ${familyFlags.join(", ")}.` : "";
    const summary = polishExecutiveSummaryText(
      `${input.domain} dispute context is connected to ${location}. Key facts indicate ${factLine}.${familyLine} The user seeks ${wants}, including partition/rights clarity and next procedural steps where applicable.${urgent ? ` ${urgent}` : ""}`,
      {
        factSentence: `${input.domain} dispute context is connected to ${location}.`,
        disputeSentence: `Key facts indicate ${factLine}.${familyLine ? ` ${familyLine.trim()}` : ""}`.trim(),
        askSentence: `The user seeks ${wants}, including partition/rights clarity and next procedural steps where applicable.`,
        urgencySentence,
      },
    );
    return removeDomainHallucinationTerms(summary, input.domain, input.subtype);
  }
  if (input.domain.toLowerCase().includes("employment")) {
    const factsLine = [
      lower.includes("terminated") || lower.includes("termination") ? "termination due to alleged performance issues" : "",
      (lower.includes("written warning") || lower.includes("warnings")) ? "no written warnings referenced" : "",
      (lower.includes("full & final") || lower.includes("full and final")) ? "full and final dues are disputed" : "",
      (lower.includes("pf") || lower.includes("gratuity")) ? "PF/gratuity delay is reported" : "",
      (lower.includes("abusive language") || lower.includes("threatened") || lower.includes("screenshots")) ? "screenshots indicate abusive/threatening communications" : "",
    ].filter(Boolean);
    const line = factsLine.length ? factsLine.join(", ") : factLine;
    const summary = polishExecutiveSummaryText(
      `Employment dispute context is connected to ${location}. Key facts indicate ${line}. The user seeks ${wants}, including clarity on applicable laws, document collection, notice preparation, and realistic timeline/cost expectations.${urgent ? ` ${urgent}` : ""}`,
      {
        factSentence: `Employment dispute context is connected to ${location}.`,
        disputeSentence: `Key facts indicate ${line}.`,
        askSentence: "The user seeks applicable-law guidance, a document checklist, notice preparation support, and realistic timeline/cost expectations.",
        urgencySentence,
      },
    );
    return removeDomainHallucinationTerms(summary, input.domain, input.subtype);
  }
  if (input.domain.toLowerCase().includes("consumer")) {
    const consumerFacts = [
      lower.includes("online") || lower.includes("online order") ? "an online purchase transaction is described" : "",
      lower.includes("laptop") || lower.includes("mobile") ? "a consumer product purchase is involved" : "",
      lower.includes("defect") || lower.includes("repair") ? "product defect / malfunction is alleged" : "",
      lower.includes("warranty") || lower.includes("service center") ? "warranty or service-center interactions are referenced" : "",
      lower.includes("refund") ? "refund is requested" : "",
      lower.includes("replacement") ? "replacement is requested" : "",
    ].filter(Boolean);
    const line = consumerFacts.length ? consumerFacts.join(", ") : factLine;
    const summary = polishExecutiveSummaryText(
      `Consumer-service dispute context is connected to ${location}. Key facts indicate ${line}. The user seeks ${wants}, including a practical complaint/remedy pathway and documentation checklist.${urgent ? ` ${urgent}` : ""}`,
      {
        factSentence: `Consumer-service dispute context is connected to ${location}.`,
        disputeSentence: `Key facts indicate ${line}.`,
        askSentence: `The user seeks ${wants}, including a practical complaint/remedy pathway and documentation checklist.`,
        urgencySentence,
      },
    );
    return removeDomainHallucinationTerms(summary, input.domain, input.subtype);
  }
  if (input.domain.toLowerCase().includes("civil litigation / finance")) {
    const financeFacts = [
      lower.includes("loan") || lower.includes("installment") ? "loan/installment dispute facts are described" : "",
      lower.includes("harassing") || lower.includes("harassment") ? "harassing conduct is alleged" : "",
      lower.includes("residence") || lower.includes("public roads") || lower.includes("illegal approach")
        ? "extra-legal recovery conduct at residence/public places is alleged"
        : "",
      lower.includes("threat") || lower.includes("dire consequences") || lower.includes("anti social") || lower.includes("henchmen")
        ? "threat/intimidation concerns are raised"
        : "",
      lower.includes("injunction") || lower.includes("permanent injunction") ? "injunction relief is requested" : "",
      lower.includes("order xxxix") || lower.includes("section 151") || lower.includes("cpc") ? "civil procedure grounds for interim relief are referenced" : "",
      lower.includes("court") ? "court filing context is present" : "",
    ].filter(Boolean);
    const line = financeFacts.length ? financeFacts.join(", ") : factLine;
    const summary = polishExecutiveSummaryText(
      `Civil-litigation/finance dispute context is connected to ${location}. Key facts indicate ${line}. The user seeks ${wants}, including urgent civil relief and filing strategy where applicable.${urgent ? ` ${urgent}` : ""}`,
      {
        factSentence: `Civil-litigation/finance dispute context is connected to ${location}.`,
        disputeSentence: `Key facts indicate ${line}.`,
        askSentence: `The user seeks ${wants}, including civil protection against extra-legal recovery conduct and filing strategy where applicable.`,
        urgencySentence,
      },
    );
    return removeDomainHallucinationTerms(summary, input.domain, input.subtype);
  }
  const summary = polishExecutiveSummaryText(
    `${factsSentence} ${disputeSentence} The user seeks ${wants}.${urgent ? ` ${urgent}` : ""}`,
    {
      factSentence: factsSentence,
      disputeSentence,
      askSentence: `The user seeks ${wants}.`,
      urgencySentence,
    },
  );
  return removeDomainHallucinationTerms(summary, input.domain, input.subtype);
}

export async function runQueryParsing(ctx: Context) {
  const queryText = (ctx.userQueryText || "").trim();
  const seededSnippets = Array.isArray(ctx.extractedDocSnippets) ? ctx.extractedDocSnippets : [];
  const promptTemplateQuery = detectPromptTemplateQuery(queryText);
  const hasMeaningfulQuery = isLikelyMeaningfulCaseQuery(queryText) || hasSubstantialSubmittedInput(queryText);
  const baseText = [queryText, ctx.documentsText].filter(Boolean).join("\n\n").trim();
  const primaryText = hasMeaningfulQuery ? queryText : baseText;
  const terms = topIssues(primaryText);
  const retrievalTerms = [...terms, ...normalizeForParsing(queryText).split(/\s+/).filter(Boolean).slice(0, 12)];
  const requestedSourceTypes = Array.isArray(ctx.caseMeta?.filtersApplied?.source_types)
    ? (ctx.caseMeta?.filtersApplied?.source_types as string[])
    : [];
  const wantsLegalCorpus =
    requestedSourceTypes.length > 0 &&
    requestedSourceTypes.some((s) =>
      ["acts & statutes", "case laws", "regulations", "legal opinions"].includes(String(s || "").toLowerCase()),
    );
  let hits = seededSnippets.length
    ? seededSnippets.slice(0, 10)
    : await indexService.retrieve(ctx.caseId, retrievalTerms, 8, {
        includeUserDocs: true,
        includeLegalCorpus: false,
        filters: ctx.caseMeta?.filtersApplied,
      });
  if (!seededSnippets.length && (wantsLegalCorpus || hits.length < 3)) {
    const legalBoost = await indexService.retrieve(ctx.caseId, retrievalTerms, 10, {
      includeUserDocs: true,
      includeLegalCorpus: true,
      sourceTypes: requestedSourceTypes,
      filters: ctx.caseMeta?.filtersApplied,
    });
    const merged = [...hits, ...legalBoost];
    const dedup = new Map<string, any>();
    for (const h of merged) {
      const key = `${String(h?.source_type || "user_doc")}::${String(h?.doc_id || "")}::${String(h?.chunk_id || "")}`;
      if (!dedup.has(key)) dedup.set(key, h);
      if (dedup.size >= 10) break;
    }
    hits = [...dedup.values()];
  }
  if (queryText) {
    const filteredHits = filterRelevantHitsForQuery(hits as any[], queryText);
    if (filteredHits.length > 0) hits = filteredHits;
    else if (!hasMeaningfulQuery) hits = [];
  }
  const combinedEvidenceText = [baseText.slice(0, 7000), ...hits.map((h: any) => h.snippet || "")].join(" ").trim();
  const normalizedQueryText = normalizeForParsing(queryText).toLowerCase().replace(/\s+/g, " ").trim();
  const hasExternalEvidenceHits = hits.some((h: any) => {
    const docId = String(h?.doc_id || h?.docId || "").toLowerCase();
    const sourceType = String(h?.source_type || "").toLowerCase();
    const sourceLabel = String(h?.source_label || "").toLowerCase().replace(/\s+/g, "_");
    if (docId.startsWith("live_query")) return false;
    if (sourceType === "current_input" || sourceLabel === "current_input") return false;
    const snippetNorm = normalizeForParsing(String(h?.snippet || "")).toLowerCase().replace(/\s+/g, " ").trim();
    if (!snippetNorm) return false;
    if (
      normalizedQueryText &&
      (
        snippetNorm === normalizedQueryText ||
        snippetNorm.includes(normalizedQueryText) ||
        normalizedQueryText.includes(snippetNorm)
      )
    ) return false;
    return true;
  });
  const hasDocContext = Boolean(ctx.documentsText.trim()) || hasExternalEvidenceHits;
  const lowSignalQuery = detectLowSignalQueryInput(queryText);
  const nonLegalScreen = detectLikelyNonLegalCaseInput(combinedEvidenceText || baseText || queryText);
  const mixedCaseScreen = detectLikelyMixedCaseBundleInput(combinedEvidenceText || baseText || queryText);

  if (queryText && !hasDocContext && promptTemplateQuery.likelyTemplate) {
    const qLang = detectLanguageInfo(queryText);
    const code = qLang.code === "unknown" ? "en" : qLang.code;
    const label = qLang.label || (code === "en" ? "English" : code);
    const execSummary =
      "Rejected prompt-template input: the submitted text is an analysis instruction template, not a factual legal dispute. Provide concrete facts, parties, timeline, amount, and remedy sought, or upload supporting case documents.";
    const corePayload = buildQueryParsingCorePayload({
      queryText,
      languageCode: code,
      languageName: label,
      languageConfidence: Number(Math.max(qLang.confidence || 0.8, 0.8).toFixed(3)),
      jurisdiction: null,
      legalDomain: "General",
      legalSubtype: "unknown",
      domainConfidence: 0.1,
      execSummary,
      legalGrounds: ["prompt-template input", "factual dispute details required", "evidence upload required"],
      issueGroups: [{ title: "Prompt-template input", description: "", priority: "high" }],
      keyFactsLegacy: {},
      state: null,
      requestedOutcomes: [],
      confidenceScore: 6,
      confidenceBase: 0.06,
      citationsStrict: [],
      clarifyingQuestions: [
        "Who are the parties and what exactly happened?",
        "What dates, amount, notice, or breach events are involved?",
        "What remedy do you want and what documents can you upload?",
      ],
    });
    return {
      ...corePayload,
      summary: "Rejected prompt-template input due to missing case facts.",
      executive_summary_text: execSummary,
      rejected_input: true,
      analysis_valid: false,
      output_mode: "rejected_input",
      jurisdiction_guess: "Unknown",
      state: null,
      legal_domain: null,
      legal_subtype: "unknown",
      case_type: null,
      detected_language: { code, confidence: Number(Math.max(qLang.confidence || 0.8, 0.8).toFixed(3)), name: label },
      filters_supported: { jurisdiction: true, legal_domain: true, date_range: true, source_types: ["Acts & Statutes", "Case Laws", "Regulations", "Legal Opinions"] },
      filters_applied: normalizeFiltersApplied(ctx.caseMeta?.filtersApplied, { jurisdiction: null, state: null, domain: null }),
      filters_not_fully_applied: Boolean(ctx.caseMeta?.filtersNotFullyApplied),
      issues: ["prompt-template input", "facts clarification required", "evidence upload required"],
      issue_groups: [{ title: "Prompt-template input", description: "The entered text reads like a reusable analysis prompt, not a case-specific dispute.", priority: "high" }],
      entities: {},
      evidence_available: [],
      requested_outcomes: [],
      suggested_topics: ["state the actual dispute facts", "name the parties and timeline", "upload the contract, notice, or chats"],
      missing_information_questions: [
        "What happened, between whom, and when?",
        "What amount, notice, payment, delivery, or breach facts are actually involved?",
        "Which document or communication best proves the dispute?",
      ],
      recommended_next_agents: { common: ["query_parsing"], role_specific: [] },
      confidence: 0.06,
      confidence_score: 6,
      qa_debug: {
        parser_path: "deterministic_prompt_template_guard",
        prompt_template_query: promptTemplateQuery,
        input_stats: ctx.caseMeta?.inputStats || {},
        input_source_verification: {
          used_current_input: Boolean(queryText.trim()),
          used_uploaded_docs: Boolean(ctx.documentsText.trim()) || (seededSnippets || []).some((s: any) => !String(s?.doc_id || "").startsWith("live_query")),
          query_text_chars_used: queryText.trim().length,
          docs_text_chars_used: String(ctx.documentsText || "").trim().length,
          doc_snippets_used_count: (seededSnippets || []).filter((s: any) => !String(s?.doc_id || "").startsWith("live_query")).length,
          current_input_citations_count: 0,
          user_doc_citations_count: 0,
        },
        retrieval_hits_before_filter: hits.length,
        retrieval_hits_after_filter: hits.length,
      },
    };
  }

  if (queryText && !hasDocContext && lowSignalQuery.likelyLowSignal) {
    const qLang = detectLanguageInfo(queryText);
    const code = qLang.code === "unknown" ? "en" : qLang.code;
    const label = qLang.label || (code === "en" ? "English" : code);
    const strictCitations = toStrictQueryCitations(fallbackQueryCitations(queryText), queryText, seededSnippets as any);
    const execSummary =
      "Rejected non-case input: the submitted text does not contain sufficient legal dispute facts. Please provide a factual case description or upload relevant legal/case documents.";
    const corePayload = buildQueryParsingCorePayload({
      queryText,
      languageCode: code,
      languageName: label,
      languageConfidence: Number(Math.max(qLang.confidence || 0.8, 0.8).toFixed(3)),
      jurisdiction: null,
      legalDomain: "General",
      legalSubtype: "unknown",
      domainConfidence: 0.12,
      execSummary,
      legalGrounds: ["invalid or low-signal input", "facts clarification required", "evidence upload required"],
      issueGroups: [{ title: "Invalid or low-signal input", description: "", priority: "high" }],
      keyFactsLegacy: {},
      state: null,
      requestedOutcomes: [],
      confidenceScore: 8,
      confidenceBase: 0.08,
      citationsStrict: strictCitations,
      clarifyingQuestions: [
        "What happened, between whom, and what is the dispute about?",
        "What remedy do you want?",
        "Can you upload the relevant document or communications?",
      ],
    });
    return {
      ...corePayload,
      summary: "Rejected non-case input due to insufficient facts.",
      executive_summary_text: execSummary,
      rejected_input: true,
      analysis_valid: false,
      output_mode: "rejected_input",
      jurisdiction_guess: "Unknown",
      state: null,
      legal_domain: null,
      legal_subtype: "unknown",
      case_type: null,
      detected_language: { code, confidence: Number(Math.max(qLang.confidence || 0.8, 0.8).toFixed(3)), name: label },
      filters_supported: { jurisdiction: true, legal_domain: true, date_range: true, source_types: ["Acts & Statutes", "Case Laws", "Regulations", "Legal Opinions"] },
      filters_applied: normalizeFiltersApplied(ctx.caseMeta?.filtersApplied, { jurisdiction: null, state: null, domain: null }),
      filters_not_fully_applied: Boolean(ctx.caseMeta?.filtersNotFullyApplied),
      issues: ["invalid or low-signal input", "facts clarification required", "evidence upload required"],
      issue_groups: [{ title: "Invalid or low-signal input", description: "The entered text appears to be placeholder/gibberish or lacks case facts.", priority: "high" }],
      entities: {},
      evidence_available: [],
      requested_outcomes: [],
      suggested_topics: ["describe the dispute facts", "upload the main case document", "state the remedy sought"],
      missing_information_questions: [
        "What happened, between whom, and what is the dispute about?",
        "What remedy do you want (refund, notice, recovery, injunction, etc.)?",
        "Can you upload the contract/document/communication related to the dispute?",
      ],
      recommended_next_agents: { common: ["query_parsing"], role_specific: [] },
      confidence: 0.08,
      confidence_score: 8,
      qa_debug: {
        parser_path: "deterministic_low_signal_query_guard",
        low_signal_query: lowSignalQuery,
        input_stats: ctx.caseMeta?.inputStats || {},
        input_source_verification: {
          used_current_input: Boolean(queryText.trim()),
          used_uploaded_docs: Boolean(ctx.documentsText.trim()) || (seededSnippets || []).some((s: any) => !String(s?.doc_id || "").startsWith("live_query")),
          query_text_chars_used: queryText.trim().length,
          docs_text_chars_used: String(ctx.documentsText || "").trim().length,
          doc_snippets_used_count: (seededSnippets || []).filter((s: any) => !String(s?.doc_id || "").startsWith("live_query")).length,
          current_input_citations_count: 0,
          user_doc_citations_count: 0,
        },
        retrieval_hits_before_filter: hits.length,
        retrieval_hits_after_filter: hits.length,
      },
    };
  }

  if (queryText && !hasDocContext && normalizeForParsing(queryText).replace(/\s+/g, "").length < 25) {
    const qLang = detectLanguageInfo(queryText);
    const code = qLang.code === "unknown" ? "en" : qLang.code;
    const label = qLang.label || (code === "en" ? "English" : code);
    const guardLegacy: any = {
      summary: "The submitted text is too short to parse as a legal case query.",
      executive_summary_text:
        "Rejected non-case input: submitted text is too short and lacks legal dispute context. Describe dispute facts, parties, timeline, and requested remedy, or upload case documents.",
      jurisdiction_guess: "Unknown",
      jurisdiction: null,
      state: null,
      domain: "General",
      legal_domain: null,
      case_type: null,
      detected_language: { code, confidence: Number(Math.max(qLang.confidence || 0.9, 0.9).toFixed(3)), name: label },
      filters_supported: { jurisdiction: true, legal_domain: true, date_range: true, source_types: ["Acts & Statutes", "Case Laws", "Regulations", "Legal Opinions"] },
      filters_applied: normalizeFiltersApplied(ctx.caseMeta?.filtersApplied, { jurisdiction: null, state: null, domain: null }),
      filters_not_fully_applied: Boolean(ctx.caseMeta?.filtersNotFullyApplied),
      issues: ["insufficient facts"],
      issue_groups: [{ title: "Insufficient factual input", description: "The entered text is too short to classify as a legal dispute. Add case details or upload documents.", priority: "high" }],
      entities: {},
      key_facts: extractKeyFacts(""),
      evidence_available: [],
      requested_outcomes: [],
      suggested_topics: ["describe dispute facts", "upload documents", "specify jurisdiction"],
      missing_information_questions: ["What happened, between whom, and when?", "What legal outcome do you want?", "Do you have any supporting documents to upload?"],
      recommended_next_agents: { common: ["query_parsing", "contract_risk", "outcome_projection", "policy_compliance", "legal_drafts_validation"], role_specific: [] },
      confidence: 0.1,
      confidence_score: 10,
      citations: [],
      qa_debug: {
        parser_path: "deterministic_short_input_guard",
        input_stats: ctx.caseMeta?.inputStats || {},
        input_source_verification: {
          used_current_input: Boolean(queryText.trim()),
          used_uploaded_docs: Boolean(ctx.documentsText.trim()) || (seededSnippets || []).some((s: any) => !String(s?.doc_id || "").startsWith("live_query")),
          query_text_chars_used: queryText.trim().length,
          docs_text_chars_used: String(ctx.documentsText || "").trim().length,
          doc_snippets_used_count: (seededSnippets || []).filter((s: any) => !String(s?.doc_id || "").startsWith("live_query")).length,
          current_input_citations_count: 0,
          user_doc_citations_count: 0,
        },
        retrieval_hits_before_filter: 0,
        retrieval_hits_after_filter: 0,
      },
    };
    const strictCitations = toStrictQueryCitations(fallbackQueryCitations(queryText), queryText, seededSnippets as any);
    return {
      ...guardLegacy,
      ...buildQueryParsingCorePayload({
        queryText,
        languageCode: code,
        languageName: label,
        languageConfidence: Number(Math.max(qLang.confidence || 0.9, 0.9).toFixed(3)),
        jurisdiction: null,
        legalDomain: "General",
        legalSubtype: "unknown",
        domainConfidence: 0.2,
        execSummary: guardLegacy.executive_summary_text,
        legalGrounds: ["insufficient factual input", "facts clarification required", "evidence upload required"],
        issueGroups: [{ title: "Insufficient factual input", description: "", priority: "high" }],
        keyFactsLegacy: {},
        state: null,
        requestedOutcomes: [],
        confidenceScore: 10,
        confidenceBase: 0.1,
        citationsStrict: strictCitations,
        clarifyingQuestions: [
          "What happened, between whom, and when?",
          "What outcome do you want?",
          "Do you have supporting documents or chats to upload?",
        ],
      }),
      rejected_input: true,
      analysis_valid: false,
      output_mode: "rejected_input",
    };
  }

  const hasConcreteRawQuery =
    Boolean(queryText) &&
    (hasSubstantialSubmittedInput(queryText) ||
      (normalizeForParsing(queryText).replace(/\s+/g, "").length >= 18 &&
        /\s/.test(queryText) &&
        /[a-zA-Z\u0600-\u06ff\u0900-\u0d7f]/.test(queryText)));

  if ((!queryText || !hasConcreteRawQuery) && !ctx.documentsText.trim() && hits.length === 0) {
    const guardLegacy: any = {
      summary: "Insufficient facts were provided for query parsing.",
      executive_summary_text: "Insufficient facts were provided for query parsing. Please enter a case description or upload case documents before running analysis.",
      jurisdiction_guess: "Unknown",
      jurisdiction: null,
      state: null,
      domain: "General",
      legal_domain: null,
      case_type: null,
      detected_language: { code: "en", confidence: 0.1, name: "English" },
      filters_supported: { jurisdiction: true, legal_domain: true, date_range: true, source_types: ["Acts & Statutes", "Case Laws", "Regulations", "Legal Opinions"] },
      filters_applied: normalizeFiltersApplied(ctx.caseMeta?.filtersApplied, { jurisdiction: null, state: null, domain: null }),
      filters_not_fully_applied: Boolean(ctx.caseMeta?.filtersNotFullyApplied),
      issues: ["insufficient facts"],
      issue_groups: [{ title: "Insufficient factual input", description: "No user query text or document snippets were available for parsing.", priority: "high" }],
      entities: {},
      key_facts: extractKeyFacts(""),
      evidence_available: [],
      requested_outcomes: [],
      suggested_topics: ["add case facts", "upload documents", "specify jurisdiction"],
      missing_information_questions: ["Describe the dispute facts, timeline, and what outcome you want.", "Upload the contract, invoices, notices, or communications if available."],
      recommended_next_agents: { common: ["query_parsing", "contract_risk", "outcome_projection", "policy_compliance", "legal_drafts_validation"], role_specific: [] },
      confidence: 0.12,
      confidence_score: 12,
      citations: [],
      qa_debug: {
        parser_path: "deterministic_missing_input_guard",
        input_stats: ctx.caseMeta?.inputStats || {},
        input_source_verification: {
          used_current_input: Boolean(queryText.trim()),
          used_uploaded_docs: Boolean(ctx.documentsText.trim()) || (seededSnippets || []).some((s: any) => !String(s?.doc_id || "").startsWith("live_query")),
          query_text_chars_used: queryText.trim().length,
          docs_text_chars_used: String(ctx.documentsText || "").trim().length,
          doc_snippets_used_count: (seededSnippets || []).filter((s: any) => !String(s?.doc_id || "").startsWith("live_query")).length,
          current_input_citations_count: 0,
          user_doc_citations_count: 0,
        },
        retrieval_hits_before_filter: hits.length,
        retrieval_hits_after_filter: hits.length,
      },
    };
    const strictCitations = toStrictQueryCitations(fallbackQueryCitations(queryText), queryText, seededSnippets as any);
    return {
      ...guardLegacy,
      ...buildQueryParsingCorePayload({
        queryText,
        languageCode: "en",
        languageName: "English",
        languageConfidence: 0.1,
        jurisdiction: null,
        legalDomain: "General",
        legalSubtype: "unknown",
        domainConfidence: 0.2,
        execSummary: guardLegacy.executive_summary_text,
        legalGrounds: ["insufficient factual input", "facts clarification required", "evidence upload required"],
        issueGroups: [{ title: "Insufficient factual input", description: "", priority: "high" }],
        keyFactsLegacy: {},
        state: null,
        requestedOutcomes: [],
        confidenceScore: 12,
        confidenceBase: 0.12,
        citationsStrict: strictCitations,
        clarifyingQuestions: [
          "Describe the dispute facts, timeline, and the key object/service/property involved.",
          "What exact remedy do you want?",
          "Can you upload the main document or chats for evidence?",
        ],
      }),
      rejected_input: true,
      analysis_valid: false,
      output_mode: "rejected_input",
    };
  }

  if (nonLegalScreen.likelyNonLegal) {
    const qLang = detectLanguageInfo(combinedEvidenceText || baseText || queryText);
    const code = qLang.code === "unknown" ? "en" : qLang.code;
    const label = qLang.label || (code === "en" ? "English" : code);
    const preCitations = getCitations(hits.slice(0, 6));
    const strictCitations = toStrictQueryCitations(
      limitQueryParsingCitations(ensureMinQueryParsingCitations(preCitations, queryText, 3), Boolean(queryText.trim())),
      queryText,
      seededSnippets as any,
    );
    const guardSummary =
      "Rejected non-case input: the submitted material appears non-legal/technical or lacks a legal dispute narrative. Query Parsing will not route downstream legal agents until legal case facts/documents are provided.";
    const guardLegacy: any = {
      summary: "Rejected non-case input: non-legal or unrelated material detected.",
      executive_summary_text: guardSummary,
      jurisdiction_guess: /india/i.test(combinedEvidenceText) ? "India" : "Unknown",
      jurisdiction: /india/i.test(combinedEvidenceText) ? "India" : null,
      state: detectState(combinedEvidenceText, ctx.caseMeta?.filtersApplied),
      domain: "General",
      legal_domain: null,
      case_type: null,
      detected_language: { code, confidence: Number(Math.max(qLang.confidence || 0.8, 0.8).toFixed(3)), name: label },
      filters_supported: { jurisdiction: true, legal_domain: true, date_range: true, source_types: ["Acts & Statutes", "Case Laws", "Regulations", "Legal Opinions"] },
      filters_applied: normalizeFiltersApplied(ctx.caseMeta?.filtersApplied, { jurisdiction: null, state: null, domain: null }),
      filters_not_fully_applied: Boolean(ctx.caseMeta?.filtersNotFullyApplied),
      issues: ["non-legal document", "case facts missing", "clarification required"],
      issue_groups: [{ title: "Non-legal or non-case input", description: "Uploaded content does not read like a legal dispute/case description.", priority: "high" }],
      entities: {},
      key_facts: extractKeyFacts(""),
      evidence_available: [],
      requested_outcomes: [],
      suggested_topics: ["upload legal case documents", "paste dispute facts", "state requested remedy"],
      missing_information_questions: [
        "What legal dispute or complaint do you want help with?",
        "Who are the parties and what happened?",
        "Can you upload the contract/notices/chats relevant to the dispute?",
      ],
      recommended_next_agents: { common: ["query_parsing"], role_specific: [] },
      confidence: 0.18,
      confidence_score: 18,
      citations: strictCitations,
      qa_debug: {
        parser_path: "deterministic_non_legal_input_guard",
        input_stats: ctx.caseMeta?.inputStats || {},
        non_legal_screen: nonLegalScreen,
        input_source_verification: {
          used_current_input: Boolean(queryText.trim()),
          used_uploaded_docs: Boolean(ctx.documentsText.trim()) || (seededSnippets || []).some((s: any) => !String(s?.doc_id || "").startsWith("live_query")),
          query_text_chars_used: queryText.trim().length,
          docs_text_chars_used: String(ctx.documentsText || "").trim().length,
          doc_snippets_used_count: (seededSnippets || []).filter((s: any) => !String(s?.doc_id || "").startsWith("live_query")).length,
          current_input_citations_count: strictCitations.filter((c: any) => c?.source_type === "current_input").length,
          user_doc_citations_count: strictCitations.filter((c: any) => c?.source_type === "user_doc").length,
        },
        retrieval_hits_before_filter: hits.length,
        retrieval_hits_after_filter: hits.length,
      },
    };
    return {
      ...guardLegacy,
      ...buildQueryParsingCorePayload({
        queryText,
        languageCode: code,
        languageName: label,
        languageConfidence: Number(Math.max(qLang.confidence || 0.8, 0.8).toFixed(3)),
        jurisdiction: guardLegacy.jurisdiction,
        legalDomain: "General",
        legalSubtype: "unknown",
        domainConfidence: 0.2,
        execSummary: guardSummary,
        legalGrounds: ["non-legal input detected", "legal dispute facts not established", "clarification required"],
        issueGroups: [{ title: "Non-legal or non-case input", description: "", priority: "high" }],
        keyFactsLegacy: {},
        state: guardLegacy.state,
        requestedOutcomes: [],
        confidenceScore: 18,
        confidenceBase: 0.18,
        citationsStrict: strictCitations,
        clarifyingQuestions: [
          "What legal dispute or complaint do you want help with?",
          "Who are the parties and what happened?",
          "Can you upload the legal contract/notice/chats related to the dispute?",
        ],
      }),
      rejected_input: true,
      analysis_valid: false,
      output_mode: "rejected_input",
    };
  }

  if (mixedCaseScreen.likelyMixed && !hasMeaningfulQuery) {
    const qLang = detectLanguageInfo(combinedEvidenceText || baseText || queryText);
    const code = qLang.code === "unknown" ? "en" : qLang.code;
    const label = qLang.label || (code === "en" ? "English" : code);
    const preCitations = getCitations(hits.slice(0, 6));
    const docFallback = String(ctx.documentsText || "").trim() ? fallbackDocTextCitations(String(ctx.documentsText || "").trim()) : [];
    const strictCitations = toStrictQueryCitations(
      limitQueryParsingCitations(
        ensureMinQueryParsingCitations(preCitations.length ? preCitations : docFallback, queryText, 3),
        Boolean(queryText.trim()),
      ),
      queryText,
      seededSnippets as any,
    );
    const guardSummary =
      "The uploaded document appears to contain multiple case sections/examples, so Query Parsing cannot confidently identify a single case narrative for routing. Upload the exact case document or paste the target case facts.";
    const stateGuess = detectState(combinedEvidenceText, ctx.caseMeta?.filtersApplied);
    const guardLegacy: any = {
      summary: "Multiple case sections detected in uploaded document.",
      executive_summary_text: guardSummary,
      jurisdiction_guess: /india/i.test(combinedEvidenceText) ? "India" : "Unknown",
      jurisdiction: /india/i.test(combinedEvidenceText) ? "India" : null,
      state: stateGuess,
      domain: "General",
      legal_domain: null,
      case_type: null,
      detected_language: { code, confidence: Number(Math.max(qLang.confidence || 0.8, 0.8).toFixed(3)), name: label },
      filters_supported: { jurisdiction: true, legal_domain: true, date_range: true, source_types: ["Acts & Statutes", "Case Laws", "Regulations", "Legal Opinions"] },
      filters_applied: normalizeFiltersApplied(ctx.caseMeta?.filtersApplied, { jurisdiction: null, state: stateGuess, domain: null }),
      filters_not_fully_applied: Boolean(ctx.caseMeta?.filtersNotFullyApplied),
      issues: ["multiple case sections detected", "single case narrative unclear", "clarification required"],
      issue_groups: [{ title: "Mixed case sections in uploaded document", description: "The uploaded content appears to include more than one case/example.", priority: "high" }],
      entities: {},
      key_facts: extractKeyFacts(""),
      evidence_available: [],
      requested_outcomes: [],
      suggested_topics: ["upload exact case file only", "paste target case facts", "remove templates/examples"],
      missing_information_questions: [
        "Which specific case in the uploaded document should be analyzed?",
        "Can you upload only the exact contract/case documents for that dispute?",
        "Can you paste the target case facts and requested outcome?",
      ],
      recommended_next_agents: { common: ["query_parsing"], role_specific: [] },
      confidence: 0.2,
      confidence_score: 20,
      citations: strictCitations,
      qa_debug: {
        parser_path: "deterministic_mixed_case_bundle_guard",
        input_stats: ctx.caseMeta?.inputStats || {},
        mixed_case_screen: mixedCaseScreen,
        input_source_verification: {
          used_current_input: Boolean(queryText.trim()),
          used_uploaded_docs: Boolean(ctx.documentsText.trim()) || (seededSnippets || []).some((s: any) => !String(s?.doc_id || "").startsWith("live_query")),
          query_text_chars_used: queryText.trim().length,
          docs_text_chars_used: String(ctx.documentsText || "").trim().length,
          doc_snippets_used_count: (seededSnippets || []).filter((s: any) => !String(s?.doc_id || "").startsWith("live_query")).length,
          current_input_citations_count: strictCitations.filter((c: any) => c?.source_type === "current_input").length,
          user_doc_citations_count: strictCitations.filter((c: any) => c?.source_type === "user_doc").length,
        },
        retrieval_hits_before_filter: hits.length,
        retrieval_hits_after_filter: hits.length,
      },
    };
    return {
      ...guardLegacy,
      ...buildQueryParsingCorePayload({
        queryText,
        languageCode: code,
        languageName: label,
        languageConfidence: Number(Math.max(qLang.confidence || 0.8, 0.8).toFixed(3)),
        jurisdiction: guardLegacy.jurisdiction,
        legalDomain: "General",
        legalSubtype: "unknown",
        domainConfidence: 0.2,
        execSummary: guardSummary,
        legalGrounds: ["multiple case sections detected", "single case extraction required", "clarification required"],
        issueGroups: [{ title: "Mixed case sections in uploaded document", description: "", priority: "high" }],
        keyFactsLegacy: {},
        state: stateGuess,
        requestedOutcomes: [],
        confidenceScore: 20,
        confidenceBase: 0.2,
        citationsStrict: strictCitations,
        clarifyingQuestions: [
          "Which specific case in this uploaded file should be analyzed?",
          "Can you upload only the exact case documents (without examples/templates)?",
          "Can you paste the target case facts and requested remedy?",
        ],
      }),
      rejected_input: true,
      analysis_valid: false,
      output_mode: "rejected_input",
    };
  }

  const hitsBeforeFilter = hits.length;
  const classifierText = hasMeaningfulQuery
    ? [queryText, ...hits.slice(0, 3).map((h: any) => h.snippet || "")].join(" ")
    : [...hits.slice(0, 6).map((h: any) => String(h?.snippet || "")), String(ctx.documentsText || "").slice(0, 1800)]
        .filter(Boolean)
        .join(" ");
  const domainDetails = classifyDomainDetailed(classifierText);
  const detectedDomain = domainDetails.domain;
  let keyFacts = extractKeyFacts(classifierText);
  if (keyFacts.outstanding_amount_inr == null || keyFacts.outstanding_amount_inr <= 0) {
    keyFacts = {
      ...keyFacts,
      outstanding_amount_inr: parseInrAmount(ctx.documentsText || combinedEvidenceText || classifierText),
    };
  }
  const evidence = extractEvidenceAvailable(classifierText);
  const requestedOutcomes = extractRequestedOutcomes(classifierText);
  let issueGroups: Array<{ title: string; description: string; priority: "high" | "medium" | "low" }> = buildIssueGroups(classifierText, terms);
  const jurisdiction = /india/i.test(normalizeForParsing(combinedEvidenceText)) || ctx.caseMeta?.filtersApplied?.jurisdiction === "India" || ctx.caseMeta?.filtersApplied?.jurisdiction === "All India"
    ? "India"
    : (ctx.caseMeta?.filtersApplied?.jurisdiction || null);
  const detectedState = detectState(classifierText, ctx.caseMeta?.filtersApplied);
  const legalDomain =
    detectedDomain === "Corporate / Contract"
      ? "Commercial Contract / Supply"
      : detectedDomain === "Property / Family"
        ? "Property / Family"
        : detectedDomain;
  const documentProfile = buildLegalDocumentProfile({
    text: ctx.documentsText || combinedEvidenceText || classifierText,
    domain: legalDomain,
    subtype: domainDetails.subtype,
    state: detectedState,
    requestedOutcomes,
  });
  const state = detectedState || documentProfile.state_hint || null;
  keyFacts = enrichKeyFactsWithDocumentProfile(keyFacts, documentProfile, state);
  issueGroups = mergeIssueGroupsWithDocumentHints(issueGroups, documentProfile);
  const filtersApplied = normalizeFiltersApplied(ctx.caseMeta?.filtersApplied, { jurisdiction, state, domain: legalDomain });

  if (!seededSnippets.length && legalDomain !== "General") {
    const legalTerms = buildLegalCorpusRetrievalTerms({
      queryText: primaryText,
      domain: legalDomain,
      subtype: domainDetails.subtype,
      issues: issueGroups.map((g) => String(g?.title || "").trim()).filter(Boolean),
    });
    if (legalTerms.length) {
      const legalFocusedHits = await indexService.retrieve(ctx.caseId, legalTerms, 10, {
        includeUserDocs: false,
        includeLegalCorpus: true,
        sourceTypes: requestedSourceTypes,
        filters: ctx.caseMeta?.filtersApplied,
      });
      const merged = [...hits, ...legalFocusedHits];
      const dedup = new Map<string, any>();
      for (const h of merged) {
        const key = `${String(h?.source_type || "user_doc")}::${String(h?.doc_id || "")}::${String(h?.chunk_id || "")}`;
        if (!dedup.has(key)) dedup.set(key, h);
        if (dedup.size >= 12) break;
      }
      hits = [...dedup.values()];
    }
  }

  const queryLang = queryText ? detectLanguageInfo(queryText) : null;
  const docsSample = [...hits.map((h: any) => h.snippet || ""), ctx.documentsText.slice(0, 2000)].join(" ").trim();
  const docsLang = docsSample ? detectLanguageInfo(docsSample) : null;
  const langInfo =
    queryLang && queryLang.code !== "unknown"
      ? docsLang && docsLang.code === queryLang.code
        ? { ...queryLang, confidence: Math.max(queryLang.confidence, Math.min(0.99, docsLang.confidence + 0.03)) }
        : queryLang
      : docsLang || detectLanguageInfo(combinedEvidenceText);
  const detectedLanguageName = langInfo.label || ctx.caseMeta?.detectedLanguage || "English";
  const languageCode = langInfo.code === "unknown" ? languageCodeFromName(ctx.caseMeta?.detectedLanguage) : langInfo.code;
  const languageConfidence = languageCode === "en" ? Math.max(langInfo.confidence || 0.88, 0.88) : Math.max(langInfo.confidence || 0.86, 0.86);

  const provisionalCitationsCount = (hasMeaningfulQuery ? filterRelevantHitsForQuery(hits as any[], queryText).slice(0, 6) : hits).length;
  const roleSpecificDefaults: Record<UserRole, string[]> = {
    LAWYER: ["lawyer_strategy_action_plan", "lawyer_client_communication", "lawyer_court_process_copilot", "lawyer_case_prep", "lawyer_intern_guidance"],
    LAW_STUDENT: ["student_workflow_case_mgmt", "student_concept_learning_books", "student_exam_preparation"],
    BUSINESS_CORPORATE: ["corp_executive_decision_support", "corp_workflow_case_prep", "corp_court_process"],
    NORMAL_PERSON: ["individual_step_by_step_guidance", "individual_family_explain", "individual_cost_factor"],
  };

  let execSummary = buildDocumentAwareExecutiveSummary({
    profile: documentProfile,
    domain: legalDomain,
    jurisdiction,
    state,
    requestedOutcomes,
    inputMode: ctx.caseMeta?.inputStats?.input_mode,
  }) || executiveSummaryText({ queryText: primaryText, domain: legalDomain, subtype: domainDetails.subtype, jurisdiction, state, keyFacts, outcomes: requestedOutcomes });

  const relevantHits = hasMeaningfulQuery ? filterRelevantHitsForQuery(hits as any[], queryText).slice(0, 6) : hits;
  const cleanRelevantHits = (relevantHits.length ? relevantHits : (hasMeaningfulQuery ? [] : hits))
    .filter((h: any) => !isLikelyInstructionOrUiSnippet(String(h?.snippet || "")));
  const citations = getCitations(cleanRelevantHits);
  const queryFallback = hasMeaningfulQuery ? fallbackQueryCitations(queryText) : [];
  const docFallback = (!citations.length && String(ctx.documentsText || "").trim())
    ? fallbackDocTextCitations(String(ctx.documentsText || "").trim())
    : [];
  const finalCitations = limitQueryParsingCitations(
    ensureMinQueryParsingCitations(citations.length ? citations : [...docFallback, ...queryFallback], queryText, 3),
    Boolean(queryText.trim()),
  );
  issueGroups = filterIrrelevantQueryParsingIssueGroups(
    issueGroups,
    [classifierText, ...finalCitations.map((c) => String(c?.snippet || ""))].join(" "),
  );
  const legalCorpusCitations = finalCitations.filter((c) => (c.source_type || "").toLowerCase() === "legal_corpus");
  if (jurisdiction === "India") {
    execSummary = sanitizeIndiaJurisdictionStatuteMentions(execSummary, legalCorpusCitations);
  }
  if (!hasMeaningfulQuery || looksLikeDeterministicTemplateSummary(execSummary)) {
    execSummary = buildDocumentAwareExecutiveSummary({
      profile: documentProfile,
      domain: legalDomain,
      jurisdiction,
      state,
      requestedOutcomes,
      inputMode: ctx.caseMeta?.inputStats?.input_mode,
    }) || evidenceLedExecutiveSummary({
      citations: finalCitations,
      domain: legalDomain,
      jurisdiction,
      state,
      issueGroups,
      requestedOutcomes,
    });
  }
  let legalGrounds = buildPlainLegalGrounds({
    domain: legalDomain,
    text: classifierText,
    issueGroups,
    evidenceAvailable: evidence,
  }).map((g) => (jurisdiction === "India" ? sanitizeIndiaJurisdictionStatuteMentions(g, legalCorpusCitations) : g));
  legalGrounds = mergeLegalGroundsWithDocumentHints(legalGrounds, documentProfile);
  legalGrounds = filterIrrelevantQueryParsingGrounds(legalGrounds, combinedEvidenceText || classifierText);
  legalGrounds = enrichGroundsWithCorpusEvidence(legalGrounds, finalCitations);

  let legalResearchAuthorities = buildLegalResearchAuthoritiesFromCitations(finalCitations);
  if (legalResearchAuthorities.length < 2 && legalDomain !== "General") {
    const llmAuthorities = await generateLegalResearchAuthoritiesLlmFallback({
      queryText,
      summary: execSummary,
      domain: legalDomain,
      subtype: domainDetails.subtype,
      jurisdiction,
      issueGroups,
      legalCorpusCitations,
    });
    legalResearchAuthorities = dedupeLegalResearchAuthorities([...legalResearchAuthorities, ...llmAuthorities]).slice(0, 5);
  }
  const factsTotal = 8;
  const factsFilled = [
    keyFacts.contract_date,
    keyFacts.payment_terms,
    keyFacts.delivery_terms,
    keyFacts.outstanding_amount_inr != null ? "amt" : null,
    keyFacts.delay_days_range,
    keyFacts.arbitration_clause.present ? "arb" : null,
    keyFacts.interest_clause.present ? "int" : null,
    keyFacts.threats.length ? "threats" : null,
  ].filter(Boolean).length;
  const factsRatio = factsFilled / factsTotal;
  const citationSignal = Math.min(1, finalCitations.length >= 1 ? 0.7 + Math.min(finalCitations.length, 3) * 0.1 : 0);
  const confidenceBreakdown = {
    language: Number(languageConfidence.toFixed(3)),
    domain: Number(domainDetails.domainConfidence.toFixed(3)),
    facts: Number(factsRatio.toFixed(3)),
    citations: Number(citationSignal.toFixed(3)),
  };
  let confidenceBase = Math.max(
    0.2,
    Math.min(
      0.98,
      confidenceBreakdown.language * 0.25 +
        confidenceBreakdown.domain * 0.3 +
        confidenceBreakdown.facts * 0.3 +
        confidenceBreakdown.citations * 0.15,
    ),
  );
  const externalGroundingCitations = finalCitations.filter((c: any) => {
    const sourceType = String(c?.source_type || "").toLowerCase();
    const docId = String(c?.doc_id || "").toLowerCase();
    return sourceType === "legal_corpus" || (sourceType === "user_doc" && !docId.startsWith("live_query"));
  });
  const hasConcreteExtractedFacts =
    factsFilled >= 2 ||
    evidence.length > 0 ||
    requestedOutcomes.length > 0 ||
    externalGroundingCitations.length > 0 ||
    !!documentProfile.court_name ||
    documentProfile.parties.length > 0 ||
    documentProfile.case_numbers.length > 0 ||
    documentProfile.reliefs_claimed.length > 0;
  if (!hasConcreteExtractedFacts) {
    confidenceBase = Math.min(confidenceBase, 0.18);
  } else if (factsFilled <= 1 && evidence.length === 0 && externalGroundingCitations.length === 0) {
    confidenceBase = Math.min(confidenceBase, 0.32);
  }
  const confidenceScore = Math.round(confidenceBase * 100);

  const strictCitations = toStrictQueryCitations(finalCitations as any, queryText, seededSnippets as any);
  const queryTextChars = queryText.trim().length;
  const docsTextCharsUsed = String(ctx.documentsText || "").trim().length;
  const seededUserDocSnippets = (seededSnippets || []).filter((s: any) => !String(s?.doc_id || "").startsWith("live_query"));
  const inputSourceVerification = {
    used_current_input: queryTextChars > 0,
    used_uploaded_docs: docsTextCharsUsed > 0 || seededUserDocSnippets.length > 0,
    query_text_chars_used: queryTextChars,
    docs_text_chars_used: docsTextCharsUsed,
    doc_snippets_used_count: seededUserDocSnippets.length,
    current_input_citations_count: strictCitations.filter((c: any) => c?.source_type === "current_input").length,
    user_doc_citations_count: strictCitations.filter((c: any) => c?.source_type === "user_doc").length,
  };

  const legacyPayload: any = {
    summary: execSummary,
    executive_summary_text: execSummary,
    jurisdiction_guess: jurisdiction || "Unknown",
    jurisdiction,
    state,
    domain: legalDomain,
    legal_domain: legalDomain,
    case_type: deriveCaseType(legalDomain, combinedEvidenceText, domainDetails.subtype),
    legal_subtype: domainDetails.subtype,
    detected_language: { code: languageCode, confidence: Number(languageConfidence.toFixed(3)), name: detectedLanguageName },
    filters_supported: { jurisdiction: true, legal_domain: true, date_range: true, source_types: ["Acts & Statutes", "Case Laws", "Regulations", "Legal Opinions"] },
    filters_applied: filtersApplied,
    filters_not_fully_applied: Boolean(ctx.caseMeta?.filtersNotFullyApplied),
    issues: terms,
    issue_groups: issueGroups,
    entities: extractEntities(normalizeForParsing(classifierText)),
    key_facts: keyFacts,
    evidence_available: evidence,
    requested_outcomes: requestedOutcomes,
    suggested_topics: ["timeline validation", "evidence sufficiency", "risk mitigation"],
    missing_information_questions: [
      !keyFacts.contract_date ? "What is the contract/work order date?" : null,
      keyFacts.outstanding_amount_inr == null ? "What is the exact outstanding amount?" : null,
      !evidence.includes("invoices") ? "Do you have invoices and payment ledger statements?" : null,
      keyFacts.arbitration_clause.present && !keyFacts.arbitration_clause.seat ? "What is the arbitration seat mentioned in the clause?" : null,
    ].filter(Boolean),
    recommended_next_agents: { common: ["query_parsing", "contract_risk", "outcome_projection", "policy_compliance", "legal_drafts_validation"], role_specific: roleSpecificDefaults[ctx.caseRole] || [] },
    confidence: confidenceBase,
    confidence_score: confidenceScore,
    confidence_breakdown: confidenceBreakdown,
    citations: finalCitations,
    legal_research_authorities: legalResearchAuthorities,
    legal_grounds: legalGrounds,
    qa_debug: {
      parser_path: "deterministic_base_with_optional_llm_polish",
      input_stats: ctx.caseMeta?.inputStats || {},
      input_source_verification: inputSourceVerification,
      has_meaningful_query: hasMeaningfulQuery,
      retrieval_hits_before_filter: hitsBeforeFilter,
      retrieval_hits_after_filter: hits.length,
      relevant_hits_used: relevantHits.length,
      citations_used: finalCitations.length,
      external_grounding_citations: externalGroundingCitations.length,
      has_concrete_extracted_facts: hasConcreteExtractedFacts,
      legal_research_authorities_count: legalResearchAuthorities.length,
      legal_research_authorities_rag_count: legalResearchAuthorities.filter((a) => a.source === "rag").length,
      classifier_domain: detectedDomain,
      classifier_subtype: domainDetails.subtype,
      classifier_confidence: domainDetails.domainConfidence,
    },
  };
  const subtypeForStrict = domainDetails.subtype || (strictCitations.length < 3 ? "unknown" : null) || "unknown";
  const clarifyingQuestions = [
    !keyFacts.contract_date ? "What is the key date (contract/order/incident date)?" : null,
    keyFacts.outstanding_amount_inr == null && !/₹|rs\.?|inr/i.test(queryText) ? "What is the exact amount involved, if any?" : null,
    !state ? "Which city/state is this dispute connected to?" : null,
  ].filter(Boolean) as string[];
  return {
    ...legacyPayload,
    ...buildQueryParsingCorePayload({
      queryText,
      languageCode,
      languageName: detectedLanguageName,
      languageConfidence,
      jurisdiction,
      legalDomain,
      legalSubtype: subtypeForStrict,
      domainConfidence: domainDetails.domainConfidence,
      execSummary,
      legalGrounds,
      issueGroups,
        keyFactsLegacy: keyFacts,
        state,
        requestedOutcomes,
        confidenceScore,
        confidenceBase,
        citationsStrict: strictCitations,
        clarifyingQuestions,
        documentProfile,
      }),
    summary: appendRolePerspective(execSummary, ctx.caseRole, "query"),
    executive_summary_text: appendRolePerspective(execSummary, ctx.caseRole, "query"),
    suggested_topics: prependRoleItems(ctx.caseRole, ["timeline validation", "evidence sufficiency", "risk mitigation"], "query"),
    missing_information_questions: prependRoleItems(ctx.caseRole, legacyPayload.missing_information_questions || [], "query").slice(0, 5),
    audience_mode: applyRoleAwareLabel(ctx.caseRole),
    rejected_input: false,
    analysis_valid: true,
    output_mode: "normal",
  };
}

export async function runTermsAndPolicies(ctx: Context) {
  const qp = ctx.existing.query_parsing || {};
  const qpDomainText =
    (typeof qp.domain === "string" ? qp.domain : null) ||
    (typeof qp.legal_domain === "string" ? qp.legal_domain : null) ||
    (typeof qp.domain?.primary === "string" ? qp.domain.primary : null) ||
    "General";
  const requestedTypes = qp.filters_applied?.source_types as string[] | undefined;
  const hits = await indexService.retrieve(ctx.caseId, [...(qp.issues || []), "policy", "clause", "regulation", "statute"], 8, { includeUserDocs: true, includeLegalCorpus: true, sourceTypes: requestedTypes });
  const legalHits = hits.filter((h: any) => h.source_type !== "documents");
  return {
    summary: appendRolePerspective(`Terms and policy recommendations generated for ${qpDomainText || "the matter"} using uploaded case materials and legal source references.`, ctx.caseRole, "terms"),
    applicable_policies: [
      { name: qpDomainText.includes("Contract") ? "Contract obligations and breach remedies" : "General civil procedure readiness", rationale: "Aligned to parsed issues and evidence requirements." },
      { name: "Notice and documentation protocol", rationale: "Repeated timeline/notice dependencies detected in case context." },
    ],
    recommended_terms: [
      { title: "Notice and Cure", clause_text: "Provide written notice with a defined cure period before escalation." },
      { title: "Evidence Preservation", clause_text: "Maintain records, communications, invoices, and delivery proof for dispute evaluation." },
    ],
    risk_flags: [
      { title: "Insufficient governing terms", description: "Missing or unclear governing law / jurisdiction language can increase dispute complexity." },
      { title: "Evidence mismatch", description: "Claims without documentary support weaken compliance and outcome projections." },
    ],
    recommended_actions: prependRoleItems(ctx.caseRole, [
      "Review the governing terms against the present case facts",
      "Check whether the notice and documentation steps are commercially and legally usable",
    ], "terms"),
    audience_mode: applyRoleAwareLabel(ctx.caseRole),
    confidence: hits.length ? (legalHits.length ? 0.76 : 0.58) : 0.32,
    citations: pickModuleCitations("terms_and_policies", hits, [qpDomainText, ...(qp.issues || [])]),
  };
}

export async function runContractRisk(ctx: Context) {
  const qp = ctx.existing.query_parsing || {};
  const hits = await indexService.retrieve(ctx.caseId, [...(qp.issues || []), "liability", "termination", "payment"], 6);
  const text = normalizeForParsing(ctx.documentsText).toLowerCase();
  const missing = [];
  if (!text.includes("termination")) missing.push("termination clause language");
  if (!text.includes("indemn")) missing.push("indemnity clause");
  if (!text.includes("governing law")) missing.push("governing law / jurisdiction clause");
  const flagged = [];
  if (text.includes("penalty") || text.includes("interest")) flagged.push("Penalty / interest clause may require proportionality and enforceability review");
  if (text.includes("delay")) flagged.push("Delay obligations and cure periods need review");
  if (text.includes("exclusive")) flagged.push("Exclusive remedy language may limit claims");
  const riskScore = flagged.length + missing.length;
  return {
    risk_level: riskScore >= 5 ? "High" : riskScore >= 3 ? "Medium" : "Low",
    flagged_clauses: flagged,
    missing_clauses: missing,
    dispute_suggestions: prependRoleItems(ctx.caseRole, ["Preserve correspondence and delivery proof", "Compare contractual cure periods to actual notices sent", "Assess settlement leverage using delay and loss evidence"], "risk"),
    summary: appendRolePerspective(`Contract risk review for ${String(qp?.legal_domain || qp?.domain || "the matter")} highlights ${riskScore} key clause gaps or clause-level risk signals.`, ctx.caseRole, "risk"),
    audience_mode: applyRoleAwareLabel(ctx.caseRole),
    confidence: 0.64 + Math.min(hits.length * 0.04, 0.2),
    citations: pickModuleCitations("contract_risk", hits, [...flagged, ...missing, ...(qp.issues || [])]),
  };
}

export async function runOutcomeProjection(ctx: Context) {
  const qp = ctx.existing.query_parsing || {};
  const risk = ctx.existing.contract_risk || {};
  const hits = await indexService.retrieve(ctx.caseId, ["damages", "notice", "timeline", "evidence", ...(qp.issues || [])], 7);
  const combined = normalizeForParsing(`${ctx.documentsText || ""} ${ctx.userQueryText || ""} ${qp?.executive_summary || qp?.summary || ""}`).toLowerCase();
  const evidenceSignals = [
    /invoice|ledger|purchase order|work order/i,
    /payment|outstanding|receipt|bank transfer|utr/i,
    /notice|email|whatsapp|communication/i,
    /agreement|contract|clause|annexure/i,
  ].filter((r) => r.test(combined)).length;
  const disputeSignals = [
    /breach|default|termination|delay/i,
    /liquidated damages|penalty|interest/i,
    /dispute|arbitration|jurisdiction|governing law/i,
  ].filter((r) => r.test(combined)).length;
  const issueCount = Array.isArray(qp?.issue_groups) ? qp.issue_groups.length : Array.isArray(qp?.issues) ? qp.issues.length : 0;
  const complexity = Math.min(6, disputeSignals + Math.ceil(issueCount / 2));
  const riskLevel = String(risk?.risk_level || "").toLowerCase();
  const riskPenalty = riskLevel === "high" ? -0.11 : riskLevel === "medium" ? -0.05 : 0.02;
  let win = 0.32 + evidenceSignals * 0.05 + (combined.includes("governing law") ? 0.03 : 0) + riskPenalty;
  let settle = 0.26 + disputeSignals * 0.04 + (riskLevel === "high" ? 0.08 : 0.02);
  win = Math.max(0.18, Math.min(0.78, win));
  settle = Math.max(0.12, Math.min(0.68, settle));
  let lose = Math.max(0.08, 1 - win - settle);
  const total = win + settle + lose;
  win /= total; settle /= total; lose /= total;
  const timelineMin = Math.max(3, Math.min(18, 4 + complexity));
  const timelineMax = Math.max(timelineMin + 3, Math.min(36, timelineMin + 5 + complexity));
  const amountMatch = combined.match(/(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)/i);
  const amount = amountMatch?.[1] ? Number(String(amountMatch[1]).replace(/,/g, "")) : NaN;
  let costMin = 30000 + complexity * 12000;
  let costMax = 180000 + complexity * 60000;
  if (Number.isFinite(amount) && amount > 0) {
    costMin = Math.max(35000, Math.round(amount * 0.025));
    costMax = Math.max(costMin + 50000, Math.round(amount * 0.18));
  }
  const factors: string[] = [];
  if (/invoice|ledger|payment|outstanding/i.test(combined)) factors.push("Invoice/ledger trail and payment chronology");
  if (/notice|email|whatsapp|communication/i.test(combined)) factors.push("Notice and communication compliance with contract process");
  if (/liquidated damages|penalty|interest/i.test(combined)) factors.push("Enforceability of damages/penalty/interest clauses");
  if (/termination|breach|default/i.test(combined)) factors.push("Breach attribution and termination trigger evidence");
  if (/arbitration|jurisdiction|governing law/i.test(combined)) factors.push("Dispute forum/arbitration clause enforceability");
  if (!factors.length) factors.push("Evidence sufficiency, timeline consistency, and claim quantification");
  const deadlineSignals = [
    "within",
    "days",
    "months",
    "due date",
    "deadline",
    "interest",
    "liquidated damages",
    "penalty",
  ];
  const deadlines = String(ctx.documentsText || "")
    .split(/(?<=[.;!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 20 && deadlineSignals.some((k) => s.toLowerCase().includes(k)))
    .slice(0, 5)
    .map((s) => trimToMaxWords(s, 30));
  const confidence = Math.max(0.28, Math.min(0.86, 0.44 + evidenceSignals * 0.05 + Math.min(hits.length, 6) * 0.03));
  return {
    outcomes: { win: Number(win.toFixed(4)), settle: Number(settle.toFixed(4)), lose: Number(lose.toFixed(4)) },
    timeline_range_months: [timelineMin, timelineMax],
    cost_range: [Math.round(costMin), Math.round(costMax)],
    key_factors: prependRoleItems(ctx.caseRole, [...new Set(factors)].slice(0, 6), "outcome").slice(0, 6),
    deadlines: deadlines.length ? deadlines : ["Review contract timelines and evidence chronology before filing/settlement steps."],
    summary: appendRolePerspective(`Outcome projection suggests a ${Math.round(win * 100)}% win pathway, ${Math.round(settle * 100)}% settlement pathway, and ${Math.round(lose * 100)}% adverse pathway based on the present evidence and dispute posture.`, ctx.caseRole, "outcome"),
    recommended_actions: prependRoleItems(ctx.caseRole, [
      "Strengthen the evidence items that most directly affect the likely outcome",
      "Recheck timeline consistency before relying on the present projection",
    ], "outcome"),
    audience_mode: applyRoleAwareLabel(ctx.caseRole),
    confidence: Number(confidence.toFixed(4)),
    citations: pickModuleCitations("outcome_projection", hits, [...factors, ...deadlines, ...(qp.issues || [])]),
  };
}

export async function runPolicyCompliance(ctx: Context) {
  const hits = await indexService.retrieve(ctx.caseId, ["policy", "compliance", "regulation", "notice", ...(ctx.existing.query_parsing?.issues || [])], 6, { includeUserDocs: true, includeLegalCorpus: true, sourceTypes: ctx.existing.query_parsing?.filters_applied?.source_types });
  const text = normalizeForParsing(ctx.documentsText).toLowerCase();
  const violations = [];
  if (text.includes("delay") && !text.includes("notice")) violations.push("Delay appears without documented notice trail");
  if (text.includes("payment") && !text.includes("invoice")) violations.push("Payment claim lacks invoice references");
  const compliant = [];
  if (text.includes("agreement") || text.includes("contract")) compliant.push("Contract reference present");
  if (text.includes("date")) compliant.push("Timeline markers available");
  const noSources = hits.length === 0;
  const allCitations = pickModuleCitations("policy_compliance", hits, [...violations, ...compliant, ...(ctx.existing.query_parsing?.issues || [])], 5);
  const legalCorpusCitations = allCitations.filter((c) => (c.source_type || "").toLowerCase() === "legal_corpus");
  let legalGrounds = violations.slice(0, 6).map((v) => String(v || "").trim()).filter(Boolean);
  const mentionsStatute = legalGrounds.some(hasStatuteLikeReference);
  if (mentionsStatute && legalCorpusCitations.length === 0) {
    legalGrounds = legalGrounds.map(stripStatuteLikeReference).filter(Boolean);
  }
  return {
    compliance_score: Math.max(30, 82 - violations.length * 18),
    violations,
    compliant_areas: compliant,
    recommended_actions: prependRoleItems(
      ctx.caseRole,
      noSources
        ? ["Insufficient sources: upload more documents or add legal corpus materials", "Re-run compliance after adding statutes/case law references"]
        : ["Create evidence matrix", "Validate notices and approvals", "Reconcile contract obligations vs actions"],
      "compliance",
    ),
    insufficient_sources: noSources || (mentionsStatute && legalCorpusCitations.length === 0),
    summary: appendRolePerspective(
      noSources ? "Compliance analysis has insufficient sources. Confidence lowered until legal/document citations are available." : "Compliance decision support generated from case documents and legal sources.",
      ctx.caseRole,
      "compliance",
    ),
    audience_mode: applyRoleAwareLabel(ctx.caseRole),
    confidence: noSources ? 0.2 : (mentionsStatute && legalCorpusCitations.length === 0) ? 0.35 : 0.66,
    citations: allCitations,
    legal_grounds: legalGrounds,
  };
}

export async function runLegalDraftsValidation(ctx: Context) {
  const hits = await indexService.retrieve(ctx.caseId, ["notice", "draft", "demand", "termination"], 5);
  const qp = ctx.existing.query_parsing || {};
  const qpDomainText =
    (typeof qp.domain === "string" ? qp.domain : null) ||
    (typeof qp.legal_domain === "string" ? qp.legal_domain : null) ||
    (typeof qp.domain?.primary === "string" ? qp.domain.primary : null) ||
    "";
  const templates = ["Issue brief", "Demand notice", "Response draft"];
  const selected = qpDomainText.toLowerCase().includes("contract") ? "Demand notice" : "Issue brief";
  return {
    templates_available: templates,
    selected_template: selected,
    draft_text: appendRolePerspective(`Template selected: ${selected}. Prepare facts, chronology, contractual obligations, breach narrative, and relief sought with supporting evidence references.`, ctx.caseRole, "drafts"),
    validation_checks: prependRoleItems(ctx.caseRole, ["Parties identified", "Dates and chronology included", "Relief sought defined", "Evidence references attached"], "drafts").slice(0, 5),
    missing_evidence: prependRoleItems(ctx.caseRole, ["Signed contract copy (if unavailable)", "Loss computation worksheet"], "drafts").slice(0, 4),
    audience_mode: applyRoleAwareLabel(ctx.caseRole),
    confidence: 0.7,
    citations: pickModuleCitations("legal_drafts_validation", hits, [selected, qpDomainText, ...(qp.issues || [])]),
  };
}

function extractEntities(text: string) {
  const amounts = [...new Set((text.match(/(?:Rs\.?|INR|\u20B9)\s?[\d,]+/gi) || []).slice(0, 10))];
  const dates = [...new Set((text.match(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g) || []).slice(0, 10))];
  const names = [...new Set((text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g) || []).slice(0, 10))];
  return { amounts, dates, names };
}




