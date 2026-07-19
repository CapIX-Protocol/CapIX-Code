#!/usr/bin/env bash
# build-all.sh — unified build for every Capix package (code, MCP, protocol, IDE).
#
# Usage: scripts/build-all.sh [options]
#   --skip-code       Skip the Capix Code CLI build
#   --skip-mcp        Skip the Capix MCP server build
#   --skip-protocol   Skip the Capix Protocol web build
#   --skip-ide        Skip the Capix IDE build (heavy; requires Node 20.18.2)
#   --skip-verify     Skip scripts/verify-build.sh after packaging
#   --upload TAG      Upload release-artifacts/ to the GitHub release TAG
#
# Package directories resolve from env vars, falling back to sibling checkouts
# of this repository:
#   CAPIX_CODE_DIR      default: repo root containing this script
#   CAPIX_MCP_DIR       default: ../mcp or ../CapIX-MCP
#   CAPIX_PROTOCOL_DIR  default: ../protocol or ../Capix-Protocol
#   CAPIX_IDE_DIR       default: ../ide or ../CapIX-IDE
#
# Outputs:
#   release-artifacts/            distributable archives + .sha256 sidecars
#   release-artifacts/build-manifest.json   per-package release manifest
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/release-artifacts"

SKIP_CODE=0
SKIP_MCP=0
SKIP_PROTOCOL=0
SKIP_IDE=0
SKIP_VERIFY=0
UPLOAD_TAG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-code) SKIP_CODE=1 ;;
    --skip-mcp) SKIP_MCP=1 ;;
    --skip-protocol) SKIP_PROTOCOL=1 ;;
    --skip-ide) SKIP_IDE=1 ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    --upload) UPLOAD_TAG="${2:?--upload requires a release tag}"; shift ;;
    -h|--help)
      sed -n '2,25p' "$0"
      exit 0
      ;;
    *) echo "✗ Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

first_existing() {
  local candidate
  for candidate in "$@"; do
    [ -n "$candidate" ] && [ -d "$candidate" ] && { printf '%s' "$candidate"; return 0; }
  done
  return 1
}

CODE_DIR="${CAPIX_CODE_DIR:-$ROOT}"
MCP_DIR="$(first_existing "${CAPIX_MCP_DIR:-}" "$ROOT/../mcp" "$ROOT/../CapIX-MCP" || true)"
PROTOCOL_DIR="$(first_existing "${CAPIX_PROTOCOL_DIR:-}" "$ROOT/../protocol" "$ROOT/../Capix-Protocol" || true)"
IDE_DIR="$(first_existing "${CAPIX_IDE_DIR:-}" "$ROOT/../ide" "$ROOT/../CapIX-IDE" || true)"

mkdir -p "$OUT"
PACKAGES_FILE="$(mktemp)"
trap 'rm -f "$PACKAGES_FILE"' EXIT

record_package() {
  # name|version|directory
  printf '%s|%s|%s\n' "$1" "$2" "$3" >> "$PACKAGES_FILE"
}

pkg_version() {
  node -p 'require(process.argv[1]).version' "$1/package.json"
}

