#!/usr/bin/env bash
# install-config.sh — drop the Capix provider config as the default.
set -uo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
CAPIX_CODE_DIR="${CAPIX_CODE_DIR:-$DIR/opencode}"
CONFIG_SRC="$DIR/config/defaults.json"

if [ ! -f "$CONFIG_SRC" ]; then
  echo "✗ Missing $CONFIG_SRC"
  exit 1
fi

# 1. Bundle the config into the opencode package as a default.
DEST_DIR="$CAPIX_CODE_DIR/packages/opencode/config"
mkdir -p "$DEST_DIR"
cp "$CONFIG_SRC" "$DEST_DIR/capix-defaults.json"
echo "  ✓ bundled capix-defaults.json"

# 2. Create the init script that writes the default config on first run.
WRAPPER="$CAPIX_CODE_DIR/packages/opencode/scripts/init-capix-config.ts"
mkdir -p "$(dirname "$WRAPPER")"
cat > "$WRAPPER" << 'WRAPPER_EOF'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function getConfigDir(): string {
  switch (process.platform) {
    case "darwin": return join(homedir(), "Library", "Application Support", "capix-code");
    case "win32": return join(homedir(), "AppData", "Roaming", "capix-code");
    default: return join(homedir(), ".config", "capix-code");
  }
}

const configDir = getConfigDir();
const configFile = join(configDir, "opencode.json");

if (!existsSync(configFile)) {
  let defaults = "{}";
  try {
    defaults = readFileSync(join(import.meta.dir, "..", "config", "capix-defaults.json"), "utf-8");
  } catch {}
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configFile, defaults, "utf-8");
}
WRAPPER_EOF
echo "  ✓ created init-capix-config.ts wrapper"

# 3. Install the TUI theme + brand assets.
if [ -d "$DIR/themes" ]; then
  THEME_DEST="$CAPIX_CODE_DIR/packages/opencode/config/themes"
  mkdir -p "$THEME_DEST"
  cp "$DIR/themes/capix.toml" "$THEME_DEST/capix.toml" 2>/dev/null || true
  cp "$DIR/tui-capix.json" "$CAPIX_CODE_DIR/packages/opencode/config/tui-capix.json" 2>/dev/null || true
  echo "  ✓ TUI theme installed"
fi

if [ -d "$DIR/brand" ]; then
  BRAND_DEST="$CAPIX_CODE_DIR/packages/opencode/config/brand"
  mkdir -p "$BRAND_DEST"
  cp -R "$DIR/brand/"* "$BRAND_DEST/" 2>/dev/null || true
  echo "  ✓ brand assets installed"
fi

echo "✓ Capix config + branding installed."
