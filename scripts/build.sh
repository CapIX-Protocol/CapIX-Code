#!/usr/bin/env bash
# build.sh — produce packaged capix-code binaries.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
CAPIX_CODE_DIR="${CAPIX_CODE_DIR:-$DIR/upstream}"
BUN="${BUN_BIN:-$(command -v bun || true)}"
if [ -z "$BUN" ] && [ -x "$DIR/node_modules/.bin/bun" ]; then BUN="$DIR/node_modules/.bin/bun"; fi
[ -n "$BUN" ] || { echo "✗ Bun 1.3.14 is required"; exit 1; }
[ "$($BUN --version)" = "1.3.14" ] || { echo "✗ Expected Bun 1.3.14"; exit 1; }

if [ ! -d "$CAPIX_CODE_DIR" ]; then
  echo "✗ No $CAPIX_CODE_DIR. Run ./scripts/bootstrap.sh first."
  exit 1
fi

cd "$CAPIX_CODE_DIR"

echo "▸ Building capix-code standalone binary…"
"$BUN" install

# Write default config if the init script exists.
if [ -f "packages/capix-code/scripts/init-capix-config.ts" ]; then
  "$BUN" run packages/capix-code/scripts/init-capix-config.ts 2>/dev/null || true
fi

# Build using the upstream build script.
if [ -f "packages/capix-code/script/build.ts" ]; then
  "$BUN" run --cwd packages/capix-code script/build.ts --single
fi

# Find the output — handle both renamed and original patterns.
OUTPUT=$(find packages/capix-code/dist -name "capix-code" -type f 2>/dev/null | head -1)
if [ -z "$OUTPUT" ]; then
  OUTPUT=$(find packages/capix-code/dist -name "opencode" -type f 2>/dev/null | head -1)
  if [ -n "$OUTPUT" ]; then
    NEW_OUTPUT="$(dirname "$OUTPUT")/capix-code"
    mv "$OUTPUT" "$NEW_OUTPUT"
    OUTPUT="$NEW_OUTPUT"
  fi
fi

if [ -n "$OUTPUT" ]; then
  ARTIFACT="$DIR/dist/customer"
  rm -rf "$ARTIFACT"
  mkdir -p "$ARTIFACT/bin" "$ARTIFACT/engine" "$ARTIFACT/runtime/packages" "$ARTIFACT/config"
  EXE_SUFFIX=""
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) EXE_SUFFIX=".exe";; esac
  cp "$OUTPUT" "$ARTIFACT/engine/capix-engine$EXE_SUFFIX"
  cp -R "$DIR/src" "$ARTIFACT/runtime/src"
  cp -R "$DIR/packages/runtime-provider" "$ARTIFACT/runtime/packages/runtime-provider"
  cp "$DIR/package.json" "$DIR/package-lock.json" "$ARTIFACT/runtime/"
  cp "$DIR/config/capix-defaults.json" "$ARTIFACT/config/"
  chmod 0755 "$ARTIFACT/engine/capix-engine$EXE_SUFFIX"
  (cd "$ARTIFACT/runtime" && npm ci --omit=dev --ignore-scripts)
  (cd "$DIR/launcher" && cargo build --locked --release)
  cp "$DIR/launcher/target/release/capix-code$EXE_SUFFIX" "$ARTIFACT/bin/capix-code$EXE_SUFFIX"
  chmod 0755 "$ARTIFACT/bin/capix-code$EXE_SUFFIX"
  "$DIR/scripts/assert-artifact.sh" "$ARTIFACT"
  "$DIR/scripts/assert-customer-brand.sh" "$ARTIFACT"
  echo "✓ Customer artifact staged: $ARTIFACT"
else
  echo "✗ No binary found in dist/ — build may have failed."
  exit 1
fi
