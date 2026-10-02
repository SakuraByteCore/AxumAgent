import assert from "node:assert/strict";
import test from "node:test";

import {
  PI_RATE_LIMIT_429_PATTERN_SOURCE,
  PI_SUBAGENTS_PROACTIVE_MARKER,
  LEGACY_PI_SUBAGENTS_PROACTIVE_MARKER,
  applyBundledPiPatches,
  patchPiSubagentsProactiveDelegation,
  patchPiSubagentsLatencyOrchestrator,
  PI_SUBAGENTS_LATENCY_ORCHESTRATOR_MARKER,
  LEGACY_PI_SUBAGENTS_LATENCY_ORCHESTRATOR_MARKER,
  patchPiAiRateLimitRetry,
  patchPiAgentSessionRateLimitRetry,
  patchPiHttpIdleTimeoutDefault,
  patchPiTuiStdinBuffer,
  patchPiExtensionTerminalInputFocusGate,
  PI_EXTENSION_TERMINAL_INPUT_FOCUS_GATE_MARKER,
  patchPiExtensionSelectorScroll,
  PI_EXTENSION_SELECTOR_SCROLL_MARKER,
  PI_CONNECTION_ERROR_PATTERN_SOURCE,
  PI_ASSISTANT_CONNECTION_DISPLAY_MARKER,
  PI_INTERACTIVE_CONNECTION_DISPLAY_MARKER,
  patchPiAssistantMessageErrorDedup,
  patchPiAssistantMessageConnectionDisplay,
  patchPiInteractiveErrorDedup,
  patchPiInteractiveRateLimitDisplay,
  patchPiInteractiveConnectionDisplay,
  patchPiUserAgent,
  patchPiAiUserAgent,
  PI_USER_AGENT_CUSTOM_MARKER,
  patchPiLoadedSkillsExtensionsHide,
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
    "        if (message.stopReason === \"error\" && this._retryAttempt > 0) {",
    "            this._emit({",
    "                type: \"auto_retry_end\",",
    "                success: false,",
    "                attempt: this._retryAttempt,",
    "                finalError: message.errorMessage,",
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
    "        const delayMs = retryDelayMs(settings, this._retryAttempt);",
    "        this._emit({",
    "            type: \"auto_retry_start\",",
    "            attempt: this._retryAttempt,",
    "            maxAttempts: settings.maxRetries,",
    "            delayMs,",
    "            errorMessage: message.errorMessage || \"Unknown error\",",
    "        });",
    "        const attempt = this._retryAttempt;",
    "        this._retryAttempt = 0;",
  ].join("\n");
  const patched = patchPiAgentSessionRateLimitRetry(stock);
  assert.ok(patched.includes("delayMs = retryDelayMs(settings, this._retryAttempt);"));
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

test("patchPiExtensionTerminalInputFocusGate gates raw input on the focused editor and is idempotent", () => {
  const sample = [
    "    addExtensionTerminalInputListener(handler) {",
    "        const subscription = { handler, unsubscribe: this.ui.addInputListener(handler) };",
    "        this.extensionTerminalInputSubscriptions.add(subscription);",
    "    }",
  ].join("\n");

  const once = patchPiExtensionTerminalInputFocusGate(sample);
  assert.ok(once.includes(PI_EXTENSION_TERMINAL_INPUT_FOCUS_GATE_MARKER));
  assert.ok(once.includes("this.ui.getFocusedComponent() === this.editor ? handler(data) : undefined"));
  assert.ok(!once.includes("unsubscribe: this.ui.addInputListener(handler)"));
  // Rebind reuses subscription.handler, so it must carry the gate as well.
  assert.ok(once.includes("handler: gated, unsubscribe: this.ui.addInputListener(gated)"));

  const twice = patchPiExtensionTerminalInputFocusGate(once);
  assert.equal(twice, once);

  const drifted = sample.replace("const subscription = { handler,", "const subscription = { restructured,");
  assert.equal(patchPiExtensionTerminalInputFocusGate(drifted), drifted);
});

