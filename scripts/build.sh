#!/usr/bin/env bash
# build.sh — produce packaged capix-code binaries.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
CAPIX_CODE_DIR="${CAPIX_CODE_DIR:-$DIR/upstream}"
BUN="${BUN_BIN:-$(command -v bun || true)}"
if [ -z "$BUN" ] && [ -x "$DIR/node_modules/.bin/bun" ]; then BUN="$DIR/node_modules/.bin/bun"; fi
[ -n "$BUN" ] || { echo "✗ Bun 1.3.14 is required"; exit 1; }
[ "$($BUN --version)" = "1.3.14" ] || { echo "✗ Expected Bun 1.3.14"; exit 1; }

if [ ! -d "$CAPIX_CODE_DIR" ]; then
  echo "✗ No $CAPIX_CODE_DIR. Run ./scripts/bootstrap.sh first."
  exit 1
fi

cd "$CAPIX_CODE_DIR"

echo "▸ Building capix-code standalone binary…"
"$BUN" install

# The embedded engine otherwise falls back to a timestamped 0.0.0 development
# identifier. Stamp it with the immutable Capix Code package version so the TUI,
# API metadata and diagnostics all report the customer release.
CAPIX_RELEASE_VERSION="${CAPIX_CODE_VERSION:-$(node -p 'require(process.argv[1]).version' "$DIR/package.json")}"
export CAPIX_CODE_VERSION="$CAPIX_RELEASE_VERSION"
export CAPIX_CODE_CHANNEL="latest"
export OPENCODE_VERSION="$CAPIX_RELEASE_VERSION"

# Write default config if the init script exists.
if [ -f "packages/capix-code/scripts/init-capix-config.ts" ]; then
  "$BUN" run packages/capix-code/scripts/init-capix-config.ts 2>/dev/null || true
fi

# Build using the upstream build script.
if [ -f "packages/capix-code/script/build.ts" ]; then
  "$BUN" run --cwd packages/capix-code script/build.ts --single
fi

# Find the output — handle both renamed and original patterns.
EXE_SUFFIX=""
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) EXE_SUFFIX=".exe";; esac
OUTPUT=$(find packages/capix-code/dist -name "capix-code$EXE_SUFFIX" -type f 2>/dev/null | head -1)
if [ -z "$OUTPUT" ]; then
  OUTPUT=$(find packages/capix-code/dist -name "opencode$EXE_SUFFIX" -type f 2>/dev/null | head -1)
  if [ -n "$OUTPUT" ]; then
    NEW_OUTPUT="$(dirname "$OUTPUT")/capix-code$EXE_SUFFIX"
    mv "$OUTPUT" "$NEW_OUTPUT"
    OUTPUT="$NEW_OUTPUT"
  fi
fi

if [ -n "$OUTPUT" ]; then
  ARTIFACT="$DIR/dist/customer"
  rm -rf "$ARTIFACT"
  mkdir -p "$ARTIFACT/bin" "$ARTIFACT/engine" "$ARTIFACT/runtime/packages" "$ARTIFACT/config" "$ARTIFACT/mcp"
  cp "$OUTPUT" "$ARTIFACT/engine/capix-engine$EXE_SUFFIX"
  cp -R "$DIR/src" "$ARTIFACT/runtime/src"
  # Create tsconfig.json so path aliases (@/*) resolve when the engine imports providers
  cat > "$ARTIFACT/runtime/tsconfig.json" << 'TCSONFIG'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
