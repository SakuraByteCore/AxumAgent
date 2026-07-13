# AxumAgent

AxumAgent is a small TypeScript/Rust prototype for a local agent runtime and CLI:

- `src/`: TypeScript CLI/provider layer for pi-aligned user-facing commands.
- `axum-cli`: command-line client.
- `axum-server`: Axum HTTP/SSE server for queued runs.
- `axum-runtime`: hook-driven agent loop.
- `axum-policy`: authorization policy layer.
- `axum-tools`: built-in demo tools.
- `axum-llm`: OpenAI-compatible planning adapter.
- `bin/axum.js`: npm binary shim that routes TypeScript CLI commands first and falls back to the Rust CLI.

## Current shape

This repository is not an Android app. It is an agent runtime/server/CLI workspace with prebuilt artifacts for several targets, including Android aarch64 binaries.

## Requirements

- Node.js for the npm wrapper and TypeScript CLI layer.
- Rust toolchain for workspace builds.

## Quick checks

```bash
npm test
npm run build
cd rs
cargo check --workspace
cargo test --workspace
```

## CLI examples

```bash
npm test
node bin/axum.js --help
OPENAI_API_KEY=... node bin/axum.js chat --model gpt-4o-mini "Say hello"
AXUM_OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_API_KEY=ollama node bin/axum.js chat --model llama3.1 "Say hello"
node bin/axum.js validate --spawn-server
node bin/axum.js run "echo hello" --spawn-server
```

`axum chat` is the first pi-aligned TypeScript path. It supports OpenAI Chat Completions and OpenAI-compatible providers through `/v1/chat/completions`.

Useful environment variables:

- `OPENAI_API_KEY`: default API key source.
- `AXUM_MODEL`: default model id, otherwise `gpt-4o-mini`.
- `AXUM_OPENAI_BASE_URL`: OpenAI-compatible base URL, otherwise `https://api.openai.com/v1`.
- `AXUM_OPENAI_API_KEY_ENV`: alternate env var name for API keys.

The CLI can start a managed local server when `--spawn-server` is passed to commands that support it, such as `run` and `validate`.

## Safety boundary

The current demo server wires an allow-all policy and filesystem read tool inside the current working directory sandbox. Treat it as a local prototype, not a hardened multi-user service.

## Android artifacts

The old Android aarch64 prebuilts were removed during the Axum rename because their embedded strings still referenced the old name. Rebuild them with an Android NDK that provides `aarch64-linux-android-clang`.
