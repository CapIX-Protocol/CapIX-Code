#!/usr/bin/env bash
# bootstrap.sh — clone opencode and prepare capix-code.
set -uo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
CAPIX_CODE_DIR="${CAPIX_CODE_DIR:-$DIR/opencode}"

# TODO: Update this SHA when upgrading upstream
CAPIX_CODE_REF="${CAPIX_CODE_REF:-9976269ab1accfc9f9dc98a4a688c516934de422}"

if [ -d "$CAPIX_CODE_DIR/.git" ]; then
  echo "✓ $CAPIX_CODE_DIR already cloned."
  exit 0
fi

echo "▸ Cloning opencode into $CAPIX_CODE_DIR (SHA: $CAPIX_CODE_REF)…"
git clone https://github.com/anomalyco/opencode.git "$CAPIX_CODE_DIR"
git -C "$CAPIX_CODE_DIR" checkout "$CAPIX_CODE_REF"

echo "✓ Clone complete."
