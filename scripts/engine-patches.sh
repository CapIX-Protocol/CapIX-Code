#!/usr/bin/env bash
# engine-patches.sh — apply Capix behavioral patches over the rebranded
# upstream engine tree.
#
# The engine binary is built from a pristine pinned upstream checkout (see
# scripts/bootstrap.sh); rebrand.sh only renames. Behavioral Capix fixes to
# engine core files travel as an overlay in patches/engine/ and are copied
# over the rebranded tree here. Keep the overlay minimal — every file in it
# is drift to re-review at the next upstream pin bump.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
CAPIX_CODE_DIR="${CAPIX_CODE_DIR:-$DIR/upstream}"
OVERLAY="$DIR/patches/engine"

if [ ! -d "$CAPIX_CODE_DIR/packages/capix-code" ]; then
  echo "✗ $CAPIX_CODE_DIR is not rebranded yet. Run bootstrap.sh + rebrand.sh first."
  exit 1
fi

if [ -d "$OVERLAY" ]; then
  cp -R "$OVERLAY"/. "$CAPIX_CODE_DIR"/
  echo "✓ engine patches applied from $OVERLAY"
else
  echo "✓ no engine overlay present"
fi
