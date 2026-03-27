#!/usr/bin/env bash
set -euo pipefail

echo "[prove] Start backend in one terminal: npm run dev:backend"
echo "[prove] Start frontend in another terminal: npm run dev:frontend"
echo "[prove] Ensure XAMPP MySQL is running and backend/.env is configured (Gmail SMTP app password)."
node scripts/prove_e2e.mjs
