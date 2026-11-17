import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { getBundledPiNodeModules } from "../src/bundled-pi-cache.js";
import { patchPiAiAllErrorsRetry, patchPiAgentSessionAllErrorsRetry } from "../src/bundled-pi-patches.js";

const modules = getBundledPiNodeModules();
const retryFile = join(modules, "@earendil-works/pi-ai/dist/utils/retry.js");
const sessionFile = join(modules, "@earendil-works/pi-coding-agent/dist/core/agent-session.js");
const errors = ["Task aborted", "401 Unauthorized", "400 Bad Request", "insufficient_quota", "billing", "unrecognized provider failure", ""];

test("all-error patches reject drifted sources", () => {
  assert.throws(() => patchPiAiAllErrorsRetry(""), /all-error retry/);
  assert.throws(() => patchPiAgentSessionAllErrorsRetry(""), /session all-error retry/);
});

test("installed retry loop retries every error and provider abort, preserving limits and real cancellation", { skip: !existsSync(retryFile) }, async () => {
  const source = patchPiAiAllErrorsRetry(readFileSync(retryFile, "utf8"));
  assert.equal(patchPiAiAllErrorsRetry(source), source);
  const { retryAssistantCall } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
  const policy = { enabled: true, maxRetries: 1, baseDelayMs: 0 };
  for (const stopReason of ["error", "aborted"]) for (const errorMessage of errors) {
    let calls = 0;
    const failed = { stopReason, errorMessage, content: [] };
    const result = await retryAssistantCall(async () => ++calls === 1 ? failed : { stopReason: "stop" }, policy);
    assert.equal(result.stopReason, "stop", errorMessage);
    assert.equal(calls, 2);
    assert.equal(failed.stopReason, stopReason, "provider response remains unchanged");
  }
  for (const enabled of [true, false]) {
    let calls = 0;
    await retryAssistantCall(async () => { calls++; return { stopReason: "error", errorMessage: "Task aborted" }; }, { ...policy, enabled });
    assert.equal(calls, enabled ? 2 : 1);
  }
  const controller = new AbortController();
  let calls = 0;
  const cancelled = await retryAssistantCall(async () => { calls++; return { stopReason: "error", errorMessage: "Task aborted" }; }, policy, controller.signal, {
    onRetryScheduled: () => controller.abort(),
  });
  assert.equal(cancelled.stopReason, "aborted");
  assert.equal(calls, 1);
});

test("real SDK child retries all failures without replaying tools and honors disable, exhaustion and cancel", {
  skip: !existsSync(sessionFile), timeout: 20000,
}, async t => {
  const source = patchPiAgentSessionAllErrorsRetry(readFileSync(sessionFile, "utf8"));
  assert.equal(patchPiAgentSessionAllErrorsRetry(source), source);
  const hook = registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.endsWith("/pi-ai/dist/utils/retry.js")) return { ...result, source: patchPiAiAllErrorsRetry(String(result.source)) };
    if (url === pathToFileURL(sessionFile).href) return { ...result, source };
    return result;
  } });
  t.after(() => hook.deregister());
  const sdk = await import(pathToFileURL(join(modules, "@earendil-works/pi-coding-agent/dist/index.js")).href);
  const ai = await import(pathToFileURL(join(modules, "@earendil-works/pi-ai/dist/index.js")).href);
  const root = mkdtempSync(join(tmpdir(), "axum-all-errors-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = await sdk.ModelRuntime.create({ modelsPath: null, authPath: join(root, "auth.json"), refreshOnCreate: false });
  runtime.registerProvider("retry-fixture", { api: "openai-completions", apiKey: "offline-fixture", baseUrl: "http://invalid.local",
    models: [{ id: "fixed", name: "fixed", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] });
  const cases = [
    ...errors.map(errorMessage => ({ errorMessage, stopReason: "error", enabled: true, limit: 1, failures: 1 })),
    { errorMessage: "Task aborted", stopReason: "aborted", enabled: true, limit: 2, failures: 3 },
    { errorMessage: "Task aborted", stopReason: "aborted", enabled: true, limit: 1, failures: 1 },
    { errorMessage: "Task aborted", stopReason: "error", enabled: false, limit: 1, failures: 1 },
    { errorMessage: "Task aborted", stopReason: "aborted", enabled: true, limit: 2, failures: 1, cancel: true },
  ];
  for (const scenario of cases) {
    const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: scenario.enabled, maxRetries: scenario.limit, baseDelayMs: 0 } });
    const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
    await loader.reload();
    let tools = 0, calls = 0, started;
    const ready = new Promise(resolve => { started = resolve; });
    const { session } = await sdk.createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model: runtime.getModel("retry-fixture", "fixed"), settingsManager: settings, sessionManager: sdk.SessionManager.inMemory(root), resourceLoader: loader,
      tools: ["evidence"], customTools: [{ name: "evidence", label: "evidence", description: "Record one completed tool", parameters: { type: "object", properties: {} }, execute: async () => { tools++; return { content: [{ type: "text", text: "saved" }] }; } }] });
    await session.bindExtensions({ mode: "print" });
    const events = []; session.subscribe(event => events.push(event));
    session.agent.streamFunction = async (model, _context, options) => {
      calls++;
      const output = new ai.AssistantMessageEventStream();
      const emit = (stopReason, errorMessage, content) => {
        const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason, errorMessage, content, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        output.push(stopReason === "error" || stopReason === "aborted" ? { type: "error", reason: stopReason, error: message } : { type: "done", reason: stopReason, message }); output.end(message);
      };
      if (scenario.cancel) { options.signal.addEventListener("abort", () => emit("aborted", "Task aborted", []), { once: true }); started(); }
      else if (calls === 1) emit("toolUse", undefined, [{ type: "toolCall", id: "evidence", name: "evidence", arguments: {} }]);
      else if (calls <= scenario.failures + 1) emit(scenario.stopReason, scenario.errorMessage, []);
      else emit("stop", undefined, [{ type: "text", text: "complete" }]);
      return output;
    };
    try {
      const run = session.prompt("Complete one child task");
      if (scenario.cancel) { await ready; await session.abort(); }
      await run; await session.waitForIdle();
      const retries = events.filter(event => event.type === "auto_retry_start");
      const expected = scenario.cancel || !scenario.enabled ? 0 : Math.min(scenario.failures, scenario.limit);
      assert.deepEqual(retries.map(event => event.attempt), Array.from({ length: expected }, (_, i) => i + 1), JSON.stringify(scenario));
      assert.equal(tools, scenario.cancel ? 0 : 1, "completed tools must not replay");
      assert.equal(calls, scenario.cancel ? 1 : 2 + expected);
      assert.equal(session.agent.state.messages.at(-1).stopReason, scenario.cancel || !scenario.enabled || scenario.failures > scenario.limit ? scenario.stopReason : "stop");
      if (scenario.failures > scenario.limit) assert.ok(events.some(event => event.type === "auto_retry_end" && event.success === false && event.attempt === scenario.limit));
    } finally { session.dispose(); }
  }
});
