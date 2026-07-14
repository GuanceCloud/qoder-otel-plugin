#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
USER_HOME="${HOME:-$(cd ~ && pwd)}"
QODER_HOME="${QODER_HOME:-}"
MARKETPLACE_NAME="${MARKETPLACE_NAME:-qoder-marketplace}"
PLUGIN_NAME="${PLUGIN_NAME:-qoder-otel-plugin}"
LEGACY_PLUGIN_NAME="${LEGACY_PLUGIN_NAME:-qoder-otel-probe}"
CONFIG_FILE="${QODER_GTRACE_CONFIG:-}"
WRITE_CONFIG=1
KEEP_OLD=0
INSTALL_TYPE="${QODER_OTEL_TYPE:-otlp}"
INSTALL_VARIANT="${QODER_OTEL_VARIANT:-${QODER_VARIANT:-auto}}"
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

warn() {
  printf '[qoder-otel-plugin] WARN: %s\n' "$1" >&2
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

resolve_variant() {
  local candidate="${1:-auto}"
  candidate="$(printf '%s' "$candidate" | tr '[:upper:]' '[:lower:]')"
  case "$candidate" in
    cn|qoder-cn)
      printf 'cn'
      ;;
    global|qoder|non-cn|intl|international)
      printf 'global'
      ;;
    auto|"")
      if [[ -n "$QODER_HOME" ]]; then
        case "$(basename "$QODER_HOME")" in
          .qoder-cn|qoder-cn) printf 'cn'; return 0 ;;
          .qoder|qoder) printf 'global'; return 0 ;;
        esac
      fi
      if [[ -d "$USER_HOME/.qoder" && ! -d "$USER_HOME/.qoder-cn" ]]; then
        printf 'global'
      else
        printf 'cn'
      fi
      ;;
    *)
      echo "Unsupported --variant: $candidate. Supported values: cn, global, auto" >&2
      exit 2
      ;;
  esac
}

resolve_qoder_home() {
  local variant="$1"
  if [[ -n "$QODER_HOME" ]]; then
    printf '%s' "$QODER_HOME"
    return 0
  fi
  if [[ "$variant" == "global" ]]; then
    printf '%s' "$USER_HOME/.qoder"
  else
    printf '%s' "$USER_HOME/.qoder-cn"
  fi
}

resolve_config_root() {
  local variant="$1"
  if [[ "$variant" == "global" ]]; then
    printf '%s' "$USER_HOME/.config/Qoder"
  else
    printf '%s' "$USER_HOME/.config/QoderCN"
  fi
}

is_qoder_running() {
  if command -v pgrep >/dev/null 2>&1; then
    if pgrep -af 'Qoder|qoder' >/dev/null 2>&1; then
      return 0
    fi
  fi
  return 1
}

