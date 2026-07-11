#!/usr/bin/env bash
# bootstrap.sh — clone opencode and prepare capix-code.
set -uo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPENCODE_DIR="${OPENCODE_DIR:-$DIR/opencode}"
OPENCODE_REF="${OPENCODE_REF:-dev}"

if [ -d "$OPENCODE_DIR/.git" ]; then
  echo "✓ $OPENCODE_DIR already cloned."
  exit 0
fi

echo "▸ Cloning opencode into $OPENCODE_DIR (ref: $OPENCODE_REF)…"
git clone --depth 1 --branch "$OPENCODE_REF" https://github.com/anomalyco/opencode.git "$OPENCODE_DIR"

echo "✓ Clone complete."
