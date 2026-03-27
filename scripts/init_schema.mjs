import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import mysql from "mysql2/promise";

const backendRoot = process.cwd();
for (const file of [".env", ".env.example"]) {
  const full = path.join(backendRoot, file);
  if (fs.existsSync(full)) dotenv.config({ path: full, override: false });
}

function buildDatabaseUrl() {
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim();
  const host = process.env.DB_HOST || "127.0.0.1";
  const port = Number(process.env.DB_PORT || "3306");
  const user = process.env.DB_USER || "root";
  const password = process.env.DB_PASSWORD ?? "";
  const db = process.env.DB_NAME || "agentic_omni_law";
  return { host, port, user, password, db };
}

async function main() {
  const cfg = buildDatabaseUrl();
  const sql = fs.readFileSync(path.join(backendRoot, "sql", "schema.sql"), "utf8");

  const dbName =
    typeof cfg === "string"
      ? decodeURIComponent(new URL(cfg).pathname.replace(/^\//, "")) || (process.env.DB_NAME || "agentic_omni_law")
      : cfg.db;

  const execute = async (conn) => {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName.replace(/`/g, "")}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await conn.query(`USE \`${dbName.replace(/`/g, "")}\``);
    const [tables] = await conn.query("SHOW TABLES LIKE 'users'");
    if (Array.isArray(tables) && tables.length > 0) {
      console.log("MySQL schema already initialized (users table exists).");
      return;
    }
    await conn.query(sql);
    console.log("MySQL schema initialized from backend/sql/schema.sql");
  };

  if (typeof cfg === "string") {
    const u = new URL(cfg);
    const conn = await mysql.createConnection({
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password || ""),
      multipleStatements: true,
    });
    await execute(conn);
    await conn.end();
  } else {
    const conn = await mysql.createConnection({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      multipleStatements: true,
    });
    await execute(conn);
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
