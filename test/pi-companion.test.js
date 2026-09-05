import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import shortcuts from "../plugin/pi-companion/index.ts";

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
      hasPendingMessages() { return false; },
      isIdle() { return true; },
      cwd: process.cwd(),
    },
  };
}

async function waitFor(predicate, timeoutMs = 2000, stepMs = 5) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

async function emit(pi, event, ...args) {
  const handlers = pi.listeners.get(event) ?? [];
  let last;
  for (const handler of handlers) {
    last = await handler(...args);
  }
  return last;
}

function createPi() {
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
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => {
        const list = listeners.get(event);
        const i = list.indexOf(handler);
        if (i >= 0) list.splice(i, 1);
      };
    },
    sendUserMessage(message, options) {
      messages.push({ message, options });
    },
    events: {
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(handler);
        return () => {
          const list = listeners.get(event);
          const i = list.indexOf(handler);
          if (i >= 0) list.splice(i, 1);
        };
      },
      emit(event, data) {
        emitted.push({ event, data });

      },
    },
  };
  shortcuts(pi);
  return pi;
}


test("plan command still sends the plan-first prompt", async () => {
  const pi = createPi();
  const { ctx } = createContext();

  await pi.commands.get("plan").handler("add login", ctx);

  assert.equal(pi.messages.length, 1);
  assert.match(pi.messages[0].message, /\[Requirement\] add login/);
  assert.match(pi.messages[0].message, /\[Expectation\] Use plain English style to describe the expected outcome of the current requirement/);
  // First plan in session uses "new" streamingBehavior to bypass followUp scheduling overhead
  assert.equal(pi.messages[0].options.streamingBehavior, "new");
});

