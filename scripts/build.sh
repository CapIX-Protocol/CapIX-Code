#!/usr/bin/env bash
# build.sh — produce packaged capix-code binaries.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
CAPIX_CODE_DIR="${CAPIX_CODE_DIR:-$DIR/opencode}"

if [ ! -d "$CAPIX_CODE_DIR" ]; then
  echo "✗ No $CAPIX_CODE_DIR. Run ./scripts/bootstrap.sh first."
  exit 1
fi

cd "$CAPIX_CODE_DIR"

echo "▸ Building capix-code standalone binary…"
bun install

# Write default config if the init script exists.
if [ -f "packages/opencode/scripts/init-capix-config.ts" ]; then
  bun run packages/opencode/scripts/init-capix-config.ts 2>/dev/null || true
fi

# Build using the upstream build script.
if [ -f "packages/opencode/script/build.ts" ]; then
  bun run --cwd packages/opencode script/build.ts --single
fi

# Find the output — handle both renamed and original patterns.
OUTPUT=$(find packages/opencode/dist -name "capix-code" -type f 2>/dev/null | head -1)
if [ -z "$OUTPUT" ]; then
  OUTPUT=$(find packages/opencode/dist -name "opencode" -type f 2>/dev/null | head -1)
  if [ -n "$OUTPUT" ]; then
    NEW_OUTPUT="$(dirname "$OUTPUT")/capix-code"
    mv "$OUTPUT" "$NEW_OUTPUT"
    OUTPUT="$NEW_OUTPUT"
  fi
fi

if [ -n "$OUTPUT" ]; then
  echo "✓ Build complete: $OUTPUT"
else
  echo "✗ No binary found in dist/ — build may have failed."
  exit 1
fi
