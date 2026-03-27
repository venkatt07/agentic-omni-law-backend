#!/usr/bin/env node
import crypto from "node:crypto";
import readline from "node:readline/promises";
import process from "node:process";

const API_BASE = process.env.API_BASE_URL || "http://127.0.0.1:5000/api";

const samples = [
  {
    name: "kannada_employment",
    text: "ನಾನು ಬೆಂಗಳೂರಿನ ಖಾಸಗಿ ಕಂಪನಿಯಲ್ಲಿ ಕೆಲಸ ಮಾಡುತ್ತಿದ್ದೆ. ಕಳೆದ ತಿಂಗಳು ಅವರು 'performance issues' ಎಂದು ಹೇಳಿ ನನ್ನನ್ನು terminate ಮಾಡಿದ್ದಾರೆ. ನನಗೆ full and final settlement, PF transfer ಮತ್ತು gratuity ಹಣ ತಡೆಹಿಡಿದಿದ್ದಾರೆ. HR ಮತ್ತು manager ಸಂದೇಶಗಳಲ್ಲಿ ಬೆದರಿಕೆ ಇದೆ. ಯಾವ ಕಾನೂನುಗಳು ಅನ್ವಯಿಸುತ್ತವೆ, ಯಾವ ದಾಖಲೆಗಳನ್ನು ಸಂಗ್ರಹಿಸಬೇಕು, legal notice draft ಮತ್ತು timeline/cost ತಿಳಿಸಿ.",
    expectLang: "kn",
    expectSubtype: /employment_/i,
  },
  {
    name: "malayalam_family_dv",
    text: "ഞാൻ വിവാഹിതയാണ്. ഭർത്താവ് പല മാസങ്ങളായി മാനസികവും ശാരീരികവുമായ പീഡനം ചെയ്യുന്നു. maintenance കൊടുക്കുന്നില്ല. പൊലീസ് പരാതി, മെഡിക്കൽ റിപ്പോർട്ടുകൾ, ചാറ്റുകൾ എനിക്ക് ഉണ്ട്. എനിക്ക് maintenance, protection order, പിന്നത്തെ legal steps എന്തൊക്കെ എന്ന് അറിയണം.",
    expectLang: "ml",
    expectSubtype: /^family_maintenance_dv$/i,
    summaryMustNotContain: /(succession|partition)/i,
  },
];

function sha256(v) {
  return crypto.createHash("sha256").update(v).digest("hex");
}

async function api(path, init = {}, token) {
  const headers = {
    "content-type": "application/json",
    ...(init.headers || {}),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${JSON.stringify(json)}`);
  return json;
}

async function pollRun(runId, token) {
  for (let i = 0; i < 240; i += 1) {
    const status = await api(`/runs/${encodeURIComponent(runId)}/status`, { method: "GET" }, token);
    if (status.status === "SUCCEEDED") return status;
    if (status.status === "FAILED") throw new Error(`Run failed: ${JSON.stringify(status)}`);
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error("Timed out waiting for run");
}

function dedupeKey(c) {
  const normalized = String(c?.snippet || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 180);
  return normalized
    ? `${c?.source_type || ""}::${c?.doc_id || ""}::${normalized}`
    : `${c?.source_type || ""}::${c?.doc_id || ""}::${c?.chunk_id || ""}`;
}

function repeatedBigrams(text) {
  const tokens = String(text || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const counts = new Map();
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const bg = `${tokens[i]} ${tokens[i + 1]}`;
    counts.set(bg, (counts.get(bg) || 0) + 1);
  }
  let repeats = 0;
  for (const count of counts.values()) if (count > 1) repeats += count - 1;
  return repeats;
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const token = (await rl.question("Paste JWT token: ")).trim();
  rl.close();
  if (!token) throw new Error("JWT token required");

  for (const sample of samples) {
    const created = await api("/cases", { method: "POST", body: JSON.stringify({ title: sample.name }) }, token);
    const caseId = created.case_id;
    const filtersApplied = {
      jurisdiction: "India",
      legal_domain: "All Domains",
      date_range: { from: "2010-01-01", to: "2026-12-31" },
      source_types: ["Acts & Statutes", "Case Laws"],
    };
    await api(`/cases/${encodeURIComponent(caseId)}/text`, {
      method: "POST",
      body: JSON.stringify({ text: sample.text, title: "query-context" }),
    }, token);
    const started = await api(`/cases/${encodeURIComponent(caseId)}/run-all`, {
      method: "POST",
      body: JSON.stringify({ filtersApplied }),
    }, token);
    await pollRun(started.run_id, token);
    const details = await api(`/cases/${encodeURIComponent(caseId)}`, { method: "GET" }, token);
    const qp = details.outputs?.query_parsing;
    if (!qp) throw new Error(`[${sample.name}] missing query_parsing output`);

    const lang = qp.detected_language?.code;
    const langConf = Number(qp.detected_language?.confidence || 0);
    if (lang !== sample.expectLang) throw new Error(`[${sample.name}] expected lang ${sample.expectLang}, got ${lang}`);
    if (langConf < 0.85) throw new Error(`[${sample.name}] low language confidence ${langConf}`);

    const subtype = String(qp.legal_subtype || qp.case_type || "");
    if (!sample.expectSubtype.test(subtype)) throw new Error(`[${sample.name}] subtype mismatch: ${subtype}`);

    const summary = String(qp.executive_summary_text || "");
    if (summary.length < 60) throw new Error(`[${sample.name}] summary too short`);
    if (sample.summaryMustNotContain && sample.summaryMustNotContain.test(summary)) {
      throw new Error(`[${sample.name}] summary contains forbidden term (succession/partition): ${summary}`);
    }
    if (repeatedBigrams(summary) > 3) throw new Error(`[${sample.name}] summary too repetitive`);

    const citations = Array.isArray(qp.citations) ? qp.citations : [];
    const keys = citations.map(dedupeKey);
    if (new Set(keys).size !== keys.length) throw new Error(`[${sample.name}] duplicate citations detected`);
    if (sample.text.trim() && citations.length < 1) throw new Error(`[${sample.name}] expected >=1 citation`);

    const expectedInputHash = sha256(`${sample.text}::${JSON.stringify(filtersApplied)}`);
    if (String(qp.input_hash || "") !== expectedInputHash) {
      throw new Error(`[${sample.name}] input_hash mismatch`);
    }

    console.log(`[PASS] ${sample.name} lang=${lang} conf=${langConf} subtype=${subtype} citations=${citations.length}`);
  }
  console.log("QUERY_PARSING_REGRESSION_PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

