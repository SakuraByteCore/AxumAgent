import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import { EventEmitter, once } from "node:events";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { startProviderWeb } from "../src/provider-web.js";
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple as streamChat } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { ExtensionRunner } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js";
import { registerLiveModelThinking } from "../plugin/pi-companion/model-thinking-live.ts";
import { registerProviderOutputTokens } from "../plugin/pi-companion/provider-output-tokens.ts";

function makeModel(provider = "alpha", overrides = {}) {
  return {
    id: "test-model", name: "Test model", provider, api: "openai-completions",
    baseUrl: "https://example.invalid/v1", reasoning: true,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000, maxTokens: 2048,
    compat: { maxTokensField: "max_tokens", supportsReasoningEffort: true },
    ...overrides,
  };
}

function fixture(t, model = makeModel(), options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-output-tokens-"));
  const file = path.join(dir, "models.json");
  t.after(async () => {
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, {});
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const handlers = new Map();
  const events = new EventEmitter();
  const notifications = [];
  registerProviderOutputTokens({
    on: (event, handler) => handlers.set(event, [handler]),
    setThinkingLevel: (level) => { agent.state.thinkingLevel = clampThinkingLevel(agent.state.model, level); },
    getThinkingLevel: () => agent.state.thinkingLevel,
    events,
  }, () => file, options);
  assert.ok(handlers.has("context"), "output refresh precedes SDK options and payload construction");
  registerLiveModelThinking({
    on: (event, handler) => handlers.set(event, [handler]),
    setThinkingLevel: (level) => { agent.state.thinkingLevel = clampThinkingLevel(agent.state.model, level); },
    getThinkingLevel: () => agent.state.thinkingLevel, events,
  }, () => file, options);
  const requests = [];
  const errors = [];
  const budgets = [];
  let beforeRespond = async () => {};
  let payloadCalls = 0;
  const runner = new ExtensionRunner([{ path: "provider-output-tokens", handlers }], {
    pendingProviderRegistrations: [], pendingNativeProviderRegistrations: [],
  }, dir, {}, {});
  const agent = new Agent({
    initialState: { model, thinkingLevel: "high", systemPrompt: "Keep this context." },
    getApiKey: () => "test-key",
    transformContext: (messages) => runner.emitContext(messages),
    onPayload: (payload) => { payloadCalls++; return payload; },
    streamFn: (current, context, options) => {
      budgets.push(current.maxTokens);
      const stream = current.api === "anthropic-messages" ? streamAnthropic
        : current.api === "openai-responses" ? streamResponses : streamChat;
      return stream(current, context, { ...options, maxRetries: 0,
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const body = JSON.parse(await request.text());
          requests.push({ body, authorization: request.headers.get("authorization") });
          await beforeRespond(body);
          const events = current.api === "anthropic-messages"
            ? [
              ["message_start", { type: "message_start", message: { id: "msg_test", role: "assistant", content: [], model: current.id, usage: { input_tokens: 1, output_tokens: 0 } } }],
              ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
              ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
              ["content_block_stop", { type: "content_block_stop", index: 0 }],
              ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
              ["message_stop", { type: "message_stop" }],
            ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("")
            : current.api === "openai-responses"
            ? 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_test","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n'
            : 'data: {"id":"chat_test","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"chat_test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
          return new Response(events, { headers: { "content-type": "text/event-stream" } });
        },
      });
    },
  });
  runner.bindCore({}, { getModel: () => agent.state.model });
  const ctx = { get model() { return agent.state.model; }, hasUI: true,
    ui: { notify: (message) => notifications.push(message) } };
  runner.onError((error) => errors.push(error));
  return {
    agent, model, file, requests, errors, budgets, events, notifications,
    start: () => handlers.get("session_start")[0]({}, ctx),
    stop: () => handlers.get("session_shutdown")[0](),
    select: async (model) => {
      agent.state.model = model;
      await handlers.get("model_select")[0]({}, ctx);
    },
    prompt: async (text) => {
      await handlers.get("before_agent_start")[0]({}, ctx);
      await agent.prompt(text);
    },
    enableTurnRefresh: () => {
      AgentSession.prototype._installAgentNextTurnRefresh.call({ agent, _baseSystemPrompt: agent.state.systemPrompt });
      agent.subscribe(event => event.type === "turn_end" ? handlers.get("turn_end")[0](event, ctx) : undefined);
    },
    save: (config) => fs.writeFileSync(file, JSON.stringify(config)),
    refresh: async () => {
      await handlers.get("before_agent_start")[0]({}, ctx);
      await handlers.get("context")[0]({ type: "context", messages: [] }, { model: agent.state.model });
    },
    beforeRespond: (callback) => { beforeRespond = callback; },
    payloadCalls: () => payloadCalls,
  };
}

const providerConfig = (maxTokens) => ({ providers: { alpha: { maxTokens } } });

test("running Agent rereads provider limits between serialized SDK requests without interrupting an in-flight request", async (t) => {
  const f = fixture(t);
  f.save(providerConfig(4096));
  await f.agent.prompt("first request");
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  f.beforeRespond(async () => { entered(); await gate; });
  f.save(providerConfig(8192));
  const pending = f.agent.prompt("second request");
  await started;
  f.save(providerConfig(16384));
  assert.equal(f.requests[1].body.max_tokens, 8192);
  release();
  await pending;
  await f.agent.prompt("third request");
  assert.deepEqual(f.requests.map(({ body }) => body.max_tokens), [4096, 8192, 16384]);
  assert.deepEqual(f.budgets, [4096, 8192, 16384]);
  assert.equal(f.payloadCalls(), 3, "existing onPayload callback still runs");
  assert.equal(f.agent.state.model, f.model, "preserve model identity");
  assert.equal(f.model.contextWindow, 100000);
  assert.equal(f.agent.state.thinkingLevel, "high");
  assert.ok(f.requests.every(({ authorization, body }) => authorization === "Bearer test-key" && body.reasoning_effort === "high"));
  assert.ok(f.requests[2].body.messages.some(({ content }) => content === "first request" ||
    Array.isArray(content) && content.some(part => part.type === "text" && part.text === "first request")));
  assert.deepEqual(f.errors, []);
  assert.equal(f.agent.state.messages.at(-1).stopReason, "stop");
});

test("provider isolation and absent provider override preserve legacy per-model behavior", async (t) => {
  const f = fixture(t);
  const beta = makeModel("beta", { maxTokens: 1234 });
  f.save({ providers: { alpha: { maxTokens: 4096 }, beta: { models: [{ id: beta.id, maxTokens: 9999 }] } } });
  await f.agent.prompt("alpha");
  f.agent.state.model = beta;
  await f.agent.prompt("beta without override");
  f.save({ providers: { alpha: { maxTokens: 8192 }, beta: { maxTokens: 3072 } } });
  await f.agent.prompt("beta with override");
  assert.equal(f.model.maxTokens, 4096, "changing another provider must not mutate this model");
  f.agent.state.model = f.model;
  await f.agent.prompt("alpha again");
  assert.deepEqual(f.requests.map(({ body }) => body.max_tokens), [4096, 1234, 3072, 8192]);
  assert.equal(beta.maxTokens, 3072);
  assert.deepEqual(f.errors, []);
});

test("Kilo uses the live context window cap and SDK context safety remains active", async (t) => {
  const f = fixture(t, makeModel("kilo"));
  f.save({ providers: { kilo: { maxTokens: 90000, models: [{ id: f.model.id, contextWindow: 999999 }] } } });
  await f.agent.prompt("initial context");
  f.model.contextWindow = 10000; // /ctx updates this same live object; persisted context must not overwrite it.
  await f.agent.prompt("after context change");
  assert.equal(f.model.contextWindow, 10000);
  assert.deepEqual(f.requests.map(({ body }) => body.max_tokens), [50000, 5000]);
  f.model.contextWindow = 6000;
  await f.agent.prompt("near the context boundary");
  assert.equal(f.model.maxTokens, 3000);
  assert.ok(f.requests[2].body.max_tokens > 0 && f.requests[2].body.max_tokens < 1904,
    "SDK still reserves 4096 tokens and prompt space after the Kilo cap");
  assert.equal(f.agent.state.thinkingLevel, "high");
  assert.deepEqual(f.errors, []);
});

test("OpenAI max_completion_tokens and Responses max_output_tokens use refreshed values", async (t) => {
  const chat = fixture(t, makeModel("alpha", { compat: { maxTokensField: "max_completion_tokens", supportsReasoningEffort: true } }));
  const responses = fixture(t, makeModel("alpha", { api: "openai-responses" }));
  for (const f of [chat, responses]) {
    f.save(providerConfig(4096));
    await f.agent.prompt("first");
    f.save(providerConfig(8192));
    await f.agent.prompt("next");
    assert.deepEqual(f.errors, []);
  }
  assert.deepEqual(chat.requests.map(({ body }) => body.max_completion_tokens), [4096, 8192]);
  assert.deepEqual(responses.requests.map(({ body }) => body.max_output_tokens), [4096, 8192]);
});

test("missing models.json and missing provider fields leave a fresh model untouched", async (t) => {
  const f = fixture(t);
  await f.refresh();
  for (const config of [{}, { providers: {} }, { providers: { other: { maxTokens: 7 } } },
    { providers: { alpha: { models: [{ id: f.model.id, maxTokens: 9999 }] } } }]) {
    f.save(config);
    await f.refresh();
    assert.equal(f.model.maxTokens, 2048);
  }
  assert.deepEqual(f.model, makeModel());
});

test("invalid overrides and malformed configuration throw before mutating the model", async (t) => {
  const f = fixture(t);
  for (const invalid of [0, -1, 1.5, "4096", null, true, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
    f.save(providerConfig(invalid));
    await assert.rejects(f.refresh(), /providers.alpha.maxTokens: expected a positive safe integer/);
    assert.deepEqual(f.model, makeModel());
  }
  for (const config of [null, [], { providers: null }, { providers: [] }, { providers: { alpha: null } }]) {
    f.save(config);
    await assert.rejects(f.refresh(), TypeError);
  }
  fs.writeFileSync(f.file, "{");
  await assert.rejects(f.refresh(), SyntaxError);
  fs.rmSync(f.file);
  fs.mkdirSync(f.file);
  await assert.rejects(f.refresh(), { code: "EISDIR" });
  assert.deepEqual(f.model, makeModel());
});

test("actual SDK extension runner reports refresh errors and retains the previous request budget", async (t) => {
  const f = fixture(t);
  f.save(providerConfig(4096));
  await f.agent.prompt("valid");
  f.save(providerConfig(-1));
  await f.agent.prompt("invalid");
  fs.writeFileSync(f.file, "{");
  await f.agent.prompt("malformed");
  fs.rmSync(f.file);
  fs.mkdirSync(f.file);
  await f.agent.prompt("read failure");
  assert.deepEqual(f.requests.map(({ body }) => body.max_tokens), [4096, 4096, 4096, 4096]);
  assert.equal(f.errors.length, 3);
  assert.ok(f.errors.every(({ event }) => event === "context"));
  assert.match(f.errors[0].error, /positive safe integer/);
  assert.match(f.errors[2].error, /EISDIR/);
});


test("Anthropic requests refresh the output ceiling while keeping thinking inside the cap", async (t) => {
  const f = fixture(t, makeModel("alpha", { api: "anthropic-messages" }));
  for (const maxTokens of [4096, 8192]) {
    f.save(providerConfig(maxTokens));
    await f.agent.prompt("next request");
    assert.equal(f.agent.state.messages.at(-1).stopReason, "stop");
  }
  assert.deepEqual(f.requests.map(({ body }) => body.max_tokens), [4096, 8192]);
  assert.ok(f.requests.every(({ body }) => body.thinking.budget_tokens < body.max_tokens));
  assert.deepEqual(f.errors, []);
});


const reasoningConfig = (level, provider = "alpha") => ({ providers: { [provider]: {
  maxTokens: 20000, models: [{ id: "test-model", reasoningEffort: level, reasoning: level !== "off",
    thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } }],
} } });

test("thinking changes reach consecutive real SDK requests before their snapshots", async (t) => {
  const f = fixture(t);
  for (const level of ["low", "high", "off", "medium", "xhigh", "max"]) {
    f.save(reasoningConfig(level));
    await f.prompt("use configured reasoning");
    assert.equal(f.agent.state.thinkingLevel, level);
    assert.equal(f.agent.state.messages.at(-1).stopReason, "stop");
  }
  assert.deepEqual(f.requests.map(({ body }) => body.reasoning_effort), ["low", "high", undefined, "medium", "xhigh", "max"]);
  assert.equal(f.model.contextWindow, 100000);
  assert.deepEqual(f.errors, []);
});

test("idle atomic saves publish new thinking immediately without starting another request", async (t) => {
  const f = fixture(t);
  f.save(reasoningConfig("low"));
  await f.start();
  assert.equal(f.agent.state.thinkingLevel, "low");
  const changed = once(f.events, "pi-companion:thinking-changed", { signal: AbortSignal.timeout(2000) });
  fs.writeFileSync(f.file + ".next", JSON.stringify(reasoningConfig("high")));
  fs.renameSync(f.file + ".next", f.file);
  assert.deepEqual((await changed)[0], { provider: "alpha", model: "test-model", level: "high" });
  assert.equal(f.agent.state.thinkingLevel, "high");
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.notifications, []);
});

