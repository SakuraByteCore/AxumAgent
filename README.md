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

Start a background subagent from the prompt:

```text
/subagent Explore find all files that handle authentication
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
- `pi-shortcuts` (merged pi-plan + pi-clear + /subagent + /plugin-create-mode)
- `@narumitw/pi-goal`
- `pi-guard`
- `@tintinweb/pi-subagents`

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

## Doctor

```bash
axum doctor
```

`doctor` checks the bundled Pi cache and entrypoint.

If a broken extension prevents normal startup, use `axum code --safe` to launch only the Pi core with `-ne`, without loading `pi-bar` / `pi-header` / `pi-shortcuts` / `pi-goal` / `pi-guard` / `@tintinweb/pi-subagents`.

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
