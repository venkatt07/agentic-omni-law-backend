#!/usr/bin/env bash
set -euo pipefail

if [ -f "$(dirname "$0")/../.env" ]; then
  set -a
  . "$(dirname "$0")/../.env"
  set +a
fi

SERVER_BIN="${EMBED_SERVER_BIN:-${LLAMA_SERVER_BIN:-}}"
if [ -z "${SERVER_BIN}" ]; then
  echo "Set EMBED_SERVER_BIN or LLAMA_SERVER_BIN in backend/.env to your local server binary path." >&2
  exit 1
fi
MODEL_PATH="${MODEL_EMBED_PATH:-./models/omni-law-embed.gguf}"
PORT="$(printf '%s' "${EMBED_ENDPOINT:-http://127.0.0.1:8002}" | sed -E 's#.*:([0-9]+)$#\1#')"
LOGICAL_CORES="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 8)"
DEFAULT_THREADS="$((LOGICAL_CORES>1 ? LOGICAL_CORES-1 : 1))"
THREADS="${EMBED_THREADS:-$DEFAULT_THREADS}"

echo "Starting local embedding server on port ${PORT} with model alias ${EMBED_MODEL_ID:-omni-law-embed}"
echo "Binary: ${SERVER_BIN}"
echo "Model path: ${MODEL_PATH}"
echo "threads=${THREADS}"

exec "${SERVER_BIN}" --model "${MODEL_PATH}" --port "${PORT}" --host 127.0.0.1 --embeddings --threads "${THREADS}"