usage() {
  cat <<HELP
Usage:
  scripts/install-local.sh [--type gtrace|otlp] [--variant cn|global|auto] [--endpoint URL] [--x-token TOKEN] [--trace-path PATH] [--metrics-path PATH] [--header KEY=VALUE] [--tag KEY=VALUE] [--no-config] [--keep-old]

Options:
  --type         Config preset. Default: otlp. Values: gtrace, otlp.
  --variant      Qoder layout. `cn` uses ~/.qoder-cn and ~/.config/QoderCN. `global` uses ~/.qoder and ~/.config/Qoder. Default: auto.
  --endpoint     Receiver base URL, for example https://llm-openway.guance.com.
  --x-token      Dataway/GTrace X-Token. Written to gtrace.json as header X-Token.
  --trace-path   Trace route. Overrides the selected type default.
  --metrics-path Metrics route. Overrides the selected type default.
  --header       Extra HTTP header as KEY=VALUE. Can be repeated.
  --tag          Resource attribute as KEY=VALUE. Can be repeated.
  --config-file  Config file. Default: <QODER_HOME>/gtrace.json.
  --no-config    Install plugin files only; do not create or update gtrace.json.
  --keep-old      Keep older installed versions. Default behavior removes old qoder-otel-plugin versions.

Environment:
  QODER_HOME          Qoder home. Overrides --variant derived home.
  QODER_OTEL_NODE     Node.js executable path when node is not in PATH
  QODER_OTEL_TYPE     Same as --type
  QODER_OTEL_VARIANT  Same as --variant
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
    --variant)
      shift; [[ "$#" -gt 0 ]] || { echo "--variant requires a value" >&2; exit 2; }
      INSTALL_VARIANT="$1"
      ;;
    --variant=*)
      INSTALL_VARIANT="${1#*=}"
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
INSTALL_VARIANT="$(resolve_variant "$INSTALL_VARIANT")"
QODER_HOME="$(resolve_qoder_home "$INSTALL_VARIANT")"
CONFIG_ROOT="$(resolve_config_root "$INSTALL_VARIANT")"
SHARED_PLUGIN_REGISTRY_DIR="$CONFIG_ROOT/SharedClientCache/plugins"
SHARED_SETTINGS_FILE="$CONFIG_ROOT/SharedClientCache/settings.json"
SHARED_INSTALLED_PLUGINS_FILE="$SHARED_PLUGIN_REGISTRY_DIR/installed_plugins.json"
QODER_PLUGIN_REGISTRY_DIR="$QODER_HOME/plugins"
QODER_SETTINGS_FILE="$QODER_HOME/settings.json"
QODER_INSTALLED_PLUGINS_FILE="$QODER_PLUGIN_REGISTRY_DIR/installed_plugins.json"
CONFIG_FILE="${CONFIG_FILE:-$QODER_HOME/gtrace.json}"

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

mkdir -p "$SHARED_PLUGIN_REGISTRY_DIR" "$QODER_PLUGIN_REGISTRY_DIR"
"$NODE_BIN" - "$MARKETPLACE_NAME" "$PLUGIN_NAME" "$LEGACY_PLUGIN_NAME" "$PLUGIN_ROOT" "$VERSION" "$SHARED_SETTINGS_FILE" "$SHARED_INSTALLED_PLUGINS_FILE" "$QODER_SETTINGS_FILE" "$QODER_INSTALLED_PLUGINS_FILE" <<'NODE'
const fs = require("fs");

const [
  marketplaceName,
  pluginName,
  legacyPluginName,
  pluginRoot,
  version,
  ...registryFiles
] = process.argv.slice(2);

const pluginId = `${pluginName}@${marketplaceName}`;
const legacyPluginId = `${legacyPluginName}@${marketplaceName}`;
const now = new Date().toISOString();

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

for (let index = 0; index < registryFiles.length; index += 2) {
  const settingsFile = registryFiles[index];
  const installedPluginsFile = registryFiles[index + 1];
  if (!settingsFile || !installedPluginsFile) continue;

  const settings = readJson(settingsFile, {});
  const enabledPlugins = { ...(settings.enabledPlugins || {}) };
  delete enabledPlugins[legacyPluginId];
  enabledPlugins[pluginId] = true;
  writeJson(settingsFile, {
    ...settings,
    enabledPlugins,
  });

  const installedPluginsState = readJson(installedPluginsFile, {});
  const plugins = { ...(installedPluginsState.plugins || {}) };
  const existing = plugins[pluginId] || {};
  delete plugins[legacyPluginId];
  plugins[pluginId] = {
    scope: existing.scope || "user",
    installPath: pluginRoot,
    version,
    installedAt: existing.installedAt || now,
    lastUpdated: now,
  };
  writeJson(installedPluginsFile, {
    ...installedPluginsState,
    plugins,
  });
}
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
if (!Object.keys(headers).some((key) => key.toLowerCase() === "to-headless")) {
  headers["To-Headless"] = "true";
}
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

