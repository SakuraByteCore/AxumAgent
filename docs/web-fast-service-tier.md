# Web Fast service tier

Run `axum web`, open **Provider**, then use **Fast service tier** below max output tokens and save. The checkbox defaults off and applies to the models saved in that provider form. It is disabled for non-OpenAI protocols. English, Japanese and Chinese labels are included.

The setting is Axum-owned metadata in the agent directory’s `axum.json` (`fastModels`, keyed by provider ID and model ID). It does not add unsupported properties to Pi’s `models.json`, change the selected model, or affect unrelated providers. It is a provider/model preference, not a new per-session flag. Saving off removes the selection; the next request, including in an existing session, is assembled without Axum’s `service_tier` field.

`axum chat` starts the packaged Pi Web server with an Axum-owned Node preload. A narrowly matched, checked in-memory transform decorates the Pi SDK’s existing `onPayload` callback after extension hooks. The OpenAI Responses/Chat adapters invoke that callback on their final request JSON. Only selected `openai-responses` and `openai-completions` models receive top-level literal `service_tier: "fast"`; no `priority` substitution, global fetch patch, installed dependency edits, or extra deployment step is used. A changed SDK callback fails explicitly instead of pretending the setting worked.

Web host continuations and retries reuse the same SDK payload callback. Web’s in-process child sessions use their own resolved provider/model, so the preference follows that model rather than forcibly inheriting a parent’s request flag. Tool-free chat sessions also work (the implementation does not rely on extensions being enabled). Terminal `axum code` and other protocols are untouched.

Verification uses only local mock upstreams. `test/fast-service-tier.test.js` captures real SDK HTTP bodies for Chat and Responses off/on/off, including repeated prompts in a running session. `test/fast-web-control.test.js` executes the actual rendered checkbox save handler against the authenticated Web API. Neither test needs a paid upstream account.
