# Project Instructions

## Communication

- Always respond in English.
- Write documentation, comments, commit messages, release notes, and user-facing installer messages in English.
- Lead with the result, then summarize implementation details and validation evidence.

## Project Overview

`qoder-otel-plugin` exports Qoder agent activity as OpenTelemetry traces and metrics. It reads Qoder hook events and transcript data, enriches spans with token metadata from Qoder's local SQLite database, and uploads OTLP HTTP/protobuf payloads.

The runtime intentionally uses only Node.js built-in modules. Do not add runtime dependencies unless the task explicitly requires them and the tradeoff is documented.

Key files:

- `src/qoder-hook-wrapper.js`: hook entry point, transcript processing, span construction, upload orchestration, and runtime version constant.
- `src/qoder-config.js`: configuration loading and normalization.
- `src/qoder-paths.js`: platform and Qoder variant path resolution.
- `src/qoder-otlp.js`, `src/qoder-metrics.js`, and `src/proto.js`: OTLP trace/metric encoding and transport support.
- `scripts/install-local.sh`: Linux/macOS local installer and the implementation used by the remote shell installer.
- `scripts/install-local.mjs`: cross-platform Node installer used by npm and Windows wrappers.
- `scripts/build-release.sh`: release asset builder.

## Supported Environments

- Node.js 22.5 or newer.
- Linux, macOS, and Windows.
- Qoder CN uses `~/.qoder-cn`; global Qoder uses `~/.qoder`.
- Desktop configuration roots are platform-specific:
  - Linux: `~/.config/QoderCN` or `~/.config/Qoder`
  - macOS: `~/Library/Application Support/QoderCN` or `~/Library/Application Support/Qoder`
  - Windows: `%APPDATA%\\QoderCN` or `%APPDATA%\\Qoder`
- Respect `QODER_HOME` and `QODER_CONFIG_ROOT` overrides in installers and runtime path resolution.

## Runtime and Security Rules

- Preserve the Qoder hook stdin/stdout protocol and existing exit-code behavior.
- Keep hook execution non-blocking unless a task explicitly changes that behavior.
- Preserve duplicate-upload protection for repeated hook events.
- Never print authentication values, `X-Token`, `Authorization`, public/secret keys, or complete sensitive payloads.
- Redact sensitive headers in all logs and errors.
- Preserve unknown configuration fields when updating `gtrace.json`.
- Keep trace and metric semantic attributes aligned with the conventions documented in `docs/configuration.md`.

## Installer Invariants

- Keep `scripts/install-local.sh` and `scripts/install-local.mjs` behaviorally equivalent across supported platforms.
- Register the plugin in every Qoder state format currently supported:
  - `<QODER_HOME>/settings.json`
  - `<QODER_HOME>/plugins/installed_plugins.json`
  - `<QODER_HOME>/plugins/installed_plugins_v2.json`
  - `<CONFIG_ROOT>/SharedClientCache/settings.json`
  - `<CONFIG_ROOT>/SharedClientCache/plugins/installed_plugins.json`
- Preserve unrelated registry entries and unknown fields while updating this plugin's entry.
- Remove legacy `qoder-otel-probe` entries without deleting unrelated plugins.
- On macOS, do not modify plugin state while Qoder is running; fail before the first persistent write.
- Write and verify plugin files and registries before writing `gtrace.json`. Runtime configuration must be the final persistent installer write.
- `--no-config` must leave an existing `gtrace.json` unchanged.
- Test installers against temporary homes. Never run installer tests against the developer's real Qoder directories.

## Versioning and Releases

For every release, keep these versions identical:

- `package.json` → `version`
- `.qoder-plugin/plugin.json` → `version`
- `src/qoder-hook-wrapper.js` → `PLUGIN_VERSION`

Use semantic versioning. A pushed `vX.Y.Z` tag triggers `.github/workflows/release.yml`.

Release requirements:

- Run all required checks before creating the tag.
- Build both versioned and stable-name archives/installers.
- SHA256 files must contain relative archive names, never local or CI absolute paths.
- Download published assets and verify both checksum files after the workflow completes.
- Write release notes in English with sections for fixes/features, upgrade notes when needed, validation, and the full changelog link.
- Do not rewrite an already published tag. Repair mutable release metadata/assets carefully or publish a new patch version when source changes must be included in the tag.

## Validation

Run checks proportional to the change. The standard baseline is:

```bash
npm run check
bash -n scripts/install-local.sh
node --check scripts/install-local.mjs
git diff --check
```

For installer or path changes, also run isolated smoke tests with temporary `HOME`, `QODER_HOME`, and `QODER_CONFIG_ROOT` values. Cover the affected Linux/macOS/Windows path branches where practical, and verify registry contents, installed version, hook command, and `gtrace.json` behavior.

Before a release, also run:

```bash
npm run build:release
(cd dist && sha256sum -c qoder-otel-plugin-v*.tar.gz.sha256)
(cd dist && sha256sum -c qoder-otel-plugin.tar.gz.sha256)
```

## Documentation and Repository Hygiene

- Update `README.md` and `docs/configuration.md` when installation, paths, configuration, or observable behavior changes.
- Keep examples cross-platform or label platform-specific commands clearly.
- Do not commit generated `dist/` artifacts unless the repository policy changes.
- Do not commit credentials, local Qoder state, logs, transcripts, SQLite databases, IDE metadata, or temporary test files.
- Preserve unrelated user changes in a dirty worktree.