test("patchPiSubagentsLatencyOrchestrator upgrades the proactive protocol into the latency-first orchestrator", () => {
  const base = [
    'export const SUBAGENT_TOOL_PROMPT_SNIPPET = "Delegate to subagents; orchestrate in one workflowScript call.";',
    "const guideline = `Use subagent only when delegation is needed. keep the expert list concise: [dron,..]`",
    "export const SUBAGENT_TOOL_PROMPT_GUIDELINES = [",
    "    `Default to subagent delegation: launch async lanes in your first action; idle waiting is worse than over-delegating. ${guideline}`",
    '    "Inside workflowScript, use runs.run single key for one child, runs.all parallel children, or runs.lanes for bounded parallel sequential chains."',
    "    'Keep one writer per cwd/worktree. For advanced workflows, read the bundled pi-subagents skill or call { action: \"guide\", topic: \"workflows\" }.',",
    "];",
  ].join("\n");
  const proactive = patchPiSubagentsProactiveDelegation(base);
  assert.ok(proactive.includes(PI_SUBAGENTS_PROACTIVE_MARKER));
  const patched = patchPiSubagentsLatencyOrchestrator(proactive);
  assert.ok(patched.includes(PI_SUBAGENTS_LATENCY_ORCHESTRATOR_MARKER));
  assert.ok(patched.includes("Latency-first orchestrator: the main agent executes first"));
  assert.ok(patched.includes("never a decomposition pass or a plan"));
  assert.ok(!patched.includes("launch ALL of them in one async workflowScript call in your first action"), "up-front all-at-once dispatch must be gone");
  assert.ok(!patched.includes("Delegate aggressively to subagents"), "proactive snippet must be replaced, not duplicated");
  assert.ok(patched.includes("Latency-first budget: derive every lane timeout from one wall-clock budget"));
  assert.ok(patched.includes("Every lane returns a structured envelope: status (done|partial|blocked|failed)"));
  assert.equal(patchPiSubagentsLatencyOrchestrator(patched), patched, "idempotent");
  const commalessBase = base.replace("workflows\" }.',", "workflows\" }.'");
  const commaless = patchPiSubagentsLatencyOrchestrator(patchPiSubagentsProactiveDelegation(commalessBase));
  assert.ok(commaless.includes(PI_SUBAGENTS_LATENCY_ORCHESTRATOR_MARKER), "compiled .js variant without the trailing comma still matches");
  assert.equal(patchPiSubagentsLatencyOrchestrator("unrelated content"), "unrelated content", "drifted content is left untouched");
  const noSnippet = proactive.replace("export const SUBAGENT_TOOL_PROMPT_SNIPPET = \"Delegate aggressively to subagents", "drifted export");
  assert.equal(patchPiSubagentsLatencyOrchestrator(noSnippet), noSnippet, "snippet drift skips the patch");
});

test("connection error pattern classifies transport aborts like undici terminated", () => {
  const re = new RegExp(PI_CONNECTION_ERROR_PATTERN_SOURCE);
  assert.ok(re.test("Error: terminated"));
  assert.ok(re.test("terminated"));
  assert.equal(re.test("some unrelated model error"), false);
});

test("patchPiAssistantMessageConnectionDisplay softens connection error bubbles and is idempotent", () => {
  const stock = [
    "export class AssistantMessageComponent extends Container {",
    "    render(message) {",
    "        if (message.stopReason === \"aborted\") {",
    "            const abortMessage = message.errorMessage && message.errorMessage !== \"Request was aborted\"",
    "                ? message.errorMessage",
    "                : \"Operation aborted\";",
    "                this.contentContainer.addChild(new Spacer(1));",
    "                this.contentContainer.addChild(new Text(theme.fg(\"error\", abortMessage), this.outputPad, 0));",
    "        }",
    "        else if (message.stopReason === \"error\") {",
    "                const errorMsg = message.errorMessage || \"Unknown error\";",
    "                this.contentContainer.addChild(new Spacer(1));",
    "                this.contentContainer.addChild(new Text(theme.fg(\"error\", `Error: ${errorMsg}`), this.outputPad, 0));",
    "        }",
    "    }",
    "}",
    "",
  ].join("\n");
  const deduped = patchPiAssistantMessageErrorDedup(stock);
  const once = patchPiAssistantMessageConnectionDisplay(deduped);
  assert.ok(once.includes(PI_ASSISTANT_CONNECTION_DISPLAY_MARKER), "marker comment injected");
  assert.ok(once.includes("function isAxumConnectionErrorMessage(message)"), "classifier helper injected");
  assert.ok(once.includes("网络连接中断，已在后台自动重试；请稍候。"), "soft notice injected");
  assert.ok(once.includes("isAxumConnectionErrorMessage(errorMsg)"), "error branch consults the classifier");
  assert.ok(once.includes("theme.fg(\"error\", `Error: ${errorMsg}`)"), "non-connection errors keep the raw render");
  assert.ok(once.includes("axumLastBubbleFailure !== `error:${errorMsg}`"), "dedup key unchanged");
  assert.equal(patchPiAssistantMessageConnectionDisplay(once), once, "idempotent on re-run");
  assert.throws(
    () => patchPiAssistantMessageConnectionDisplay("const X = 1;"),
    /class anchor not found/,
  );
});

