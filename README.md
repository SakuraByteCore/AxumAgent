# Axum Agent

Axum Agent is a Pi-based coding-agent distribution. It launches Pi with the extension stack already bundled, so users do not need to run separate `pi install` commands for subagents or Magic Context.

Bundled runtime:

- `@earendil-works/pi-coding-agent`
- `pi-subagents`
- `@cortexkit/pi-magic-context`

## Install

```bash
npm install -g axum-agent
```

## Use

```bash
axum
```

All arguments are passed through to Pi:

```bash
axum --print "inspect this repository"
axum --help
```

## Doctor

```bash
axum doctor
```

`doctor` verifies that the bundled Pi CLI and bundled extension entrypoints are present.

## Extension behavior

Axum starts Pi with these extension entrypoints preloaded:

- `pi-subagents/index.ts`
- `@cortexkit/pi-magic-context/dist/index.js`

This gives users the installed-package experience directly from Axum. No separate `pi install npm:pi-subagents` or `pi install npm:@cortexkit/pi-magic-context` step is required.

Magic Context may still create or use its own runtime data/config according to the upstream extension behavior. Axum does not hard-code a user home directory or machine-specific path.
