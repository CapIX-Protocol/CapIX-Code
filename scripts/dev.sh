#!/usr/bin/env bash
#
# dev.sh — launch capix-code in dev mode.
#
# Requires Bun 1.3+ (https://bun.sh).
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
CAPIX_CODE_DIR="${CAPIX_CODE_DIR:-$DIR/upstream}"

if [ ! -d "$CAPIX_CODE_DIR" ]; then
  echo "✗ No $CAPIX_CODE_DIR. Run ./scripts/bootstrap.sh first."
  exit 1
fi

cd "$CAPIX_CODE_DIR"

echo "▸ Installing dependencies (Bun)…"
bun install

echo "▸ Writing default Capix config (if missing)…"
bun run packages/capix-code/scripts/init-capix-config.ts 2>/dev/null || true

echo "▸ Launching capix-code (dev mode)…"
echo ""
echo "  Set your Capix env vars before starting:"
echo "    export CAPIX_BASE_URL=https://capix.network/api/v1"
echo "    export CAPIX_API_KEY=cpk_...   (or your deployed cpxllm_... key)"
echo "    export CAPIX_MODEL=capix/auto   (optional — defaults to auto)"
echo ""
bun run --cwd packages/capix-code --conditions=browser src/index.ts "$@"
