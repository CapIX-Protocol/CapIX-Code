#!/usr/bin/env bash
# rebrand.sh — apply Capix branding.
# ONLY renames: binary name, config dirs, env var prefixes, install script.
# Does NOT rename: workspace package name, npm package name, or import paths.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
CAPIX_CODE_DIR="${CAPIX_CODE_DIR:-$DIR/upstream}"

if [ ! -d "$CAPIX_CODE_DIR" ]; then
  echo "✗ No $CAPIX_CODE_DIR. Run ./scripts/bootstrap.sh first."
  exit 1
fi

cd "$CAPIX_CODE_DIR"

# 0. Rename the upstream package directory.
if [ -d "packages/opencode" ]; then
  mv packages/opencode packages/capix-code
  echo "  ✓ package directory renamed"
fi

echo "▸ Rebranding in $CAPIX_CODE_DIR"

# 0a. Patch the script package to use CAPIX_CODE_VERSION env var instead of OPENCODE_VERSION
SCRIPT_SRC="$CAPIX_CODE_DIR/packages/script/src/index.ts"
if [ -f "$SCRIPT_SRC" ]; then
  sed -i.bak 's/env\.OPENCODE_VERSION/env.CAPIX_CODE_VERSION/g' "$SCRIPT_SRC"
  sed -i.bak 's/env\.OPENCODE_BUMP/env.CAPIX_CODE_BUMP/g' "$SCRIPT_SRC"
  sed -i.bak 's/env\.OPENCODE_RELEASE/env.CAPIX_CODE_RELEASE/g' "$SCRIPT_SRC"
  sed -i.bak 's/env\.OPENCODE_CHANNEL/env.CAPIX_CODE_CHANNEL/g' "$SCRIPT_SRC"
  sed -i.bak 's/OPENCODE_CHANNEL/CAPIX_CODE_CHANNEL/g' "$SCRIPT_SRC"
  sed -i.bak 's/process\.env\["OPENCODE_CHANNEL"\]/process.env["CAPIX_CODE_CHANNEL"]/g' "$SCRIPT_SRC"
  if ! grep -Fq 'CAPIX_CODE_VERSION: process.env["CAPIX_CODE_VERSION"]' "$SCRIPT_SRC"; then
    sed -i.bak '/CAPIX_CODE_CHANNEL: process.env\["CAPIX_CODE_CHANNEL"\],/a\
  CAPIX_CODE_VERSION: process.env["CAPIX_CODE_VERSION"],' "$SCRIPT_SRC"
  fi
  rm -f "$SCRIPT_SRC.bak"
  echo "  ✓ script package env vars rebranded"
fi

# 0b. Patch the build script to define CAPIX_CODE_VERSION instead of OPENCODE_VERSION
BUILD_SCRIPT="$CAPIX_CODE_DIR/packages/capix-code/script/build.ts"
if [ -f "$BUILD_SCRIPT" ]; then
  sed -i.bak 's/OPENCODE_VERSION/CAPIX_CODE_VERSION/g' "$BUILD_SCRIPT"
  sed -i.bak 's/OPENCODE_CHANNEL/CAPIX_CODE_CHANNEL/g' "$BUILD_SCRIPT"
  rm -f "$BUILD_SCRIPT.bak"
  echo "  ✓ build script defines rebranded"
fi

# 0c. Patch the version.ts to use CAPIX_CODE_VERSION global
VERSION_SRC="$CAPIX_CODE_DIR/packages/core/src/installation/version.ts"
if [ -f "$VERSION_SRC" ]; then
  sed -i.bak 's/OPENCODE_VERSION/CAPIX_CODE_VERSION/g' "$VERSION_SRC"
  sed -i.bak 's/OPENCODE_CHANNEL/CAPIX_CODE_CHANNEL/g' "$VERSION_SRC"
  rm -f "$VERSION_SRC.bak"
  echo "  ✓ version.ts globals rebranded"
fi

# 0d. Patch the installation index.ts user-agent string
INSTALL_SRC="$CAPIX_CODE_DIR/packages/capix-code/src/installation/index.ts"
if [ -f "$INSTALL_SRC" ]; then
  sed -i.bak 's|opencode/|capix-code/|g' "$INSTALL_SRC"
  rm -f "$INSTALL_SRC.bak"
  echo "  ✓ installation user-agent rebranded"
fi