test("patchPiInteractiveConnectionDisplay softens every interactive surface and is idempotent", () => {
  const stock = [
    "export class InteractiveMode {",
    "    showError(errorMessage) {",
    "        this.chatContainer.addChild(new Spacer(1));",
    "        this.chatContainer.addChild(new ThemedText(() => theme.fg(\"error\", `Error: ${errorMessage}`), this.outputPad, 0));",
    "        this.ui.requestRender();",
    "    }",
    "    handleEvent(event, message, errorMessage, component) {",
    "        switch (event.type) {",
    "            case \"message_end\": {",
    "                    if (this.streamingMessage.stopReason === \"aborted\" || this.streamingMessage.stopReason === \"error\") {",
    "                        if (!errorMessage) {",
    "                            errorMessage = this.streamingMessage.errorMessage || \"Error\";",
    "                        }",
    "                        for (const [, component] of this.pendingTools.entries()) {",
    "                            component.updateResult({",
    "                                content: [{ type: \"text\", text: errorMessage }],",
    "                                isError: true,",
    "                            });",
    "                        }",
    "                        this.pendingTools.clear();",
    "                    }",
    "                break;",
    "            }",
    "            case \"auto_retry_end\": {",
    "                if (!event.success) {",
    "                    this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || \"Unknown error\"}`);",
    "                }",
    "                break;",
    "            }",
    "            case \"summarization_retry_scheduled\": {",
    "                this.showError(event.errorMessage);",
    "                break;",
    "            }",
    "            case \"compaction\": {",
    "                else if (event.errorMessage) {",
    "                    if (event.reason === \"manual\") {",
    "                        this.showError(event.errorMessage);",
    "                    }",
    "                    else {",
    "                        this.chatContainer.addChild(new Spacer(1));",
    "                        const errorMessage = event.errorMessage;",
    "                        this.chatContainer.addChild(new ThemedText(() => theme.fg(\"error\", errorMessage), 1, 0));",
    "                    }",
    "                }",
    "                break;",
    "            }",
    "            case \"history_replay\": {",
    "                        if (message.stopReason === \"aborted\" || message.stopReason === \"error\") {",
    "                            let errorMessage;",
    "                            if (message.stopReason === \"aborted\") {",
    "                                errorMessage = \"Operation aborted\";",
    "                            }",
    "                            else {",
    "                                errorMessage = message.errorMessage || \"Error\";",
    "                            }",
    "                            component.updateResult({ content: [{ type: \"text\", text: errorMessage }], isError: true });",
    "                        }",
    "                break;",
    "            }",
    "        }",
    "    }",
    "}",
    "",
  ].join("\n");
  const previous = patchPiInteractiveErrorDedup(patchPiInteractiveRateLimitDisplay(stock));
  const once = patchPiInteractiveConnectionDisplay(previous);
  assert.ok(once.includes(PI_INTERACTIVE_CONNECTION_DISPLAY_MARKER), "marker comment injected");
  assert.ok(once.includes("网络连接中断；请检查网络后重试。"), "showError notice injected");
  assert.ok(once.includes("isAxumConnectionErrorMessage(errorMessage)"), "showError consults the classifier");
  assert.ok(once.includes("else if (isAxumConnectionErrorMessage(event.finalError)) {"), "exhausted retry branch added");
  assert.ok(once.includes("网络持续中断，已自动重试 ${event.attempt} 次仍未成功；请检查网络后重试。"), "exhausted retry notice uses attempt count");
  assert.ok(once.includes("!isAxumConnectionErrorMessage(event.errorMessage)) {"), "summarization retry suppressed for connection errors");
  assert.ok(once.includes("isAxumConnectionErrorMessage(event.errorMessage)) {\n                        this.chatContainer.addChild(new Spacer(1));\n                        this.chatContainer.addChild(new Text(AXUM_CONNECTION_INTERRUPTED_NOTICE, 1, 0));"), "compaction row softened");
  assert.ok(once.includes("const axumToolResultText = isAxumConnectionErrorMessage(errorMessage)"), "message_end tool result softened");
  assert.ok(once.includes("text: isAxumConnectionErrorMessage(errorMessage) ? AXUM_CONNECTION_INTERRUPTED_NOTICE : errorMessage"), "history replay tool result softened");
  assert.equal(patchPiInteractiveConnectionDisplay(once), once, "idempotent on re-run");
  assert.throws(
    () => patchPiInteractiveConnectionDisplay("const X = 1;"),
    /class anchor not found/,
  );
});

