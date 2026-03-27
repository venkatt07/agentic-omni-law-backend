# MODEL_SETUP (Local Offline AI Runtime)

This project uses local/offline model servers only.

Recommended topology:
- `preview` generator: small, fast local model for chat previews and quick Query Parsing previews
- `final` generator: larger local model for grounded legal reasoning, role agents, and final synthesis
- `embed` model: local embedding server for retrieval

## 1) Place model files
Create:
- `backend/models/`

Add your local files with internal aliases:
- `backend/models/omni-law-gen-preview.gguf`
- `backend/models/omni-law-gen-final.gguf`
- `backend/models/omni-law-embed.gguf`

Do not rename these aliases in the app unless you also update `backend/.env`.

## 2) Configure backend env
In `backend/.env` set:
- `AI_MODE=rag_llm`
- `AI_PROFILE=compact` (default) or `AI_PROFILE=quality`
- `LLM_ENDPOINT=http://127.0.0.1:8001`
- `PREVIEW_LLM_ENDPOINT=http://127.0.0.1:8003`
- `FINAL_LLM_ENDPOINT=http://127.0.0.1:8001`
- `EMBED_ENDPOINT=http://127.0.0.1:8002`
- `LLM_MODEL_ID=omni-law-gen`
- `PREVIEW_LLM_MODEL_ID=omni-law-gen-preview`
- `FINAL_LLM_MODEL_ID=omni-law-gen-final`
- `EMBED_MODEL_ID=omni-law-embed`
- `MODEL_GEN_PATH=./models/omni-law-gen-final.gguf` (optional compatibility fallback)
- `MODEL_GEN_PREVIEW_PATH=./models/omni-law-gen-preview.gguf`
- `MODEL_GEN_FINAL_PATH=./models/omni-law-gen-final.gguf`
- `MODEL_EMBED_PATH=./models/omni-law-embed.gguf`
- `PREVIEW_GEN_CTX=2048`
- `FINAL_GEN_CTX=4096`
- `PREVIEW_GEN_MAX_TOKENS=320`
- `FINAL_GEN_MAX_TOKENS=900`
- `LLAMA_SERVER_BIN=<path to local server binary>`
- `EMBED_SERVER_BIN=<path to local embedding server binary>` (optional if same binary)
- `OCR_ENABLED=true`
- `LEGAL_CORPUS_DIR=./legal_corpus`

## 3) Start local model servers
Install your preferred local AI server runtime separately (must expose HTTP endpoints).

PowerShell:
- `.\backend\scripts\start_llm_preview_server.ps1`
- `.\backend\scripts\start_llm_server.ps1`
- `.\backend\scripts\start_embed_server.ps1`

Bash:
- `bash ./backend/scripts/start_llm_preview_server.sh`
- `bash ./backend/scripts/start_llm_server.sh`
- `bash ./backend/scripts/start_embed_server.sh`

The scripts assume:
- preview completion endpoint at `PREVIEW_LLM_ENDPOINT` or `LLM_ENDPOINT`
- final completion endpoint at `FINAL_LLM_ENDPOINT` or `LLM_ENDPOINT`
- embedding endpoint at `EMBED_ENDPOINT`

Compact vs quality profile:
- `compact`: prefer this for the preview model
- `quality`: prefer this for the final reasoning model

## 3.1) Download model files with your own URLs (optional helper)
No URLs are stored in this repo. Supply your own:

PowerShell:
- set `GEN_MODEL_URL`, `EMBED_MODEL_URL` (and optional SHA256 vars)
- run `npm --prefix backend run ai:download:ps`

Bash:
- export `GEN_MODEL_URL`, `EMBED_MODEL_URL` (and optional SHA256 vars)
- run `npm --prefix backend run ai:download:sh`

The download script writes `backend/models/MODEL_INFO.json` using internal aliases only.

## 4) Legal corpus grounding (recommended)
Place legal source files in:
- `backend/legal_corpus/`

Supported file types:
- `.txt`
- `.pdf`
- `.docx`

Name files to help source typing:
- include words like `act`, `statute`, `case`, `judgment`, `regulation`, `rule`

## 5) Validation
After model servers are running:
1. Start backend + frontend
2. Upload/paste case text
3. Run all modules
4. Confirm citations appear (especially compliance + terms/policies)
5. Confirm language switch changes outputs and run step messages
