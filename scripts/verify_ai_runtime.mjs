import fs from "node:fs/promises";
import path from "node:path";

const BACKEND_ROOT = path.basename(process.cwd()).toLowerCase() === "backend"
  ? process.cwd()
  : path.resolve(process.cwd(), "backend");

async function loadEnv() {
  const envPath = path.join(BACKEND_ROOT, ".env");
  const out = {};
  try {
    const raw = await fs.readFile(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.trim().startsWith("#")) continue;
      const idx = line.indexOf("=");
      if (idx < 0) continue;
      out[line.slice(0, idx).trim()] = line.slice(idx + 1);
    }
  } catch {
    // ignore; use process.env
  }
  return { ...out, ...process.env };
}

async function fetchJson(url, body) {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

async function main() {
  const env = await loadEnv();
  const llm = env.LLM_ENDPOINT || "http://127.0.0.1:8001";
  const previewLlm = env.PREVIEW_LLM_ENDPOINT || llm;
  const finalLlm = env.FINAL_LLM_ENDPOINT || llm;
  const embed = env.EMBED_ENDPOINT || "http://127.0.0.1:8002";
  const corpusDir = path.resolve(BACKEND_ROOT, env.LEGAL_CORPUS_DIR || "./legal_corpus");

  const summary = {
    llm_endpoint: llm,
    preview_llm_endpoint: previewLlm,
    final_llm_endpoint: finalLlm,
    embed_endpoint: embed,
    llm_ok: false,
    preview_llm_ok: false,
    final_llm_ok: false,
    embed_ok: false,
    legal_corpus_files: 0,
    legal_corpus_present: false,
    sample_retrieval_ok: false,
  };

  const llmProbe = await fetchJson(`${llm.replace(/\/$/, "")}/completion`, {
    prompt: "Return exactly: {\"ok\":true}",
    n_predict: 16,
    temperature: 0,
  }).catch((e) => ({ ok: false, status: 0, text: String(e) }));
  summary.llm_ok = Boolean(llmProbe.ok);

  const previewProbe = await fetchJson(`${previewLlm.replace(/\/$/, "")}/completion`, {
    prompt: "Return exactly: {\"ok\":true}",
    n_predict: 16,
    temperature: 0,
  }).catch((e) => ({ ok: false, status: 0, text: String(e) }));
  summary.preview_llm_ok = Boolean(previewProbe.ok);

  const finalProbe = await fetchJson(`${finalLlm.replace(/\/$/, "")}/completion`, {
    prompt: "Return exactly: {\"ok\":true}",
    n_predict: 16,
    temperature: 0,
  }).catch((e) => ({ ok: false, status: 0, text: String(e) }));
  summary.final_llm_ok = Boolean(finalProbe.ok);
  summary.llm_ok = summary.llm_ok && summary.preview_llm_ok && summary.final_llm_ok;

  const embedProbe = await fetchJson(`${embed.replace(/\/$/, "")}/embedding`, {
    input: "legal compliance notice",
  }).catch((e) => ({ ok: false, status: 0, text: String(e) }));
  summary.embed_ok = Boolean(embedProbe.ok);

  try {
    const entries = await fs.readdir(corpusDir, { withFileTypes: true });
    summary.legal_corpus_files = entries.filter((e) => e.isFile()).length;
    summary.legal_corpus_present = summary.legal_corpus_files > 0;
  } catch {
    summary.legal_corpus_present = false;
  }

  if (summary.legal_corpus_present) {
    try {
      const { legalCorpusService } = await import("../dist/services/legalCorpus.service.js");
      await legalCorpusService.preload();
      const rows = await legalCorpusService.retrieve(["act", "notice", "compliance"], 2);
      summary.sample_retrieval_ok = Array.isArray(rows) && rows.length > 0;
    } catch {
      summary.sample_retrieval_ok = false;
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.llm_ok || !summary.embed_ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error("verify_ai_runtime failed", err);
  process.exitCode = 1;
});
