#!/usr/bin/env bash
# Generate release notes from monorepo commits since the last koe release tag.
# Usage: generate-release-notes.sh [version]
# Output: markdown release notes to stdout
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ELECTRON_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(dirname "$ELECTRON_DIR")"
REPO_ROOT="$(cd "$PROJECT_DIR/../.." && pwd)"

VERSION="${1:-$(node -p "require('$ELECTRON_DIR/package.json').version")}"

cd "$REPO_ROOT"

# Find the previous koe release tag
PREV_TAG=$(git tag --list 'koe-v*' --sort=-version:refname | head -1)

if [ -n "$PREV_TAG" ]; then
  RANGE="$PREV_TAG..HEAD"
else
  # No previous tag — use all gammawave commits
  RANGE="HEAD"
fi

# Collect commits scoped to gammawave, skip legion/merge commits
COMMITS=$(git log "$RANGE" --oneline --no-merges -- projects/gammawave/ \
  | grep -v 'legion(' || true)

if [ -z "$COMMITS" ]; then
  echo "Release v$VERSION"
  echo ""
  echo "Maintenance release."
  exit 0
fi

# Strip hash and conventional commit prefix, output as bullet points
strip_prefix() {
  sed -E 's/^[a-f0-9]+ [a-z]+\([^)]*\): /- /' | sed -E 's/^[a-f0-9]+ /- /'
}

FEATURES=$(echo "$COMMITS" | grep -i 'feat(' | strip_prefix || true)
FIXES=$(echo "$COMMITS" | grep -i 'fix(' | strip_prefix || true)
OTHER=$(echo "$COMMITS" | grep -iv -e 'feat(' -e 'fix(' | strip_prefix || true)

echo "## What's New in v$VERSION"
echo ""

if [ -n "$FEATURES" ]; then
  echo "### Features"
  echo "$FEATURES"
  echo ""
fi

if [ -n "$FIXES" ]; then
  echo "### Fixes"
  echo "$FIXES"
  echo ""
fi

if [ -n "$OTHER" ]; then
  echo "### Other"
  echo "$OTHER"
  echo ""
fi