test("live thinking preserves manual selection until config changes and isolates provider/model", async (t) => {
  const f = fixture(t);
  f.save(reasoningConfig("low"));
  await f.prompt("configured");
  f.agent.state.thinkingLevel = "medium";
  await f.prompt("keep manual selection");
  f.save({ providers: { alpha: { models: [{ id: "other-model", reasoningEffort: "high" }] },
    beta: { models: [{ id: "test-model", reasoningEffort: "high" }] } } });
  await f.prompt("other model and provider");
  assert.deepEqual(f.requests.map(({ body }) => body.reasoning_effort), ["low", "medium", "medium"]);
  f.save(reasoningConfig("high", "beta"));
  f.agent.state.model = makeModel("beta");
  await f.prompt("switch provider");
  assert.equal(f.requests.at(-1).body.reasoning_effort, "high");
});

test("explicit CLI thinking wins over live config while output limits still refresh", async (t) => {
  const f = fixture(t, makeModel(), { explicitThinking: true });
  for (const level of ["low", "off"]) {
    f.save(reasoningConfig(level));
    await f.prompt("keep explicit thinking");
  }
  assert.deepEqual(f.requests.map(({ body }) => body.reasoning_effort), ["high", "high"]);
  assert.deepEqual(f.requests.map(({ body }) => body.max_tokens), [20000, 20000]);
});

