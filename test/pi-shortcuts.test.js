import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

function createPi({ subagentsEnabled = true } = {}) {
  const commands = new Map();
  const messages = [];
  const listeners = new Map();
  const emitted = [];
  const pi = {
    commands,
    messages,
    listeners,
    emitted,
    registerCommand(name, command) {
      commands.set(name, command);
    },
    getModel() { return undefined; },
    on(event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
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
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  let cleanup;
  if (subagentsEnabled !== undefined) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shortcuts-"));
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ subagentsEnabled }));
    process.env.PI_CODING_AGENT_DIR = dir;
    cleanup = () => {
      process.env.PI_CODING_AGENT_DIR = previousDir;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    };
  }
  shortcuts(pi);
  if (cleanup) cleanup();
  return pi;
}

test("subagent command spawns a background agent through RPC", async () => {
  const pi = createPi();
  const { ctx, notifications } = createContext();

  await pi.commands.get("subagent").handler("Explore find auth files", ctx);

  assert.equal(pi.emitted.length, 1);
  assert.equal(pi.emitted[0].event, "subagents:rpc:spawn");
	assert.equal(pi.emitted[0].data.type, "");
	assert.equal(pi.emitted[0].data.prompt, "Explore find auth files");
  assert.equal(pi.emitted[0].data.options.isBackground, true);
  assert.equal(pi.emitted[0].data.options.description, "Explore find auth files");
  assert.deepEqual(notifications, [
    { message: "Started subagent agent-1. Manage it with /agents.", level: "info" },
  ]);
});

test("subagent command requires prompt", async () => {
	const pi = createPi();
	const { ctx, notifications } = createContext();
	await pi.commands.get("subagent").handler("", ctx);
	assert.equal(pi.emitted.length, 0);
	assert.deepEqual(notifications, [
		{ message: "Please provide a prompt: /subagent <prompt>", level: "warning" },
	]);
});



test("plan command still sends the plan-first prompt", async () => {
  const pi = createPi();
  const { ctx } = createContext();

  await pi.commands.get("plan").handler("add login", ctx);

  assert.equal(pi.messages.length, 1);
  assert.match(pi.messages[0].message, /\[Requirement\] add login/);
  assert.equal(pi.messages[0].options.streamingBehavior, "followUp");
});

test("pi-response-guard defers thinking-only auto-continue until agent_settled", async () => {
  const pi = createPi();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-settled-"));
  const notifications = [];
  const ctx = {
    cwd: tmpDir,
    hasUI: true,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
    hasPendingMessages() {
      return false;
    },
    isIdle() {
      return true;
    },
    getContextUsage() {
      return { tokens: 0, contextWindow: 100 };
    },
  };

  try {
    await pi.listeners.get("message_end")({
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "thinking", text: "private reasoning only" }],
        usage: { input: 10, output: 1 },
      },
    }, ctx);

    assert.equal(pi.messages.length, 0, "message_end must not inject while runtime may still be processing");

    await pi.listeners.get("agent_settled")({}, ctx);

    assert.equal(pi.messages.length, 1);
    assert.equal(pi.messages[0].message, "continue");
    assert.equal(pi.messages[0].options.streamingBehavior, "followUp");
    assert.match(notifications[0].message, /thinking content/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("pi-plugins command opens the skill guide", async () => {
  const pi = createPi();
  const { ctx, notifications } = createContext();

  await pi.commands.get("plugin-create-mode").handler("", ctx);

  assert.equal(notifications.length, 2);
  assert.equal(notifications[0].message, "=== pi-plugins Skill Guide ===");
  assert.equal(notifications[0].level, "info");
  assert.ok(notifications[1].message.includes("Scoped use"), "skill content should mention Scoped use");
});


test("subagent command is not registered when subagents are disabled", () => {
  const pi = createPi({ subagentsEnabled: false });
  assert.equal(pi.commands.has("subagent"), false);
});

test("subagent command is registered when subagents are enabled", () => {
  const pi = createPi({ subagentsEnabled: true });
  assert.equal(pi.commands.has("subagent"), true);
});
