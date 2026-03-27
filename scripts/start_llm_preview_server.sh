#!/usr/bin/env bash
set -euo pipefail

if [ -f "$(dirname "$0")/../.env" ]; then
  set -a
  . "$(dirname "$0")/../.env"
  set +a
fi

SERVER_BIN="${LLAMA_SERVER_BIN:-}"
if [ -z "${SERVER_BIN}" ]; then
  echo "Set LLAMA_SERVER_BIN in backend/.env to your local server binary path." >&2
  exit 1
fi
MODEL_PATH="${MODEL_GEN_PREVIEW_PATH:-${MODEL_GEN_PATH:-./models/omni-law-gen-preview.gguf}}"
PORT="$(printf '%s' "${PREVIEW_LLM_ENDPOINT:-http://127.0.0.1:8003}" | sed -E 's#.*:([0-9]+)$#\1#')"
LOGICAL_CORES="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 8)"
DEFAULT_THREADS="$((LOGICAL_CORES>2 ? LOGICAL_CORES/2 : 1))"
THREADS="${LLM_THREADS:-$DEFAULT_THREADS}"
PROFILE="${AI_PROFILE:-compact}"
if [ -n "${PREVIEW_GEN_CTX:-}" ]; then
  CTX="${PREVIEW_GEN_CTX}"
elif [ -n "${LLM_CTX:-}" ]; then
  CTX="${LLM_CTX}"
else
  CTX="${GEN_CTX_COMPACT:-2048}"
fi
N_PREDICT="${PREVIEW_GEN_MAX_TOKENS:-${GEN_MAX_TOKENS_COMPACT:-300}}"
BATCH="${LLM_BATCH_SIZE:-128}"
UBATCH="${LLM_UBATCH_SIZE:-32}"
PARALLEL="${LLM_PARALLEL:-1}"

echo "Starting preview server on port ${PORT} with model alias ${PREVIEW_LLM_MODEL_ID:-${LLM_MODEL_ID:-omni-law-gen-preview}}"
echo "Binary: ${SERVER_BIN}"
echo "Model path: ${MODEL_PATH}"
echo "profile=${PROFILE} ctx=${CTX} threads=${THREADS} n_predict=${N_PREDICT} batch=${BATCH} ubatch=${UBATCH} parallel=${PARALLEL}"
echo "Use a smaller GGUF here for low-latency previews."

exec "${SERVER_BIN}" \
  --model "${MODEL_PATH}" \
  --port "${PORT}" \
  --host 127.0.0.1 \
  --ctx-size "${CTX}" \
  --threads "${THREADS}" \
  --batch-size "${BATCH}" \
  --ubatch-size "${UBATCH}" \
  --parallel "${PARALLEL}" \
  --n-predict "${N_PREDICT}"
