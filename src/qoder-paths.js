import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function exists(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

function normalizeVariant(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized || normalized === "auto") return "auto";
  if (["cn", "qoder-cn"].includes(normalized)) return "cn";
  if (["global", "qoder", "non-cn", "intl", "international"].includes(normalized)) return "global";
  return "auto";
}

function inferVariantFromQoderHome(qoderHome) {
  const base = path.basename(String(qoderHome ?? ""));
  if (base === ".qoder-cn" || base === "qoder-cn") return "cn";
  if (base === ".qoder" || base === "qoder") return "global";
  return undefined;
}

function inferVariantFromPluginRoot(pluginRoot) {
  if (!pluginRoot) return undefined;
  let current = path.resolve(pluginRoot);
  for (let index = 0; index < 8; index += 1) {
    const inferred = inferVariantFromQoderHome(current);
    if (inferred) return inferred;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function inferVariantFromFileSystem(home) {
  const hasCnHome = exists(path.join(home, ".qoder-cn"));
  const hasGlobalHome = exists(path.join(home, ".qoder"));
  if (hasCnHome && !hasGlobalHome) return "cn";
  if (hasGlobalHome && !hasCnHome) return "global";
  if (hasCnHome && hasGlobalHome) return "cn";

  const hasCnConfig = exists(path.join(home, ".config", "QoderCN"));
  const hasGlobalConfig = exists(path.join(home, ".config", "Qoder"));
  if (hasCnConfig && !hasGlobalConfig) return "cn";
  if (hasGlobalConfig && !hasCnConfig) return "global";
  if (hasCnConfig && hasGlobalConfig) return "cn";

  return "cn";
}

export function resolveQoderLayout(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? os.homedir();
  const explicitQoderHome = options.qoderHome ?? env.QODER_HOME;
  let variant = normalizeVariant(options.variant ?? env.QODER_OTEL_VARIANT ?? env.QODER_VARIANT ?? env.QODER_CHANNEL);

  if (variant === "auto") {
    variant =
      inferVariantFromQoderHome(explicitQoderHome)
      ?? inferVariantFromPluginRoot(options.pluginRoot)
      ?? inferVariantFromFileSystem(home);
  }

  const qoderHome = explicitQoderHome ?? path.join(home, variant === "cn" ? ".qoder-cn" : ".qoder");
  const configRoot = options.configRoot ?? env.QODER_CONFIG_ROOT ?? path.join(home, ".config", variant === "cn" ? "QoderCN" : "Qoder");
  const localConfigDirName = variant === "cn" ? ".qoder-cn" : ".qoder";

  return {
    variant,
    home,
    qoderHome,
    configRoot,
    localConfigDirName,
    globalConfigFile: path.join(qoderHome, "gtrace.json"),
    hookLogFile: path.join(qoderHome, "qoder-otel-hook.log"),
    debugJsonlFile: path.join(qoderHome, "qoder-otel-native-hook-events.jsonl"),
    stateDir: path.join(qoderHome, "qoder-otel-state"),
    skillsDir: path.join(qoderHome, "skills"),
    localDbPath: path.join(configRoot, "SharedClientCache", "cache", "db", "local.db"),
  };
}
