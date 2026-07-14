#!/usr/bin/env bash
# bootstrap.sh — clone upstream source and prepare capix-code.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
CAPIX_CODE_DIR="${CAPIX_CODE_DIR:-$DIR/upstream}"

# TODO: Update this SHA when upgrading upstream
CAPIX_CODE_REF="${CAPIX_CODE_REF:-9976269ab1accfc9f9dc98a4a688c516934de422}"

if [ -d "$CAPIX_CODE_DIR/.git" ]; then
  echo "✓ $CAPIX_CODE_DIR already cloned."
else
  echo "▸ Cloning upstream source into $CAPIX_CODE_DIR (SHA: $CAPIX_CODE_REF)…"
  git clone https://github.com/anomalyco/opencode.git "$CAPIX_CODE_DIR"
  git -C "$CAPIX_CODE_DIR" checkout "$CAPIX_CODE_REF"
fi

ACTUAL_REF="$(git -C "$CAPIX_CODE_DIR" rev-parse HEAD)"
if [ "$ACTUAL_REF" != "$CAPIX_CODE_REF" ]; then
  echo "✗ Source checkout is at $ACTUAL_REF; expected pinned ref $CAPIX_CODE_REF"
  echo "  Use a new CAPIX_CODE_DIR or restore the pinned checkout before continuing."
  exit 1
fi

# A prepared checkout is intentionally changed by scripts/rebrand.sh. Treat the
# expected renamed package as an idempotent success, while still rejecting an
# unrelated dirty checkout before the first rebrand.
if [ -d "$CAPIX_CODE_DIR/packages/capix-code" ]; then
  echo "✓ Pinned Capix Code source already prepared: $ACTUAL_REF"
  exit 0
fi

git -C "$CAPIX_CODE_DIR" diff --quiet || {
  echo "✗ Source tree has unstaged changes before Capix preparation"
  exit 1
}
echo "✓ Pinned source ready: $ACTUAL_REF"
