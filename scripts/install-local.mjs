#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const env = process.env;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const userHome = os.homedir();
const opt = { type: env.QODER_OTEL_TYPE || "otlp", variant: env.QODER_OTEL_VARIANT || env.QODER_VARIANT || "auto", endpoint: env.GTRACE_ENDPOINT || env.QODER_OTEL_ENDPOINT || "", tracePath: env.GTRACE_TRACE_PATH || env.QODER_OTEL_TRACE_PATH || "", metricsPath: env.GTRACE_METRICS_PATH || env.QODER_OTEL_METRICS_PATH || "", xToken: env.GTRACE_X_TOKEN || env.X_TOKEN || "", configFile: env.QODER_GTRACE_CONFIG || "", writeConfig: true, keepOld: false, headers: [], tags: [] };
const args = process.argv.slice(2);
const valueAt = (name, inline, index) => inline ?? (args[index + 1] ?? (() => { throw new Error(`${name} requires a value`); })());
for (let i = 0; i < args.length; i++) {
  const eq = args[i].indexOf("="); const name = eq > 0 ? args[i].slice(0, eq) : args[i]; const inline = eq > 0 ? args[i].slice(eq + 1) : undefined;
  const value = () => { const result = valueAt(name, inline, i); if (inline === undefined) i++; return result; };
  if (name === "--type") opt.type = value(); else if (name === "--variant") opt.variant = value(); else if (name === "--endpoint") opt.endpoint = value(); else if (name === "--x-token") opt.xToken = value(); else if (name === "--trace-path") opt.tracePath = value(); else if (name === "--metrics-path") opt.metricsPath = value(); else if (name === "--header") opt.headers.push(value()); else if (name === "--tag") opt.tags.push(value()); else if (name === "--config-file") opt.configFile = value(); else if (name === "--no-config") opt.writeConfig = false; else if (name === "--keep-old") opt.keepOld = true; else if (name === "-h" || name === "--help") { console.log("Usage: node scripts/install-local.mjs [--type gtrace|otlp] [--variant cn|global|auto] [--endpoint URL] [--x-token TOKEN] [--trace-path PATH] [--metrics-path PATH] [--header KEY=VALUE] [--tag KEY=VALUE] [--config-file PATH] [--no-config] [--keep-old]"); process.exit(0); } else throw new Error(`Unknown argument: ${args[i]}`);
}
if (Number(process.versions.node.split(".")[0]) < 22) throw new Error(`Node.js >= 22 is required. Found ${process.version}`);
const readJson = (file, fallback = {}) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n"); };
const toMap = items => Object.fromEntries(items.map(item => { const i = item.indexOf("="); if (i < 1) throw new Error(`Expected KEY=VALUE: ${item}`); return [item.slice(0, i), item.slice(i + 1)]; }));
let variant = String(opt.variant).toLowerCase();
if (["qoder-cn"].includes(variant)) variant = "cn"; if (["qoder", "non-cn", "intl", "international"].includes(variant)) variant = "global";
if (variant === "auto" || !variant) variant = env.QODER_HOME ? (/(?:^|[\\/])\.?qoder-cn$/.test(env.QODER_HOME) ? "cn" : "global") : (fs.existsSync(path.join(userHome, ".qoder")) && !fs.existsSync(path.join(userHome, ".qoder-cn")) ? "global" : "cn");
if (!["cn", "global"].includes(variant)) throw new Error(`Unsupported --variant: ${opt.variant}`);
if (!["gtrace", "otlp", "otel"].includes(opt.type)) throw new Error(`Unsupported --type: ${opt.type}`);

const qoderHome = path.resolve(env.QODER_HOME || path.join(userHome, variant === "global" ? ".qoder" : ".qoder-cn"));
const defaultConfigRoot = process.platform === "win32"
  ? path.join(env.APPDATA || path.join(userHome, "AppData", "Roaming"), variant === "global" ? "Qoder" : "QoderCN")
  : path.join(userHome, ".config", variant === "global" ? "Qoder" : "QoderCN");
const configRoot = path.resolve(env.QODER_CONFIG_ROOT || defaultConfigRoot);
const version = readJson(path.join(repoRoot, "package.json")).version;
const marketplace = env.MARKETPLACE_NAME || "qoder-marketplace", pluginName = env.PLUGIN_NAME || "qoder-otel-plugin", legacyName = env.LEGACY_PLUGIN_NAME || "qoder-otel-probe";
const pluginParent = path.join(qoderHome, "plugins", "cache", marketplace, pluginName), pluginRoot = path.join(pluginParent, version);
if (!opt.keepOld && fs.existsSync(pluginParent)) for (const entry of fs.readdirSync(pluginParent, { withFileTypes: true })) if (entry.isDirectory() && entry.name !== version) fs.rmSync(path.join(pluginParent, entry.name), { recursive: true, force: true });
fs.rmSync(path.join(qoderHome, "plugins", "cache", marketplace, legacyName), { recursive: true, force: true }); fs.mkdirSync(pluginRoot, { recursive: true });
for (const item of ["src", "hooks", ".qoder-plugin"]) { fs.rmSync(path.join(pluginRoot, item), { recursive: true, force: true }); fs.cpSync(path.join(repoRoot, item), path.join(pluginRoot, item), { recursive: true }); }
fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(pluginRoot, "package.json"));

