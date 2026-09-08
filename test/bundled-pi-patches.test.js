import assert from "node:assert/strict";
import test from "node:test";

import {
  PI_RATE_LIMIT_429_PATTERN_SOURCE,
  PI_SUBAGENTS_PROACTIVE_MARKER,
  LEGACY_PI_SUBAGENTS_PROACTIVE_MARKER,
  applyBundledPiPatches,
  patchPiSubagentsProactiveDelegation,
  patchPiAiRateLimitRetry,
  patchPiAgentSessionRateLimitRetry,
  patchPiHttpIdleTimeoutDefault,
  patchPiTuiStdinBuffer,
} from "../src/bundled-pi-patches.js";

test("429 pattern matches strict provider throttle shapes only", () => {
  const re = new RegExp(PI_RATE_LIMIT_429_PATTERN_SOURCE, "i");
  assert.ok(re.test("Error: 429: {\"message\":\"Too Many Requests\"}"));
  assert.ok(re.test("429 Too Many Requests"));
  assert.ok(re.test("  Error: 429: quota"));
  assert.equal(re.test("the file is 429 bytes long"), false);
  assert.equal(re.test("status 1429"), false);
});

test("patchPiTuiStdinBuffer throws when the paste constants are absent", () => {
  assert.throws(
    () => patchPiTuiStdinBuffer("const X = 1;"),
    /paste constants not found/,
  );
});

test("patchPiTuiStdinBuffer inserts the unbracketed-paste guard and is idempotent", () => {
  const content = [
    'const BRACKETED_PASTE_START = "\\x1b[200~";',
    'const BRACKETED_PASTE_END = "\\x1b[201~";',
    'class Parser {',
    '    process(str) {',
    '        if (str.length === 0 && this.buffer.length === 0) {',
    '            this.emitDataSequence("");',
    '            return;',
    '        }',
    '    }',
    '}',
    '',
  ].join("\n");
  const once = patchPiTuiStdinBuffer(content);
  assert.ok(once.includes("looksLikeUnbracketedPaste"));
  assert.ok(once.includes('this.emit("paste", str);'));
  const twice = patchPiTuiStdinBuffer(once);
  assert.equal(twice, once);
});

test("applyBundledPiPatches throws for a cache root without installed packages", () => {
  assert.throws(
    () => applyBundledPiPatches({ env: { ...process.env, AXUM_BUNDLED_PI_DIR: "/nonexistent-axum-cache" } }),
    /stdin buffer not found/,
  );
});

test("patchPiSubagentsProactiveDelegation rewrites passive tool wording and is idempotent", () => {
  const content = [
    'export const SUBAGENT_TOOL_PROMPT_SNIPPET = "Delegate to subagents; orchestrate in one workflowScript call.";',
    'const guideline = `Use subagent only when delegation is needed. keep`;',
  ].join("\n");
  const once = patchPiSubagentsProactiveDelegation(content);
  assert.ok(once.includes(PI_SUBAGENTS_PROACTIVE_MARKER));
  assert.ok(once.includes("Delegate aggressively to subagents"));
  assert.ok(once.includes("token cost is irrelevant"));
  assert.ok(once.includes("Default to subagent delegation"));
  assert.ok(!once.includes("Use subagent only when delegation is needed"));
  const twice = patchPiSubagentsProactiveDelegation(once);
  assert.equal(twice, once);
});

test("patchPiSubagentsProactiveDelegation upgrades a V1-patched bundle and clears the legacy marker", () => {
  const v1Patched = [
    "// " + LEGACY_PI_SUBAGENTS_PROACTIVE_MARKER + ": proactive delegation triggers (Axum).",
    'export const SUBAGENT_TOOL_PROMPT_SNIPPET = "Delegate proactively to subagents; orchestrate in one workflowScript call. When the request carries multiple independent tasks or requirements, partition them into non-overlapping scopes and launch all of them in one async workflow immediately, without a long planning pass first.";',
    'const guideline = `Use subagent proactively; do not wait for the user to explicitly request delegation. keep`;',
  ].join("\n");
  const upgraded = patchPiSubagentsProactiveDelegation(v1Patched);
  assert.ok(upgraded.includes(PI_SUBAGENTS_PROACTIVE_MARKER));
  assert.ok(!upgraded.includes(LEGACY_PI_SUBAGENTS_PROACTIVE_MARKER + ": proactive delegation triggers"));
  assert.ok(upgraded.includes("Delegate aggressively to subagents"));
  assert.ok(upgraded.includes("Default to subagent delegation"));
  assert.equal(patchPiSubagentsProactiveDelegation(upgraded), upgraded);
});

test("patchPiSubagentsProactiveDelegation skips upstream content that drifted", () => {
  const drifted = "export const SUBAGENT_TOOL_PROMPT_SNIPPET = \"something new\";";
  assert.equal(patchPiSubagentsProactiveDelegation(drifted), drifted);
});

