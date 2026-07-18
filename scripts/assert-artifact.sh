#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:?artifact directory required}"
SUFFIX=""
test -f "$ROOT/bin/capix-code.exe" && SUFFIX=".exe"
required=(
  "bin/capix-code$SUFFIX"
  "engine/capix-engine$SUFFIX"
  runtime/src/plugin.ts
  runtime/src/native-bridge.ts
  runtime/src/broker.ts
  runtime/src/credential-constants.ts
  runtime/src/sandbox.ts
  runtime/src/capix-provider.ts
  runtime/src/ai-sdk-provider.ts
  runtime/packages/runtime-provider/package.json
  runtime/node_modules/@capix/runtime-provider/package.json
  config/capix-defaults.json
  config/defaults.json
  mcp/capix-mcp.js
)
for path in "${required[@]}"; do
  test -e "$ROOT/$path" || { echo "✗ artifact missing $path"; exit 1; }
done
test -x "$ROOT/engine/capix-engine$SUFFIX" || { echo "✗ bundled engine is not executable"; exit 1; }
test -x "$ROOT/bin/capix-code$SUFFIX" || { echo "✗ native launcher is not executable"; exit 1; }
grep -q '"name": "@capix/runtime-provider"' "$ROOT/runtime/packages/runtime-provider/package.json"
grep -q '"model": "{env:CAPIX_MODEL:capix/auto}"' "$ROOT/config/defaults.json"
grep -q '"lsp": true' "$ROOT/config/defaults.json"
grep -q '"__INSTALL_ROOT__/mcp/capix-mcp.js"' "$ROOT/config/defaults.json"
if grep -q '"~/.capix-code/mcp' "$ROOT/config/defaults.json"; then
  echo "✗ MCP configuration is pinned to a home-directory layout"; exit 1;
fi
grep -q 'SuperGemma' "$ROOT/config/defaults.json"
grep -q '/oauth/authorize' "$ROOT/runtime/src/broker.ts"
grep -q '/oauth/token' "$ROOT/runtime/src/broker.ts"
expected_version="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' "$ROOT/runtime/package.json")"
launcher_version="$($ROOT/bin/capix-code$SUFFIX --version | awk '{print $NF}')"
engine_version="$($ROOT/engine/capix-engine$SUFFIX --version | awk '{print $NF}')"
mcp_expected_version="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' "$ROOT/mcp/package.json")"
mcp_reported_version="$(CAPIX_API_KEY=cpxk_artifact_version_check node "$ROOT/mcp/capix-mcp.js" --version | awk '{sub(/^v/, "", $NF); print $NF}')"
test "$launcher_version" = "$expected_version" || {
  echo "✗ launcher version $launcher_version does not match runtime $expected_version"; exit 1;
}
test "$engine_version" = "$expected_version" || {
  echo "✗ engine version $engine_version does not match runtime $expected_version"; exit 1;
}
test "$mcp_reported_version" = "$mcp_expected_version" || {
  echo "✗ MCP version $mcp_reported_version does not match package $mcp_expected_version"; exit 1;
}
echo "✓ artifact contains pinned engine, plugin, broker, sandbox and runtime provider"
