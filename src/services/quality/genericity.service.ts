const GENERIC_PHRASES = [
  "this appears to be",
  "the matter appears to involve",
  "based on the provided context",
  "based on retrieved case material",
  "case materials",
  "the user seeks",
  "use the strongest cited excerpts",
  "verify party names dates and amounts",
  "verify parties dates and monetary figures",
  "add any missing evidence and rerun",
  "insufficient sources message",
  "relevant authority identified for this dispute context",
  "prepared grounded role agent output",
  "grounded key points",
];

function normalizeText(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/^\[(?:hindi|tamil|bengali)\]\s*/i, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildSupportTokenSet(values: Array<unknown>) {
  const stop = new Set([
    "this", "that", "with", "from", "into", "where", "when", "have", "has", "been", "were", "their", "there",
    "legal", "case", "document", "documents", "workspace", "query", "parsing", "report", "analysis", "review",
    "using", "used", "current", "matter", "issue", "issues", "output", "generated", "support", "evidence",
  ]);
  const out = new Set<string>();
  for (const value of values) {
    const normalized = normalizeText(value);
    for (const token of normalized.split(/\s+/)) {
      if (token.length < 4 || stop.has(token)) continue;
      out.add(token);
    }
  }
  return out;
}

export function countSupportOverlap(texts: Array<unknown>, supportTokens: Set<string>) {
  if (!supportTokens.size) return 0;
  const seen = new Set<string>();
  for (const text of texts) {
    const normalized = normalizeText(text);
    for (const token of normalized.split(/\s+/)) {
      if (token.length < 4 || !supportTokens.has(token)) continue;
      seen.add(token);
    }
  }
  return seen.size;
}

export function countGenericPhraseHits(texts: Array<unknown>) {
  const merged = texts.map((text) => normalizeText(text)).join(" ");
  if (!merged) return 0;
  return GENERIC_PHRASES.filter((phrase) => merged.includes(normalizeText(phrase))).length;
}

export function repeatedLineRatio(text: unknown) {
  const lines = String(text || "")
    .split(/\n+/)
    .map((line) => normalizeText(line))
    .filter(Boolean);
  if (lines.length < 4) return 0;
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) || 0) + 1);
  const worst = Math.max(...counts.values());
  return worst / lines.length;
}

export function looksPromptLeaky(texts: Array<unknown>) {
  const merged = texts.map((text) => normalizeText(text)).join(" ");
  if (!merged) return false;
  return /return strict json|output schema|query parsing hints|current parsed fields|no markdown|do not use/i.test(merged);
}

export function assessNarrativeQuality(input: {
  texts: Array<unknown>;
  supportTexts: Array<unknown>;
  minSupportOverlap?: number;
  minCombinedLength?: number;
  maxGenericPhraseHits?: number;
}) {
  const texts = input.texts.filter((value) => String(value || "").trim().length > 0);
  const combined = texts.map((text) => String(text || "").trim()).join("\n");
  const supportTokens = buildSupportTokenSet(input.supportTexts);
  const overlap = countSupportOverlap(texts, supportTokens);
  const genericPhraseHits = countGenericPhraseHits(texts);
  const repeatRatio = repeatedLineRatio(combined);
  const promptLeak = looksPromptLeaky(texts);
  const combinedLength = combined.replace(/\s+/g, " ").trim().length;
  const minSupportOverlap = input.minSupportOverlap ?? 4;
  const minCombinedLength = input.minCombinedLength ?? 140;
  const maxGenericPhraseHits = input.maxGenericPhraseHits ?? 1;
  const tooShort = combinedLength < minCombinedLength;
  const lowOverlap = overlap < minSupportOverlap;
  const tooGeneric = genericPhraseHits > maxGenericPhraseHits;
  const tooRepetitive = repeatRatio >= 0.25;

  return {
    overlap,
    genericPhraseHits,
    repeatRatio,
    promptLeak,
    combinedLength,
    tooShort,
    lowOverlap,
    tooGeneric,
    tooRepetitive,
    isGeneric: tooShort || lowOverlap || tooGeneric || tooRepetitive || promptLeak,
  };
}
