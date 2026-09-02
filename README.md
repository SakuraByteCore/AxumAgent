<p align="center">
  <a href="./LICENSE"> <img src="https://img.shields.io/badge/license-FSL--1.1--ALv2-blue?style=flat-square" alt="License"> </a>
  <a href="https://nodejs.org"> <img src="https://img.shields.io/badge/node-%3E%3D18-green?style=flat-square" alt="Node"> </a>
</p>

<div align="center">
  <h1>Axum Agent</h1>
  <p>A Pi-based coding agent distribution that bundles the Pi core with curated extensions and launches them together.</p>
</div>

> Axum Agent is built around Pi-based agent distribution. The web UI handles provider, retry, and system-prompt settings locally, and startup can be isolated with safe mode when needed.
>
> Quick Start: [Quick Start](#quick-start)
>
> Requirements: [Requirements](#requirements)
>
> Translations: [English](./README.md) • [日本語](./README.ja.md) • [中文](./README.zh-CN.md)

## Overview

Axum Agent is a Pi-based coding agent distribution package. It bundles the Pi core together with extensions and launches them together, so a single `npm install -g` gives you a ready-to-run agent with no extra wiring.

## Highlights

- **One-command install** — global npm package from the main branch tarball, no clone or build step.
- **Bundled extensions** — Pi core plus a hand-picked set of extensions ship together and start together.
- **Web-based config** — provider, retry, and system-prompt settings live in a local web UI.
- **Safe mode** — any broken extension can be bypassed to launch only the Pi core.
- **Self-contained runtime** — the bundled Pi runtime lives in the user cache, so reinstalling Axum does not repeat first-run setup.

## Requirements

- **Node.js** >= 22.19.0
- **npm** >= 9
- A terminal on macOS, Linux, or Windows; Android/Termux is supported too.
- An OpenAI-compatible API key (or any provider you configure in the web UI).

## Quick Start

Install Axum globally from the main branch tarball:

```bash
npm install -g https://github.com/SakuraByteCore/AxumAgent/archive/refs/heads/main.tar.gz
```

Start the agent directly:

```bash
axum
```

Configure your Provider and System Prompt on the Web UI:

```bash
axum web
```

Launch the agent:

```bash
axum code
```

> Tip: in a repository checkout, run `node bin/axum.js code` (or the installed `code` command) to skip the `npm run` wrapper and shave ~0.2s off every startup.

Delegate subagent work from the prompt; the bundled `task` tool spawns single or batched subagents automatically:

```text
Find all files that handle authentication and summarize how the login flow works.
```

Open the bundled pi-plugins skill guide for plugin management workflows:

```text
/plugin-create-mode
```


```bash
axum code --safe
```

Check health:

```bash
axum doctor
```

## Bundled Runtime

The distribution ships these packages, all in one install:

- `@earendil-works/pi-coding-agent`
- `pi-bar` (AxumAgent bundled fork)
- `pi-header` (AxumAgent bundled fork)
- `pi-companion` (merged pi-shortcuts + pi-guard: slash shortcuts, response guard, advisory watcher)
- `@narumitw/pi-goal`
- `pi-hashline-edit-pro`
- `pi-task` (local task-delegation plugin: single or batched subagent fan-out, modeled after oh-my-pi)
- `pi-memory`
- `pi-agent` (vendored from @giladbarnea/pi-user-agents: user-triggered background agents with live progress widget)

## Configure an OpenAI-compatible Provider

Save it from the Provider tab in `axum web` (see [Quick Start](#quick-start) for how to launch).

Fields:

- **Base URL**, e.g. `https://api.moonshot.cn/v1`
- **API Key**
- **Model**. Providers without `/models` can be entered manually.

Saved to:

- `~/.pi/agent/models.json`
- `~/.pi/agent/axum.json`

After saving, launch the agent again:

```bash
axum code
```

For compatibility, OpenAI-compatible providers default to `supportsDeveloperRole=false` / `supportsReasoningEffort=false`.

## Retry Settings

In the retry tab of `axum web`, configure the automatic retry strategy for failed API requests (see [Quick Start](#quick-start) for how to launch).

Options:

- **Enable retry** — default off. Pi core defaults to on, but Axum requires explicit enablement.
- **Max retry count** — default `3`.
- **Base backoff delay (ms)** — default `2000`. Exponential backoff: `baseDelayMs * 2^(attempt-1)`.

Retries target overload, rate-limit, and server errors. Context overflow is **not** retried (it is handled by compaction).

Saved to:

- `~/.pi/agent/settings.json`

## Edit the System Prompt

Edit it from the System Prompt tab in `axum web` (see [Quick Start](#quick-start) for how to launch).

Defaults to:

```text
~/.pi/agent/SYSTEM.md
```

Targets:

- **Global `SYSTEM.md`** — default. Replaces the standard prompt.
- **Global `APPEND_SYSTEM.md`** — appends to the standard prompt.
- **Project `APPEND_SYSTEM.md`** — `<cwd>/.pi/APPEND_SYSTEM.md`.
- **Project `SYSTEM.md`** — `<cwd>/.pi/SYSTEM.md`.

It shows a diff before saving. If the file was changed externally, saving is refused.

## Customize the `/plan` Prompt

`/plan` supports a user-level prompt override file:

```text
~/.pi/agent/plan-prompt.md
```

Rules:

- If the file does not exist, Axum falls back to the built-in `/plan` prompt.
- If the file exists, Axum uses its content as the `/plan` prompt template.
- The file must include the placeholder `{{requirement}}` so Axum knows where to inject the user requirement.
- If the file exists but is empty, or does not contain `{{requirement}}`, `/plan` stops with an error instead of sending a broken prompt.

Example:

```md
[Requirement]
{{requirement}}

[Expectation]
Describe the expected outcome in plain language, including visible behavior, boundaries, and any missing information that must be confirmed first.

[Instructions]
Research the current implementation first, then propose a plan, risks, compatibility impact, and validation approach. Do not write code yet.
```

## Doctor

```bash
axum doctor
```

`doctor` checks the bundled Pi cache and entrypoint.

Safe mode (`axum code --safe`) launches the Pi core without loading `pi-edit` / `pi-bar` / `pi-goal` / `pi-header` / `pi-web-access` / `pi-hashline-edit-pro` / `pi-task` / `pi-memory` / `pi-agent`.


The bundled Pi runtime is stored in the user cache, not the npm global package directory. So reinstalling Axum usually does not repeat the first-run setup of `axum code`.

## Update

```bash
axum update
```

Reinstalls the npm global package from the main branch tarball on GitHub. There is usually no need to rerun the first-run setup afterwards.

## License

Axum Agent is released under the **FSL-1.1-ALv2** license: Functional Source License, Version 1.1, ALv2 Future License. The future license grant is Apache License 2.0. See [LICENSE](./LICENSE) for details.

## Translations

- [English](./README.md) (current)
- [日本語](./README.ja.md)
- [中文](./README.zh-CN.md)
