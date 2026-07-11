#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:?artifact directory required}"
required=(
  bin/capix-code
  engine/capix-engine
  runtime/src/plugin.ts
  runtime/src/broker.ts
  runtime/src/sandbox.ts
  runtime/src/capix-provider.ts
  runtime/src/ai-sdk-provider.ts
  runtime/packages/runtime-provider/package.json
  runtime/node_modules/@capix/runtime-provider/package.json
  config/capix-defaults.json
)
for path in "${required[@]}"; do
  test -e "$ROOT/$path" || { echo "✗ artifact missing $path"; exit 1; }
done
test -x "$ROOT/engine/capix-engine" || { echo "✗ bundled engine is not executable"; exit 1; }
test -x "$ROOT/bin/capix-code" || { echo "✗ native launcher is not executable"; exit 1; }
grep -q '"name": "@capix/runtime-provider"' "$ROOT/runtime/packages/runtime-provider/package.json"
echo "✓ artifact contains pinned engine, plugin, broker, sandbox and runtime provider"
