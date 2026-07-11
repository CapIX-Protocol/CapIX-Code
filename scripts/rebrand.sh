#!/usr/bin/env bash
# rebrand.sh — apply Capix branding to the cloned opencode source.
# ONLY renames: binary name, config dirs, env var prefixes, install script.
# Does NOT rename: workspace package name, npm package name, or import paths.
set -uo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
CAPIX_CODE_DIR="${CAPIX_CODE_DIR:-$DIR/opencode}"

if [ ! -d "$CAPIX_CODE_DIR" ]; then
  echo "✗ No $CAPIX_CODE_DIR. Run ./scripts/bootstrap.sh first."
  exit 1
fi

cd "$CAPIX_CODE_DIR"
echo "▸ Rebranding in $CAPIX_CODE_DIR"

# 1. Binary name in packages/opencode/package.json — ONLY the "bin" field.
PKG="$CAPIX_CODE_DIR/packages/opencode/package.json"
if [ -f "$PKG" ]; then
  # Change only the binary name, not the package name (workspace deps depend on it).
  sed -i.bak 's|"bin": {"opencode"|"bin": {"capix-code"|g' "$PKG"
  rm -f "$PKG.bak"
  echo "  ✓ binary name: opencode → capix-code"
fi

# 2. Build script — only the output directory/file naming.
BUILD="$CAPIX_CODE_DIR/packages/opencode/script/build.ts"
if [ -f "$BUILD" ]; then
  sed -i.bak 's|bin/opencode|bin/capix-code|g' "$BUILD"
  rm -f "$BUILD.bak"
  echo "  ✓ build.ts: output binary renamed"
fi

# 3. Env var prefixes: OPENCODE_ → CAPIX_CODE_ (source files only).
echo "▸ Replacing env var prefixes…"
find "$CAPIX_CODE_DIR/packages/opencode/src" \( -name '*.ts' -o -name '*.js' -o -name '*.tsx' \) -type f 2>/dev/null | while IFS= read -r f; do
  sed -i.bak 's/OPENCODE_/CAPIX_CODE_/g' "$f"
  rm -f "$f.bak"
done
echo "  ✓ env prefix: OPENCODE_ → CAPIX_CODE_"

# 4. Config directory paths in source: .opencode → .capix-code, .config/opencode → .config/capix-code.
echo "▸ Replacing config directory paths…"
find "$CAPIX_CODE_DIR/packages/opencode/src" \( -name '*.ts' -o -name '*.js' -o -name '*.tsx' \) -type f 2>/dev/null | while IFS= read -r f; do
  sed -i.bak \
    -e 's|\.config/opencode|.config/capix-code|g' \
    -e 's|\.opencode/|.capix-code/|g' \
    -e "s|opencode/auth|capix-code/auth|g" \
    "$f"
  rm -f "$f.bak"
done
echo "  ✓ config dirs updated"

# 5. Config filename: opencode.json → capix-code.json (only in the default config path lookup).
echo "▸ Replacing config filename…"
find "$CAPIX_CODE_DIR/packages/opencode/src" \( -name '*.ts' -o -name '*.js' \) -type f 2>/dev/null | while IFS= read -r f; do
  sed -i.bak "s/opencode\.json/capix-code.json/g" "$f"
  rm -f "$f.bak"
done
echo "  ✓ config filename: opencode.json → capix-code.json"

# 6. Display name in source — "OpenCode" → "CapixCode" (display strings only, not imports).
echo "▸ Replacing display names…"
find "$CAPIX_CODE_DIR/packages/opencode/src" \( -name '*.ts' -o -name '*.tsx' \) -type f 2>/dev/null | while IFS= read -r f; do
  # Only replace in string literals, not import paths. Conservative: replace "OpenCode" in quotes.
  sed -i.bak \
    -e 's/"OpenCode"/"CapixCode"/g' \
    -e "s/'OpenCode'/'CapixCode'/g" \
    -e 's/`OpenCode`/`CapixCode`/g' \
    "$f"
  rm -f "$f.bak"
done
echo "  ✓ display names updated"

# 7. Install script references.
INSTALL="$CAPIX_CODE_DIR/install"
if [ -f "$INSTALL" ]; then
  sed -i.bak \
    -e 's|anomalyco/opencode|CapIX-Protocol/CapIX-Code|g' \
    -e 's|opencode-ai|capix-code|g' \
    "$INSTALL"
  rm -f "$INSTALL.bak"
  echo "  ✓ install script updated"
fi

echo "✓ Rebrand complete. The workspace package name stays 'opencode' — only the binary name, config dirs, and env vars are rebranded."
