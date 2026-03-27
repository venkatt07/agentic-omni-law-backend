export function chunkText(text: string, size = 1000, overlap = 150) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [] as string[];
  const chunks: string[] = [];
  let i = 0;
  while (i < normalized.length) {
    chunks.push(normalized.slice(i, i + size));
    if (i + size >= normalized.length) break;
    i += Math.max(1, size - overlap);
  }
  return chunks;
}

export const buildChunks = chunkText;