const quote = value => process.platform === "win32" ? `"${String(value).replace(/"/g, '\\"')}"` : `'${String(value).replace(/'/g, `'\\''`)}'`;
const invocation = `${quote(process.execPath)} ${quote(path.join(pluginRoot, "src", "qoder-hook-wrapper.js"))}`;
// Qoder runs hook commands through `cmd /c` on Windows. Prefixing the quoted
// executable with the cmd.exe `call` built-in prevents cmd from treating the
// executable quotes as the outer /c command quotes.
const command = process.platform === "win32" ? `call ${invocation}` : invocation;
const hooks = {};
for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"]) hooks[event] = [{ matcher: "", hooks: [{ type: "command", command, timeout: 30, outputByteLimit: 200000 }] }];
writeJson(path.join(pluginRoot, "hooks.json"), { hooks });

const pluginId = `${pluginName}@${marketplace}`, legacyId = `${legacyName}@${marketplace}`;
const registries = [[path.join(qoderHome, "settings.json"), path.join(qoderHome, "plugins", "installed_plugins.json")], [path.join(configRoot, "SharedClientCache", "settings.json"), path.join(configRoot, "SharedClientCache", "plugins", "installed_plugins.json")]];
for (const [settingsFile, installedFile] of registries) {
  const settings = readJson(settingsFile); settings.enabledPlugins = { ...(settings.enabledPlugins || {}) }; delete settings.enabledPlugins[legacyId]; settings.enabledPlugins[pluginId] = true; writeJson(settingsFile, settings);
  const installed = readJson(installedFile), now = new Date().toISOString(), existing = installed.plugins?.[pluginId] || {}; installed.plugins = { ...(installed.plugins || {}) }; delete installed.plugins[legacyId]; installed.plugins[pluginId] = { scope: existing.scope || "user", installPath: pluginRoot, version, installedAt: existing.installedAt || now, lastUpdated: now }; writeJson(installedFile, installed);
}
const installedV2File = path.join(qoderHome, "plugins", "installed_plugins_v2.json");
const installedV2 = readJson(installedV2File, { version: 2, plugins: {} });
installedV2.version = 2;
installedV2.plugins = { ...(installedV2.plugins || {}) };
const existingV2Entries = Array.isArray(installedV2.plugins[pluginId]) ? installedV2.plugins[pluginId] : [];
const existingV2 = existingV2Entries.find(entry => entry?.scope === "user") || existingV2Entries[0] || {};
const nowV2 = new Date().toISOString();
delete installedV2.plugins[legacyId];
installedV2.plugins[pluginId] = [{
  ...existingV2,
  scope: "user",
  installPath: pluginRoot,
  version,
  source: existingV2.source || "marketplace",
  enabled: true,
  installedAt: existingV2.installedAt || nowV2,
  lastUpdated: nowV2,
}];
writeJson(installedV2File, installedV2);
const configFile = path.resolve(opt.configFile || path.join(qoderHome, "gtrace.json"));
if (opt.writeConfig) { const config = readJson(configFile), headers = { ...(config.headers || {}), ...toMap(opt.headers) }; if (!Object.keys(headers).some(k => k.toLowerCase() === "to-headless")) headers["To-Headless"] = "true"; if (opt.xToken) headers["X-Token"] = opt.xToken; const gtrace = opt.type === "gtrace"; Object.assign(config, { enabled: true, tracePath: opt.tracePath || (gtrace ? "v1/write/otel-llm" : "v1/traces"), metricsPath: opt.metricsPath || (gtrace ? "v1/write/otel-metrics" : "v1/metrics"), headers, resourceAttributes: { ...(config.resourceAttributes || {}), ...toMap(opt.tags) } }); if (opt.endpoint) config.endpoint = opt.endpoint; writeJson(configFile, config); }
for (const file of [path.join(pluginRoot, "src", "qoder-hook-wrapper.js"), path.join(pluginRoot, "hooks.json"), path.join(pluginRoot, ".qoder-plugin", "plugin.json")]) if (!fs.existsSync(file)) throw new Error(`Verification failed, missing ${file}`);
for (const [settingsFile, installedFile] of registries) { if (readJson(settingsFile).enabledPlugins?.[pluginId] !== true || readJson(installedFile).plugins?.[pluginId]?.installPath !== pluginRoot) throw new Error(`Registry verification failed: ${settingsFile}`); }
if (!readJson(installedV2File).plugins?.[pluginId]?.some(entry => entry.installPath === pluginRoot && entry.version === version)) throw new Error(`Registry verification failed: ${installedV2File}`);
console.log(`[qoder-otel-plugin] installed and verified: ${pluginRoot}`); console.log(`[qoder-otel-plugin] hooks use Node.js: ${process.execPath}`); if (opt.writeConfig) console.log(`[qoder-otel-plugin] updated config: ${configFile}`); console.log("[qoder-otel-plugin] restart Qoder to reload hooks");