TCSONFIG
  cp -R "$DIR/packages/runtime-provider" "$ARTIFACT/runtime/packages/runtime-provider"
  cp "$DIR/config/runtime-package.json" "$ARTIFACT/runtime/package.json"
  cp "$DIR/config/capix-defaults.json" "$DIR/config/defaults.json" "$ARTIFACT/config/"
  cp -R "$DIR/commands" "$ARTIFACT/commands"
  # Build and bundle the MCP server from the capix-mcp npm package
  mkdir -p "$ARTIFACT/mcp" "$ARTIFACT/mcp/node_modules"
  npm install capix-mcp@2.1.0 --prefix "$DIR/dist/mcp-tmp" 2>/dev/null
  cp -R "$DIR/dist/mcp-tmp/node_modules/capix-mcp/dist/"* "$ARTIFACT/mcp/" 2>/dev/null
  cp "$DIR/dist/mcp-tmp/node_modules/capix-mcp/package.json" "$ARTIFACT/mcp/" 2>/dev/null
  # Copy ALL dependencies needed by capix-mcp
  for dep in @modelcontextprotocol zod; do
    if [ -d "$DIR/dist/mcp-tmp/node_modules/$dep" ]; then
      cp -R "$DIR/dist/mcp-tmp/node_modules/$dep" "$ARTIFACT/mcp/node_modules/" 2>/dev/null
    fi
  done
  if [ -d "$DIR/dist/mcp-tmp/node_modules/capix-mcp/node_modules" ]; then
    cp -R "$DIR/dist/mcp-tmp/node_modules/capix-mcp/node_modules/"* "$ARTIFACT/mcp/node_modules/" 2>/dev/null
  fi
  # Copy capix-mcp's dependencies (SDK, zod, etc.)
  mkdir -p "$ARTIFACT/mcp/node_modules"
  if [ -d "$DIR/dist/mcp-tmp/node_modules/capix-mcp/node_modules" ]; then
    cp -R "$DIR/dist/mcp-tmp/node_modules/capix-mcp/node_modules/"* "$ARTIFACT/mcp/node_modules/" 2>/dev/null
  fi
  for dep in @modelcontextprotocol zod; do
    if [ -d "$DIR/dist/mcp-tmp/node_modules/$dep" ]; then
      cp -R "$DIR/dist/mcp-tmp/node_modules/$dep" "$ARTIFACT/mcp/node_modules/" 2>/dev/null
    fi
  done
  # Create entry point wrapper that shares credentials with capix-code
  cat > "$ARTIFACT/mcp/capix-mcp.js" << 'MCPWRAPPER'
#!/usr/bin/env node
const { readFileSync, writeFileSync, chmodSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");
const credPath = join(homedir(), ".capix-code", "credentials.json");
async function loadMcp() {
  require(join(__dirname, "index.js"));
}
(async () => {
  try {
    if (existsSync(credPath)) {
      const creds = JSON.parse(readFileSync(credPath, "utf8"));
      const rt = creds["capix-code:oauth-refresh-token"];
      if (rt) {
        const res = await fetch("https://www.capix.network/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: "capix-code" }).toString(),
        });
        const body = await res.json();
        if (body.access_token) {
          process.env.CAPIX_API_KEY = body.access_token;
          creds["capix-code:oauth-refresh-token"] = body.refresh_token;
          writeFileSync(credPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
          chmodSync(credPath, 0o600);
        }
      }
    }
  } catch {}
  loadMcp();
})();
MCPWRAPPER
  chmod 0755 "$ARTIFACT/mcp/capix-mcp.js"
  rm -rf "$DIR/dist/mcp-tmp"
  chmod 0755 "$ARTIFACT/engine/capix-engine$EXE_SUFFIX"
  # Install from the dedicated runtime manifest. The outer npm package has
  # platform selectors which do not belong inside the embedded runtime.
  (cd "$ARTIFACT/runtime" && npm install --omit=dev --ignore-scripts)
  (cd "$DIR/launcher" && cargo build --locked --release)
  cp "$DIR/launcher/target/release/capix-code$EXE_SUFFIX" "$ARTIFACT/bin/capix-code$EXE_SUFFIX"
  chmod 0755 "$ARTIFACT/bin/capix-code$EXE_SUFFIX"

  "$DIR/scripts/assert-artifact.sh" "$ARTIFACT"
  "$DIR/scripts/assert-customer-brand.sh" "$ARTIFACT"
  echo "✓ Customer artifact staged: $ARTIFACT"
else
  echo "✗ No binary found in dist/ — build may have failed."
  exit 1
fi
