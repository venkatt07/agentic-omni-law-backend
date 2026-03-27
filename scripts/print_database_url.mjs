import fs from "node:fs";
import path from "node:path";
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

process.stdout.write(`${buildDatabaseUrl()}\n`);

