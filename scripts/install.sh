#!/bin/bash
set -euo pipefail

VERSION="${CAPIX_CODE_VERSION:-${1:-}}"
RELEASE_BASE_URL="${CAPIX_RELEASE_BASE_URL:-https://github.com/CapIX-Protocol/Capix-Code/releases/download}"
INSTALL_DIR="${CAPIX_INSTALL_DIR:-${CAPIX_CODE_INSTALL_DIR:-${HOME}/.local/bin}}"
RUNTIME_DIR="${CAPIX_CODE_RUNTIME_DIR:-${HOME}/.local/share/capix-code}"

# "latest" is permitted only by resolving it to an immutable version BEFORE any
# download — never by trusting mutable content. The release pipeline pins the
# current stable version in CAPIX_STABLE_VERSION (the single source of truth
# that also populates manifest/release-manifest.json#stableVersion). Without a
# pin, "latest" fails closed so the installer never proceeds unbounded.
if [ -z "$VERSION" ] || [ "$VERSION" = "latest" ]; then
  if [ -n "${CAPIX_STABLE_VERSION:-}" ]; then
    VERSION="$CAPIX_STABLE_VERSION"
    echo "Resolved latest -> ${VERSION} (CAPIX_STABLE_VERSION)" >&2
  else
    echo "ERROR: 'latest' requires CAPIX_STABLE_VERSION to be set to an immutable release (e.g. v1.2.3)." >&2
    echo "The release pipeline pins the current stable version there; do not pin to mutable content." >&2
    exit 2
  fi
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

RELEASE_VERSION="${VERSION#v}"
ARTIFACT="capix-code-${RELEASE_VERSION}-${OS}-${ARCH}-unsigned.tar.gz"
BASE_URL="${RELEASE_BASE_URL}/${VERSION}"
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/capix-code-install.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT INT TERM

if [[ "$BASE_URL" == https://* ]]; then
  curl --proto '=https' --tlsv1.2 -fsSL "${BASE_URL}/${ARTIFACT}.sha256" -o "${WORK_DIR}/${ARTIFACT}.sha256"
  curl --proto '=https' --tlsv1.2 -fsSL "${BASE_URL}/${ARTIFACT}" -o "${WORK_DIR}/${ARTIFACT}"
else
  curl -fsSL "${BASE_URL}/${ARTIFACT}.sha256" -o "${WORK_DIR}/${ARTIFACT}.sha256"
  curl -fsSL "${BASE_URL}/${ARTIFACT}" -o "${WORK_DIR}/${ARTIFACT}"
fi

CHECKSUM_LINES=$(awk 'NF { count++ } END { print count + 0 }' "${WORK_DIR}/${ARTIFACT}.sha256")
EXPECTED=$(awk 'NF { print $1 }' "${WORK_DIR}/${ARTIFACT}.sha256")
RECORDED_ARTIFACT=$(awk 'NF { print $2 }' "${WORK_DIR}/${ARTIFACT}.sha256")
RECORDED_ARTIFACT="${RECORDED_ARTIFACT#\*}"
RECORDED_ARTIFACT="${RECORDED_ARTIFACT##*/}"
if [ "$CHECKSUM_LINES" -ne 1 ] || [ "$RECORDED_ARTIFACT" != "$ARTIFACT" ] || [[ ! "$EXPECTED" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "ERROR: adjacent checksum must contain exactly one valid SHA-256 entry for ${ARTIFACT}" >&2
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

mkdir -p "$INSTALL_DIR" "$(dirname "$RUNTIME_DIR")"

if [ ! -w "$INSTALL_DIR" ]; then
  echo "ERROR: ${INSTALL_DIR} is not writable. Re-run with a user-owned CAPIX_CODE_INSTALL_DIR; this installer does not invoke sudo." >&2
  exit 1
fi

tar -xzf "${WORK_DIR}/${ARTIFACT}" -C "$WORK_DIR"
test -x "${WORK_DIR}/customer/bin/capix-code" || {
  echo "ERROR: verified archive does not contain customer/bin/capix-code" >&2
  exit 1
}

STAGED_RUNTIME="${RUNTIME_DIR}.${VERSION}.new"
rm -rf "$STAGED_RUNTIME"
mkdir -p "$STAGED_RUNTIME"
cp -a "${WORK_DIR}/customer/." "$STAGED_RUNTIME/"
rm -rf "$RUNTIME_DIR"
mv "$STAGED_RUNTIME" "$RUNTIME_DIR"
ln -sfn "${RUNTIME_DIR}/bin/capix-code" "${INSTALL_DIR}/capix-code"
TARGET="${INSTALL_DIR}/capix-code"

echo "Installed verified Capix Code ${VERSION} at ${TARGET}"
echo "This artifact is unsigned. Verification used the release's exact SHA-256 manifest entry."

# Detect if the install directory is on the user's PATH. On macOS,
# ~/.local/bin is not on PATH by default — a customer who runs the
# curl installer sees "Installed" but then hits "command not found".
# Warn them with the exact one-line fix instead of leaving them stuck.
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo ""
    echo "⚠  ${INSTALL_DIR} is not on your PATH."
    echo "  Add it to your shell profile so 'capix-code' is findable:"
    echo ""
    echo "    echo 'export PATH=\"${INSTALL_DIR}:\$PATH\"' >> ~/.zshrc"
    echo "    source ~/.zshrc"
    echo ""
    echo "  Then run: capix-code --version"
    ;;
esac
