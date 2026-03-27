import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.cwd(), "backend");
const testDir = path.join(root, "testdata", "rag_eval");
const logDir = path.join(root, "logs");
const logFile = path.join(logDir, "ai_metrics.log");

function now() {
  return new Date().toISOString();
}

async function main() {
  await fs.mkdir(logDir, { recursive: true });
  let files = [];
  try {
    files = (await fs.readdir(testDir)).filter((f) => f.endsWith(".json"));
  } catch {
    console.log("No evaluation dataset found at backend/testdata/rag_eval. Add JSON test cases and rerun.");
    return;
  }

  const metrics = {
    timestamp: now(),
    samples: 0,
    citation_coverage: 0,
    insufficient_sources_rate: 0,
    avg_latency_ms_per_module: {},
    schema_failure_rate: 0,
  };

  let citationHits = 0;
  let insufficient = 0;
  let schemaFailures = 0;
  const latencies = {};

  for (const file of files) {
    const raw = JSON.parse(await fs.readFile(path.join(testDir, file), "utf8"));
    metrics.samples += 1;
    if (raw.hasCitations) citationHits += 1;
    if (raw.insufficientSources) insufficient += 1;
    if (raw.schemaFailure) schemaFailures += 1;
    for (const [moduleKey, value] of Object.entries(raw.latencyMs || {})) {
      latencies[moduleKey] ??= [];
      latencies[moduleKey].push(Number(value) || 0);
    }
  }

  metrics.citation_coverage = metrics.samples ? citationHits / metrics.samples : 0;
  metrics.insufficient_sources_rate = metrics.samples ? insufficient / metrics.samples : 0;
  metrics.schema_failure_rate = metrics.samples ? schemaFailures / metrics.samples : 0;
  metrics.avg_latency_ms_per_module = Object.fromEntries(
    Object.entries(latencies).map(([k, values]) => [k, values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1)]),
  );

  const line = JSON.stringify(metrics);
  await fs.appendFile(logFile, `${line}\n`, "utf8");
  console.log(line);
}

main().catch((error) => {
  console.error("eval_rag failed", error);
  process.exitCode = 1;
});

