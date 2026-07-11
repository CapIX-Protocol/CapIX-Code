#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:?artifact directory required}"
SUFFIX=""
test -f "$ROOT/bin/capix-code.exe" && SUFFIX=".exe"
required=(
  "bin/capix-code$SUFFIX"
  "engine/capix-engine$SUFFIX"
  runtime/src/plugin.ts
  runtime/src/broker.ts
  runtime/src/sandbox.ts
  runtime/src/capix-provider.ts
  runtime/src/ai-sdk-provider.ts
  runtime/packages/runtime-provider/package.json
  runtime/node_modules/@capix/runtime-provider/package.json
  config/capix-defaults.json
  config/defaults.json
)
for path in "${required[@]}"; do
  test -e "$ROOT/$path" || { echo "✗ artifact missing $path"; exit 1; }
done
test -x "$ROOT/engine/capix-engine$SUFFIX" || { echo "✗ bundled engine is not executable"; exit 1; }
test -x "$ROOT/bin/capix-code$SUFFIX" || { echo "✗ native launcher is not executable"; exit 1; }
grep -q '"name": "@capix/runtime-provider"' "$ROOT/runtime/packages/runtime-provider/package.json"
echo "✓ artifact contains pinned engine, plugin, broker, sandbox and runtime provider"
