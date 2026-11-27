#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_PATH="${1:-$ROOT_DIR/dist/joy-inbox-lambda.zip}"
if [[ "$OUTPUT_PATH" != /* ]]; then OUTPUT_PATH="$(pwd)/$OUTPUT_PATH"; fi
OUTPUT_DIR="$(dirname "$OUTPUT_PATH")"
BUILD_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$BUILD_DIR"
}
trap cleanup EXIT

mkdir -p "$OUTPUT_DIR"
cp "$ROOT_DIR/package.json" "$ROOT_DIR/package-lock.json" "$ROOT_DIR/index.js" "$BUILD_DIR/"
cp -R "$ROOT_DIR/src" "$BUILD_DIR/src"

(
  cd "$BUILD_DIR"
  npm ci --omit=dev --no-audit --no-fund
  zip -qr "$OUTPUT_PATH" index.js package.json package-lock.json src node_modules
  unzip -t "$OUTPUT_PATH" >/dev/null
)

echo "Lambda deployment package created and verified: $OUTPUT_PATH"
