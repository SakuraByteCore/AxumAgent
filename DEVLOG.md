# DEVLOG

## 2026-07-13

Direction changed toward a pi-aligned CLI with a TypeScript user-facing layer.

Work added:
- TypeScript CLI entrypoint under `src/`.
- OpenAI Chat Completions / OpenAI-compatible provider path for `axum chat`.
- Node shim now runs the TypeScript CLI directly.
- Mock HTTP regression test proving `axum chat` sends `/v1/chat/completions` requests with model, system/user messages, and bearer auth.
- Removed the old Rust workspace and prebuilt artifacts to avoid large disk usage and keep the project TS-only.
- OpenAI-compatible chat requests now retry transient transport/upstream failures 10 times by default, configurable with CLI flags or environment variables.
- Added user-level TOML config loading (`~/.axum/config.toml`, `AXUM_CONFIG`, or `--config`) so provider settings can live outside project directories.
- Prepared npm packaging as `axum-agent` with committed dist output, `axum` binary, package exports, package metadata, MIT license, and dry-run pack script.
- Added a lightweight pi-style terminal UI command, `axum tui`, with a boxed terminal layout and `--dry-run` preview mode.
- Refined `axum tui` toward a Codex-like terminal layout with a top status line, conversation stream, and bottom message input.
- Fixed no-prompt `axum tui` so it stays open for interactive input instead of rendering once and exiting.
- Added Codex-like TUI behavior: dynamic terminal width, TTY alternate-screen redraws, and `--no-alt-screen` for scrollback-preserving sessions.
- Replaced the fake message box with raw TTY input rendering so typed characters appear inside the message frame before Enter sends.
- Moved TUI shortcut help below the message frame and added an in-frame cursor marker so the active input area is visible.
- Added an npm `postinstall` hook that creates `~/.axum/config.toml` with an OpenAI-compatible template when missing, without overwriting existing config.
- Reworked `axum tui` empty state toward a compact Codex-like startup card with version/model/directory/permissions, a short tip, an inline prompt, bottom status, a dynamically updating Codex-like working timer, no cursor rendered after placeholder suggestions, and no user/assistant labels in the conversation body.

Validation:
- `npm test` builds TypeScript, checks generated JS, and runs the OpenAI-compatible mock CLI regression.

## 2026-07-12

Continued `SakuraByteCore/AxumAgent` from a clean clone. This section documents the old Rust prototype baseline before the repository was simplified to TypeScript-only on 2026-07-13.

Baseline:
- `npm test` passes.
- `cargo check --workspace` passes with one existing dead-code warning in `axum-server`.
- `cargo test --workspace` passes, but the original repository had no effective unit tests.

Work added:
- Root README documenting project shape, checks, CLI examples, and current safety boundary.
- TODO tracking next decisions and hardening gaps.
- Unit tests for policy, tools, and runtime basics.

Validation:
- `node bin/axum.js validate --spawn-server` starts a managed server and returns `ok`.
- `node bin/axum.js run "echo hello" --spawn-server --max-steps 2` completes the demo runtime loop through echo tool and finish action.

Rename validation:
- Replaced source/package/bin/crate naming from the old name to `axum`.
- Rebuilt Linux and Windows artifacts from renamed sources.
- Removed stale Android prebuilts because this host lacks `aarch64-linux-android-clang`; Android artifacts must be rebuilt with NDK.
