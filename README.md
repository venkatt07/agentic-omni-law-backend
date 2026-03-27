# Agentic Omni Law (Backend)

Frontend lives in the separate `agentic-omni-law-frontend` repo.

## Local Development (XAMPP MySQL + Gmail SMTP, No Docker)

1. Start **XAMPP MySQL**.
2. Create database `agentic_omni_law` in phpMyAdmin.
3. Copy `backend/.env.example` to `backend/.env` and fill:
   - `DB_HOST=127.0.0.1`
   - `DB_PORT=3306`
   - `DB_USER=root`
   - `DB_PASSWORD=` (empty for XAMPP root with no password)
   - `DB_NAME=agentic_omni_law`
   - (Optional) `DATABASE_URL=...` if you want to override the auto-built DB URL
   - `SMTP_USER`, `SMTP_PASS` (Gmail App Password), `SMTP_FROM`
   - Optional: `LEGAL_CORPUS_DIR=./legal_corpus` and place `.txt/.pdf/.docx` legal source files there for grounded citations
4. Install dependencies:
   - `npm install`
5. Initialize MySQL schema (phpMyAdmin/XAMPP compatible):
   - Import `backend/sql/schema.sql` in phpMyAdmin
   - OR run `npm --prefix backend run db:init`
6. Start backend:
   - `npm run dev`
   - If `AI_MODE=rag_llm`, also start local model servers (see `MODEL_SETUP.md`)

Backend runs on `http://127.0.0.1:5000`.

## Proof / E2E Script

Use the no-Docker proof scripts (OTP pasted manually from Gmail):
- PowerShell: `./scripts/prove_e2e.ps1`
- Bash: `bash ./scripts/prove_e2e.sh`

Detailed steps are documented in `LOCAL_PROOF.md`.

## Local AI Runtime (Offline)

- Model setup and local server startup: `MODEL_SETUP.md`
- Track your own model download URLs/checksums: `MODEL_SOURCES.md`
- Optional runtime checks: `npm --prefix backend run ai:verify`
