# AxumAgent

AxumAgent is a TypeScript CLI prototype aligned toward `earendil-works/pi`-style provider and agent ergonomics.

- `src/`: TypeScript CLI/provider layer.
- `src/providers/openai-chat.ts`: OpenAI Chat Completions and OpenAI-compatible provider.
- `bin/axum.js`: npm binary shim that runs the built TypeScript CLI.
- `dist/`: committed build output for install-time execution.

## Current shape

The repository is now TypeScript-only. The previous Rust workspace and prebuilt binary artifacts were removed to avoid large local/remote footprint.

## Requirements

- Node.js.
- npm.

## Quick checks

```bash
npm test
npm run build
node bin/axum.js --help
```

## CLI examples

```bash
npm test
node bin/axum.js --help
OPENAI_API_KEY=... node bin/axum.js chat --model gpt-4o-mini "Say hello"
AXUM_OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_API_KEY=ollama node bin/axum.js chat --model llama3.1 "Say hello"
```

`axum chat` supports OpenAI Chat Completions and OpenAI-compatible providers through `/v1/chat/completions`.

Useful environment variables:

- `OPENAI_API_KEY`: default API key source.
- `AXUM_MODEL`: default model id, otherwise `gpt-4o-mini`.
- `AXUM_OPENAI_BASE_URL`: OpenAI-compatible base URL, otherwise `https://api.openai.com/v1`.
- `AXUM_OPENAI_API_KEY_ENV`: alternate env var name for API keys.

## Safety boundary

This is still an early CLI/provider slice, not a hardened autonomous agent runtime. The next hardening step is to add explicit session/event/tool-loop semantics and provider config loading before expanding file or shell tools.
