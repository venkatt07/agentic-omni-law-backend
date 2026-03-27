import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const apiBase = process.env.VERIFY_API_BASE_URL || "http://127.0.0.1:5000/api";
const caseText =
  process.env.VERIFY_AI_CASE_TEXT ||
  "I’m a small business owner in Chennai. I signed a supply contract with a distributor on 12 Aug 2024. They were supposed to deliver 500 units/month and pay within 30 days of invoice. Since Nov 2024, payments are delayed by 60–90 days. Total outstanding is about ₹18,40,000 across 14 invoices. The contract has an arbitration clause (seat: Chennai, language: English) and a late payment interest clause of 18% p.a. They are now threatening to terminate and blacklist us. I have WhatsApp chats, emails, purchase orders, delivery challans, and bank statements. What are my legal options? Can I send a legal notice and also file for an urgent order to stop termination?";

async function ask(question) {
  const rl = readline.createInterface({ input, output });
  try {
    const v = await rl.question(question);
    return v.trim();
  } finally {
    rl.close();
  }
}

async function api(path, method = "GET", token, body) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${text}`);
  return json;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  let token = process.env.VERIFY_AI_JWT || "";
  if (!token) {
    token = await ask("Paste JWT token for verify:ai case run (from logged-in session): ");
  }
  if (!token) throw new Error("JWT token required");

  const created = await api("/cases", "POST", token, { title: "AI Runtime Verify Case" });
  const caseId = created.case_id;
  await api(`/cases/${caseId}/text`, "POST", token, { text: caseText, title: "Runtime Verify Input" });
  const run = await api(`/cases/${caseId}/run-all`, "POST", token, {
    filtersApplied: {
      jurisdiction: "India",
      state: "Tamil Nadu",
      legal_domain: "Contract/Commercial",
      date_range: { from: "2010-01-01", to: "2026-12-31" },
      source_types: ["Acts & Statutes", "Case Laws"],
    },
  });
  const runId = run.run_id;

  let status;
  for (let i = 0; i < 180; i += 1) {
    status = await api(`/runs/${runId}/status`, "GET", token);
    if (status.status === "SUCCEEDED" || status.status === "FAILED") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!status) throw new Error("No run status received");
  if (status.status !== "SUCCEEDED") throw new Error(`Run did not succeed: ${status.status}`);

  const details = await api(`/cases/${caseId}`, "GET", token);
  const requiredCommon = [
    "query_parsing",
    "terms_and_policies",
    "contract_risk",
    "outcome_projection",
    "policy_compliance",
    "legal_drafts_validation",
  ];
  for (const key of requiredCommon) {
    if (!details.outputs?.[key]) throw new Error(`Missing required common module output: ${key}`);
  }
  if (!details.final_summary) throw new Error("Missing final_summary");

  const qp = details.outputs.query_parsing;
  if (!qp.detected_language || !qp.filters_supported || !qp.filters_applied) {
    throw new Error("query_parsing missing detected_language/filters_supported/filters_applied");
  }
  const detected = typeof qp.detected_language === "object" ? qp.detected_language : { code: qp.detected_language, confidence: 0 };
  const execSummary = String(qp.executive_summary_text || qp.summary || "");
  const domain = String(qp.legal_domain || qp.domain || "");
  const amount = Number(qp.key_facts?.outstanding_amount_inr);
  const arbPresent = qp.key_facts?.arbitration_clause?.present === true;
  const threats = Array.isArray(qp.key_facts?.threats) ? qp.key_facts.threats.map((t) => String(t).toLowerCase()) : [];

  assert(execSummary.length > 80, "executive_summary_text should be > 80 chars");
  assert(detected.code === "en", `detected_language.code should be 'en', got '${detected.code}'`);
  assert(Number(detected.confidence) >= 0.8, `detected_language.confidence should be >= 0.8, got '${detected.confidence}'`);
  assert(/contract|commercial/i.test(domain), `legal_domain/domain should include Contract/Commercial, got '${domain}'`);
  assert(Number.isFinite(amount) && Math.abs(amount - 1840000) <= 1000, `outstanding_amount_inr should be ~1840000, got '${amount}'`);
  assert(arbPresent, "arbitration_clause.present should be true");
  assert(threats.includes("termination"), "threats should include termination");
  assert(threats.includes("blacklisting"), "threats should include blacklisting");

  console.log(
    JSON.stringify(
      {
        ok: true,
        case_id: caseId,
        run_id: runId,
        status: status.status,
        common_modules: requiredCommon,
        final_summary: true,
        qp_detected_language: qp.detected_language,
        qp_legal_domain: qp.legal_domain || qp.domain,
        qp_key_facts: {
          outstanding_amount_inr: qp.key_facts?.outstanding_amount_inr,
          arbitration_present: qp.key_facts?.arbitration_clause?.present,
          threats: qp.key_facts?.threats,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("verify_ai_case failed:", err.message || err);
  process.exitCode = 1;
});
