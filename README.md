# AxumAgent

AxumAgent is a TypeScript CLI prototype aligned toward `earendil-works/pi`-style provider and agent ergonomics.

- `src/`: TypeScript CLI/provider layer.
- `src/config.ts`: user-level TOML config loading.
- `src/providers/openai-chat.ts`: OpenAI Chat Completions and OpenAI-compatible provider.
- `bin/axum.js`: npm binary shim that runs the built TypeScript CLI.
- `dist/`: committed build output for install-time execution.

## Current shape

The repository is TypeScript-only. The previous Rust workspace and prebuilt binary artifacts were removed to avoid large local/remote footprint.

## Requirements

- Node.js.
- npm.

## Quick checks

```bash
npm test
npm run build
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

AxumAgent reads user-level config instead of project-local config by default. Installing the npm package creates `~/.axum/config.toml` when it is missing and never overwrites an existing config.

```toml
# ~/.axum/config.toml
provider = "openai-chat"

[providers.openai-chat]
type = "openai-chat"
base_url = "https://api.openai.com/v1"
api_key = "env:OPENAI_API_KEY"
models = ["gpt-4o-mini"]
max_retries = 10
retry_delay_ms = 250
```

Config path resolution:

1. `--config <path>`
2. `AXUM_CONFIG=/path/to/config.toml`
3. `~/.axum/config.toml`

`api_key` may be a literal key or an environment reference such as `env:OPENAI_API_KEY`. `models` is the TUI model list; when no explicit `model`/`--model` is set, `axum tui` selects the first configured model. If the list is omitted and a provider key is available, TUI tries `GET /models` and selects the first returned model. Use `/model` inside TUI to list models and `/model 2` or `/model <id>` to switch.

## CLI examples

```bash
npm test
npm run pack:dry
node bin/axum.js --help
node bin/axum.js chat "Say hello"
node bin/axum.js tui --dry-run "Preview the terminal UI"
node bin/axum.js tui --dry-run
node bin/axum.js tui --no-alt-screen --dry-run
node bin/axum.js tui "Say hello in the terminal UI"
node bin/axum.js chat --config ~/.axum/config.toml "Say hello"
node bin/axum.js chat --max-retries 3 "Retry a flaky request"
```

`axum chat` supports OpenAI Chat Completions and OpenAI-compatible providers through `/v1/chat/completions`. `axum tui` can also read OpenAI-compatible model lists through `/v1/models`.

Useful environment variables:

- `AXUM_CONFIG`: config file path.
- `OPENAI_API_KEY`: optional API key source when config uses `api_key = "env:OPENAI_API_KEY"`.
- `AXUM_MODEL`: fallback model id, otherwise `gpt-4o-mini`.
- `AXUM_OPENAI_BASE_URL`: fallback OpenAI-compatible base URL, otherwise `https://api.openai.com/v1`.
- `AXUM_OPENAI_API_KEY_ENV`: fallback env var name for API keys.
- `AXUM_OPENAI_MAX_RETRIES`: fallback retry count for transient failures, otherwise `10`.
- `AXUM_OPENAI_RETRY_DELAY_MS`: fallback base retry delay in milliseconds, otherwise `250`.

## Safety boundary

This is still an early CLI/provider slice, not a hardened autonomous agent runtime. The next hardening step is to add explicit session/event/tool-loop semantics before expanding file or shell tools.
