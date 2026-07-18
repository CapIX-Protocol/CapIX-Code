#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:?artifact directory required}"
FORBIDDEN='opencode|vast|hetzner|void|vscode'

if find "$ROOT" -path "$ROOT/runtime/node_modules" -prune -o -path "$ROOT/mcp/node_modules" -prune -o -type f -print | sed "s|$ROOT/||" | grep -Eiq "$FORBIDDEN"; then
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

# The embedded engine is not invoked directly by customers, but every help
# surface it can render through the launcher must still be Capix-only.
for args in "--help" "run --help"; do
  output="$($ROOT/engine/capix-engine $args 2>&1)"
  if printf '%s' "$output" | grep -Eiq "$FORBIDDEN"; then
    echo "✗ forbidden predecessor brand in embedded engine output: $args"
    exit 1
  fi
done

# Native account commands must never fall through to the bundled engine's
# command parser. An unsigned CI artifact has no user keychain credential, so
# the expected result is a clean Capix-only sign-in instruction.
set +e
status_output="$($ROOT/bin/capix-code status 2>&1)"
status_code=$?
set -e
if [ "$status_code" -eq 0 ]; then
  # A developer machine may already have a valid native keychain session.
  printf '%s' "$status_output" | grep -Fq '"accountId"' || {
    echo "✗ authenticated status did not return canonical Capix account data"; exit 1;
  }
else
  printf '%s' "$status_output" | grep -Fq 'capix-code login' || {
    echo "✗ status did not return the native Capix authentication instruction"; exit 1;
  }
fi
if printf '%s' "$status_output" | grep -Eiq "$FORBIDDEN"; then
  echo "✗ status leaked a forbidden inherited brand"; exit 1
fi

if grep -ERiq "$FORBIDDEN" "$ROOT/config"; then
  echo "✗ forbidden customer-visible brand in configuration"
  exit 1
fi
echo "✓ customer-visible artifact surfaces use Capix branding only"
