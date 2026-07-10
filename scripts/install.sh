#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
QODER_HOME="${QODER_HOME:-$HOME/.qoder-cn}"
MARKETPLACE_NAME="${MARKETPLACE_NAME:-qoder-marketplace}"
PLUGIN_NAME="${PLUGIN_NAME:-qoder-otel-plugin}"
LEGACY_PLUGIN_NAME="${LEGACY_PLUGIN_NAME:-qoder-otel-probe}"
CONFIG_FILE="${QODER_GTRACE_CONFIG:-$QODER_HOME/gtrace.json}"
WRITE_CONFIG=1
KEEP_OLD=0
INSTALL_TYPE="${QODER_OTEL_TYPE:-otlp}"
ENDPOINT="${GTRACE_ENDPOINT:-${QODER_OTEL_ENDPOINT:-}}"
TRACE_PATH="${GTRACE_TRACE_PATH:-${QODER_OTEL_TRACE_PATH:-}}"
METRICS_PATH="${GTRACE_METRICS_PATH:-${QODER_OTEL_METRICS_PATH:-}}"
X_TOKEN="${GTRACE_X_TOKEN:-${X_TOKEN:-}}"
NODE_BIN="${QODER_OTEL_NODE:-}"
TAGS=()
HEADERS=()

log() {
  printf '[qoder-otel-plugin] %s\n' "$1"
}

resolve_node() {
  local candidate
  if [[ -n "$NODE_BIN" ]]; then
    if [[ -x "$NODE_BIN" ]]; then
      printf '%s' "$NODE_BIN"
      return 0
    fi
    echo "QODER_OTEL_NODE is not executable: $NODE_BIN" >&2
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

usage() {
  cat <<HELP
Usage:
  scripts/install.sh [--type gtrace|otlp] [--endpoint URL] [--x-token TOKEN] [--trace-path PATH] [--metrics-path PATH] [--header KEY=VALUE] [--tag KEY=VALUE] [--no-config] [--keep-old]

Options:
  --type         Config preset. Default: otlp. Values: gtrace, otlp.
  --endpoint     Receiver base URL, for example https://llm-openway.guance.com.
  --x-token      Dataway/GTrace X-Token. Written to gtrace.json as header X-Token.
  --trace-path   Trace route. Overrides the selected type default.
  --metrics-path Metrics route. Overrides the selected type default.
  --header       Extra HTTP header as KEY=VALUE. Can be repeated.
  --tag          Resource attribute as KEY=VALUE. Can be repeated.
  --config-file  Config file. Default: ~/.qoder-cn/gtrace.json.
  --no-config    Install plugin files only; do not create or update gtrace.json.
  --keep-old      Keep older installed versions. Default behavior removes old qoder-otel-plugin versions.

Environment:
  QODER_HOME          Qoder home. Default: ~/.qoder-cn
  QODER_OTEL_NODE     Node.js executable path when node is not in PATH
  QODER_OTEL_TYPE     Same as --type
  QODER_OTEL_ENDPOINT Same as --endpoint
  GTRACE_ENDPOINT     Same as --endpoint
  QODER_OTEL_TRACE_PATH / GTRACE_TRACE_PATH
  QODER_OTEL_METRICS_PATH / GTRACE_METRICS_PATH
  GTRACE_X_TOKEN / X_TOKEN
HELP
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --type)
      shift; [[ "$#" -gt 0 ]] || { echo "--type requires a value" >&2; exit 2; }
      INSTALL_TYPE="$1"
      ;;
    --type=*)
      INSTALL_TYPE="${1#*=}"
      ;;
    --endpoint)
      shift; [[ "$#" -gt 0 ]] || { echo "--endpoint requires a URL" >&2; exit 2; }
      ENDPOINT="$1"
      ;;
    --endpoint=*)
      ENDPOINT="${1#*=}"
      ;;
    --x-token)
      shift; [[ "$#" -gt 0 ]] || { echo "--x-token requires a token" >&2; exit 2; }
      X_TOKEN="$1"
      ;;
    --x-token=*)
      X_TOKEN="${1#*=}"
      ;;
    --trace-path)
      shift; [[ "$#" -gt 0 ]] || { echo "--trace-path requires a path" >&2; exit 2; }
      TRACE_PATH="$1"
      ;;
    --trace-path=*)
      TRACE_PATH="${1#*=}"
      ;;
    --metrics-path)
      shift; [[ "$#" -gt 0 ]] || { echo "--metrics-path requires a path" >&2; exit 2; }
      METRICS_PATH="$1"
      ;;
    --metrics-path=*)
      METRICS_PATH="${1#*=}"
      ;;
    --header)
      shift; [[ "$#" -gt 0 ]] || { echo "--header requires KEY=VALUE" >&2; exit 2; }
      HEADERS+=("$1")
      ;;
    --header=*)
      HEADERS+=("${1#*=}")
      ;;
    --tag)
      shift; [[ "$#" -gt 0 ]] || { echo "--tag requires KEY=VALUE" >&2; exit 2; }
      TAGS+=("$1")
      ;;
    --tag=*)
      TAGS+=("${1#*=}")
      ;;
    --config-file)
      shift; [[ "$#" -gt 0 ]] || { echo "--config-file requires a path" >&2; exit 2; }
      CONFIG_FILE="$1"
      ;;
    --config-file=*)
      CONFIG_FILE="${1#*=}"
      ;;
    --no-config)
      WRITE_CONFIG=0
      ;;
    --keep-old)
      KEEP_OLD=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

if [[ ! -f "$REPO_ROOT/src/qoder-hook-wrapper.js" ]]; then
  echo "Cannot find src/qoder-hook-wrapper.js under $REPO_ROOT" >&2
  exit 1
