# AxumAgent

[![CI](https://github.com/SakuraByteCore/AxumAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/SakuraByteCore/AxumAgent/actions/workflows/ci.yml)

AxumAgent is a TypeScript CLI for OpenAI-compatible chat providers, with a Kilo-style terminal shell, quick provider setup, and a pi-style workflow runtime foundation.

- `src/`: TypeScript CLI/provider/runtime layer.
- `src/config.ts`: user-level TOML config loading.
- `src/shell/kilo-shell.ts`: Kilo-style shell mode definitions without depending on KiloCode.
- `src/runtime/pi-workflow.ts`: pi-style workflow events, permission gates, and checkpoint layout.
- `src/providers/openai-chat.ts`: OpenAI Chat Completions and OpenAI-compatible provider.
- `bin/axum.js`: npm binary shim that runs the built TypeScript CLI.
- `dist/`: committed build output for install-time execution.

## Current shape

The repository is TypeScript-only and npm-packaged as `axum-agent`. The previous Rust workspace and prebuilt binary artifacts were removed to avoid large local/remote footprint.

## Requirements

- Node.js.
- npm.

## Quick start

```bash
npm install -g axum-agent
# Install does not write config automatically; initialize explicitly:
axum init --provider-config "https://api.openai.com/v1 env:OPENAI_API_KEY gpt-4o-mini"
axum config-web
axum doctor
axum providers
axum modes
axum workflow --dry-run --mode plan "Ship the next change"
axum workflow --dry-run --verbose --mode plan "Inspect every step"
axum tui
```

Local development checks:

```bash
npm test
npm run pack:dry
node bin/axum.js --help
```

## Install from npm

```bash
npm install -g axum-agent
axum --help
```

For local development from this repository:

```bash
npm install
npm link
axum --help
```

## Config

AxumAgent reads user-level config instead of project-local config by default. Installing the npm package does not write user files; run `axum init` explicitly to create `~/.axum/config.toml`. Existing config is not overwritten unless `axum init --force` is used.

```toml
# ~/.axum/config.toml
provider = "openai-chat"
# One-line shortcut, equivalent to base_url + api_key + model:
# provider_config = "https://api.openai.com/v1 env:OPENAI_API_KEY gpt-4o-mini"

[providers.openai-chat]
type = "openai-chat"
base_url = "https://api.openai.com/v1"
api_key = "env:OPENAI_API_KEY"
models = ["gpt-4o-mini"]
max_retries = 10
retry_delay_ms = 250
request_timeout_ms = 600000
```

Config path resolution:

1. `--config <path>`
2. `AXUM_CONFIG=/path/to/config.toml`
3. `~/.axum/config.toml`

`api_key` may be a literal key or an environment reference such as `env:OPENAI_API_KEY`. For quick setup, `provider_config = "<base_url> <api_key|env:VAR> <model>"` can configure url/key/model in one line. You can also run `axum config-web` to start a temporary local web page for editing URL/key/model in the same config file. `models` is the TUI model list; when no explicit `model`/`--model` is set, `axum tui` selects the first configured model. If the list is omitted and a provider key is available, TUI tries `GET /models` even when a current model is already configured, fills the provider model list from the response, and only auto-selects the first returned model when no model was explicitly configured. Use `/provider set <url> <key> <model>` inside TUI to save all three fields at once, or `/provider url <url>` and `/provider key <key>` for separate updates. Use `/model` to dynamically fetch and list provider models, then `/model 2` or `/model <id>` to switch and save the model selection. `/provider model <id>` remains available for saving a custom model id under the current provider without fetching. The TUI input keeps an active cursor by default, ←/→ move the cursor for in-line edits, `Shift+Insert`/bracketed paste inserts pasted text, typing `/` shows a two-column command list with a selected item, `Tab` completes the selected slash command, and ↑/↓ recalls prior inputs when the slash command list is not active.

## CLI examples

```bash
npm test
npm run pack:dry
node bin/axum.js --help
node bin/axum.js --version
node bin/axum.js init --provider-config "https://api.openai.com/v1 env:OPENAI_API_KEY gpt-4o-mini"
node bin/axum.js chat "Say hello"
node bin/axum.js tui --dry-run "Preview the terminal UI"
node bin/axum.js tui --dry-run
node bin/axum.js tui --no-alt-screen --dry-run
node bin/axum.js tui "Say hello in the terminal UI"
node bin/axum.js doctor
node bin/axum.js doctor --json
node bin/axum.js providers
node bin/axum.js providers --json
node bin/axum.js modes
node bin/axum.js workflow --dry-run --mode build "Implement a safe change"
node bin/axum.js workflow --dry-run --verbose --mode build "Show folded workflow steps"
node bin/axum.js config-web
node bin/axum.js config-web --port 8788 --config ~/.axum/config.toml
node bin/axum.js chat --config ~/.axum/config.toml "Say hello"
node bin/axum.js chat --max-retries 3 "Retry a flaky request"
node bin/axum.js chat --provider secondary "Use another configured provider"
node bin/axum.js doctor --provider secondary --json
node bin/axum.js chat --request-timeout-ms 900000 "Run a longer request"
```

`axum workflow` renders a compact Unicode stage view by default and folds intermediate workflow steps; pass `--verbose` to expand them. `axum chat` supports OpenAI Chat Completions and OpenAI-compatible providers through `/v1/chat/completions`. `axum providers` lists configured providers and masks literal keys; use `--json` for scripts. `axum chat`, `axum tui`, and `axum doctor` accept `--provider <id>` to temporarily use another provider from `providers.<id>` without changing the default config. `axum tui` can also read OpenAI-compatible model lists through `/v1/models`. `axum doctor` checks the resolved provider config and `/v1/models` connectivity without sending a chat prompt; use `axum doctor --json` for scripts and CI diagnostics. `axum config-web` does not echo stored raw API keys; leave the key field blank to keep an existing key.

Useful environment variables:

- `AXUM_CONFIG`: config file path.
- `OPENAI_API_KEY`: optional API key source when config uses `api_key = "env:OPENAI_API_KEY"`.
- `AXUM_MODEL`: fallback model id, otherwise `gpt-4o-mini`.
- `AXUM_OPENAI_BASE_URL`: fallback OpenAI-compatible base URL, otherwise `https://api.openai.com/v1`.
- `AXUM_OPENAI_API_KEY_ENV`: fallback env var name for API keys.
- `AXUM_OPENAI_MAX_RETRIES`: fallback retry count for transient failures, otherwise `10`.
- `AXUM_OPENAI_RETRY_DELAY_MS`: fallback base retry delay in milliseconds, otherwise `250`.
- `AXUM_OPENAI_REQUEST_TIMEOUT_MS`: request timeout in milliseconds, otherwise `600000`; set `0` to disable.

## Safety boundary

This is still an early CLI/provider/runtime slice, not a hardened autonomous agent runtime. The session/event/tool-loop path now exists, and `axum parallel` has a pi-style child-task state model plus merge-review metadata, but managed child-agent execution is not enabled yet. The next hardening step is to connect queued/running child tasks to isolated execution, cancellation, failure handling, and merge review without letting the TUI state become the source of truth.

## Release checklist

Only release from a clean `main` checkout after the current head has a green CI run.

```bash
git status --short --branch
npm test
npm run pack:dry
npm version patch --no-git-tag-version
git add package.json package-lock.json dist/ README.md TODO.md DEVLOG.md
git commit -m "chore(release): v$(node -p 'require("./package.json").version')"
git tag "v$(node -p 'require("./package.json").version')"
npm publish --access public
git push origin main --tags
```

Do not publish if `npm test`, `npm run pack:dry`, or CI fails. Do not tag or publish uncommitted local changes.