# 1. Binary name in packages/capix-code/package.json — ONLY the "bin" field.
PKG="$CAPIX_CODE_DIR/packages/capix-code/package.json"
if [ -f "$PKG" ]; then
  # Change only the binary name, not the package name (workspace deps depend on it).
  sed -i.bak 's|"bin": {"opencode"|"bin": {"capix-code"|g' "$PKG"
  rm -f "$PKG.bak"
  echo "  ✓ binary name renamed"
fi

# 2. Build script — only the output directory/file naming.
BUILD="$CAPIX_CODE_DIR/packages/capix-code/script/build.ts"
if [ -f "$BUILD" ]; then
  sed -i.bak 's|bin/opencode|bin/capix-code|g' "$BUILD"
  rm -f "$BUILD.bak"
  echo "  ✓ build.ts: output binary renamed"
fi

# 3. Env prefixes in environment accesses only. Never rewrite imported symbols.
echo "▸ Replacing env var prefixes…"
find "$CAPIX_CODE_DIR/packages/capix-code/src" \( -name '*.ts' -o -name '*.js' -o -name '*.tsx' \) -type f 2>/dev/null | while IFS= read -r f; do
  perl -0pi.bak -e 's/(process[.]env|Bun[.]env)[.]OPENCODE_/$1.CAPIX_CODE_/g' "$f"
  rm -f "$f.bak"
done
echo "  ✓ env prefix replaced"

# 4. Config directory paths in source.
echo "▸ Replacing config directory paths…"
find "$CAPIX_CODE_DIR/packages/capix-code/src" \( -name '*.ts' -o -name '*.js' -o -name '*.tsx' \) -type f 2>/dev/null | while IFS= read -r f; do
  sed -i.bak \
    -e 's|\.config/opencode|.config/capix-code|g' \
    -e 's|\.opencode/|.capix-code/|g' \
    -e "s|opencode/auth|capix-code/auth|g" \
    "$f"
  rm -f "$f.bak"
done
echo "  ✓ config dirs updated"

# 5. Config filename: opencode.json → capix-code.json (only in the default config path lookup).
echo "▸ Replacing config filename…"
find "$CAPIX_CODE_DIR/packages/capix-code/src" \( -name '*.ts' -o -name '*.js' \) -type f 2>/dev/null | while IFS= read -r f; do
  sed -i.bak "s/opencode\.json/capix-code.json/g" "$f"
  rm -f "$f.bak"
done
echo "  ✓ config filename renamed"

# 6. Display name in source — "OpenCode" → "CapixCode" (display strings only, not imports).
echo "▸ Replacing display names…"
find "$CAPIX_CODE_DIR/packages/capix-code/src" \( -name '*.ts' -o -name '*.tsx' \) -type f 2>/dev/null | while IFS= read -r f; do
  # Only replace in string literals, not import paths. Conservative: replace "OpenCode" in quotes.
  sed -i.bak \
    -e 's/"OpenCode"/"CapixCode"/g' \
    -e "s/'OpenCode'/'CapixCode'/g" \
    -e 's/`OpenCode`/`CapixCode`/g' \
    "$f"
  rm -f "$f.bak"
done
echo "  ✓ display names updated"

