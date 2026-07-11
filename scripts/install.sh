#!/bin/bash
set -euo pipefail

VERSION="${CAPIX_CODE_VERSION:-${1:-}}"
RELEASE_BASE_URL="${CAPIX_RELEASE_BASE_URL:-https://github.com/CapIX-Protocol/Capix-Code/releases/download}"
INSTALL_DIR="${CAPIX_INSTALL_DIR:-${CAPIX_CODE_INSTALL_DIR:-/usr/local/bin}}"

if [ -z "$VERSION" ] || [ "$VERSION" = "latest" ]; then
  echo "ERROR: pass an immutable release version, for example: $0 v1.2.3" >&2
  exit 2
fi

if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "ERROR: invalid version '$VERSION' (expected vMAJOR.MINOR.PATCH)" >&2
  exit 2
fi

OS="${CAPIX_INSTALL_OS:-$(uname -s | tr '[:upper:]' '[:lower:]')}"
ARCH="${CAPIX_INSTALL_ARCH:-$(uname -m)}"
case "$OS" in
  darwin|linux) ;;
  mingw*|msys*|cygwin*|win32*|windows*)
    echo "ERROR: Windows is not supported by this shell installer." >&2
    echo "Download the Windows binary from:" >&2
    echo "  https://github.com/CapIX-Protocol/Capix-Code/releases" >&2
    echo "Or use PowerShell:" >&2
    echo "  iwr -UseBasicParsing https://github.com/CapIX-Protocol/Capix-Code/releases/download/${VERSION}/capix-code-windows-x64.exe -OutFile capix-code.exe" >&2
    exit 2
    ;;
  *)
    echo "ERROR: unsupported operating system '$OS'" >&2
    echo "Download a binary from: https://github.com/CapIX-Protocol/Capix-Code/releases" >&2
    exit 2
    ;;
esac
case "$ARCH" in
  x86_64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "ERROR: unsupported architecture '$ARCH'" >&2; exit 2 ;;
esac

ARTIFACT="capix-code-${OS}-${ARCH}"
BASE_URL="${RELEASE_BASE_URL}/${VERSION}"
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/capix-code-install.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT INT TERM

if [[ "$BASE_URL" == https://* ]]; then
  curl --proto '=https' --tlsv1.2 -fsSL "${BASE_URL}/checksums.txt" -o "${WORK_DIR}/checksums.txt"
  curl --proto '=https' --tlsv1.2 -fsSL "${BASE_URL}/${ARTIFACT}" -o "${WORK_DIR}/${ARTIFACT}"
else
  curl -fsSL "${BASE_URL}/checksums.txt" -o "${WORK_DIR}/checksums.txt"
  curl -fsSL "${BASE_URL}/${ARTIFACT}" -o "${WORK_DIR}/${ARTIFACT}"
fi

EXPECTED=$(awk -v name="$ARTIFACT" '$2 == name || $2 == "*" name { print $1 }' "${WORK_DIR}/checksums.txt")
MATCH_COUNT=$(awk -v name="$ARTIFACT" '$2 == name || $2 == "*" name { count++ } END { print count + 0 }' "${WORK_DIR}/checksums.txt")
if [ -z "$EXPECTED" ] || [ "$MATCH_COUNT" -ne 1 ] || [[ ! "$EXPECTED" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "ERROR: checksum manifest must contain exactly one SHA-256 entry for ${ARTIFACT}" >&2
  exit 1
fi

if command -v shasum >/dev/null 2>&1; then
  ACTUAL=$(shasum -a 256 "${WORK_DIR}/${ARTIFACT}" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "${WORK_DIR}/${ARTIFACT}" | awk '{print $1}')
else
  echo "ERROR: neither shasum nor sha256sum is available" >&2
  exit 1
fi

if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "ERROR: checksum verification failed for ${ARTIFACT}" >&2
  exit 1
fi

chmod 0755 "${WORK_DIR}/${ARTIFACT}"
mkdir -p "$INSTALL_DIR"
TARGET="${INSTALL_DIR}/capix-code"
STAGED="${INSTALL_DIR}/.capix-code.${VERSION}.new"

if [ ! -w "$INSTALL_DIR" ]; then
  echo "ERROR: ${INSTALL_DIR} is not writable. Re-run with a user-owned CAPIX_CODE_INSTALL_DIR; this installer does not invoke sudo." >&2
  exit 1
fi

cp "${WORK_DIR}/${ARTIFACT}" "$STAGED"
mv "$STAGED" "$TARGET"

echo "Installed verified Capix Code ${VERSION} at ${TARGET}"
echo "This artifact is unsigned. Verification used the release's exact SHA-256 manifest entry."
