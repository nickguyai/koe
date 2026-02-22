#!/usr/bin/env bash
# Sync Koe source to the public release repo, stripping build-only config.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/.."
RELEASE_DIR="/Users/yugu/Desktop/gehirn/product-releases/koe"

if [ ! -d "$RELEASE_DIR/.git" ]; then
  echo "ERROR: Release repo not found at $RELEASE_DIR"
  echo "Clone it first: git clone git@github.com:nickguyai/koe.git $RELEASE_DIR"
  exit 1
fi

echo "Syncing source to release repo..."
rsync -av \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='bin' \
  --exclude='.env' \
  --exclude='.DS_Store' \
  --exclude='*.dmg' \
  --exclude='package.json.prod' \
  "$SRC_DIR/" \
  "$RELEASE_DIR/"

echo "Stripping build-only config from package.json..."
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('$RELEASE_DIR/package.json', 'utf8'));
pkg.build.mac.notarize = false;
delete pkg.build.afterSign;
delete pkg.build.afterPack;
fs.writeFileSync('$RELEASE_DIR/package.json', JSON.stringify(pkg, null, 2) + '\n');
"

echo "Done. Review changes:"
echo "  cd $RELEASE_DIR && git diff"
