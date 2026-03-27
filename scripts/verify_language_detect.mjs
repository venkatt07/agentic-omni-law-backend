import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const apiBase = process.env.VERIFY_API_BASE_URL || "http://127.0.0.1:5000/api";
const hindiCaseText =
  "मैं चेन्नई में एक छोटे बिज़नेस का मालिक हूँ। मैंने 12 अगस्त 2024 को एक डिस्ट्रीब्यूटर के साथ सप्लाई कॉन्ट्रैक्ट साइन किया था। उन्हें हर महीने 500 यूनिट्स डिलीवर करनी थीं और इनवॉइस के 30 दिनों के अंदर भुगतान करना था। नवंबर 2024 से वे 60–90 दिन की देरी से भुगतान कर रहे हैं। कुल बकाया लगभग ₹18,40,000 है (14 इनवॉइस)। कॉन्ट्रैक्ट में आर्बिट्रेशन क्लॉज़ है (सीट: चेन्नई, भाषा: इंग्लिश) और 18% p.a. लेट पेमेंट इंटरेस्ट है। अब वे कॉन्ट्रैक्ट टर्मिनेट करने और ब्लैकलिस्ट करने की धमकी दे रहे हैं। मेरे पास व्हाट्सएप चैट, ईमेल, PO, डिलीवरी चालान और बैंक स्टेटमेंट हैं। मैं क्या कर सकता हूँ? क्या मैं लीगल नोटिस भेज सकता हूँ और टर्मिनेशन रोकने के लिए तुरंत कोई आदेश ले सकता हूँ? Filters: India → Tamil Nadu; Domain: Contract/Commercial; Sources: Acts & Statutes + Case Laws; Date range: 2010–2026.";

async function ask(question) {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
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
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${text}`);
  return json;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function dedupeKey(c) {
  return `${c?.source_type || ""}::${c?.doc_id || ""}::${c?.chunk_id || ""}::${String(c?.snippet || "").slice(0, 100)}`;
}

async function main() {
  let token = process.env.VERIFY_AI_JWT || "";
  if (!token) token = await ask("Paste JWT token: ");
  if (!token) throw new Error("JWT token required");

  const created = await api("/cases", "POST", token, { title: "Hindi Detection Verify Case" });
  const caseId = created.case_id;
  await api(`/cases/${caseId}/text`, "POST", token, { text: hindiCaseText, title: "query-context" });
  const { run_id } = await api(`/cases/${caseId}/run-all`, "POST", token, {
    filtersApplied: {
      jurisdiction: "India",
      state: "Tamil Nadu",
      legal_domain: "Contract/Commercial",
      date_range: { from: "2010-01-01", to: "2026-12-31" },
      source_types: ["Acts & Statutes", "Case Laws"],
    },
  });

  let runStatus = null;
  for (let i = 0; i < 180; i += 1) {
    runStatus = await api(`/runs/${run_id}/status`, "GET", token);
    if (runStatus.status === "SUCCEEDED" || runStatus.status === "FAILED") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert(runStatus?.status === "SUCCEEDED", `Run did not succeed: ${runStatus?.status}`);

  const details = await api(`/cases/${caseId}`, "GET", token);
  const qp = details.outputs?.query_parsing;
  assert(qp, "Missing query_parsing output");
  const detected = typeof qp.detected_language === "object" ? qp.detected_language : { code: qp.detected_language, confidence: 0 };
  assert(detected.code === "hi", `Expected detected_language.code=hi, got ${detected.code}`);
  assert(Number(detected.confidence) >= 0.85, `Expected detected_language.confidence >= 0.85, got ${detected.confidence}`);

  const citations = Array.isArray(qp.citations) ? qp.citations : [];
  assert(citations.length >= 1, `Expected citations length >= 1 when text exists, got ${citations.length}`);
  const unique = new Set(citations.map(dedupeKey));
  assert(unique.size === citations.length, `Duplicate citations found in query_parsing: ${citations.length - unique.size}`);
  const summary = String(qp.executive_summary_text || qp.summary || "");
  const legalNoticeMatches = (summary.toLowerCase().match(/legal notice/g) || []).length;
  assert(legalNoticeMatches <= 1, `Executive summary repeats 'legal notice' (${legalNoticeMatches} times)`);

  console.log(JSON.stringify({
    ok: true,
    case_id: caseId,
    run_id,
    detected_language: detected,
    legal_notice_mentions: legalNoticeMatches,
    citations_count: citations.length,
    unique_citations_count: unique.size,
  }, null, 2));
}

main().catch((err) => {
  console.error("verify_language_detect failed:", err.message || err);
  process.exitCode = 1;
});
