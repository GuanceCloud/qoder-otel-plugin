#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
VERSION="$("$NODE_BIN" -p "JSON.parse(require('fs').readFileSync('$REPO_ROOT/package.json', 'utf8')).version")"
DIST_DIR="$REPO_ROOT/dist"
NAME="qoder-otel-plugin-v$VERSION"
WORK_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$DIST_DIR" "$WORK_DIR/$NAME"

for item in \
  README.md \
  AGENTS.md \
  package.json \
  hooks.json \
  .qoder-plugin \
  config \
  docs \
  hooks \
  scripts \
  src
do
  cp -R "$REPO_ROOT/$item" "$WORK_DIR/$NAME/$item"
done

tar -C "$WORK_DIR" -czf "$DIST_DIR/$NAME.tar.gz" "$NAME"
sha256sum "$DIST_DIR/$NAME.tar.gz" > "$DIST_DIR/$NAME.tar.gz.sha256"

cp "$DIST_DIR/$NAME.tar.gz" "$DIST_DIR/qoder-otel-plugin.tar.gz"
cp "$DIST_DIR/$NAME.tar.gz.sha256" "$DIST_DIR/qoder-otel-plugin.tar.gz.sha256"
rm -f "$DIST_DIR/install-release.sh"
cp "$REPO_ROOT/scripts/install.sh" "$DIST_DIR/install.sh"

printf 'created %s\n' "$DIST_DIR/$NAME.tar.gz"
