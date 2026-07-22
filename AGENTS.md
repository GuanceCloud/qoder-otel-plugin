# Project Instructions

## Communication

- Always respond in English.
- Keep documentation, comments, commit messages, release notes, and installer output in English.
- Lead with the result and include concise validation evidence.

## Development

- Support Node.js 22.5+, Linux, macOS, and Windows.
- Keep the runtime dependency-free; use Node.js built-in modules unless explicitly required otherwise.
- Preserve Qoder hook behavior, duplicate-upload protection, and existing configuration fields.
- Never log credentials or sensitive headers such as `X-Token` and `Authorization`.
- Update `README.md` and `docs/configuration.md` when paths, configuration, installation, or observable behavior changes.

## Installers

- Keep `scripts/install-local.sh` and `scripts/install-local.mjs` behaviorally aligned.
- Preserve unrelated entries in Qoder settings and plugin registries, including `installed_plugins_v2.json`.
- Respect `QODER_HOME` and `QODER_CONFIG_ROOT` and use platform-specific desktop config paths.
- On macOS, fail before writing files if Qoder is running.
- Write `gtrace.json` only after plugin files and registries are written and verified; `--no-config` must not modify it.
- Run installer tests only with temporary home directories.

## Validation and Releases

Run the relevant checks before handoff:

```bash
npm run check
bash -n scripts/install-local.sh
node --check scripts/install-local.mjs
git diff --check
```

- Keep versions synchronized in `package.json`, `.qoder-plugin/plugin.json`, and `PLUGIN_VERSION` in `src/qoder-hook-wrapper.js`.
- Ensure release checksum files contain relative archive names and verify published assets after download.
- Write release notes in English and never rewrite a published tag.
- Do not commit secrets, local Qoder data, temporary files, IDE metadata, or generated `dist/` artifacts.
- Preserve unrelated changes in a dirty worktree.
