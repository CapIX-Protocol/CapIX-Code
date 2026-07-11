#!/bin/bash
# Local development installation of Capix Code
# This is NOT a production installer — for development only
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Capix Code Development Install ==="
echo "Path: $SOURCE_DIR"
echo ""

# Install dependencies
cd "$SOURCE_DIR"
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

# Type check
echo "Running type check..."
npx tsc --noEmit

# Run tests
echo "Running tests..."
npx vitest run

echo ""
echo "✅ Development environment ready."
echo "Run: npx tsx src/plugin.ts  # to start the Capix Code agent"
