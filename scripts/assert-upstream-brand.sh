#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:?prepared engine source required}"
# Internal import/package symbols intentionally retain their upstream ABI.
# This expression targets customer-readable identity and command prose only.
FORBIDDEN='OpenCode|OC \||run opencode|close opencode|Starting opencode|opencode -s|opencode (models|auth|does|version|server|with|to|upgrade|mcp|session)|Thank you[^\n]*opencode'
SURFACES=(
  packages/tui/src/logo.ts
  packages/tui/src/app.tsx
  packages/tui/src/util/presentation.ts
  packages/tui/src/routes/session/sidebar.tsx
  packages/tui/src/routes/session/footer.tsx
  packages/tui/src/routes/session/permission.tsx
  packages/tui/src/feature-plugins/sidebar/footer.tsx
  packages/tui/src/util/error.ts
  packages/tui/src/component/error-component.tsx
  packages/tui/src/attention.ts
  packages/capix-code/src/cli/ui.ts
  packages/capix-code/src/index.ts
  packages/capix-code/src/cli/error.ts
  packages/capix-code/src/cli/cmd/run.ts
  packages/capix-code/src/cli/cmd/run/splash.ts
  packages/capix-code/src/cli/cmd/run/footer.permission.tsx
  packages/capix-code/src/cli/cmd/run/footer.prompt.tsx
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
)
for file in "${SURFACES[@]}"; do
  test -f "$ROOT/$file" || { echo "✗ missing customer presentation source: $file"; exit 1; }
  if grep -Eq "$FORBIDDEN" "$ROOT/$file"; then
    echo "✗ predecessor branding remains in customer presentation source: $file"
    grep -En "$FORBIDDEN" "$ROOT/$file" | head -n 10
    exit 1
  fi
done
for sidebar in \
  "$ROOT/packages/tui/src/routes/session/sidebar.tsx" \
  "$ROOT/packages/tui/src/feature-plugins/sidebar/footer.tsx"; do
  if grep -Eq '<b>Open</b>|<b>Code</b>|<span>Open</span>|<span>Code</span>' "$sidebar"; then
    echo "✗ split predecessor wordmark remains in the interactive TUI footer: $sidebar"
    exit 1
  fi
done
grep -Fq 'CAPIX CODE' "$ROOT/packages/capix-code/src/cli/ui.ts" || {
  echo "✗ Capix Code startup wordmark is missing"
  exit 1
}
grep -Fq 'export const identity' "$ROOT/packages/tui/src/logo.ts" &&
  grep -Fq 'CAPIX CODE' "$ROOT/packages/tui/src/logo.ts" || {
  echo "✗ Capix Code TUI identity is missing"
  exit 1
}
grep -Fq 'CAPIX_CODE_VERSION: process.env["CAPIX_CODE_VERSION"]' "$ROOT/packages/script/src/index.ts" || {
  echo "✗ prepared build cannot receive the Capix release version"
  exit 1
}
echo "✓ prepared engine customer presentation sources are Capix-only"
