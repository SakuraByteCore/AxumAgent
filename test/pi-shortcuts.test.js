import assert from "node:assert/strict";
import test from "node:test";
import shortcuts from "../plugin/pi-shortcuts/index.ts";

function createContext() {
  const notifications = [];
  return {
    notifications,
    ctx: {
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
      sessionManager: {
        getSessionFile() { return undefined; },
      },
      newSession() { return { cancelled: false }; },
      getContextUsage() { return { tokens: 0, contextWindow: 100 }; },
    },
  };
}

function createPi() {
  const commands = new Map();
  const messages = [];
  const listeners = new Map();
  const emitted = [];
  const pi = {
    commands,
    messages,
    emitted,
    registerCommand(name, command) {
      commands.set(name, command);
    },
    on() {},
    sendUserMessage(message, options) {
      messages.push({ message, options });
    },
    events: {
      on(event, handler) {
        listeners.set(event, handler);
        return () => listeners.delete(event);
      },
      emit(event, data) {
        emitted.push({ event, data });
        if (event === "subagents:rpc:spawn") {
          const reply = listeners.get(`subagents:rpc:spawn:reply:${data.requestId}`);
          reply?.({ success: true, data: { id: "agent-1" } });
        }
      },
    },
  };
  shortcuts(pi);
  return pi;
}

test("subagent command spawns a background agent through RPC", async () => {
  const pi = createPi();
  const { ctx, notifications } = createContext();

  await pi.commands.get("subagent").handler("Explore find auth files", ctx);

  assert.equal(pi.emitted.length, 1);
  assert.equal(pi.emitted[0].event, "subagents:rpc:spawn");
  assert.equal(pi.emitted[0].data.type, "Explore");
  assert.equal(pi.emitted[0].data.prompt, "find auth files");
  assert.equal(pi.emitted[0].data.options.isBackground, true);
  assert.equal(pi.emitted[0].data.options.description, "find auth files");
  assert.deepEqual(notifications, [
    { message: "Started subagent agent-1. Manage it with /agents.", level: "info" },
  ]);
});

test("subagent command requires type and prompt", async () => {
  const pi = createPi();
  const { ctx, notifications } = createContext();

  await pi.commands.get("subagent").handler("Explore", ctx);

  assert.equal(pi.emitted.length, 0);
  assert.deepEqual(notifications, [
    { message: "Please provide a type and prompt: /subagent <type> <prompt>", level: "warning" },
  ]);
});

test("plan command still sends the plan-first prompt", async () => {
  const pi = createPi();
  const { ctx } = createContext();

  await pi.commands.get("plan").handler("add login", ctx);

  assert.equal(pi.messages.length, 1);
  assert.match(pi.messages[0].message, /\[Requirement\] add login/);
  assert.equal(pi.messages[0].options.deliverAs, "followUp");
});
