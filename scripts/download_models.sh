#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODELS_DIR="${MODELS_DIR:-$ROOT/models}"
GEN_URL="${GEN_MODEL_URL:-}"
EMBED_URL="${EMBED_MODEL_URL:-}"
GEN_SHA="${GEN_MODEL_SHA256:-}"
EMBED_SHA="${EMBED_MODEL_SHA256:-}"
AI_PROFILE="${AI_PROFILE:-compact}"

mkdir -p "$MODELS_DIR"

download_file() {
  local url="$1"
  local out="$2"
  if [ -z "$url" ]; then
    echo "Missing URL for $out. Set env var before running." >&2
    return 1
  fi
  echo "Downloading $(basename "$out") ..."
  curl -L --fail -o "$out" "$url"
}

verify_sha() {
  local file="$1"
  local want="$2"
  if [ -z "$want" ]; then return 0; fi
  local got
  got="$(sha256sum "$file" | awk '{print toupper($1)}')"
  if [ "${got^^}" != "${want^^}" ]; then
    echo "SHA256 mismatch for $(basename "$file")" >&2
    echo "Expected: $want" >&2
    echo "Actual:   $got" >&2
    return 1
  fi
}

warn_size() {
  local file="$1"
  local size
  size=$(wc -c < "$file")
  local mb=$((size / 1024 / 1024))
  echo "$(basename "$file"): ${mb} MB"
  if [[ "$(basename "$file")" == "omni-law-gen.gguf" ]]; then
    if [ "$AI_PROFILE" = "compact" ] && { [ "$mb" -lt 250 ] || [ "$mb" -gt 650 ]; }; then
      echo "Warning: compact generator expected roughly 250-650MB (got ${mb}MB)." >&2
    fi
    if [ "$AI_PROFILE" = "quality" ] && [ "$mb" -le 650 ]; then
      echo "Warning: quality profile typically expects >650MB generator file." >&2
    fi
  fi
}

GEN_FILE="$MODELS_DIR/omni-law-gen.gguf"
EMBED_FILE="$MODELS_DIR/omni-law-embed.gguf"

download_file "$GEN_URL" "$GEN_FILE"
download_file "$EMBED_URL" "$EMBED_FILE"
verify_sha "$GEN_FILE" "$GEN_SHA"
verify_sha "$EMBED_FILE" "$EMBED_SHA"
warn_size "$GEN_FILE"
warn_size "$EMBED_FILE"

GEN_SIZE=$(wc -c < "$GEN_FILE")
EMBED_SIZE=$(wc -c < "$EMBED_FILE")
mkdir -p "$ROOT/models"
cat > "$ROOT/models/MODEL_INFO.json" <<JSON
{
  "generator": {
    "alias": "omni-law-gen.gguf",
    "profile": "${AI_PROFILE}",
    "size_mb": $((GEN_SIZE / 1024 / 1024)),
    "quant": "",
    "notes": "Local offline generator model alias"
  },
  "embedder": {
    "alias": "omni-law-embed.gguf",
    "size_mb": $((EMBED_SIZE / 1024 / 1024))
  }
}
JSON

echo "Models downloaded to $MODELS_DIR"
echo "Metadata written to $ROOT/models/MODEL_INFO.json"