"$NODE_BIN" - "$PLUGIN_ROOT" "$CONFIG_FILE" "$PLUGIN_NAME" "$MARKETPLACE_NAME" "$VERSION" "$WRITE_CONFIG" "$QODER_SETTINGS_FILE" "$QODER_INSTALLED_PLUGINS_FILE" "$SHARED_SETTINGS_FILE" "$SHARED_INSTALLED_PLUGINS_FILE" <<'NODE'
const fs = require("fs");
const path = require("path");

const [
  pluginRoot,
  configFile,
  pluginName,
  marketplaceName,
  version,
  writeConfigFlag,
  ...registryFiles
] = process.argv.slice(2);

const pluginId = `${pluginName}@${marketplaceName}`;

function fail(message) {
  console.error(`[qoder-otel-plugin] verify failed: ${message}`);
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`);
  }
}

const requiredFiles = [
  path.join(pluginRoot, "src", "qoder-hook-wrapper.js"),
  path.join(pluginRoot, "hooks.json"),
  path.join(pluginRoot, ".qoder-plugin", "plugin.json"),
];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) {
    fail(`missing required file ${file}`);
  }
}

const hooksState = readJson(path.join(pluginRoot, "hooks.json"));
const hookEvents = Object.keys(hooksState.hooks || {});
if (hookEvents.length === 0) {
  fail("hooks.json contains no hook events");
}

for (let index = 0; index < registryFiles.length; index += 2) {
  const settingsFile = registryFiles[index];
  const installedPluginsFile = registryFiles[index + 1];
  if (!settingsFile || !installedPluginsFile) continue;

  const settings = readJson(settingsFile);
  if (!settings.enabledPlugins || settings.enabledPlugins[pluginId] !== true) {
    fail(`plugin ${pluginId} is not enabled in ${settingsFile}`);
  }

  const installedPluginsState = readJson(installedPluginsFile);
  const pluginMeta = installedPluginsState.plugins?.[pluginId];
  if (!pluginMeta) {
    fail(`plugin ${pluginId} missing from ${installedPluginsFile}`);
  }
  if (pluginMeta.installPath !== pluginRoot) {
    fail(`installPath mismatch in ${installedPluginsFile}: expected ${pluginRoot}, got ${pluginMeta.installPath}`);
  }
  if (pluginMeta.version !== version) {
    fail(`version mismatch in ${installedPluginsFile}: expected ${version}, got ${pluginMeta.version}`);
  }
}

if (String(writeConfigFlag) === "1") {
  const runtimeConfig = readJson(configFile);
  if (runtimeConfig.enabled !== true) {
    fail(`runtime config ${configFile} is not enabled`);
  }
}

console.log(`[qoder-otel-plugin] verified plugin files: ${pluginRoot}`);
for (let index = 0; index < registryFiles.length; index += 2) {
  const settingsFile = registryFiles[index];
  const installedPluginsFile = registryFiles[index + 1];
  if (settingsFile && installedPluginsFile) {
    console.log(`[qoder-otel-plugin] verified plugin registry: ${settingsFile}`);
    console.log(`[qoder-otel-plugin] verified installed plugin record: ${installedPluginsFile}`);
  }
}
if (String(writeConfigFlag) === "1") {
  console.log(`[qoder-otel-plugin] verified runtime config: ${configFile}`);
}
NODE

log "installed plugin to $PLUGIN_ROOT"
log "updated plugin registry: $QODER_SETTINGS_FILE"
log "updated installed plugins: $QODER_INSTALLED_PLUGINS_FILE"
log "updated shared plugin registry: $SHARED_SETTINGS_FILE"
log "updated shared installed plugins: $SHARED_INSTALLED_PLUGINS_FILE"
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
if is_qoder_running; then
  warn "Qoder is currently running. Restart Qoder to reload hooks."
else
  log "Qoder is not running; next launch will load hooks."
fi
log "install completed: registered, enabled, verified"