fi

NODE_BIN="$(resolve_node)"
check_node_version "$NODE_BIN"

case "$INSTALL_TYPE" in
  gtrace)
    TRACE_PATH="${TRACE_PATH:-v1/write/otel-llm}"
    METRICS_PATH="${METRICS_PATH:-v1/write/otel-metrics}"
    ;;
  otlp|otel)
    INSTALL_TYPE="otlp"
    TRACE_PATH="${TRACE_PATH:-v1/traces}"
    METRICS_PATH="${METRICS_PATH:-v1/metrics}"
    ;;
  *)
    echo "Unsupported --type: $INSTALL_TYPE. Supported values: gtrace, otlp" >&2
    exit 2
    ;;
esac

VERSION="$("$NODE_BIN" -p "JSON.parse(require('fs').readFileSync('$REPO_ROOT/package.json', 'utf8')).version")"
PLUGIN_PARENT="$QODER_HOME/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME"
PLUGIN_ROOT="$PLUGIN_PARENT/$VERSION"
LEGACY_PLUGIN_PARENT="$QODER_HOME/plugins/cache/$MARKETPLACE_NAME/$LEGACY_PLUGIN_NAME"
REMOVED_LEGACY_PLUGIN=0

if [[ "$KEEP_OLD" -eq 0 && -d "$PLUGIN_PARENT" ]]; then
  find "$PLUGIN_PARENT" -mindepth 1 -maxdepth 1 -type d ! -name "$VERSION" -exec rm -rf {} +
fi
if [[ -d "$LEGACY_PLUGIN_PARENT" ]]; then
  rm -rf "$LEGACY_PLUGIN_PARENT"
  REMOVED_LEGACY_PLUGIN=1
fi

mkdir -p "$PLUGIN_ROOT"
rm -rf "$PLUGIN_ROOT/src" "$PLUGIN_ROOT/hooks" "$PLUGIN_ROOT/.qoder-plugin"
cp -R "$REPO_ROOT/src" "$PLUGIN_ROOT/src"
cp -R "$REPO_ROOT/hooks" "$PLUGIN_ROOT/hooks"
cp -R "$REPO_ROOT/.qoder-plugin" "$PLUGIN_ROOT/.qoder-plugin"
cp "$REPO_ROOT/package.json" "$PLUGIN_ROOT/package.json"

chmod +x "$PLUGIN_ROOT/hooks/qoder-otel-plugin.sh" 2>/dev/null || true

"$NODE_BIN" - "$PLUGIN_ROOT" "$NODE_BIN" <<'NODE'
const fs = require("fs");
const path = require("path");
const [pluginRoot, nodeBin] = process.argv.slice(2);
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
const command = `${shellQuote(nodeBin)} ${shellQuote(path.join(pluginRoot, "src", "qoder-hook-wrapper.js"))}`;
const eventNames = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SessionEnd",
];
const hooks = {};
for (const eventName of eventNames) {
  hooks[eventName] = [{
    matcher: "",
    hooks: [{
      type: "command",
      command,
      timeout: 30,
      outputByteLimit: 200000,
    }],
  }];
}
fs.writeFileSync(path.join(pluginRoot, "hooks.json"), JSON.stringify({ hooks }, null, 2) + "\n");
NODE

if [[ "$WRITE_CONFIG" -eq 1 ]]; then
  mkdir -p "$(dirname "$CONFIG_FILE")"
  "$NODE_BIN" - "$CONFIG_FILE" "$ENDPOINT" "$TRACE_PATH" "$METRICS_PATH" "$X_TOKEN" "${HEADERS[@]}" -- "${TAGS[@]}" <<'NODE'
const fs = require("fs");
const [configFile, endpoint, tracePath, metricsPath, xToken, ...rest] = process.argv.slice(2);
const sep = rest.indexOf("--");
const headersArgs = sep >= 0 ? rest.slice(0, sep) : rest;
const tagArgs = sep >= 0 ? rest.slice(sep + 1) : [];
let current = {};
try {
  current = JSON.parse(fs.readFileSync(configFile, "utf8"));
} catch {}
const headers = { ...(current.headers || {}) };
if (xToken) headers["X-Token"] = xToken;
for (const item of headersArgs) {
  const index = item.indexOf("=");
  if (index > 0) headers[item.slice(0, index)] = item.slice(index + 1);
}
const resourceAttributes = { ...(current.resourceAttributes || {}) };
for (const item of tagArgs) {
  const index = item.indexOf("=");
  if (index > 0) resourceAttributes[item.slice(0, index)] = item.slice(index + 1);
}
const next = {
  ...current,
  enabled: true,
  ...(endpoint ? { endpoint } : {}),
  ...(tracePath ? { tracePath } : {}),
  ...(metricsPath ? { metricsPath } : {}),
  ...(Object.keys(headers).length ? { headers } : {}),
  ...(Object.keys(resourceAttributes).length ? { resourceAttributes } : {}),
};
fs.writeFileSync(configFile, JSON.stringify(next, null, 2) + "\n");
NODE
fi

log "installed plugin to $PLUGIN_ROOT"
if [[ "$KEEP_OLD" -eq 0 ]]; then
  log "removed older installed versions under $PLUGIN_PARENT"
fi
if [[ "$REMOVED_LEGACY_PLUGIN" -eq 1 ]]; then
  log "removed legacy plugin path $LEGACY_PLUGIN_PARENT"
fi
log "wrote hooks.json with node: $NODE_BIN"
if [[ "$WRITE_CONFIG" -eq 1 ]]; then
  log "updated config: $CONFIG_FILE"
else
  log "skipped config update"
fi
log "restart Qoder to reload hooks"
