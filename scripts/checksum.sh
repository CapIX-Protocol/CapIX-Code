#!/bin/bash
set -euo pipefail
DIST_DIR="${1:-dist}"
for f in "$DIST_DIR"/*.tar.gz "$DIST_DIR"/*.zip; do
  [ -f "$f" ] || continue
  shasum -a 256 "$f" > "$f.sha256"
  echo "  $(basename $f): $(cat "$f.sha256" | awk '{print $1}')"
done
