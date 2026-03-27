import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const IGNORE_DIRS = new Set(["node_modules", "dist", ".git", ".idea", ".vscode"]);
const IGNORE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".exe", ".dll", ".gguf"]);
const defaultBanned = [
  // keep customizable; do not add model names to source unless user configures env
  ...(process.env.BANNED_VENDOR_STRINGS ? process.env.BANNED_VENDOR_STRINGS.split(",").map((s) => s.trim()).filter(Boolean) : []),
];

async function walk(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
      continue;
    }
    if (IGNORE_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    out.push(full);
  }
  return out;
}

async function main() {
  if (defaultBanned.length === 0) {
    console.log("no_vendor_name_scan: no banned strings configured (set BANNED_VENDOR_STRINGS to enable scan)");
    return;
  }
  const files = await walk(ROOT);
  const hits = [];
  for (const file of files) {
    const text = await fs.readFile(file, "utf8").catch(() => null);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const banned of defaultBanned) {
        if (banned && line.toLowerCase().includes(banned.toLowerCase())) {
          hits.push({ file: path.relative(ROOT, file), line: idx + 1, banned, text: line.trim().slice(0, 220) });
        }
      }
    });
  }
  if (hits.length) {
    console.error(JSON.stringify({ failed: true, hits }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log("no_vendor_name_scan: no banned strings found");
}

main().catch((err) => {
  console.error("no_vendor_name_scan failed", err);
  process.exitCode = 1;
});

