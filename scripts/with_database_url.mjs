import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import dotenv from "dotenv";

const backendRoot = process.cwd();

for (const file of [".env", ".env.example"]) {
  const full = path.join(backendRoot, file);
  if (fs.existsSync(full)) {
    dotenv.config({ path: full, override: false });
  }
}

function buildDatabaseUrl() {
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim();

  const host = process.env.DB_HOST || "127.0.0.1";
  const port = process.env.DB_PORT || "3306";
  const user = process.env.DB_USER || "root";
  const password = process.env.DB_PASSWORD ?? "";
  const dbName = process.env.DB_NAME || "agentic_omni_law";
  return `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${dbName}`;
}

process.env.DATABASE_URL = buildDatabaseUrl();

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node scripts/with_database_url.mjs <command> [args...]");
  process.exit(1);
}

let cmd = args[0];
let cmdArgs = args.slice(1);

if (cmd === "prisma") {
  cmd =
    process.platform === "win32"
      ? path.join(backendRoot, "node_modules", ".bin", "prisma.cmd")
      : path.join(backendRoot, "node_modules", ".bin", "prisma");
} else if (cmd === "npm") {
  cmd = process.platform === "win32" ? "npm.cmd" : "npm";
}

const child = spawn(cmd, cmdArgs, {
  cwd: backendRoot,
  env: { ...process.env },
  stdio: "inherit",
  shell: process.platform === "win32" && !cmd.endsWith(".cmd"),
});

child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error(err);
  process.exit(1);
});

