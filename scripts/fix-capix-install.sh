#!/usr/bin/env bash
# fix-capix-install.sh — Fix the capix-code npm install EISDIR error
# The issue: the GitHub release tarball contains a symlink that conflicts with directory copy.
# This script fixes the postinstall script and re-runs the install.

set -euo pipefail

ROOT="${HOME}/.capix-code"
NPM_ROOT=$(npm root -g 2>/dev/null || echo "/usr/local/lib/node_modules")
POSTINSTALL="${NPM_ROOT}/capix-code/scripts/postinstall.cjs"

echo "Fixing Capix Code installation..."

# Fix 1: Remove conflicting symlink from existing installation
if [ -L "${ROOT}/runtime/node_modules/@capix/runtime-provider" ]; then
  echo "Removing conflicting symlink from existing installation..."
  rm -f "${ROOT}/runtime/node_modules/@capix/runtime-provider"
fi

# Fix 2: Patch the postinstall script to remove the symlink before copying
if [ -f "${POSTINSTALL}" ]; then
  echo "Patching postinstall script..."
  # Create a backup
  cp "${POSTINSTALL}" "${POSTINSTALL}.bak"
  # Apply the fix: remove the symlink before the copy loop
  sed -i.tmp 's|const backup = ROOT + '"'"'.bak'"'"';|const badLink = path.join(src, '"'"'runtime'"'"', '"'"'node_modules'"'"', '"'"'@capix'"'"', '"'"'runtime-provider'"'"');\nif (fs.existsSync(badLink) \&\& fs.lstatSync(badLink).isSymbolicLink()) {\n  fs.rmSync(badLink, { force: true });\n}\nconst backup = ROOT + '"'"'.bak'"'"';|' "${POSTINSTALL}"
  rm -f "${POSTINSTALL}.tmp"
  echo "Postinstall script patched."
else
  echo "Warning: postinstall script not found at ${POSTINSTALL}"
fi

# Fix 3: Re-run the install
echo "Reinstalling capix-code..."
npm install -g capix-code@2.2.5

# Fix 4: Verify
echo "Verifying installation..."
capix-code --version
capix-code doctor

echo ""
echo "If you still see errors, the GitHub release tarball needs to be updated."
echo "Contact the Capix team to update the release artifact."