test("patchPiSubagentsLatencyOrchestrator upgrades a V1 cache to the execute-first V2 protocol", () => {
  const v1Snippet = 'export const SUBAGENT_TOOL_PROMPT_SNIPPET = "Latency-first orchestrator: the main agent decomposes, dispatches, arbitrates, and verifies; subagents do the exploration and fixes. Partition 2+ independent requirements into non-overlapping lanes (scout / implementer / verifier) and launch ALL of them in one async workflowScript call in your first action - token cost is irrelevant, wall-clock latency is the only metric. Set ONE top-level timeoutMs equal to the wall-clock budget; children that omit timeoutMs inherit the host-enforced remaining budget. Steer still-running children to emit best-partial structured results at ~80% of the budget; interrupt redundant lanes once one passes an acceptance-checked verifier. Arbitrate only from structured envelopes (status, changes/findings, evidence, remainingRisks), preferring verified evidence over prose. Never write a long plan before dispatching.";';
  const v1 = [
    "// " + LEGACY_PI_SUBAGENTS_LATENCY_ORCHESTRATOR_MARKER + ": latency-first orchestrator protocol (Axum).",
    v1Snippet,
    "export const SUBAGENT_TOOL_PROMPT_GUIDELINES = [",
    "    'Latency-first budget: derive every lane timeout from one wall-clock budget.',",
    "    'Every lane returns a structured envelope: status (done|partial|blocked|failed), changes/findings, evidence, remainingRisks.',",
    "];",
    "",
  ].join("\n");
  const upgraded = patchPiSubagentsLatencyOrchestrator(v1);
  assert.ok(upgraded.includes(PI_SUBAGENTS_LATENCY_ORCHESTRATOR_MARKER), "V2 marker line replaces V1");
  assert.ok(!upgraded.includes(LEGACY_PI_SUBAGENTS_LATENCY_ORCHESTRATOR_MARKER + ":"), "V1 marker line removed");
  assert.ok(upgraded.includes("Latency-first orchestrator: the main agent executes first"), "execute-first snippet swapped in");
  assert.ok(upgraded.includes("never a decomposition pass or a plan"));
  assert.ok(!upgraded.includes("launch ALL of them in one async workflowScript call"), "up-front dispatch wording gone");
  assert.ok(upgraded.includes("Latency-first budget: derive every lane timeout"), "budget guideline carried over untouched");
  assert.ok(upgraded.includes("Every lane returns a structured envelope"), "envelope guideline carried over untouched");
  assert.equal(patchPiSubagentsLatencyOrchestrator(upgraded), upgraded, "idempotent after upgrade");
  const drifted = v1.replace("the main agent decomposes", "the main agent restructured");
  assert.equal(patchPiSubagentsLatencyOrchestrator(drifted), drifted, "drifted V1 cache is left untouched");
});

