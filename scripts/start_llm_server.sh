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
MODEL_PATH="${MODEL_GEN_FINAL_PATH:-${MODEL_GEN_PATH:-./models/omni-law-gen.gguf}}"
PORT="$(printf '%s' "${FINAL_LLM_ENDPOINT:-${LLM_ENDPOINT:-http://127.0.0.1:8001}}" | sed -E 's#.*:([0-9]+)$#\1#')"
LOGICAL_CORES="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 8)"
DEFAULT_THREADS="$((LOGICAL_CORES>1 ? LOGICAL_CORES-1 : 1))"
THREADS="${LLM_THREADS:-$DEFAULT_THREADS}"
PROFILE="${AI_PROFILE:-quality}"
if [ -n "${FINAL_GEN_CTX:-}" ]; then
  CTX="${FINAL_GEN_CTX}"
elif [ -n "${LLM_CTX:-}" ]; then
  CTX="${LLM_CTX}"
elif [ "${PROFILE}" = "quality" ]; then
  CTX="${GEN_CTX_QUALITY:-4096}"
else
  CTX="${GEN_CTX_COMPACT:-2048}"
fi
if [ -n "${FINAL_GEN_MAX_TOKENS:-}" ]; then
  N_PREDICT="${FINAL_GEN_MAX_TOKENS}"
  DEFAULT_BATCH="256"
  DEFAULT_UBATCH="64"
elif [ "${PROFILE}" = "quality" ]; then
  N_PREDICT="${GEN_MAX_TOKENS_QUALITY:-700}"
  DEFAULT_BATCH="256"
  DEFAULT_UBATCH="64"
else
  N_PREDICT="${GEN_MAX_TOKENS_COMPACT:-300}"
  DEFAULT_BATCH="128"
  DEFAULT_UBATCH="32"
fi
BATCH="${LLM_BATCH_SIZE:-$DEFAULT_BATCH}"
UBATCH="${LLM_UBATCH_SIZE:-$DEFAULT_UBATCH}"
PARALLEL="${LLM_PARALLEL:-1}"

echo "Starting final reasoning server on port ${PORT} with model alias ${FINAL_LLM_MODEL_ID:-${LLM_MODEL_ID:-omni-law-gen}}"
echo "Binary: ${SERVER_BIN}"
echo "Model path: ${MODEL_PATH}"
echo "profile=${PROFILE} ctx=${CTX} threads=${THREADS} n_predict=${N_PREDICT} batch=${BATCH} ubatch=${UBATCH} parallel=${PARALLEL}"
echo "If supported by your local server binary, enable keepalive/batch flags for lower latency."

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
