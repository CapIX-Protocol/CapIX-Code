#!/usr/bin/env bash
set -euo pipefail

TAG="${1:?release tag required}"
case "$TAG" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "ERROR: release tag must be vMAJOR.MINOR.PATCH: $TAG" >&2; exit 2 ;;
esac

git rev-parse --verify "refs/tags/$TAG" >/dev/null
HEAD_COMMIT="$(git rev-parse 'HEAD^{commit}')"
TAG_COMMIT="$(git rev-parse "refs/tags/$TAG^{commit}")"

if [ "$HEAD_COMMIT" != "$TAG_COMMIT" ]; then
  echo "ERROR: checked-out source $HEAD_COMMIT does not match $TAG commit $TAG_COMMIT" >&2
  exit 1
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'sha=%s\n' "$TAG_COMMIT" >> "$GITHUB_OUTPUT"
fi
echo "Verified release source: $TAG -> $TAG_COMMIT"
