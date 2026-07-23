#!/usr/bin/env bash
set -euo pipefail
VERSION="${1:?version required}"
PLATFORM="${2:?platform required}"
ARCH="${3:?architecture required}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CUSTOMER="$ROOT/dist/customer"
OUT="$ROOT/release-artifacts"
FLAVOR="${CAPIX_ARTIFACT_FLAVOR:-unsigned}"
NAME="capix-code-$VERSION-$PLATFORM-$ARCH-$FLAVOR"

"$ROOT/scripts/assert-artifact.sh" "$CUSTOMER"
"$ROOT/scripts/assert-customer-brand.sh" "$CUSTOMER"
mkdir -p "$OUT"
if [ "$PLATFORM" = win32 ]; then
  ARCHIVE="$OUT/$NAME.zip"
  (cd "$ROOT/dist" && 7z a -tzip "$ARCHIVE" customer)
else
  ARCHIVE="$OUT/$NAME.tar.gz"
  tar -C "$ROOT/dist" -czf "$ARCHIVE" customer
fi
if command -v sha256sum >/dev/null 2>&1; then
  DIGEST="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
else
  DIGEST="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
fi
printf '%s  %s\n' "$DIGEST" "$(basename "$ARCHIVE")" > "$ARCHIVE.sha256"
printf '%s\n' "$(git -C "$ROOT" rev-parse HEAD)" > "$OUT/$NAME.source-commit.txt"
node "$ROOT/scripts/write-release-entry.mjs" "$VERSION" "$PLATFORM" "$ARCH" "$ARCHIVE"
echo "Verified release artifact: $ARCHIVE"
