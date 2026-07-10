#!/usr/bin/env bash
set -euo pipefail

REPO="${QODER_OTEL_REPO:-GuanceCloud/qoder-otel-plugin}"
REF="${QODER_OTEL_VERSION:-${QODER_OTEL_REF:-latest}}"
RELEASE_ASSET_NAME="${QODER_OTEL_RELEASE_ASSET_NAME:-qoder-otel-plugin.tar.gz}"
ARCHIVE_URL="${QODER_OTEL_ARCHIVE_URL:-}"

latest_release_api_url() {
  printf 'https://api.github.com/repos/%s/releases/latest' "$REPO"
}

resolve_release_ref() {
  local ref="$1"
  if [[ "$ref" != "latest" ]]; then
    printf '%s' "$ref"
    return 0
  fi

  local api_url="${QODER_OTEL_RELEASE_API_URL:-$(latest_release_api_url)}"
  local response
  local tag
  response="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$api_url" 2>/dev/null || true)"
  if [[ -z "$response" ]]; then
    printf '%s' "latest"
    return 0
  fi
  tag="$(printf '%s' "$response" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  if [[ -z "$tag" ]]; then
    printf '%s' "latest"
    return 0
  fi
  printf '%s' "$tag"
}

release_archive_url() {
  local ref="$1"
  if [[ "$ref" == "latest" ]]; then
    printf 'https://github.com/%s/releases/latest/download/%s' "$REPO" "$RELEASE_ASSET_NAME"
    return 0
  fi
  printf 'https://github.com/%s/releases/download/%s/%s' "$REPO" "$ref" "$RELEASE_ASSET_NAME"
}

usage() {
  cat <<HELP
Usage:
  install-release.sh [latest|vX.Y.Z|X.Y.Z] [install options]

Examples:
  curl -fsSL https://github.com/GuanceCloud/qoder-otel-plugin/releases/latest/download/install-release.sh \\
    | bash -s -- latest --type gtrace --endpoint https://llm-openway.guance.com --x-token <token>

  curl -fsSL https://github.com/GuanceCloud/qoder-otel-plugin/releases/latest/download/install-release.sh \\
    | bash -s -- v0.1.0 --type gtrace --no-config

Install and upgrade options are passed to scripts/install.sh:
  --type gtrace|otlp
  --variant cn|global|auto
  --endpoint URL
  --x-token TOKEN
  --trace-path PATH
  --metrics-path PATH
  --header KEY=VALUE
  --tag KEY=VALUE
  --config-file PATH
  --no-config
  --keep-old

Default upgrade behavior:
  The new version is installed and older qoder-otel-plugin versions are removed to avoid duplicate hook uploads.
  Use --keep-old only when you explicitly want to keep old versions on disk.

Environment:
  QODER_OTEL_REPO                GitHub repo. Default: GuanceCloud/qoder-otel-plugin
  QODER_OTEL_VERSION             Release version. Default: latest
  QODER_OTEL_RELEASE_ASSET_NAME  Release asset name. Default: qoder-otel-plugin.tar.gz
  QODER_OTEL_RELEASE_API_URL     Override latest-release API endpoint
  QODER_OTEL_ARCHIVE_URL         Full release tar.gz URL override
  QODER_OTEL_NODE                Node.js executable path when node is not in PATH
  QODER_OTEL_TYPE                Config preset. Values: gtrace, otlp
  QODER_OTEL_VARIANT             Qoder layout. Values: cn, global, auto
  QODER_HOME                     Qoder home. Overrides --variant derived home.
HELP
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac

if [[ "$#" -gt 0 && "$1" != --* ]]; then
  case "$1" in
    latest)
      REF="latest"
      ;;
    v*)
      REF="$1"
      ;;
    *)
      REF="v$1"
      ;;
  esac
  shift
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

resolve_node() {
  local candidate
  if [[ -n "${QODER_OTEL_NODE:-}" ]]; then
    if [[ -x "$QODER_OTEL_NODE" ]]; then
      printf '%s' "$QODER_OTEL_NODE"
      return 0
    fi
    echo "QODER_OTEL_NODE is not executable: $QODER_OTEL_NODE" >&2
    exit 1
  fi

  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  for candidate in \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.volta/bin/node \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node
  do
    if [[ -x "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done

  echo "Missing required command: node. Install Node.js >= 22 or set QODER_OTEL_NODE=/path/to/node." >&2
  exit 1
}

check_node_version() {
  local node_bin="$1"
  local major
  major="$("$node_bin" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)"
  if [[ -z "$major" || "$major" -lt 22 ]]; then
    echo "Node.js >= 22 is required. Found: $("$node_bin" -v 2>/dev/null || echo unknown) at $node_bin" >&2
    exit 1
  fi
}

need curl
need tar
need gzip

if [[ -z "$ARCHIVE_URL" ]]; then
  RESOLVED_REF="$(resolve_release_ref "$REF")"
  ARCHIVE_URL="$(release_archive_url "$RESOLVED_REF")"
else
  RESOLVED_REF="$REF"
fi

NODE_BIN="$(resolve_node)"
check_node_version "$NODE_BIN"
export QODER_OTEL_NODE="$NODE_BIN"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/repo"
echo "Downloading $ARCHIVE_URL"
curl -fsSL "$ARCHIVE_URL" | tar -xz --strip-components=1 -C "$TMP_DIR/repo"

if [[ ! -f "$TMP_DIR/repo/scripts/install.sh" ]]; then
  echo "Invalid archive: scripts/install.sh not found" >&2
  exit 1
fi

echo "Installing qoder-otel-plugin $RESOLVED_REF"
bash "$TMP_DIR/repo/scripts/install.sh" "$@"