test("patchPiExtensionSelectorScroll windows the rendered list and is idempotent", () => {
  const arrow = "\u2192";
  const upstream = [
    "export class ExtensionSelectorComponent extends Container {",
    "    constructor(title, options, onSelect, onCancel, opts) {",
    "        super();",
    "        this.options = options;",
    "        this.updateList();",
    "    }",
    "    updateList() {",
    "        this.listContainer.clear();",
    "        for (let i = 0; i < this.options.length; i++) {",
    "            const isSelected = i === this.selectedIndex;",
    "            const text = isSelected",
    '                ? theme.fg("accent", "' + arrow + ' ") + theme.fg("accent", this.options[i])',
    '                : `  ${theme.fg("text", this.options[i])}`;',
    "            this.listContainer.addChild(new Text(text, 1, 0));",
    "        }",
    "    }",
    "    handleInput(keyData) {}",
    "}",
    "",
  ].join("\n");
  const once = patchPiExtensionSelectorScroll(upstream);
  assert.ok(once.includes(PI_EXTENSION_SELECTOR_SCROLL_MARKER), "marker present");
  assert.ok(once.includes("const maxVisible = Math.min(this.options.length, 10);"), "window size capped");
  assert.ok(once.includes("const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.options.length - maxVisible));"), "window centered on selection");
  assert.ok(once.includes("${this.selectedIndex + 1}/${this.options.length}"), "scroll indicator present");
  assert.ok(!once.includes("for (let i = 0; i < this.options.length; i++) {"), "full-list render gone");
  assert.equal(patchPiExtensionSelectorScroll(once), once, "idempotent on re-run");
  const drifted = upstream.replace("this.listContainer.clear();", "this.listContainer.reset();");
  assert.equal(patchPiExtensionSelectorScroll(drifted), drifted, "drifted upstream shape is left untouched");
});

const PI_AI_USER_AGENT_UPSTREAM = [
  "function loadNodeOs() {",
  "    if (typeof process === \"undefined\" || !(process.versions?.node || process.versions?.bun)) {",
  "        return null;",
  "    }",
  "    return process.getBuiltinModule?.(\"node:os\") ?? null;",
  "}",
  "// Keep runtime OS loading browser-safe. A top-level runtime import of node:os breaks browser/Vite builds.",
  "const nodeOs = loadNodeOs();",
  "export function getPiUserAgent() {",
  "    return nodeOs ? `pi (${nodeOs.platform()} ${nodeOs.release()}; ${nodeOs.arch()})` : \"pi (browser)\";",
  "}",
  "",
].join("\n");

test("patchPiAiUserAgent injects the AXUM_USER_AGENT override and is idempotent", () => {
  const once = patchPiAiUserAgent(PI_AI_USER_AGENT_UPSTREAM);
  assert.ok(once.includes(PI_USER_AGENT_CUSTOM_MARKER), "marker present");
  assert.ok(
    once.includes('if (typeof process !== "undefined" && process.env.AXUM_USER_AGENT) {'),
    "env override guard present",
  );
  assert.ok(once.includes('return nodeOs ? `pi (${nodeOs.platform()} ${nodeOs.release()}; ${nodeOs.arch()})` : "pi (browser)";'), "browser-safe fallback preserved");
  const twice = patchPiAiUserAgent(once);
  assert.equal(twice, once, "idempotent on re-run");
  assert.equal((once.match(/export function getPiUserAgent\(\)/g) || []).length, 1, "single function definition");
});

test("patchPiAiUserAgent throws when the browser-safe needle drifted", () => {
  assert.throws(
    () => patchPiAiUserAgent("export function getPiUserAgent() {\n    return \"something else\";\n}"),
    /browser-safe getPiUserAgent\(\) needle not found/,
  );
});

test("patchPiUserAgent throws when the versioned needle drifted", () => {
  assert.throws(
    () => patchPiUserAgent("export function getPiUserAgent(version) {\n    return \"drifted\";\n}"),
    /getPiUserAgent\(version\) needle not found/,
  );
});

test("patched pi-ai getPiUserAgent honours AXUM_USER_AGENT at runtime", async () => {
  const patched = patchPiAiUserAgent(PI_AI_USER_AGENT_UPSTREAM);
  const tmp = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await tmp.mkdtemp(path.join(os.tmpdir(), "pi-ai-ua-test-"));
  const file = path.join(dir, "pi-user-agent.mjs");
  await tmp.writeFile(file, patched);
  const before = process.env.AXUM_USER_AGENT;
  try {
    process.env.AXUM_USER_AGENT = "codex_cli_rs/0.125.0 (Ubuntu 22.4.0; x86_64) xterm-256color";
    const mod = await import(`file://${file}`);
    assert.equal(mod.getPiUserAgent(), "codex_cli_rs/0.125.0 (Ubuntu 22.4.0; x86_64) xterm-256color");
    delete process.env.AXUM_USER_AGENT;
    assert.ok(mod.getPiUserAgent().startsWith("pi ("), "falls back to the pi formula without env");
  } finally {
    if (before === undefined) delete process.env.AXUM_USER_AGENT;
    else process.env.AXUM_USER_AGENT = before;
    await tmp.rm(dir, { recursive: true, force: true });
  }
});

