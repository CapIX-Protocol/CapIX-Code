#!/usr/bin/env bash
# verify-build.sh — verify built Capix artifacts before release.
#
# Usage: scripts/verify-build.sh [ARTIFACT_DIR]
#   ARTIFACT_DIR  default: release-artifacts
#
# For every distributable archive in ARTIFACT_DIR:
#   1. Verify the adjacent .sha256 sidecar matches the archive.
#   2. Smoke test the payload: capix-code archives run `capix-code doctor`
#      when the archive platform matches the host; capix-mcp tarballs must
#      contain the compiled server entry; capix-protocol tarballs must
#      contain a Next.js BUILD_ID. Foreign-platform binaries are
#      checksum-verified and reported as not executable on this host.
#   3. Manifest files (release-manifest.json / build-manifest.json /
#      provenance.json / sbom.spdx.json) must parse as JSON.
#
# Exits non-zero on the first category of failure after reporting all
# failures found.
set -uo pipefail

DIST_DIR="${1:-release-artifacts}"

if [ ! -d "$DIST_DIR" ]; then
  echo "✗ Artifact directory not found: $DIST_DIR" >&2
  exit 1
fi

FAILURES=0
CHECKED=0
SKIPPED=0

fail() {
  echo "✗ $1" >&2
  FAILURES=$((FAILURES + 1))
}

host_platform() {
  case "$(uname -s)" in
    Darwin) echo darwin ;;
    Linux) echo linux ;;
    MINGW*|MSYS*|CYGWIN*) echo win32 ;;
    *) uname -s | tr 'A-Z' 'a-z' ;;
  esac
}

host_arch() {
  case "$(uname -m)" in
    arm64|aarch64) echo arm64 ;;
    *) echo x64 ;;
  esac
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

extract() {
  local archive="$1" dest="$2"
  mkdir -p "$dest"
  case "$archive" in
    *.zip) unzip -q "$archive" -d "$dest" ;;
    *) tar -xzf "$archive" -C "$dest" ;;
  esac
}

list_archive() {
  case "$1" in
    *.zip) unzip -l "$1" | awk '{print $4}' ;;
    *) tar -tzf "$1" ;;
  esac
}

smoke_capix_code() {
  local archive="$1" name="$2"
  # capix-code-<version>-<platform>-<arch>-<flavor>.<ext>
  local rest platform arch
  rest="${name#capix-code-}"
  rest="${rest#*-}"                       # strip version
  platform="${rest%%-*}"
  arch="${rest#*-}"; arch="${arch%%-*}"

  if [ "$platform" != "$(host_platform)" ] || [ "$arch" != "$(host_arch)" ]; then
    echo "  ↷ $name: foreign platform ($platform-$arch), checksum verified, execution skipped"
    SKIPPED=$((SKIPPED + 1))
    return 0
  fi

  local tmp binary
  tmp="$(mktemp -d)"
  if ! extract "$archive" "$tmp"; then
    fail "$name: archive could not be extracted"
    rm -rf "$tmp"
    return 1
  fi
  binary="$(find "$tmp" -name 'capix-code' -o -name 'capix-code.exe' | grep '/bin/' | head -1)"
  if [ -z "$binary" ]; then
    fail "$name: no launcher binary found in archive"
    rm -rf "$tmp"
    return 1
  fi
  chmod 0755 "$binary" 2>/dev/null || true
  if (cd "$(dirname "$binary")/.." && "./bin/$(basename "$binary")" doctor >/dev/null 2>&1); then
    echo "  ✓ $name: capix-code doctor passed"
  else
    fail "$name: capix-code doctor failed"
  fi
  rm -rf "$tmp"
}

smoke_capix_mcp() {
  local archive="$1" name="$2"
  if list_archive "$archive" | grep -q 'package/dist/index.js'; then
    echo "  ✓ $name: compiled MCP server entry present"
  else
    fail "$name: package/dist/index.js missing from MCP tarball"
  fi
}

smoke_capix_protocol() {
  local archive="$1" name="$2"
  if list_archive "$archive" | grep -q '\.next/BUILD_ID'; then
    echo "  ✓ $name: Next.js production build present"
  else
    fail "$name: .next/BUILD_ID missing from protocol archive"
  fi
}

echo "=== Verifying Capix build artifacts in $DIST_DIR ==="

# ── 1. Checksums ─────────────────────────────────────────────────────────────
ARCHIVE_FOUND=0
for archive in "$DIST_DIR"/*.tar.gz "$DIST_DIR"/*.tgz "$DIST_DIR"/*.zip "$DIST_DIR"/*.dmg; do
  [ -f "$archive" ] || continue
  ARCHIVE_FOUND=1
  CHECKED=$((CHECKED + 1))
  name="$(basename "$archive")"
  sidecar="$archive.sha256"
  if [ ! -f "$sidecar" ]; then
    fail "$name: missing .sha256 sidecar"
    continue
  fi
  expected="$(awk '{print $1}' "$sidecar")"
  actual="$(sha256_file "$archive")"
  if [ "$expected" != "$actual" ]; then
    fail "$name: checksum mismatch (expected $expected, got $actual)"
    continue
  fi

  # ── 2. Smoke tests ─────────────────────────────────────────────────────────
  case "$name" in
    capix-code-*.tar.gz|capix-code-*.zip) smoke_capix_code "$archive" "$name" ;;
    capix-mcp-*.tgz) smoke_capix_mcp "$archive" "$name" ;;
    capix-protocol-*.tar.gz) smoke_capix_protocol "$archive" "$name" ;;
    *)
      echo "  ✓ $name: checksum verified (no smoke test defined for this artifact type)"
      ;;
  esac
done
[ "$ARCHIVE_FOUND" -eq 1 ] || fail "no distributable archives found in $DIST_DIR"

# ── 3. Manifest JSON validity ────────────────────────────────────────────────
for manifest in "$DIST_DIR"/release-manifest.json "$DIST_DIR"/build-manifest.json \
                "$DIST_DIR"/provenance.json "$DIST_DIR"/sbom.spdx.json; do
  [ -f "$manifest" ] || continue
  if node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$manifest" 2>/dev/null; then
    echo "  ✓ $(basename "$manifest"): valid JSON"
  else
    fail "$(basename "$manifest"): invalid JSON"
  fi
done

echo ""
echo "=== Verification summary: $CHECKED archives checked, $SKIPPED foreign-platform skips, $FAILURES failures ==="
[ "$FAILURES" -eq 0 ] || exit 1
echo "✓ All artifacts verified"
