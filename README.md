# AxumAgent

AxumAgent is a small Rust/Node prototype for a local agent runtime:

- `axum-cli`: command-line client.
- `axum-server`: Axum HTTP/SSE server for queued runs.
- `axum-runtime`: hook-driven agent loop.
- `axum-policy`: authorization policy layer.
- `axum-tools`: built-in demo tools.
- `axum-llm`: OpenAI-compatible planning adapter.
- `bin/axum.js`: npm binary shim that builds/runs the Rust CLI.

## Current shape

This repository is not an Android app. It is an agent runtime/server/CLI workspace with prebuilt artifacts for several targets, including Android aarch64 binaries.

## Requirements

- Node.js for the npm wrapper.
- Rust toolchain for workspace builds.

## Quick checks

```bash
npm test
cd rs
cargo check --workspace
cargo test --workspace
```

## CLI examples

```bash
npm test
node bin/axum.js --help
node bin/axum.js validate --spawn-server
node bin/axum.js run "echo hello" --spawn-server
```

The CLI can start a managed local server when `--spawn-server` is passed to commands that support it, such as `run` and `validate`.

## Safety boundary

The current demo server wires an allow-all policy and filesystem read tool inside the current working directory sandbox. Treat it as a local prototype, not a hardened multi-user service.

## Android artifacts

The old Android aarch64 prebuilts were removed during the Axum rename because their embedded strings still referenced the old name. Rebuild them with an Android NDK that provides `aarch64-linux-android-clang`.
