# AxumAgent

[![CI](https://github.com/SakuraByteCore/AxumAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/SakuraByteCore/AxumAgent/actions/workflows/ci.yml)

AxumAgent is migrating from a TypeScript CLI to a Rust CLI for OpenAI-compatible chat providers, with KiloCode-aligned command structure and a Ratatui TUI roadmap.

- `crates/cli/`: Rust clap/serde/reqwest CLI foundation for config, providers, diagnostics, modes, workflow skeletons, and autonomous `run --auto` entrypoint.
- `src/`: legacy TypeScript CLI/provider/runtime layer retained while the Rust migration is phased in.
- `src/config.ts`: user-level TOML config loading used by the legacy CLI.
- `src/shell/kilo-shell.ts`: Kilo-style shell mode definitions without depending on KiloCode.
- `src/runtime/pi-workflow.ts`: pi-style workflow events, permission gates, and checkpoint layout.
- `src/providers/openai-chat.ts`: OpenAI Chat Completions and OpenAI-compatible provider.
- `bin/axum.js`: npm binary shim that currently runs the built TypeScript CLI while Rust CLI adoption is staged.
- `dist/`: committed TypeScript build output for install-time execution.

## Current shape

The Rust migration is active: `cargo build` produces a Rust `axum` binary with clap command coverage, serde-compatible `~/.axum/config.toml`, OpenAI-compatible provider calls via reqwest, `doctor --json`, provider listing, five agent modes with distinct runtime prompts, workflow skeleton output, and `run --auto` with noninteractive fail-closed sandbox policy evidence. Phase 2 has a first Ratatui TUI slice with session header, transcript, input editor, slash suggestions, history/cursor editing, undo, kill-ring basics, `/tasks`, `/providers`, `/provider`, `/model`, `/mode`, and non-streaming provider replies rendered back into the transcript. Phase 3 has a Rust `ToolSandbox` slice for workspace-contained reads, exact precise edits, allowlisted read-only safe exec, OpenAI-compatible provider `tool_calls` routed through those sandbox tools, Pi-style Plan/Now/Evidence/Result/Next/Issues traces around non-streamed provider/tool turns, `axum chat --stream` for OpenAI-compatible SSE content deltas, one-round streamed tool-call execution through the sandbox, and Rust TUI transcript support for streamed provider turns. Multi-round streamed tool execution, true in-frame TUI incremental rendering, and the full streaming state machine are planned for later phases.

## Requirements

- Node.js.
- npm.
- Rust toolchain (`cargo`, `rustc`) for the Rust CLI migration path.

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
cargo build
./target/debug/axum --help
./target/debug/axum tui --dry-run --mode debug /m
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
max_retries = 8
retry_min_delay_ms = 500
retry_max_delay_ms = 1500
request_timeout_ms = 600000
```

Config path resolution:

1. `--config <path>`
2. `AXUM_CONFIG=/path/to/config.toml`
3. `~/.axum/config.toml`

`api_key` may be a literal key or an environment reference such as `env:OPENAI_API_KEY`. For quick setup, `provider_config = "<base_url> <api_key|env:VAR> <model>"` can configure url/key/model in one line. You can also run `axum config-web` to start a temporary local web page for editing URL/key/model in the same config file. `models` is the TUI model list; when no explicit `model`/`--model` is set, `axum tui` selects the first configured model. If the list is omitted and a provider key is available, TUI tries `GET /models` even when a current model is already configured, fills the provider model list from the response, and only auto-selects the first returned model when no model was explicitly configured. Use `/providers` inside TUI to list configured providers and `/provider use <id|number>` to switch/save the default provider. Use `/provider set <url> <key> <model>` to save all three fields at once, or `/provider url <url>` and `/provider key <key>` for separate updates. Use `/model` to dynamically fetch and list provider models, then `/model 2` or `/model <id>` to switch and save the model selection. `/provider model <id>` remains available for saving a custom model id under the current provider without fetching. TUI runtime replies render as transcript-style rows for user prompts, assistant text, tool work, warnings, and blockers; `/tasks` shows the auxiliary runtime/activity dashboard. The TUI chrome uses a pi-style component boundary with a compact session header, transcript output, command suggestions, and `@earendil-works/pi-tui`'s editor component. Cursor movement, multiline editing, paste handling, undo/kill-ring behavior, and prompt history come from pi instead of Axum-owned raw key state. Typing `/` still shows Axum's command list, ↑/↓ changes the selected slash command, and `Tab` completes it; `Enter` also completes a bare incomplete slash command such as `/pro` before submission.

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

`axum workflow` renders a compact Unicode stage view by default and folds intermediate workflow steps; pass `--verbose` to expand them. `axum chat` supports OpenAI Chat Completions and OpenAI-compatible providers through `/v1/chat/completions`. Transient provider transport/upstream failures retry 8 times by default with bounded 500–1500ms jitter; legacy `retry_delay_ms` keeps fixed-delay compatibility when explicitly set. `axum providers` lists configured providers and masks literal keys; use `--json` for scripts. `axum chat`, `axum tui`, and `axum doctor` accept `--provider <id>` to temporarily use another provider from `providers.<id>` without changing the default config. `axum tui` can also read OpenAI-compatible model lists through `/v1/models`, and model-list fetches use the same retry policy. `axum doctor` checks the resolved provider config, `/v1/models`, and the same runtime/tool-call request shape used by TUI; use `axum doctor --json` for scripts and CI diagnostics, including key source, masked request previews, and categorized HTML/Cloudflare/API/transport failures. If a provider breaks the tool-call transport, the runtime retries once without tools instead of failing the whole TUI turn. `axum config-web` does not echo stored raw API keys; leave the key field blank to keep an existing key.

Useful environment variables:

- `AXUM_CONFIG`: config file path.
- `OPENAI_API_KEY`: optional API key source when config uses `api_key = "env:OPENAI_API_KEY"`.
- `AXUM_MODEL`: fallback model id, otherwise `gpt-4o-mini`.
- `AXUM_OPENAI_BASE_URL`: fallback OpenAI-compatible base URL, otherwise `https://api.openai.com/v1`.
- `AXUM_OPENAI_API_KEY_ENV`: fallback env var name for API keys.
- `AXUM_OPENAI_MAX_RETRIES`: fallback retry count for transient failures, otherwise `8`.
- `AXUM_OPENAI_RETRY_MIN_DELAY_MS`: fallback minimum retry delay in milliseconds, otherwise `500`.
- `AXUM_OPENAI_RETRY_MAX_DELAY_MS`: fallback maximum retry delay in milliseconds, otherwise `1500`.
- `AXUM_OPENAI_RETRY_DELAY_MS`: legacy fixed retry delay in milliseconds; overrides min/max when set.
- `AXUM_OPENAI_REQUEST_TIMEOUT_MS`: request timeout in milliseconds, otherwise `600000`; set `0` to disable.

## Safety boundary

This is still an early CLI/provider/runtime slice, not a hardened autonomous agent runtime. The session/event/tool-loop path now exists, and `axum parallel` has a pi-style child-task state model plus merge-review metadata, but managed child-agent execution is not enabled yet. Runtime tool execution is project-sandboxed: `read` and `precise_edit` stay inside the current workspace, while `safe_exec` accepts allowlisted commands such as `npm test` plus guarded workspace inspection commands (`pwd`, `ls`, `find`, `grep`, `cat`, `sed`, `head`, `tail`, `wc`, and read-only `git` subcommands) by splitting simple shell-like command strings into command/args without enabling arbitrary shell operators. The default TUI surface keeps runtime output in transcript-style rows instead of a single dashboard box, while `/tasks` exposes the Plan/Now/Evidence/Result/Next/Issues dashboard for activity inspection. Working status uses human-readable elapsed time (`5m 29s`, `1h 4m`), includes the latest runtime activity when available, and is rendered on the pi editor bottom border instead of inside the model/output panel. Raw pi-tui owns the live input editor directly, so the old boxed Prompt panel, fixed `prompt` label, and decorative `▌` input prefix are not rendered above the input line. Repeated identical permission denials fail fast instead of spinning until the tool-iteration limit. The next hardening step is to connect queued/running child tasks to isolated execution, cancellation, failure handling, and merge review without letting the TUI state become the source of truth.

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
