import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const API_BASE = process.env.API_BASE || "http://127.0.0.1:5000/api";

function stats(values) {
  const arr = [...values].sort((a, b) => a - b);
  const pick = (p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor((arr.length - 1) * p)))];
  const avg = arr.reduce((s, v) => s + v, 0) / (arr.length || 1);
  return { avg, p50: pick(0.5), p95: pick(0.95) };
}

async function timed(fn) {
  const t0 = Date.now();
  const result = await fn();
  return { ms: Date.now() - t0, result };
}

async function api(path, method = "GET", body, token) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status})`);
  return res.json();
}

async function main() {
  const rl = readline.createInterface({ input, output });
  const token = (await rl.question("Paste JWT token for benchmarking: ")).trim();
  if (!token) throw new Error("JWT token required");

  const chatPrompt = "Explain how Query Parsing works before the other modules run, in 4 bullet points.";
  const queryText =
    "Supply contract payment dispute in Chennai with delayed invoices, arbitration clause, and termination threat. Need legal notice and urgent relief options.";

  const caseRow = await api("/cases", "POST", { title: "perf-bench-case" }, token);
  const caseId = caseRow.case_id;
  await api(`/cases/${caseId}/text`, "POST", { title: "query-context", text: queryText }, token);

  const chatLatencies = [];
  for (let i = 0; i < 20; i++) {
    const { ms } = await timed(() => api("/chat", "POST", { message: chatPrompt }, token));
    chatLatencies.push(ms);
  }

  const queryLatencies = [];
  let schemaPass = 0;
  for (let i = 0; i < 20; i++) {
    const { ms, result } = await timed(() =>
      api(`/cases/${caseId}/query-preview`, "POST", {
        text: queryText,
        filtersApplied: {
          jurisdiction: "India",
          state: "Tamil Nadu",
          legal_domain: "Contract/Commercial",
          date_range: { from: "2010-01-01", to: "2026-12-31" },
          source_types: ["Acts & Statutes", "Case Laws"],
        },
      }, token),
    );
    queryLatencies.push(ms);
    if (result?.executive_summary_text && Array.isArray(result?.issue_groups)) schemaPass += 1;
  }

  const metrics = await api("/metrics", "GET", undefined, token).catch(() => null);
  const chatStats = stats(chatLatencies);
  const queryStats = stats(queryLatencies);

  console.log("AI Bench Results");
  console.log(`chat avg=${chatStats.avg.toFixed(1)}ms p50=${chatStats.p50}ms p95=${chatStats.p95}ms (n=20)`);
  console.log(`query_preview avg=${queryStats.avg.toFixed(1)}ms p50=${queryStats.p50}ms p95=${queryStats.p95}ms (n=20)`);
  console.log(`schema_pass_rate=${((schemaPass / 20) * 100).toFixed(1)}% (preview schema shape check)`);
  if (metrics) {
    console.log(`server_schema_pass_rate=${((metrics.schema_pass_rate || 0) * 100).toFixed(1)}%`);
    console.log(`cache_hit_rates=${JSON.stringify(metrics.cache_hit_rates)}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
