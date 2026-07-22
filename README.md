# qoder-otel-plugin

`qoder-otel-plugin` exports Qoder agent execution data as OpenTelemetry traces.

It reads Qoder hook input and transcript files, enriches them with local Qoder SQLite token metadata, reconstructs agent turns, and uploads OTLP protobuf traces to a configured receiver.

## Capabilities

- Emits `invoke_agent`, `llm`, `tool:<name>`, `skill:<name>`, and `assistant` spans.
- Uses Qoder `session_id` as `gen_ai.conversation.id`.
- Uses Qoder `request_id` as turn id and writes it to every span as `gen_ai.turn.id` and `turn_id`.
- Captures LLM input/output messages, per-call input tokens, cache tokens, output tokens, credits when available, tool calls, tool results, and skill calls.
- Emits metrics following `gtrace-ai-semantic-conventions`: `gen_ai.workflow.duration`, `gen_ai.agent.operation.count`, `gen_ai.agent.operation.duration`, and `gen_ai.client.token.usage`.
- Uses Qoder hook timestamps for tool duration when available.
- Adds duplicate-upload protection for repeated `Stop` hook executions.
- Uses only built-in Node.js modules at runtime.

## Requirements

- Linux/macOS/Windows
- Qoder local data layout:
  - CN: `~/.qoder-cn` plus Linux `~/.config/QoderCN`, macOS `~/Library/Application Support/QoderCN`, or Windows `%APPDATA%\\QoderCN`
  - non-CN: `~/.qoder` plus Linux `~/.config/Qoder`, macOS `~/Library/Application Support/Qoder`, or Windows `%APPDATA%\\Qoder`
- Node.js >= 22.5

## Install For Users

Users do not need to download the source tree. Install from a release asset:

```bash
curl -fsSL https://github.com/GuanceCloud/qoder-otel-plugin/releases/latest/download/install.sh \
  | bash -s -- latest \
      --type gtrace \
      --variant cn \
      --endpoint https://llm-openway.guance.com \
      --x-token <token>
```

Install a specific version:

```bash
curl -fsSL https://github.com/GuanceCloud/qoder-otel-plugin/releases/latest/download/install.sh \
  | bash -s -- v0.1.1 \
      --type gtrace \
      --variant cn \
      --endpoint https://llm-openway.guance.com \
      --x-token <token>
```

Upgrade uses the same command. By default, the installer removes older installed `qoder-otel-plugin` versions under `~/.qoder-cn/plugins/cache/qoder-marketplace/qoder-otel-plugin/` to avoid duplicate hook uploads.

To upgrade plugin files while keeping the existing `~/.qoder-cn/gtrace.json`:

```bash
curl -fsSL https://github.com/GuanceCloud/qoder-otel-plugin/releases/latest/download/install.sh \
  | bash -s -- latest --type gtrace --variant cn --no-config
```

Quit Qoder before installing on macOS. This prevents the running app from writing stale plugin state back over the installer changes. Restart Qoder after install or upgrade so hooks are reloaded.

Windows release install (PowerShell):

```powershell
irm https://github.com/GuanceCloud/qoder-otel-plugin/releases/latest/download/install-release.ps1 -OutFile install-release.ps1
powershell -ExecutionPolicy Bypass -File .\install-release.ps1 -Version latest -Type gtrace -Variant cn `
  --endpoint https://llm-openway.guance.com --x-token <token>
```

The installer also supports direct in-memory execution and repeatable tags:

```powershell
& ([scriptblock]::Create((irm https://github.com/GuanceCloud/qoder-otel-plugin/releases/latest/download/install-release.ps1))) `
  -Version latest `
  -Endpoint https://llm-openway.guance.com `
  -XToken '<token>' `
  -Tag @('agent_id=<agent-id>', 'agent_name=<agent-name>')
```

## Development Install

From a local source checkout:

```bash
cd qoder-otel-plugin
bash scripts/install-local.sh \
  --type gtrace \
  --variant cn \
  --endpoint https://llm-openway.guance.com \
  --x-token <token>
```

Windows PowerShell users can install from a local checkout with:

```powershell
.\scripts\install-local.ps1 --type gtrace --variant cn `
  --endpoint https://llm-openway.guance.com --x-token <token>
```

If PowerShell script execution is disabled, use the CMD entry point:

```powershell
.\scripts\install-local.cmd --variant cn --no-config
```

Or use the cross-platform npm command:

```powershell
npm run install:local -- --variant cn --no-config
```

Both installers write:

- plugin files to `~/.qoder-cn/plugins/cache/qoder-marketplace/qoder-otel-plugin/<version>`
- hook config to the installed plugin's `hooks.json`
- runtime config to `~/.qoder-cn/gtrace.json`

## Configuration

Runtime config lives at:

```text
<QODER_HOME>/gtrace.json
```

See [docs/configuration.md](docs/configuration.md) and [config/gtrace.example.json](config/gtrace.example.json).

## Verify

```bash
npm run check
```

After running a Qoder turn, inspect:

```bash
tail -n 20 ~/.qoder-cn/qoder-otel-hook.log
```

Useful upload log messages include `prepared qoder spans`, `upload traces start`, `upload traces success`, `upload traces http_error`, `upload traces exception`, `upload metrics start`, `upload metrics success`, `upload metrics http_error`, and `upload metrics exception`. Authentication headers are redacted.

Use `--no-config` when you only want to refresh plugin files and keep the existing config:

```bash
bash scripts/install-local.sh --no-config
```

Use a custom Qoder home:

```bash
QODER_HOME=/path/to/.qoder bash scripts/install-local.sh
```

Variant selection:

- `--variant cn`: uses `~/.qoder-cn` and the platform-specific `QoderCN` desktop config root listed above
- `--variant global`: uses `~/.qoder` and the platform-specific `Qoder` desktop config root listed above
- `--variant auto`: infers from `QODER_HOME` or existing local directories, defaulting to `cn` when ambiguous

## Build Release

```bash
npm run build:release
```

The build creates:

- `dist/qoder-otel-plugin-v<version>.tar.gz`
- `dist/qoder-otel-plugin.tar.gz`
- `dist/install.sh`

Pushing a version tag such as `v0.2.0` triggers `.github/workflows/release.yml`. The workflow verifies that the tag, `package.json`, plugin manifest, and runtime version match, runs checks, builds all assets, and publishes the GitHub Release automatically.