test("invalid thinking configuration reports errors without changing the live model", async (t) => {
  const f = fixture(t);
  for (const invalid of [null, true, "turbo", 3, {}, []]) {
    const config = reasoningConfig(invalid);
    f.save(config);
    await assert.rejects(f.refresh(), /Invalid reasoningEffort/);
    assert.deepEqual(f.model, makeModel());
    assert.equal(f.agent.state.thinkingLevel, "high");
  }
});

test("a change during an active request updates the next SDK turn snapshot", async (t) => {
  const f = fixture(t);
  f.enableTurnRefresh();
  f.save(reasoningConfig("low"));
  f.beforeRespond(async () => {
    if (f.requests.length === 1) {
      f.save(reasoningConfig("high"));
      f.agent.followUp("continue with new thinking");
    }
  });
  await f.prompt("first turn");
  assert.deepEqual(f.requests.map(({ body }) => body.reasoning_effort), ["low", "high"]);
  assert.deepEqual(f.errors, []);
});

test("web saves update idle thinking and the next real request in the same running agent", async (t) => {
  const f = fixture(t, makeModel("alpha", { reasoning: false }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.dirname(f.file);
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  f.save(reasoningConfig("off"));
  await f.start();
  const { server, url } = await startProviderWeb({ openBrowser: false });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const page = await (await fetch(url)).text();
  const token = JSON.parse(page.match(/const token=("[^"]+")/)[1]);
  const changed = once(f.events, "pi-companion:thinking-changed", { signal: AbortSignal.timeout(2000) });
  const response = await fetch(new URL("/api/save", url), { method: "POST",
    headers: { "x-axum-token": token, "content-type": "application/json" },
    body: JSON.stringify({ name: "alpha", originalName: "alpha", baseUrl: f.model.baseUrl,
      api: "openai-completions", apiKey: "test-key", models: [{ id: f.model.id, reasoningEffort: "high", default: true }] }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal((await changed)[0].level, "high");
  assert.equal(f.agent.state.thinkingLevel, "high");
  assert.equal(f.requests.length, 0, "the idle UI can refresh before a prompt");
  await f.prompt("use web setting");
  assert.equal(f.requests[0].body.reasoning_effort, "high");
  assert.equal(f.model.contextWindow, 100000);
  assert.equal(f.requests[0].authorization, "Bearer test-key");
});



test("idle notifications use the SDK-clamped level when model capabilities change", async (t) => {
  const f = fixture(t);
  f.save(reasoningConfig("max"));
  await f.start();
  assert.equal(f.agent.state.thinkingLevel, "max");
  const changed = once(f.events, "pi-companion:thinking-changed", { signal: AbortSignal.timeout(2000) });
  const config = reasoningConfig("max");
  config.providers.alpha.models[0].thinkingLevelMap = { off: null, low: "low", high: "high" };
  fs.writeFileSync(f.file + ".next", JSON.stringify(config));
  fs.renameSync(f.file + ".next", f.file);
  assert.equal((await changed)[0].level, "high");
  assert.equal(f.agent.state.thinkingLevel, "high");
  assert.equal(f.requests.length, 0);
});


test("returning to a configured model restores its level after an unconfigured model", async (t) => {
  const f = fixture(t);
  f.save(reasoningConfig("low"));
  await f.prompt("alpha configured low");
  const alpha = f.agent.state.model;
  await f.select(makeModel("beta"));
  f.agent.state.thinkingLevel = "high";
  await f.select(alpha);
  await f.prompt("return to same alpha object");
  assert.equal(f.agent.state.thinkingLevel, "low");
  assert.deepEqual(f.requests.map(({ body }) => body.reasoning_effort), ["low", "low"]);
});
