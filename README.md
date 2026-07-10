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

- Linux/macOS
- Qoder CN local data layout under `~/.qoder-cn` and `~/.config/QoderCN`
- Node.js >= 22

## Install For Users

Users do not need to download the source tree. Install from a release asset:

```bash
curl -fsSL https://github.com/GuanceCloud/qoder-otel-plugin/releases/latest/download/install-release.sh \
  | bash -s -- latest \
      --type gtrace \
      --endpoint https://llm-openway.guance.com \
      --x-token <token>
```

Install a specific version:

```bash
curl -fsSL https://github.com/GuanceCloud/qoder-otel-plugin/releases/latest/download/install-release.sh \
  | bash -s -- v0.1.0 \
      --type gtrace \
      --endpoint https://llm-openway.guance.com \
      --x-token <token>
```

Upgrade uses the same command. By default, the installer removes older installed `qoder-otel-probe` versions under `~/.qoder-cn/plugins/cache/qoder-marketplace/qoder-otel-probe/` to avoid duplicate hook uploads.

To upgrade plugin files while keeping the existing `~/.qoder-cn/gtrace.json`:

```bash
curl -fsSL https://github.com/GuanceCloud/qoder-otel-plugin/releases/latest/download/install-release.sh \
  | bash -s -- latest --type gtrace --no-config
```

Restart Qoder after install or upgrade so hooks are reloaded.

## Development Install

From a local source checkout:

```bash
cd qoder-otel-plugin
bash scripts/install.sh \
  --type gtrace \
  --endpoint https://llm-openway.guance.com \
  --x-token <token>
```

Both installers write:

- plugin files to `~/.qoder-cn/plugins/cache/qoder-marketplace/qoder-otel-probe/<version>`
- hook config to the installed plugin's `hooks.json`
- runtime config to `~/.qoder-cn/gtrace.json`

## Configuration

Runtime config lives at:

```text
~/.qoder-cn/gtrace.json
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
bash scripts/install.sh --no-config
```

Use a custom Qoder home:

```bash
QODER_HOME=/path/to/.qoder-cn bash scripts/install.sh
```

## Build Release

```bash
npm run build:release
```

The build creates:

- `dist/qoder-otel-plugin-v<version>.tar.gz`
- `dist/qoder-otel-plugin.tar.gz`
- `dist/install-release.sh`
