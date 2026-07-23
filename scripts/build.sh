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

# macOS enforces the Team ID of the host process when loading native Node
# add-ons. Package-manager caches can preserve a vendor signature that is
# incompatible with the Node binary running the build, which makes a clean
# customer build fail inside Rollup before an artifact exists. Ad-hoc signing
# the downloaded native add-ons is deterministic and local to the build tree.
node "$DIR/scripts/prepare-native-addons.mjs" node_modules

# The embedded engine otherwise falls back to a timestamped 0.0.0 development
# identifier. Stamp it with the immutable Capix Code package version so the TUI,
# API metadata and diagnostics all report the customer release.
CAPIX_RELEASE_VERSION="${CAPIX_CODE_VERSION:-$(node -p 'require(process.argv[1]).version' "$DIR/package.json")}"
export CAPIX_CODE_VERSION="$CAPIX_RELEASE_VERSION"
export CAPIX_CODE_CHANNEL="latest"
export OPENCODE_VERSION="$CAPIX_RELEASE_VERSION"
node "$DIR/scripts/check-release-consistency.mjs" "$CAPIX_RELEASE_VERSION"

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
  npm install capix-mcp@2.1.1 --prefix "$DIR/dist/mcp-tmp" 2>/dev/null
  cp -R "$DIR/dist/mcp-tmp/node_modules/capix-mcp/dist/"* "$ARTIFACT/mcp/" 2>/dev/null
  cp "$DIR/dist/mcp-tmp/node_modules/capix-mcp/package.json" "$ARTIFACT/mcp/" 2>/dev/null
  # capix-mcp 2.1.0 was published with stale 2.0.0 constants in its compiled
  # entry/server defaults. Stamp the bundled runtime from its immutable package
  # metadata so diagnostics and MCP initialize report the artifact actually in use.
  MCP_VERSION="$(node -p 'require(process.argv[1]).version' "$ARTIFACT/mcp/package.json")"
  MCP_VERSION="$MCP_VERSION" node -e '
    const fs = require("node:fs");
    for (const file of process.argv.slice(1)) {
      const source = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, source.replaceAll("2.0.0", process.env.MCP_VERSION));
    }
  ' "$ARTIFACT/mcp/index.js" "$ARTIFACT/mcp/server.js"
  # Preserve the complete npm dependency graph. Selectively copying only the
  # direct SDK and schema packages drops transitive ESM imports such as
  # zod-to-json-schema and makes the packaged MCP process exit at startup.
  cp -R "$DIR/dist/mcp-tmp/node_modules/." "$ARTIFACT/mcp/node_modules/"
  rm -rf "$ARTIFACT/mcp/node_modules/capix-mcp"
  # npm created .bin/capix-mcp as a symlink into the now-removed nested
  # package; repoint it at the wrapper so no dangling symlink ships (a
  # dangling link crashes postinstall's dereferencing copy). Windows npm
  # uses .cmd shims instead of POSIX symlinks — nothing to repoint there.
  if [ -z "$EXE_SUFFIX" ]; then
    mkdir -p "$ARTIFACT/mcp/node_modules/.bin"
    ln -sfn "../../capix-mcp.js" "$ARTIFACT/mcp/node_modules/.bin/capix-mcp"
  fi
  # Create an entry point wrapper. The launcher supplies a short-lived access
  # token in CAPIX_API_KEY; the MCP process must never read or persist refresh
  # material itself.
  cat > "$ARTIFACT/mcp/capix-mcp.js" << 'MCPWRAPPER'
#!/usr/bin/env node
import net from "node:net";
const brokerAddress = process.platform === "win32"
  ? "\\\\.\\pipe\\capix-code-broker"
  : "/tmp/capix-code-broker.sock";
function brokerToken() {
  return new Promise((resolve, reject) => {
    let payload = "";
    const socket = net.connect(brokerAddress, () => {
      socket.write(JSON.stringify({ method: "token.get" }));
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { payload += chunk; });
    socket.on("end", () => {
      try {
        const response = JSON.parse(payload);
        if (!response.ok || !response.result?.accessToken) throw new Error("broker rejected token request");
        resolve(response.result.accessToken);
      } catch (error) { reject(error); }
    });
    socket.on("error", reject);
    socket.setTimeout(5000, () => {
      socket.destroy(new Error("broker token request timed out"));
    });
  });
}
// Start while signed out so the MCP client remains registered. Auth is
// resolved lazily after a protected request returns 401; once browser login
// succeeds, the next tool call obtains a fresh short-lived broker token and
// retries without requiring Capix Code to restart.
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  let response = await nativeFetch(input, init);
  if (response.status !== 401) return response;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("https://www.capix.network/")) return response;
  try {
    const token = await brokerToken();
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    headers.set("Authorization", `Bearer ${token}`);
    process.env.CAPIX_API_KEY = token;
    response = await nativeFetch(input, { ...init, headers });
  } catch (error) {
    console.error(`Capix MCP could not refresh its session: ${error.message}`);
  }
  return response;
};
// capix-mcp validates that a credential-shaped value exists during startup.
// This public sentinel is deliberately unusable; it keeps tool discovery
// available while signed out, and the 401 path above replaces it with a
// short-lived broker token before retrying any protected request.
if (!process.env.CAPIX_API_KEY) process.env.CAPIX_API_KEY = "cpxk_broker_pending";
await import(new URL("./index.js", import.meta.url).href);
MCPWRAPPER
  chmod 0755 "$ARTIFACT/mcp/capix-mcp.js"
  rm -rf "$DIR/dist/mcp-tmp"
  chmod 0755 "$ARTIFACT/engine/capix-engine$EXE_SUFFIX"
  # Install from the dedicated runtime manifest. The outer npm package has
  # platform selectors which do not belong inside the embedded runtime.
  (cd "$ARTIFACT/runtime" && npm install --omit=dev --ignore-scripts)
  (cd "$DIR/launcher" && cargo build --release)
  cp "$DIR/launcher/target/release/capix-code$EXE_SUFFIX" "$ARTIFACT/bin/capix-code$EXE_SUFFIX"
  chmod 0755 "$ARTIFACT/bin/capix-code$EXE_SUFFIX"
  if [ "$(uname -s)" = "Darwin" ]; then
    # An ad-hoc signature is still an unsigned preview identity, but prevents
    # macOS library validation from killing a freshly assembled executable
    # before the release assertions can run.
    codesign --force --sign - "$ARTIFACT/engine/capix-engine" >/dev/null
    codesign --force --sign - "$ARTIFACT/bin/capix-code" >/dev/null
  fi

  "$DIR/scripts/assert-artifact.sh" "$ARTIFACT"
  "$DIR/scripts/assert-customer-brand.sh" "$ARTIFACT"
  echo "✓ Customer artifact staged: $ARTIFACT"
else
  echo "✗ No binary found in dist/ — build may have failed."
  exit 1
fi
