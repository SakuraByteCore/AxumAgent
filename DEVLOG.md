# DEVLOG

## 2026-07-17

Work added:
- Reworked the workflow skeleton from basic pi-style events into a Codex-style Plan/Execute shape with request/tool hash anchors and bounded auto-fix loop metadata.
- Added a Kilo/Codex-inspired tool registry for precise local edit, safe command sandbox, and LSP symbol lookup surfaces.
- Added permission-gated runtime executors for precise local edits, safe allowlisted commands, and lightweight TypeScript symbol lookup.
- Added `axum parallel` as the first swarm/sub-agent planning surface, persisting planned fan-out tasks with a hash-anchor merge policy.
- Added TUI `/parallel <goal> :: <task> | <task>` so the interactive shell can plan swarm fan-out without leaving the session.
- Added provider-layer safety guard helpers that correct unsupported message/tool-call shapes before OpenAI-compatible transport.
- Replaced the fake workflow-only execution path with a Codex-like TypeScript runtime split into protocol, event bus, session, turn loop, and tool-runner layers.
- Routed `axum chat` through the runtime session so model sampling can request gated tools, feed tool output back into the next sampling request, and emit turn lifecycle events.
- Added OpenAI Chat tool-call transport support while preserving retry behavior and tool-role message forwarding.
- Hardened TUI display-width helpers so clipping, wrapping, and slash-command padding use terminal cell width instead of JavaScript string length for wide/combining Unicode.
- Added a 51-column TTY regression with Chinese/wide-symbol input to guard against pi-tui `exceeds terminal width` crashes after the Termux fix.

Validation:
- `npm test` passes after workflow/tool/swarm/runtime guard changes.
- `npm run pack:dry` passes; package dry-run includes the new `dist/runtime/events.js`, `protocol.js`, `session.js`, `tool-runner.js`, and `turn.js` files.


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
- Reworked `axum tui` empty state toward a compact Codex-like startup card with version/model/directory/permissions, a short tip, an inline prompt, bottom status, a dynamically updating Codex-like working timer, no placeholder/cursor rendered without user input, no user/assistant labels in the conversation body, and OpenAI-compatible SSE streaming updates while answers arrive.
- Added TUI model discovery and switching: config can provide `models = [...]`, TUI defaults to the first configured/fetched model, OpenAI-compatible `/models` is used when the list is omitted even if a current model is already configured, `/provider url` and `/provider key` can save missing provider settings from inside TUI and immediately show the refreshed model list when fetch succeeds, `/provider models` lists models and `/provider model <id|number>` switches models by number/id, the empty input keeps an active cursor, ←/→ move the cursor for in-line edits, typing `/` shows a two-column command list with a selected item that `Tab` completes, and ↑/↓ recalls previous inputs when the slash command list is not active.
- Moved raw TTY rendering/input onto `@earendil-works/pi-tui` and added xterm-backed TUI screenshot snapshot tests for the slash command palette and remote model list layout.
- Reworked the TUI chrome toward Kilo/kilocode’s compact command/model picker style: tight title metadata, no fake tip/card, unified `▸` selection gutter, and updated screenshots as regression snapshots.
- Restored `/model` as the dynamic provider model command: `/model` fetches and lists current provider models, `/model <id|number>` refreshes then switches/saves, while `/provider model <id>` remains a custom-id persistence path.
- Added raw TUI paste handling for `Shift+Insert`/bracketed paste and multi-character input chunks, with a TTY regression covering pasted prompt submission.
- Capped long TUI model-list rendering so oversized provider model lists keep the first entries, current model, and hidden-count markers visible instead of pushing earlier models off-screen.
- Split raw TUI transient Working status from persistent output so command results/model lists are not replaced by the Working indicator while a request is running.
- Added a default concise AxumAgent system prompt for `chat` and TUI provider calls so short or ambiguous inputs stay natural and brief instead of turning into encyclopedia-style explanations; explicit `--system` still overrides it.
- Added configurable provider request timeouts (`request_timeout_ms`, `--request-timeout-ms`, `AXUM_OPENAI_REQUEST_TIMEOUT_MS`) with a 10-minute default and `0` disable option so long requests fail predictably instead of hanging indefinitely.
- Changed raw TUI busy-state interrupt handling so `Esc`/`Ctrl-C` cancels only the active provider request and returns to the prompt instead of exiting the TUI during a request.
- Added one-line provider setup via config `provider_config = "<base_url> <api_key|env:VAR> <model>"` and TUI `/provider set <url> <key> <model>`.
- Added `axum config-web`, a temporary local web page for editing provider URL/key/model in the same config file.
- Hardened `config-web` so env-referenced API keys stay as `env:...` and raw stored keys are not echoed into the page; leaving the key blank preserves the existing key.
- Added `axum doctor` for provider config and `/models` connectivity checks, including `--json` output for scripts.
- Added `axum init` for safe manual config creation with one-line provider setup and no overwrite unless `--force` is used.
- Removed install-time config mutation; npm install no longer writes `~/.axum/config.toml`, and users initialize explicitly with `axum init`.
- Removed the now-unused `bin/create-default-config.js` helper from the shipped package surface.
- Added `axum --version` / `-v` for installed CLI identification.
- Added `--provider <id>` for chat, TUI, and doctor so users can select a configured provider without editing the default.
- Added `axum providers` / `--json` to discover configured provider ids without exposing literal API keys.
- Documented the release checklist and corrected install/config wording to make `axum init` the explicit first-run step.
- Reworked top-level help around the product flow (`init` → `doctor` → `tui`) and separated config-web options from chat options.
- Added GitHub Actions CI for `npm test` and `npm run pack:dry` on push/PR to `main`.
- Added the first Kilo-inspired shell layer without adding a KiloCode runtime dependency: `axum modes` exposes build/plan/debug mode profiles, while `axum workflow` maps shell prompts into pi-style events, permission gates, and project-local checkpoints under `.axum/state`.
- Refined `axum workflow` output into a compact Unicode stage view: no artificial `shell:`/`runtime:` labels, intermediate setup is folded by default, and `--verbose` expands the hidden steps.

Validation:
- `npm test` builds TypeScript, checks generated JS, runs the OpenAI-compatible mock CLI regression, and compares TUI screenshot snapshots.

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
