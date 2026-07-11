#!/usr/bin/env bash
# rebrand.sh — rename opencode -> capix-code across the full tree.
# Safe to re-run. Uses `set -uo pipefail` (no -e so rg no-match doesn't exit).
set -uo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPENCODE_DIR="${OPENCODE_DIR:-$DIR/opencode}"

if [ ! -d "$OPENCODE_DIR" ]; then
  echo "✗ No $OPENCODE_DIR. Run ./scripts/bootstrap.sh first."
  exit 1
fi

cd "$OPENCODE_DIR"
echo "▸ Rebranding opencode → capix-code in $OPENCODE_DIR"

# Detect sed in-place flag (macOS vs GNU).
if [[ "$(uname)" == "Darwin" ]]; then
  SED_I=(-i '')
else
  SED_I=(-i)
fi

# 1. Binary name + package name in the main package.json
PKG="$OPENCODE_DIR/packages/opencode/package.json"
if [ -f "$PKG" ]; then
  sed "${SED_I[@]}" 's/"opencode"/"capix-code"/g' "$PKG"
  echo "  ✓ package.json: opencode → capix-code"
fi

# 2. Build script output naming
BUILD="$OPENCODE_DIR/packages/opencode/script/build.ts"
if [ -f "$BUILD" ]; then
  sed "${SED_I[@]}" 's/opencode-/capix-code-/g; s|bin/opencode|bin/capix-code|g' "$BUILD"
  echo "  ✓ build.ts: output paths renamed"
fi

# 3. Env var prefixes: OPENCODE_ → CAPIX_CODE_ (in source files only)
echo "▸ Replacing env var prefixes…"
find "$OPENCODE_DIR/packages/opencode/src" -name '*.ts' -o -name '*.js' -o -name '*.tsx' 2>/dev/null | while IFS= read -r f; do
  sed "${SED_I[@]}" 's/OPENCODE_/CAPIX_CODE_/g' "$f"
done
echo "  ✓ env prefix: OPENCODE_ → CAPIX_CODE_"

# 4. Config directory paths in source strings
echo "▸ Replacing config directory names…"
find "$OPENCODE_DIR/packages/opencode/src" -name '*.ts' -o -name '*.js' -o -name '*.tsx' 2>/dev/null | while IFS= read -r f; do
  sed "${SED_I[@]}" \
    's|\.config/opencode|.config/capix-code|g; s|\.opencode/|.capix-code/|g; s|"opencode"|"capix-code"|g' \
    "$f"
done
echo "  ✓ config dirs updated"

# 5. Config filename: opencode.json → capix-code.json in source references
echo "▸ Replacing config filename references…"
find "$OPENCODE_DIR/packages/opencode/src" -name '*.ts' -o -name '*.js' -o -name '*.tsx' 2>/dev/null | while IFS= read -r f; do
  sed "${SED_I[@]}" 's/opencode\.json/capix-code.json/g' "$f"
done
echo "  ✓ config filename: opencode.json → capix-code.json"

# 6. Install script references
INSTALL="$OPENCODE_DIR/install"
if [ -f "$INSTALL" ]; then
  sed "${SED_I[@]}" \
    's|anomalyco/opencode|CapIX-Protocol/CapIX-Code|g; s|opencode-ai|capix-code|g' \
    "$INSTALL"
  echo "  ✓ install: repo + binary name updated"
fi

# 7. Replace lowercase "opencode" → "capix-code" in display strings
#    (but NOT in file paths or import statements that reference the source tree)
echo "▸ Replacing display name references…"
find "$OPENCODE_DIR/packages/opencode/src" -name '*.ts' -o -name '*.tsx' 2>/dev/null | while IFS= read -r f; do
  # Only replace "opencode" when it appears as a standalone word in string literals
  # This is conservative — avoids breaking import paths like packages/opencode/src/...
  sed "${SED_I[@]}" \
    's/"opencode"/"capix-code"/g; s|`opencode`|`capix-code`|g; s/OpenCode/CapixCode/g' \
    "$f"
done
echo "  ✓ display names updated"

echo "✓ Rebrand complete."
