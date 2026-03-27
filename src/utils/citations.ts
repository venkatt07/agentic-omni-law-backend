export type Citation = {
  ref?: string;
  source_type?: "user_doc" | "legal_corpus" | string;
  doc_id: string;
  title?: string | null;
  chunk_id?: string | null;
  page?: number | null;
  offset_start?: number | null;
  offset_end?: number | null;
  snippet: string;
};

export type CitationContext = {
  citations: Citation[];
  contextBlock: string;
};

function trimWords(text: string, max = 25) {
  return String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, max).join(" ");
}

export function makeCitationRefs(snippets: Array<{
  source_type?: string;
  doc_id?: string | null;
  title?: string | null;
  page?: number | null;
  offset_start?: number | null;
  offset_end?: number | null;
  snippet?: string;
}>): CitationContext {
  const seen = new Set<string>();
  const citations: Citation[] = [];
  let userIdx = 1;
  let lawIdx = 1;
  for (const s of snippets || []) {
    const snippet = trimWords(String(s?.snippet || ""), 25);
    if (!snippet) continue;
    const sourceType = String(s?.source_type || "user_doc").toLowerCase().includes("legal") ? "legal_corpus" : "user_doc";
    const key = `${sourceType}:${String(s?.doc_id || "")}:${snippet.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ref = sourceType === "legal_corpus" ? `L${lawIdx++}` : `C${userIdx++}`;
    citations.push({
      ref,
      source_type: sourceType,
      doc_id: String(s?.doc_id || "unknown"),
      title: s?.title || null,
      page: s?.page ?? null,
      offset_start: s?.offset_start ?? null,
      offset_end: s?.offset_end ?? null,
      snippet,
    });
  }
  const contextBlock = citations
    .map((c) => `[${c.ref}] (${c.source_type}) ${c.title ? `${c.title}: ` : ""}${c.snippet}`)
    .join("\n");
  return { citations, contextBlock };
}