# 6b. Replace the terminal identity and customer-visible command copy. These
# files are an explicit reviewed allowlist: internal package names, protocol
# identifiers and import contracts remain untouched.
cp "$DIR/assets/tui-logo.ts" "$CAPIX_CODE_DIR/packages/tui/src/logo.ts"
CLI_UI="$CAPIX_CODE_DIR/packages/capix-code/src/cli/ui.ts"
perl -0pi.bak -e 's/const wordmark = \[.*?\]\n/const wordmark = [\n  `  ██████╗ █████╗ ██████╗ ██╗██╗  ██╗     ██████╗ ██████╗ ██████╗ ███████╗`,\n  ` ██╔════╝██╔══██╗██╔══██╗██║╚██╗██╔╝    ██╔════╝██╔═══██╗██╔══██╗██╔════╝`,\n  ` ██║     ███████║██████╔╝██║ ╚███╔╝     ██║     ██║   ██║██║  ██║█████╗  `,\n  ` ██║     ██╔══██║██╔═══╝ ██║ ██╔██╗     ██║     ██║   ██║██║  ██║██╔══╝  `,\n  ` ╚██████╗██║  ██║██║     ██║██╔╝ ██╗    ╚██████╗╚██████╔╝██████╔╝███████╗`,\n  `  ╚═════╝╚═╝  ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝     ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝`,\n  `                                CAPIX CODE`,\n]\n/s' "$CLI_UI"
rm -f "$CLI_UI.bak"
TUI_PRESENTATION="$CAPIX_CODE_DIR/packages/tui/src/util/presentation.ts"
perl -0pi.bak -e 's/const logo = \{.*?\}\n/const logo = {\n  left: [" ██████╗  █████╗ ██████╗ ██╗██╗  ██╗", "██╔════╝ ██╔══██╗██╔══██╗██║╚██╗██╔╝", "██║      ███████║██████╔╝██║ ╚███╔╝ ", "██║      ██╔══██║██╔═══╝ ██║ ██╔██╗ ", "╚██████╗ ██║  ██║██║     ██║██╔╝ ██╗", " ╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝"],\n  right: [" ██████╗ ██████╗ ██████╗ ███████╗", "██╔════╝██╔═══██╗██╔══██╗██╔════╝", "██║     ██║   ██║██║  ██║█████╗  ", "██║     ██║   ██║██║  ██║██╔══╝  ", "╚██████╗╚██████╔╝██████╔╝███████╗", " ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝"],\n}\n/s; s/opencode -s/capix-code -s/g' "$TUI_PRESENTATION"
rm -f "$TUI_PRESENTATION.bak"
PRESENTATION_FILES=(
  packages/tui/src/app.tsx
  packages/tui/src/util/presentation.ts
  packages/tui/src/feature-plugins/sidebar/footer.tsx
  packages/tui/src/feature-plugins/home/footer.tsx
  packages/tui/src/feature-plugins/home/tips-view.tsx
  packages/tui/src/keymap.tsx
  packages/capix-code/src/cli/ui.ts
  packages/capix-code/src/index.ts
  packages/capix-code/src/cli/error.ts
  packages/capix-code/src/cli/cmd/run.ts
  packages/capix-code/src/cli/cmd/run/splash.ts
  packages/capix-code/src/cli/cmd/run/footer.permission.tsx
  packages/capix-code/src/cli/cmd/run/footer.prompt.tsx
  packages/capix-code/src/cli/cmd/run/footer.view.tsx
  packages/capix-code/src/cli/cmd/run/permission.shared.ts
  packages/capix-code/src/provider/error.ts
  packages/capix-code/src/cli/cmd/attach.ts
  packages/capix-code/src/cli/cmd/upgrade.ts
  packages/capix-code/src/cli/cmd/uninstall.ts
  packages/capix-code/src/cli/cmd/serve.ts
  packages/capix-code/src/cli/cmd/web.ts
  packages/capix-code/src/cli/cmd/pr.ts
  packages/capix-code/src/cli/cmd/tui.ts
  packages/capix-code/src/cli/network.ts
  packages/capix-code/src/plugin/xai.ts
  packages/capix-code/src/config/tui-migrate.ts
  packages/capix-code/src/config/tui.ts
  packages/capix-code/src/config/config.ts
  packages/capix-code/src/config/paths.ts
  packages/capix-code/src/config/managed.ts
  packages/capix-code/src/temporary.ts
  packages/capix-code/src/session/prompt/anthropic.txt
  packages/capix-code/src/session/prompt/beast.txt
  packages/capix-code/src/session/prompt/codex.txt
  packages/capix-code/src/session/prompt/copilot-gpt-5.txt
  packages/capix-code/src/session/prompt/default.txt
  packages/capix-code/src/session/prompt/gemini.txt
  packages/capix-code/src/session/prompt/gpt.txt
  packages/capix-code/src/session/prompt/kimi.txt
  packages/capix-code/src/session/prompt/meta.txt
  packages/capix-code/src/session/prompt/trinity.txt
)
for relative in "${PRESENTATION_FILES[@]}"; do
  file="$CAPIX_CODE_DIR/$relative"
  test -f "$file" || { echo "ERROR: customer presentation source missing: $relative"; exit 1; }
  perl -0pi.bak -e '
    s/OpenCode/Capix Code/g;
    s/OC \|/Capix |/g;
    s/opencode --mini/capix-code --mini/g;
    s/run opencode/run Capix Code/g;
    s/opencode models/capix-code models/g;
    s/opencode auth login/capix-code login/g;
    s/opencode server/Capix Code server/g;
    s/start opencode/start Capix Code/g;
    s/path to start opencode/path to start Capix Code/g;
    s/upgrade opencode/upgrade Capix Code/g;
    s/opencode upgrade/Capix Code upgrade/g;
    s/opencode session/Capix Code session/g;
    s/Starting opencode/Starting Capix Code/g;
    s/uninstall opencode/uninstall Capix Code/g;
    s/running opencode/running Capix Code/g;
    s/path to start opencode/path to start Capix Code/g;
    s/Thank you for using opencode/Thank you for using Capix Code/g;
    s/[.]scriptName\("opencode"\)/.scriptName("capix-code")/g;
    s/startsWith\("opencode /startsWith("capix-code /g;
    s/opencode[.]local/capix.local/g;
    s/OPENCODE_SERVER/CAPIX_CODE_SERVER/g;
    s/or '\''opencode'\''/or '\''capix'\''/g;
    s/opencode does not support/Capix Code does not support/g;
    s/opencode includes free models/Capix Code includes free models/g;
    s/public opencode\.ai link/public capix.network link/g;
    s/opencode\.ai link/capix.network link/g;
    s/opencode\.json/capix-code.json/g;
    s/~\/\.config\/opencode/~\/.config\/capix-code/g;
    s/\.opencode\//.capix-code\//g;
    s/"opencode"/"capix-code"/g;
    s/opencode run/capix-code run/g;
    s/opencode serve/Capix Code serve/g;
    s/opencode --continue/capix-code --continue/g;
    s/prevent OpenCode from reading/prevent Capix Code from reading/g;
    s/to OpenCode/to Capix Code/g;
    s/opencode\//capix-code\//g;
    s/ai\.opencode\.managed/ai.capix-code.managed/g;
    s/Support\/opencode/Support\/capix-code/g;
    s/sst-dev\.opencode/sst-dev.capix/g;
    s/\.opencode-version/.capix-code-version/g;
    s/opencode\.ai\/tui\.json/capix.network\/tui.json/g;
    s/opencode\.ai\/config\.json/capix.network\/config.json/g;
    s/opencode status/capix-code status/g;
    s/opencode debug/capix-code debug/g;
    s/opencode\.mode/capix-code.mode/g;
    s/You are opencode/You are Capix Code/g;
    s/You are OpenCode/You are Capix Code/g;
    s/Your name is opencode/Your name is Capix Code/g;
    s/opencode honestly applies/Capix Code honestly applies/g;
    s/OpenCode honestly applies/Capix Code honestly applies/g;
    s/from opencode docs/from Capix docs/g;
    s/from OpenCode docs/from Capix docs/g;
    s/about opencode/about Capix Code/g;
    s/about OpenCode/about Capix Code/g;
    s/using opencode/using Capix Code/g;
    s/using OpenCode/using Capix Code/g;
    s/opencode feature/Capix Code feature/g;
    s/OpenCode feature/Capix Code feature/g;
    s/opncd\.ai/capix.network/g;
    s|github.com/anomalyco/opencode|capix.network|g;
  ' "$file"
  rm -f "$file.bak"
done
echo "  ✓ terminal title, splash, logo and customer command copy replaced"

# 6c. Fix split-span: <b>Open</b><b>Code</b> → <b>Capix Code</b>
for file in \
  "$CAPIX_CODE_DIR/packages/tui/src/routes/session/sidebar.tsx" \
  "$CAPIX_CODE_DIR/packages/tui/src/feature-plugins/sidebar/footer.tsx" \
  "$CAPIX_CODE_DIR/packages/tui/src/feature-plugins/home/footer.tsx" \
  "$CAPIX_CODE_DIR/packages/tui/src/feature-plugins/home/tips-view.tsx"; do
  if [ -f "$file" ]; then
    perl -0pi.bak -e 's/<b>Open<\/b>\s*\n\s*<b>Code<\/b>/<b>Capix Code<\/b>/gs' "$file"
    perl -0pi.bak -e 's/OpenCode/Capix Code/g' "$file"
    rm -f "$file.bak"
  fi
done
echo "  ✓ split-span branding fixed"

# 7. Install script references.
INSTALL="$CAPIX_CODE_DIR/install"
if [ -f "$INSTALL" ]; then
  sed -i.bak \
    -e 's|anomalyco/opencode|CapIX-Protocol/CapIX-Code|g' \
    -e 's|opencode-ai|capix-code|g' \
    "$INSTALL"
  rm -f "$INSTALL.bak"
  echo "  ✓ install script updated"
fi

echo "✓ Rebrand complete. Only the binary name, config dirs, and env vars are rebranded."
echo "  Runtime plugin/provider are staged by scripts/build.sh and verified fail-closed."

"$DIR/scripts/assert-upstream-brand.sh" "$CAPIX_CODE_DIR"
