import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDispatchArgs,
  buildDispatchPrompt,
  registerDispatch,
} from "../plugin/pi-agent/dispatch.ts";

function createPi() {
  const commands = new Map();
  const tools = new Map();
  const messages = [];
  return {
    commands,
    tools,
    messages,
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); },
    sendUserMessage(message, options) { messages.push({ message, options }); },
  };
}

function createCtx() {
  const notifications = [];
  return {
    notifications,
    ctx: {
      ui: {
        notify(message, level) { notifications.push({ message, level }); },
      },
      hasUI: true,
      cwd: process.cwd(),
    },
  };
}

function createDeps(overrides = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      isShuttingDown: () => false,
      async startAgent(args, invocation, _ctx) {
        calls.push({ args, invocation });
        return { id: "user-1", modelLabel: "gpt-5", task: "task" };
      },
      ...overrides,
    },
  };
}

test("registerDispatch registers /dispatch and the dispatch_agent tool", () => {
  const pi = createPi();
  registerDispatch(pi, createDeps().deps);
  assert.ok(pi.commands.has("dispatch"));
  assert.ok(pi.tools.has("dispatch_agent"));
  assert.equal(pi.tools.get("dispatch_agent").executionMode, "parallel");
});

test("/dispatch with empty args warns and sends nothing", async () => {
  const pi = createPi();
  registerDispatch(pi, createDeps().deps);
  const { ctx, notifications } = createCtx();
  await pi.commands.get("dispatch").handler("   ", ctx);
  assert.equal(pi.messages.length, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
});

test("/dispatch sends a fan-out prompt containing the batch and dispatch_agent instructions", async () => {
  const pi = createPi();
  registerDispatch(pi, createDeps().deps);
  const { ctx } = createCtx();
  await pi.commands.get("dispatch").handler("task one\ntask two", ctx);
  assert.equal(pi.messages.length, 1);
  const { message, options } = pi.messages[0];
  assert.ok(message.includes("task one\ntask two"));
  assert.ok(message.includes("dispatch_agent"));
  assert.deepEqual(options, { streamingBehavior: "followUp" });
});

test("buildDispatchPrompt embeds the batch verbatim", () => {
  const prompt = buildDispatchPrompt("do A; then B");
  assert.ok(prompt.startsWith("[Dispatch Request]\ndo A; then B"));
});

test("buildDispatchArgs: defaults to squash on, isolate off", () => {
  assert.equal(buildDispatchArgs({ task: "fix the flaky test" }), "-s fix the flaky test");
});

test("buildDispatchArgs: maps flags and quotes spaced values", () => {
  assert.equal(
    buildDispatchArgs({ task: "summarize", isolate: true, squash: false, model: "gpt 5", thinking: "high" }),
    '-i -m "gpt 5" --thinking high summarize',
  );
});

test("buildDispatchArgs: empty model and thinking are dropped", () => {
  assert.equal(buildDispatchArgs({ task: "x", model: "", thinking: "" }), "-s x");
});

test("dispatch_agent execute starts an agent and reports its id", async () => {
  const pi = createPi();
  const { deps, calls } = createDeps();
  registerDispatch(pi, deps);
  const result = await pi.tools.get("dispatch_agent").execute(
    "call-1",
    { task: "fix the flaky test", model: "gpt-5" },
    undefined,
    undefined,
    {},
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args, "-s -m gpt-5 fix the flaky test");
  assert.equal(calls[0].invocation, "dispatch_agent: fix the flaky test");
  assert.deepEqual(result.details, { agentId: "user-1", task: "task" });
  assert.match(result.content[0].text, /user-1/);
});

test("dispatch_agent execute refuses to dispatch while shutting down", async () => {
  const pi = createPi();
  const { deps, calls } = createDeps({ isShuttingDown: () => true });
  registerDispatch(pi, deps);
  const result = await pi.tools.get("dispatch_agent").execute("call-1", { task: "anything" }, undefined, undefined, {});
  assert.equal(calls.length, 0);
  assert.equal(result.details.error, "shutting-down");
});

test("dispatch_agent execute surfaces start failures as tool errors", async () => {
  const pi = createPi();
  const { deps } = createDeps({
    startAgent: () => Promise.reject(new Error('Model "nope" not found in the live model catalog.')),
  });
  registerDispatch(pi, deps);
  const result = await pi.tools.get("dispatch_agent").execute("call-1", { task: "x" }, undefined, undefined, {});
  assert.match(result.content[0].text, /Model "nope" not found/);
  assert.equal(result.details.error, 'Model "nope" not found in the live model catalog.');
});