const PI_LOADED_FIXTURE_0992 = [
  "            ];",
  "            if (contextFiles.length > 0) {",
  "                this.loadedResourcesContainer.addChild(new Spacer(1));",
  "                const contextList = () => contextFiles.map((f) => theme.fg(\"dim\", \`  \${this.formatDisplayPath(f.path)}\`)).join(\"\\n\");",
  "                const contextCompactList = () => formatCompactList(contextFiles.map((contextFile) => this.formatContextPath(contextFile.path)), { sort: false });",
  "                addLoadedSection(\"Context\", contextCompactList, contextList);",
  "            }",
  "            const skills = skillsResult.skills;",
  "            if (skills.length > 0) {",
  "                const groups = this.buildScopeGroups(skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })));",
  "                const skillList = () => this.formatScopeGroups(groups, {",
  "                    formatPath: (item) => this.formatDisplayPath(item.path),",
  "                    formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),",
  "                });",
  "                const skillCompactList = () => formatCompactList(skills.map((skill) => skill.name));",
  "                addLoadedSection(\"Skills\", skillCompactList, skillList);",
  "            }",
  "            const templates = this.session.promptTemplates;",
  "            if (templates.length > 0) {",
  "                const promptCompactList = () => formatCompactList(templates.map((template) => `/${template.name}`));",
  "                addLoadedSection(\"Prompts\", promptCompactList, templateList);",
  "            }",
  "            if (extensions.length > 0) {",
  "                const groups = this.buildScopeGroups(extensions);",
  "                const extList = () => this.formatScopeGroups(groups, {",
  "                    formatPath: (item) => this.formatExtensionDisplayPath(item.path),",
  "                    formatPackagePath: (item) => this.formatExtensionDisplayPath(this.getShortPath(item.path, item.sourceInfo)),",
  "                });",
  "                const extensionLabels = this.getCompactExtensionLabels(extensions);",
  "                const extensionCompactList = () => formatCompactList(extensionLabels);",
  "                addLoadedSection(\"Extensions\", extensionCompactList, extList, \"mdHeading\");",
  "            }",
  "        }",
  "        if (showDiagnostics) {",
  "        }",
].join("\n");

test("patchPiLoadedSkillsExtensionsHide moves Context/Skills/Extensions into the header snapshot (pi 0.99.2)", () => {
  const out = patchPiLoadedSkillsExtensionsHide(PI_LOADED_FIXTURE_0992);
  // The three banner sections are gone from the listing.
  assert.equal(out.includes('addLoadedSection("Context"'), false);
  assert.equal(out.includes('addLoadedSection("Skills"'), false);
  assert.equal(out.includes('addLoadedSection("Extensions"'), false);
  // The Prompts section is untouched.
  assert.ok(out.includes('addLoadedSection("Prompts"'));
  // Each section body becomes a globalThis.__axumLoadedResources snapshot write.
  assert.match(out, /\(globalThis\.__axumLoadedResources \?\?= \{\}\)\.context = contextFiles\.map\(\(contextFile\) => contextFile\.path\);/);
  assert.match(out, /\(globalThis\.__axumLoadedResources \?\?= \{\}\)\.skills = skills\.map\(\(skill\) => skill\.name\);/);
  assert.match(out, /\(globalThis\.__axumLoadedResources \?\?= \{\}\)\.extensions = this\.getCompactExtensionLabels\(extensions\);/);
  // The last write invalidates the custom header and schedules a re-render so
  // the SAKURA CYBERDECK header picks the snapshot up after first paint.
  assert.match(out, /this\.customHeader\?\.invalidate\?\.\(\);/);
  assert.match(out, /this\.ui\.requestRender\?\.\(\);/);
  // `const skills` survives for the diagnostics lane; marker present; idempotent.
  assert.ok(out.includes("const skills = skillsResult.skills;"));
  assert.equal(out.split("AXUM_PI_LOADED_SKILLS_EXTENSIONS_HIDDEN").length - 1, 3);
  assert.equal(patchPiLoadedSkillsExtensionsHide(out), out);
});

test("patchPiLoadedSkillsExtensionsHide skips upstream content that drifted from the 0.99.2 shape", () => {
  assert.equal(patchPiLoadedSkillsExtensionsHide("const whatever = 1;"), "const whatever = 1;");
});
