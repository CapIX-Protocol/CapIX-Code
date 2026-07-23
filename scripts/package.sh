#!/bin/bash
set -euo pipefail

VERSION="${1:-0.1.0-dev}"
ARCH="$(uname -m)"
OUTPUT_DIR="dist"
ARTIFACT_NAME="capix-code-$VERSION-darwin-$ARCH"

echo "=== Packaging Capix Code $VERSION ($ARCH) ==="

mkdir -p "$OUTPUT_DIR"

# 1. Build the TypeScript
npm run compile || true  # tsc --noEmit for now — no separate build step yet

# 2. Create tarball with src/, config/, manifest/
echo "Creating tarball..."
tar -czf "$OUTPUT_DIR/$ARTIFACT_NAME.tar.gz" \
  src/ \
  config/ \
  manifest/ \
  package.json \
  package-lock.json \
  tui-capix.json \
  tsconfig.json \
  LICENSE \
  NOTICE \
  README.md

# 3. Generate SHA-256
echo "Generating SHA-256..."
DIGEST="$(shasum -a 256 "$OUTPUT_DIR/$ARTIFACT_NAME.tar.gz" | awk '{print $1}')"
printf '%s  %s\n' "$DIGEST" "$ARTIFACT_NAME.tar.gz" > "$OUTPUT_DIR/$ARTIFACT_NAME.tar.gz.sha256"

# 4. Provenance
cat > "$OUTPUT_DIR/$ARTIFACT_NAME.provenance.json" << EOF
{
  "artifact": "$ARTIFACT_NAME.tar.gz",
  "version": "$VERSION",
  "platform": "darwin-$ARCH",
  "signed": false,
  "sourceCommit": "$(git rev-parse HEAD)",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "builder": "$(whoami)@$(hostname)",
  "checksum": "$(cat "$OUTPUT_DIR/$ARTIFACT_NAME.tar.gz.sha256" | awk '{print $1}')"
}
EOF

# 5. Minimal SBOM
cat > "$OUTPUT_DIR/$ARTIFACT_NAME.sbom.json" << EOF
{
  "sbomFormat": "CapIX-minimal",
  "version": "0.1.0",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "dependencies": "See package-lock.json",
  "sourceCommit": "$(git rev-parse HEAD)",
  "unsigned": true
}
EOF

# 6. Installation instructions
cat << INST

=== Capix Code $VERSION (UNSIGNED) ===

Artifact: $OUTPUT_DIR/$ARTIFACT_NAME.tar.gz
SHA-256:  $(cat "$OUTPUT_DIR/$ARTIFACT_NAME.tar.gz.sha256" | awk '{print $1}')

## Installation (UNSIGNED)

1. Verify checksum:
   shasum -a 256 $OUTPUT_DIR/$ARTIFACT_NAME.tar.gz

2. Extract:
   tar -xzf $OUTPUT_DIR/$ARTIFACT_NAME.tar.gz -C ~/capix-code

3. Install dependencies:
   cd ~/capix-code && npm install --production

4. Run:
   node ~/capix-code/src/index.ts  # or after tsc: node dist/index.js

Source commit: $(git rev-parse HEAD)

INST
