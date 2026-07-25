# Axum Agent

Axum Agent is a Pi-based coding-agent distribution. It launches Pi with the extension stack already bundled, so users do not need to run separate `pi install` commands for subagents or Magic Context.

Bundled runtime:

- `@earendil-works/pi-coding-agent`
- `pi-subagents`
- `@cortexkit/pi-magic-context`

## Install

Until `axum-agent` is published to npm, install the GitHub source tarball:

```bash
npm install -g https://github.com/SakuraByteCore/AxumAgent/archive/refs/heads/main.tar.gz
```

If you install from the npm registry after publication, the command becomes:

```bash
npm install -g axum-agent
```

Avoid `npm install -g github:SakuraByteCore/AxumAgent#main` on npm 10 unless you also pass `--install-links=true`; npm can leave a broken global symlink for GitHub shorthand installs.

## Use

```bash
axum
```

All arguments are passed through to Pi:

```bash
axum --print "inspect this repository"
axum --help
```

## Configure an OpenAI-compatible provider

The easiest path is the temporary local web setup page:

```bash
axum provider web
```

Open the printed local URL, fill in:

- Base URL, for example `https://api.moonshot.cn/v1`
- API Key
- Model selected from the fetched model list, or typed manually if the provider does not expose `/models`

The page saves Pi's `~/.pi/agent/models.json` and Axum's default provider/model selection. It does not show copy-paste commands after saving; close the page and run:

```bash
axum
```

CLI provider commands remain available for automation:

```bash
axum provider add-openai \
  --name kimi \
  --base-url https://api.moonshot.cn/v1 \
  --model kimi-k2-0711-preview \
  --api-key-env KIMI_API_KEY

axum provider list
axum provider test --provider kimi --model kimi-k2-0711-preview
```

For OpenAI-compatible servers, Axum defaults to the conservative compatibility flags `supportsDeveloperRole=false` and `supportsReasoningEffort=false`. If your provider supports those OpenAI features, pass `--supports-developer-role` and/or `--supports-reasoning-effort` when adding the provider by CLI.

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
