#!/bin/bash
set -euo pipefail

# Download checksums and verify
CHECKSUMS_URL="https://github.com/CapIX-Protocol/Capix-Code/releases/latest/download/checksums.txt"
SIG_URL="https://github.com/CapIX-Protocol/Capix-Code/releases/latest/download/checksums.txt.asc"

# Download
curl -fsSL "$CHECKSUMS_URL" -o checksums.txt
curl -fsSL "$SIG_URL" -o checksums.txt.asc

# Verify GPG signature (if gpg available)
if command -v gpg &>/dev/null; then
  gpg --verify checksums.txt.asc checksums.txt || { echo "ERROR: GPG signature verification failed"; exit 1; }
fi

# Determine platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in x86_64) ARCH="x64" ;; arm64|aarch64) ARCH="arm64" ;; esac
ARTIFACT="capix-code-${OS}-${ARCH}"

# Download binary
BINARY_URL="https://github.com/CapIX-Protocol/Capix-Code/releases/latest/download/${ARTIFACT}"
curl -fsSL "$BINARY_URL" -o "$ARTIFACT"

# Verify checksum
sha256sum -c checksums.txt --ignore-missing || { echo "ERROR: Checksum verification failed"; exit 1; }

# Install
chmod +x "$ARTIFACT"
sudo mv "$ARTIFACT" /usr/local/bin/capix-code

echo "✓ capix-code installed successfully"
