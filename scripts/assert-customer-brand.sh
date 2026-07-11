#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:?artifact directory required}"
FORBIDDEN='opencode|vast|hetzner|void|vscode'

if find "$ROOT" -path "$ROOT/runtime/node_modules" -prune -o -type f -print | sed "s|$ROOT/||" | grep -Eiq "$FORBIDDEN"; then
  echo "✗ customer artifact contains a forbidden filename"
  exit 1
fi

for command in "--help" "--version" "doctor"; do
  output="$($ROOT/bin/capix-code $command 2>&1)"
  if printf '%s' "$output" | grep -Eiq "$FORBIDDEN"; then
    echo "✗ forbidden customer-visible brand in: capix-code $command"
    exit 1
  fi
done

if grep -ERiq "$FORBIDDEN" "$ROOT/config"; then
  echo "✗ forbidden customer-visible brand in configuration"
  exit 1
fi
echo "✓ customer-visible artifact surfaces use Capix branding only"