test("plan command uses the user template when ~/.pi/agent/plan-prompt.md exists", async () => {
  const pi = createPi();
  const { ctx } = createContext();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-companion-home-"));
  const agentDir = path.join(tmpHome, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "plan-prompt.md"), "before {{requirement}} after\n", "utf8");
  const previousHome = process.env.HOME;
  process.env.HOME = tmpHome;

  try {
    await pi.commands.get("plan").handler("add login", ctx);

    assert.ok(pi.messages[0].message.startsWith("before add login after\n"));
    assert.equal(pi.messages.length, 1);
    assert.equal(pi.messages[0].options.streamingBehavior, "followUp");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("plan command notifies when the user template exists but is empty", async () => {
  const pi = createPi();
  const { ctx, notifications } = createContext();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-companion-home-empty-"));
  const agentDir = path.join(tmpHome, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "plan-prompt.md"), "   \n", "utf8");
  const previousHome = process.env.HOME;
  process.env.HOME = tmpHome;

  try {
    await pi.commands.get("plan").handler("add login", ctx);

    assert.equal(pi.messages.length, 0);
    assert.ok(notifications.some((n) => n.level === "error" && /Plan prompt template is empty/.test(n.message)));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("plan command notifies when the user template lacks the requirement placeholder", async () => {
  const pi = createPi();
  const { ctx, notifications } = createContext();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-companion-home-placeholder-"));
  const agentDir = path.join(tmpHome, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "plan-prompt.md"), "before after\n", "utf8");
  const previousHome = process.env.HOME;
  process.env.HOME = tmpHome;

  try {
    await pi.commands.get("plan").handler("add login", ctx);

    assert.equal(pi.messages.length, 0);
    assert.ok(notifications.some((n) => n.level === "error" && /must include \{\{requirement\}\}/.test(n.message)));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("plan command uses the uniform English expectation for CJK input", async () => {
  const pi = createPi();
  const { ctx } = createContext();

  await pi.commands.get("plan").handler("实现登录功能", ctx);

  // CJK input no longer switches the expectation wording to Chinese.
  assert.match(pi.messages[0].message, /\[Expectation\] Use plain English style to describe the expected outcome/);
  // The prompt carries the output-language directive with the timezone fallback.
  assert.match(pi.messages[0].message, /\*\*Output language\*\*/);
  assert.match(pi.messages[0].message, /use Chinese for UTC\+8, Japanese for UTC\+9, and English otherwise/);
  assert.match(pi.messages[0].message, /must not repeat this instruction or the original requirement text/);
});

test("pi-response-guard defers thinking-only auto-continue until agent_settled", async () => {
  const pi = createPi();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-companion-settled-"));
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
    await emit(pi, "message_end", {
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "thinking", text: "private reasoning only" }],
        usage: { input: 10, output: 1 },
      },
    }, ctx);

    assert.equal(pi.messages.length, 0, "message_end must not inject while runtime may still be processing");

    await emit(pi, "agent_settled", {}, ctx);

    assert.equal(pi.messages.length, 1);
    assert.equal(pi.messages[0].message, "continue");
    assert.equal(pi.messages[0].options.streamingBehavior, "followUp");
    assert.match(notifications[0].message, /thinking content/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("pi-response-guard clears deferred retry after max retry limit", async () => {
  const pi = createPi();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-companion-max-"));
  fs.writeFileSync(path.join(tmpDir, ".pi-response-guard.json"), JSON.stringify({
    enabled: true,
    retryMessage: "continue",
    maxConsecutiveAutoRetries: 0,
    notifyOnAutoContinue: true,
    autoContinueOnThinkingOnlyStop: true,
  }));
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
    await emit(pi, "message_end", {
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "thinking", text: "private reasoning only" }],
        usage: { input: 10, output: 1 },
      },
    }, ctx);

    await emit(pi, "agent_settled", {}, ctx);
    await emit(pi, "agent_settled", {}, ctx);

    assert.equal(pi.messages.length, 0);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].message, /Reached retry limit/);
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

test("reload command reads SYSTEM.md and sends combined prompt", async () => {
  const pi = createPi();
  const { ctx, notifications } = createContext();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reload-"));
  const systemDir = path.join(tmpHome, ".pi", "agent");
  fs.mkdirSync(systemDir, { recursive: true });
  fs.writeFileSync(path.join(systemDir, "SYSTEM.md"), "You are a helper.\n", "utf8");
  const originalHome = process.env.HOME;
  process.env.HOME = tmpHome;

  try {
    await pi.commands.get("rules").handler("say hello", ctx);

    assert.equal(pi.messages.length, 1);
    assert.ok(pi.messages[0].message.includes("[System Rules]"), "should include system rules header");
    assert.ok(pi.messages[0].message.includes("You are a helper."), "should include SYSTEM.md content");
    assert.ok(pi.messages[0].message.includes("[Requirement] say hello"), "should include requirement");
    assert.ok(pi.messages[0].message.includes("请严格遵照以上系统规则完成当前需求。"), "should include instruction");
    assert.equal(pi.messages[0].options.streamingBehavior, "followUp");
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("reload command notifies when SYSTEM.md is missing", async () => {
  const pi = createPi();
  const { ctx, notifications } = createContext();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reload-missing-"));
  const systemDir = path.join(tmpHome, ".pi", "agent");
  fs.mkdirSync(systemDir, { recursive: true });
  const originalHome = process.env.HOME;
  process.env.HOME = tmpHome;

  try {
    await pi.commands.get("rules").handler("do something", ctx);

    assert.equal(pi.messages.length, 0, "should not send message when file missing");
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, "error");
    assert.ok(notifications[0].message.includes("Failed to read"), "should mention failure");
    assert.ok(notifications[0].message.includes("SYSTEM.md"), "should mention file");
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("ralph command requires a prompt", async () => {
  const pi = createPi();
  const { ctx, notifications } = createContext();

  await pi.commands.get("ralph").handler("", ctx);

  assert.equal(pi.messages.length, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /\/ralph <prompt>/);
});

test("ralph starts loop and advances one loop per agent_settled", async () => {
  const pi = createPi();
  const { ctx } = createContext();

  await pi.commands.get("ralph").handler("fix all failing tests", ctx);

  assert.equal(pi.messages.length, 1);
  assert.match(pi.messages[0].message, /\[Ralph Loop 1\/10\]/);
  assert.match(pi.messages[0].message, /\[Goal\] fix all failing tests/);
  assert.match(pi.messages[0].message, /fix_plan\.md/);
  assert.match(pi.messages[0].message, /Do not run any git commands/);
  assert.equal(pi.messages[0].options.streamingBehavior, "followUp");

  await emit(pi, "agent_settled", {}, ctx);
  await emit(pi, "agent_settled", {}, ctx);

  assert.equal(pi.messages.length, 3);
  assert.match(pi.messages[1].message, /\[Ralph Loop 2\/10\]/);
  assert.match(pi.messages[2].message, /\[Ralph Loop 3\/10\]/);
});

test("ralph stop prevents further loops", async () => {
  const pi = createPi();
  const { ctx, notifications } = createContext();

  await pi.commands.get("ralph").handler("fix all failing tests", ctx);
  await pi.commands.get("ralph").handler("stop", ctx);

  assert.equal(notifications.at(-1).level, "info");
  assert.match(notifications.at(-1).message, /Ralph stopped after 1\/10 loops/);

  await emit(pi, "agent_settled", {}, ctx);

  assert.equal(pi.messages.length, 1, "no follow-up loop after stop");
});

test("ralph delete removes fix_plan.md from the current directory", async () => {
  const pi = createPi();
  const { ctx, notifications } = createContext();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ralph-delete-"));
  const planFile = path.join(tmpDir, "fix_plan.md");
  fs.writeFileSync(planFile, "# fix_plan\n", "utf8");
  const originalCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    await pi.commands.get("ralph").handler("delete", ctx);

    assert.equal(fs.existsSync(planFile), false, "fix_plan.md should be deleted");
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, "info");
    assert.match(notifications[0].message, /Deleted Ralph artifact/);
    assert.equal(pi.messages.length, 0, "delete should not start a loop");
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ralph delete warns when fix_plan.md is missing", async () => {
  const pi = createPi();
  const { ctx, notifications } = createContext();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ralph-delete-missing-"));
  const originalCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    await pi.commands.get("ralph").handler("delete", ctx);

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, "warning");
    assert.match(notifications[0].message, /Nothing to delete/);
    assert.equal(pi.messages.length, 0);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ralph includes commit step only when prompt mentions commit", async () => {
  const pi = createPi();
  const { ctx } = createContext();

  await pi.commands.get("ralph").handler("\u4fee\u590d\u6240\u6709\u6d4b\u8bd5\u5e76 commit", ctx);

  assert.equal(pi.messages.length, 1);
  assert.match(pi.messages[0].message, /git add -A/);
  assert.match(pi.messages[0].message, /git commit/);
});

test("ralph refuses to start while already running", async () => {
  const pi = createPi();
  const { ctx, notifications } = createContext();

  await pi.commands.get("ralph").handler("first goal", ctx);
  await pi.commands.get("ralph").handler("second goal", ctx);

  assert.equal(pi.messages.length, 1);
  assert.equal(notifications.at(-1).level, "warning");
  assert.match(notifications.at(-1).message, /already running/);
});

test("ralph stops after reaching the configured loop limit", async () => {
  const pi = createPi();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ralph-limit-"));
  fs.writeFileSync(path.join(tmpDir, ".pi-response-guard.json"), JSON.stringify({
    enabled: true,
    ralphMaxLoops: 2,
  }));
  const notifications = [];
  const ctx = {
    cwd: tmpDir,
    hasUI: true,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
    hasPendingMessages() { return false; },
    isIdle() { return true; },
    getContextUsage() { return { tokens: 0, contextWindow: 100 }; },
  };

  try {
    await pi.commands.get("ralph").handler("ship it", ctx);

    assert.match(pi.messages[0].message, /\[Ralph Loop 1\/2\]/);

    await emit(pi, "agent_settled", {}, ctx);

    assert.equal(pi.messages.length, 2);
    assert.match(pi.messages[1].message, /\[Ralph Loop 2\/2\]/);

    await emit(pi, "agent_settled", {}, ctx);

    assert.equal(pi.messages.length, 2, "no loop beyond the limit");
    assert.match(notifications.at(-1).message, /reached loop limit \(2\)/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

process.env.PI_COMPANION_COMPACT_COOLDOWN_MS = "0";

function createCompactContext(overrides = {}) {
  const notifications = [];
  const compactCalls = [];
  const ctx = {
    notifications,
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "pi-companion-compact-")),
    hasUI: true,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
    hasPendingMessages() { return false; },
    isIdle() { return true; },
    getContextUsage() { return { tokens: 85, contextWindow: 100 }; },
    compact(options) {
      compactCalls.push(options);
      if (overrides.compactBehavior) {
        overrides.compactBehavior(options);
      }
    },
  };
  return { ctx, notifications, compactCalls };
}

test("auto-compact uses native compaction and resumes only after proof", async () => {
  const pi = createPi();
  const { ctx, compactCalls } = createCompactContext({
    compactBehavior(options) {
      options.onComplete({ summary: "continuation ledger" });
    },
  });

  await emit(pi, "agent_start", {}, ctx);

  assert.equal(compactCalls.length, 1);
  assert.match(compactCalls[0].customInstructions, /continuation handoff ledger/i);
  assert.equal(pi.messages.length, 1, "no /compact user message injection");
  assert.doesNotMatch(pi.messages[0].message, /^\/compact/);
  assert.match(pi.messages[0].message, /continuation handoff summary/i);
  assert.equal(pi.messages[0].options.streamingBehavior, "followUp");

  fs.rmSync(ctx.cwd, { recursive: true, force: true });
});

test("auto-compact failure notifies without resuming", async () => {
  const pi = createPi();
  const { ctx, notifications } = createCompactContext({
    compactBehavior(options) {
      options.onError(new Error("boom"));
    },
  });

  await emit(pi, "agent_start", {}, ctx);

  assert.equal(pi.messages.length, 0, "failed compaction must not resume");
  assert.match(notifications[0].message, /Auto-compact failed: boom/);

  fs.rmSync(ctx.cwd, { recursive: true, force: true });
});

test("auto-compact proof arriving after agent_settled still resumes", async () => {
  const pi = createPi();
  const { ctx, compactCalls } = createCompactContext();

  const startRun = emit(pi, "agent_start", {}, ctx);
  await waitFor(() => compactCalls.length === 1);
  assert.equal(pi.messages.length, 0, "no resume before proof");

  await emit(pi, "agent_settled", {}, ctx);
  assert.equal(pi.messages.length, 0, "settled before proof must not resume yet");

  compactCalls[0].onComplete({ summary: "late ledger" });
  await startRun;
  await waitFor(() => pi.messages.length === 1);

  assert.equal(pi.messages.length, 1, "proof consumed even after agent_settled");
  assert.equal(pi.messages[0].options.streamingBehavior, "followUp");

  fs.rmSync(ctx.cwd, { recursive: true, force: true });
});

test("auto-compact stays below threshold and respects cooldown", async () => {
  const pi = createPi();
  const { ctx, compactCalls } = createCompactContext();
  ctx.getContextUsage = () => ({ tokens: 50, contextWindow: 100 });

  await emit(pi, "turn_start", {}, ctx);
  assert.equal(compactCalls.length, 0, "below threshold must not compact");
  assert.equal(pi.messages.length, 0);

  const hot = createCompactContext();
  const first = emit(pi, "turn_start", {}, hot.ctx);
  await waitFor(() => hot.compactCalls.length === 1);
  assert.equal(hot.compactCalls.length, 1, "over threshold triggers compaction");
  await emit(pi, "turn_start", {}, hot.ctx);
  assert.equal(hot.compactCalls.length, 1, "cooldown/pending blocks immediate re-compaction");
  hot.compactCalls[0].onComplete({ summary: "ledger" });
  await first;

  fs.rmSync(ctx.cwd, { recursive: true, force: true });
  fs.rmSync(hot.ctx.cwd, { recursive: true, force: true });
});

test("length stop compacts with ledger via native compaction, retries after proof", async () => {
  const pi = createPi();
  const { ctx, compactCalls } = createCompactContext();
  ctx.getContextUsage = () => ({ tokens: 0, contextWindow: 100 });

  await emit(pi, "message_end", {
    message: {
      role: "assistant",
      stopReason: "length",
      content: [{ type: "text", text: "truncated output" }],
      usage: { input: 10, output: 1 },
    },
  }, ctx);

  const settled = emit(pi, "agent_settled", {}, ctx);
  await waitFor(() => compactCalls.length === 1);

  assert.equal(compactCalls.length, 1, "length stop triggers native ledger compaction");
  assert.match(compactCalls[0].customInstructions, /continuation handoff ledger/i);
  assert.equal(pi.messages.length, 0, "no /compact injection and no retry before proof");

  compactCalls[0].onComplete({ summary: "ledger" });
  await settled;
  await waitFor(() => pi.messages.length === 1);

  assert.equal(pi.messages.length, 1, "retry follows only after compaction proof");
  assert.equal(pi.messages[0].message, "continue");
  assert.equal(pi.messages[0].options.streamingBehavior, "followUp");

  fs.rmSync(ctx.cwd, { recursive: true, force: true });
});

test("auto-compact resume waits for queued user messages", async () => {
  const pi = createPi();
  let pendingMessages = false;
  const { ctx, compactCalls } = createCompactContext();
  ctx.hasPendingMessages = () => pendingMessages;

  const startRun = emit(pi, "agent_start", {}, ctx);
  await waitFor(() => compactCalls.length === 1);
  assert.equal(compactCalls.length, 1);

  await emit(pi, "agent_settled", {}, ctx);
  assert.equal(pi.messages.length, 0);

  pendingMessages = true;
  compactCalls[0].onComplete({ summary: "ledger" });
  await startRun;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pi.messages.length, 0, "user-queued messages take priority over auto-resume");

  pendingMessages = false;
  await emit(pi, "agent_settled", {}, ctx);
  await waitFor(() => pi.messages.length === 1);
  assert.equal(pi.messages.length, 1, "resume drains once queue is empty");
  assert.equal(pi.messages[0].options.streamingBehavior, "followUp");

  fs.rmSync(ctx.cwd, { recursive: true, force: true });
});

test("ralph prompt instructs continuous multi-item execution", async () => {
  const pi = createPi();
  const { ctx } = createContext();

  await pi.commands.get("ralph").handler("fix everything", ctx);

  const prompt = pi.messages[0].message;
  assert.match(prompt, /work through items continuously within this single run/);
  assert.match(prompt, /immediately move on to the next unfinished item without waiting for user input/);
  assert.match(prompt, /Stop only when fix_plan\.md has no unfinished items left/);
  assert.doesNotMatch(prompt, /Pick exactly ONE item/);
  assert.match(prompt, /8\. Do not run any git commands/);
});

test("ralph defers continuation while messages are pending and resumes when idle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pi = createPi();
  let pending = true;
  const notifications = [];
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
    hasPendingMessages() { return pending; },
    isIdle() { return true; },
    getContextUsage() { return { tokens: 0, contextWindow: 100 }; },
  };

  await pi.commands.get("ralph").handler("keep going", ctx);
  assert.equal(pi.messages.length, 1);

  await emit(pi, "agent_settled", {}, ctx);
  assert.equal(pi.messages.length, 1);

  pending = false;
  t.mock.timers.tick(2000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pi.messages.length, 2);
  assert.match(pi.messages[1].message, /\[Ralph Loop 2\/10\]/);
});

test("ralph deferred continuation stops retrying after the attempt limit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pi = createPi();
  let pending = true;
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    ui: { notify() {} },
    hasPendingMessages() { return pending; },
    isIdle() { return true; },
    getContextUsage() { return { tokens: 0, contextWindow: 100 }; },
  };

  await pi.commands.get("ralph").handler("never resumes", ctx);
  await emit(pi, "agent_settled", {}, ctx);
  assert.equal(pi.messages.length, 1);

  t.mock.timers.tick(60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pi.messages.length, 1);
});
