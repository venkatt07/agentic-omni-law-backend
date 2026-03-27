import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const api = process.env.PROOF_API_BASE_URL || "http://127.0.0.1:5000/api";
const role = process.env.PROOF_ROLE || "Lawyer";
const email = process.env.PROOF_EMAIL || `proof_${Date.now()}@example.com`;
const phone = process.env.PROOF_PHONE || `99999${Math.floor(10000 + Math.random() * 89999)}`;
const password = process.env.PROOF_PASSWORD || "Password@123";
const language = process.env.PROOF_LANGUAGE || "Hindi";

const rl = readline.createInterface({ input, output });

async function req(path, options = {}, token) {
  const headers = new Headers(options.headers || {});
  if (!headers.has("Content-Type") && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${api}${path}`, { ...options, headers });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${typeof data === "object" ? (data?.message || JSON.stringify(data)) : data}`);
  return data;
}

async function main() {
  console.log(`[proof] API = ${api}`);
  console.log(`[proof] Sign up with ${email}`);
  await req("/auth/signup", { method: "POST", body: JSON.stringify({ name: "Proof User", email, phone, password, role }) });
  console.log("[proof] Signup request sent. Check your Gmail inbox for OTP.");
  const otp = (await rl.question("Paste the 6-digit OTP from email: ")).trim();
  await req("/auth/verify", { method: "POST", body: JSON.stringify({ emailOrPhone: email, code: otp }) });
  console.log("[proof] OTP verified");

  const login = await req("/auth/login", { method: "POST", body: JSON.stringify({ emailOrPhone: email, password }) });
  const token = login.token;
  console.log("[proof] Logged in, token received");

  const me = await req("/auth/me", { method: "GET" }, token);
  console.log("[proof] /auth/me ->", me.user.email, me.user.role);

  const created = await req("/cases", { method: "POST", body: JSON.stringify({ title: "Proof Case Workspace" }) }, token);
  const caseId = created.case_id;
  console.log("[proof] Created case", caseId);

  await req(`/cases/${encodeURIComponent(caseId)}/text`, {
    method: "POST",
    body: JSON.stringify({
      title: "Proof Input",
      text: "Vendor delivery delay caused breach of contract dispute. Agreement includes payment milestones, penalty exposure, and notice dates in India. We need remedies, timeline, and settlement strategy.",
    }),
  }, token);
  console.log("[proof] Pasted text stored");

  const run = await req(`/cases/${encodeURIComponent(caseId)}/run-all`, { method: "POST" }, token);
  console.log("[proof] run-all started", run.run_id);

  let status;
  for (let i = 0; i < 180; i++) {
    status = await req(`/runs/${encodeURIComponent(run.run_id)}/status`, { method: "GET" }, token);
    const current = (status.steps || []).find((s) => s.state === "RUNNING")?.name || status.status;
    console.log(`[proof] poll ${i + 1}: ${status.status} (${current})`);
    if (status.status === "SUCCEEDED" || status.status === "FAILED") break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const caseDetailsEn = await req(`/cases/${encodeURIComponent(caseId)}`, { method: "GET" }, token);
  console.log("[proof] outputs keys:", Object.keys(caseDetailsEn.outputs || {}));
  console.log("[proof] final summary present:", !!caseDetailsEn.final_summary);

  await req("/users/me/preferences", { method: "PATCH", body: JSON.stringify({ language }) }, token);
  const caseDetailsTranslated = await req(`/cases/${encodeURIComponent(caseId)}`, { method: "GET" }, token);
  const runStatusTranslated = await req(`/runs/${encodeURIComponent(run.run_id)}/status`, { method: "GET" }, token);
  console.log("[proof] language switched to", language);
  console.log("[proof] translated final summary snippet:", JSON.stringify(caseDetailsTranslated.final_summary).slice(0, 220));
  console.log("[proof] translated run step names:", (runStatusTranslated.steps || []).map((s) => s.name).join(" | "));

  const chat = await req("/chat", { method: "POST", body: JSON.stringify({ case_id: caseId, message: "How do I run analysis?" }) }, token);
  console.log("[proof] chat reply:", chat.reply);

  console.log("[proof] DONE");
  console.log(JSON.stringify({ email, phone, password, caseId, runId: run.run_id }, null, 2));
}

main().catch(async (err) => {
  console.error("[proof] FAILED", err);
  process.exitCode = 1;
}).finally(async () => {
  await rl.close();
});