test("patchPiAiRateLimitRetry keeps upstream exponential backoff on the non-429 lane", () => {
  const stock = [
    "class RetrySleepAbortError extends Error {",
    "    let attempt = 0;",
    "    let lastRetry;",
    "        // Non-retryable, or budget exhausted: return the final error message.",
    "        if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {",
    "            if (lastRetry)",
    "                await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);",
    "            return response;",
    "        }",
    "        attempt++;",
    "        lastRetry = { attempt, errorMessage: response.errorMessage || \"Unknown error\" };",
    "        const delayMs = policy.baseDelayMs * 2 ** (attempt - 1);",
    "        await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);",
    "            await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);",
  ].join("\n");
  const patched = patchPiAiRateLimitRetry(stock);
  assert.ok(patched.includes("delayMs = policy.baseDelayMs * 2 ** (attempt - 1);"));
  assert.ok(patched.includes("delayMs = jitteredDelay(policy?.fixedDelayMs ?? RATE_LIMIT_DELAY_MS);"));
  assert.equal(patchPiAiRateLimitRetry(patched), patched);
});

test("patchPiAgentSessionRateLimitRetry keeps upstream exponential backoff on the non-429 lane", () => {
  const stock = [
    "export class AgentSession {",
    "    _retryAttempt = 0;",
    "                if (assistantMsg.stopReason !== \"error\" && this._retryAttempt > 0) {",
    "                    this._emit({",
    "                        type: \"auto_retry_end\",",
    "                        success: true,",
    "                        attempt: this._retryAttempt,",
    "                    });",
    "                    this._retryAttempt = 0;",
    "                }",
    "        if (msg.stopReason === \"error\" && this._retryAttempt > 0) {",
    "            this._emit({",
    "                type: \"auto_retry_end\",",
    "                success: false,",
    "                attempt: this._retryAttempt,",
    "                finalError: msg.errorMessage,",
    "            });",
    "            this._retryAttempt = 0;",
    "        }",
    "        const settings = this.settingsManager.getRetrySettings();",
    "        if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {",
    "            return false;",
    "        }",
    "        for (let i = event.messages.length - 1; i >= 0; i--) {",
    "            const message = event.messages[i];",
    "            if (message.role === \"assistant\") {",
    "                return this._isRetryableError(message);",
    "            }",
    "        }",
    "        return false;",
    "        this._retryAttempt++;",
    "        if (this._retryAttempt > settings.maxRetries) {",
    "            // Preserve the completed attempt count so post-run handling can emit the final failure.",
    "            this._retryAttempt--;",
    "            return false;",
    "        }",
    "        const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);",
    "        this._emit({",
    "            type: \"auto_retry_start\",",
    "            attempt: this._retryAttempt,",
    "            maxAttempts: settings.maxRetries,",
    "            delayMs,",
    "            errorMessage: message.errorMessage || \"Unknown error\",",
    "        });",
    "            const attempt = this._retryAttempt;",
    "            this._retryAttempt = 0;",
  ].join("\n");
  const patched = patchPiAgentSessionRateLimitRetry(stock);
  assert.ok(patched.includes("delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);"));
  assert.ok(patched.includes("delayMs = jitteredDelay(settings.fixedDelayMs ?? RATE_LIMIT_DELAY_MS);"));
  assert.equal(patchPiAgentSessionRateLimitRetry(patched), patched);
});

test("patchPiSubagentsProactiveDelegation converges a legacy-marked bundle with drifted text", () => {
  const legacyOnly = [
    "// " + LEGACY_PI_SUBAGENTS_PROACTIVE_MARKER + ": proactive delegation triggers (Axum).",
    "export const SUBAGENT_TOOL_PROMPT_SNIPPET = \"older axum wording no current variant knows\";",
  ].join("\n");
  const upgraded = patchPiSubagentsProactiveDelegation(legacyOnly);
  assert.ok(upgraded.includes(PI_SUBAGENTS_PROACTIVE_MARKER));
  assert.ok(!upgraded.includes(LEGACY_PI_SUBAGENTS_PROACTIVE_MARKER + ": proactive delegation triggers"));
  assert.ok(upgraded.includes("older axum wording no current variant knows"));
  assert.equal(patchPiSubagentsProactiveDelegation(upgraded), upgraded);
});

test("patchPiHttpIdleTimeoutDefault upgrade does not duplicate the headers cap constant", () => {
  const legacyGen = [
    "// AXUM_PI_HTTP_IDLE_TIMEOUT_BODYPATCH: earlier generation rationale.",
    "// More legacy rationale lines are consumed by the upgrade pattern.",
    "export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 60_000;",
    "const HTTP_HEADERS_TIMEOUT_CAP_MS = 90_000;",
    "const dispatcher = {",
    "  headersTimeout: normalizedTimeoutMs,",
    "};",
  ].join("\n");
  const patched = patchPiHttpIdleTimeoutDefault(legacyGen);
  assert.equal(patched.split("const HTTP_HEADERS_TIMEOUT_CAP_MS =").length - 1, 1);
  assert.ok(patched.includes("export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 0;"));
  assert.equal(patchPiHttpIdleTimeoutDefault(patched), patched);
});
