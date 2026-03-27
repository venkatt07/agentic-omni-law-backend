import { legalCorpusIndexService } from "../src/services/legalCorpusIndex.service.js";

function argValue(flag: string) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return null;
  return process.argv[idx + 1] ?? null;
}

async function main() {
  const force = process.argv.includes("--force");
  const maxRaw = argValue("--max-files");
  const maxFiles = maxRaw ? Number(maxRaw) : undefined;
  if (maxRaw && (!Number.isFinite(maxFiles) || Number(maxFiles) <= 0)) {
    throw new Error("--max-files must be a positive number");
  }
  const result = await legalCorpusIndexService.reindex({ force, maxFiles });
  const status = await legalCorpusIndexService.getStatus();
  console.log(JSON.stringify({ result, status }, null, 2));
}

main().catch((error) => {
  console.error("index_legal_corpus failed:", error?.message || error);
  process.exit(1);
});