git_commit() {
  git -C "$1" rev-parse HEAD 2>/dev/null || echo unknown
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
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

# ── Capix Code CLI ───────────────────────────────────────────────────────────
build_code() {
  echo "▸ Building capix-code ($(pkg_version "$CODE_DIR")) for $(host_platform)-$(host_arch)…"
  bash "$CODE_DIR/scripts/build.sh"
  bash "$CODE_DIR/scripts/package-customer.sh" \
    "$(pkg_version "$CODE_DIR")" "$(host_platform)" "$(host_arch)"
  record_package capix-code "$(pkg_version "$CODE_DIR")" "$CODE_DIR"
  echo "✓ capix-code packaged"
}

# ── Capix MCP server ─────────────────────────────────────────────────────────
build_mcp() {
  echo "▸ Building capix-mcp ($(pkg_version "$MCP_DIR"))…"
  (cd "$MCP_DIR" && npm ci && npm run build && npm test)
  (cd "$MCP_DIR" && npm pack --pack-destination "$OUT")
  record_package capix-mcp "$(pkg_version "$MCP_DIR")" "$MCP_DIR"
  echo "✓ capix-mcp packaged"
}

# ── Capix Protocol web ───────────────────────────────────────────────────────
build_protocol() {
  echo "▸ Building capix-protocol ($(pkg_version "$PROTOCOL_DIR"))…"
  (cd "$PROTOCOL_DIR" && npm ci && npm run typecheck && npm run build)
  local version name
  version="$(pkg_version "$PROTOCOL_DIR")"
  [ -d "$PROTOCOL_DIR/.next" ] || { echo "✗ Protocol build produced no .next output"; exit 1; }
  local version name
  local -a paths
  version="$(pkg_version "$PROTOCOL_DIR")"
  name="capix-protocol-$version.tar.gz"
  # Package the production build output with the files needed to serve it.
  paths=(.next package.json next.config.ts)
  [ -d "$PROTOCOL_DIR/public" ] && paths+=(public)
  (cd "$PROTOCOL_DIR" && tar -czf "$OUT/$name" "${paths[@]}")
  record_package capix-protocol "$version" "$PROTOCOL_DIR"
  echo "✓ capix-protocol packaged"
}

# ── Capix IDE ────────────────────────────────────────────────────────────────
build_ide() {
  echo "▸ Building capix-ide…"
  bash "$IDE_DIR/scripts/build.sh"
  if [ -f "$IDE_DIR/scripts/package.sh" ]; then
    bash "$IDE_DIR/scripts/package.sh"
  fi
  local found=0 artifact
  for artifact in "$IDE_DIR"/dist/*.dmg "$IDE_DIR"/dist/*.zip "$IDE_DIR"/dist/*.tar.gz; do
    [ -f "$artifact" ] || continue
    cp "$artifact" "$OUT/"
    found=1
  done
  [ "$found" -eq 1 ] || { echo "✗ No IDE distributables found in $IDE_DIR/dist"; exit 1; }
  local version="0.0.0"
  [ -f "$IDE_DIR/vscode/package.json" ] && version="$(pkg_version "$IDE_DIR/vscode")"
  record_package capix-ide "$version" "$IDE_DIR"
  echo "✓ capix-ide packaged"
}

echo "=== Capix unified build ==="
echo "  output: $OUT"

if [ "$SKIP_CODE" -eq 0 ]; then
  build_code
else
  echo "  (skipped capix-code)"
fi

if [ "$SKIP_MCP" -eq 0 ]; then
  [ -n "$MCP_DIR" ] || { echo "✗ MCP checkout not found (set CAPIX_MCP_DIR or use --skip-mcp)"; exit 1; }
  build_mcp
else
  echo "  (skipped capix-mcp)"
fi

if [ "$SKIP_PROTOCOL" -eq 0 ]; then
  [ -n "$PROTOCOL_DIR" ] || { echo "✗ Protocol checkout not found (set CAPIX_PROTOCOL_DIR or use --skip-protocol)"; exit 1; }
  build_protocol
else
  echo "  (skipped capix-protocol)"
fi

if [ "$SKIP_IDE" -eq 0 ]; then
  [ -n "$IDE_DIR" ] || { echo "✗ IDE checkout not found (set CAPIX_IDE_DIR or use --skip-ide)"; exit 1; }
  build_ide
else
  echo "  (skipped capix-ide)"
fi

# ── Checksums ────────────────────────────────────────────────────────────────
echo "▸ Generating SHA-256 checksums…"
CHECKSUM_FOUND=0
for artifact in "$OUT"/*.tar.gz "$OUT"/*.tgz "$OUT"/*.zip "$OUT"/*.dmg; do
  [ -f "$artifact" ] || continue
  CHECKSUM_FOUND=1
  digest="$(sha256_file "$artifact")"
  printf '%s  %s\n' "$digest" "$(basename "$artifact")" > "$artifact.sha256"
  printf '  %-55s %s\n' "$(basename "$artifact")" "$digest"
done
[ "$CHECKSUM_FOUND" -eq 1 ] || { echo "✗ No artifacts were produced in $OUT"; exit 1; }

# ── Release manifest ─────────────────────────────────────────────────────────
echo "▸ Writing release manifest…"
PACKAGES_FILE="$PACKAGES_FILE" OUT_DIR="$OUT" node <<'MANIFEST'
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const outDir = process.env.OUT_DIR;
const packages = fs
  .readFileSync(process.env.PACKAGES_FILE, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [name, version, dir] = line.split("|");
    let sourceCommit = "unknown";
    try {
      sourceCommit = execSync(`git -C "${dir}" rev-parse HEAD`, { encoding: "utf8" }).trim();
    } catch {}
    return { name, version, sourceCommit, artifacts: [] };
  });

for (const entry of fs.readdirSync(outDir)) {
  const file = path.join(outDir, entry);
  if (!fs.statSync(file).isFile() || entry.endsWith(".sha256") || entry === "build-manifest.json") continue;
  const sidecar = `${file}.sha256`;
  if (!fs.existsSync(sidecar)) continue;
  const sha256 = fs.readFileSync(sidecar, "utf8").trim().split(/\s+/)[0];
  const artifact = { file: entry, sha256, bytes: fs.statSync(file).size };
  const owner =
    packages.find((p) => entry.startsWith(p.name)) ||
    packages.find((p) => p.name === "capix-code");
  if (owner) owner.artifacts.push(artifact);
}

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  builder: "scripts/build-all.sh",
  packages,
};
fs.writeFileSync(path.join(outDir, "build-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`  ${path.join(outDir, "build-manifest.json")}`);
MANIFEST

# ── Verification ─────────────────────────────────────────────────────────────
if [ "$SKIP_VERIFY" -eq 0 ]; then
  bash "$ROOT/scripts/verify-build.sh" "$OUT"
fi

# ── Upload ───────────────────────────────────────────────────────────────────
if [ -n "$UPLOAD_TAG" ]; then
  command -v gh >/dev/null 2>&1 || { echo "✗ gh CLI is required for --upload"; exit 1; }
  echo "▸ Uploading artifacts to GitHub release $UPLOAD_TAG…"
  if gh release view "$UPLOAD_TAG" >/dev/null 2>&1; then
    gh release upload "$UPLOAD_TAG" "$OUT"/* --clobber
  else
    gh release create "$UPLOAD_TAG" "$OUT"/* \
      --title "Capix $UPLOAD_TAG" \
      --notes "Built by scripts/build-all.sh. Verify .sha256 sidecars before use."
  fi
  echo "✓ Uploaded to release $UPLOAD_TAG"
fi

echo "=== Build complete: $OUT ==="
