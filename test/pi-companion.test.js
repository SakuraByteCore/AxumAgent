import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import shortcuts, {
  agentPromptDir,
  buildCustomPrompt,
  customCommandNameFromFile,
  discoverCustomPromptTemplates,
  registerCustomPromptCommands,
} from "../plugin/pi-companion/index.ts";
import { applyDefaultSelection, buildModelOptions, findCurrentModelIndex, parseModelManifest, resolveModelSelection } from "../plugin/pi-companion/model-switch.ts";
import {
  CATALOG_CACHE_FILE,
  LIVE_FETCH_FAILURE_COOLDOWN_MS,
  STATIC_FREE_MODEL_IDS,
  ZEN_CHAT_BASE_URL,
  buildDisguiseHeaders,
  buildZenModelInfo,
  canonicalSessionID,
  decodeModelsDev,
  decide,
  ensureZenProvider,
  ensureZenProviderLocal,
  fetchZenCatalog,
  mergeZenProvider,
  isGatewaySessionID,
  refreshZenProviderLive,
  stableSessionID,
  staticZenCatalog,
} from "../plugin/pi-companion/opencode-zen.ts";
import {
  KILO_CATALOG_CACHE_FILE,
  KILO_CATALOG_CACHE_VERSION,
  KILO_CHAT_BASE_URL,
  buildKiloModelInfo,
  capKiloMaxTokens,
  decodeKiloListing,
  ensureKiloProvider,
  ensureKiloProviderLocal,
  kiloCanDisableThinking,
  kiloThinkingLevelMap,
  mergeKiloProvider,
  staticKiloCatalog,
} from "../plugin/pi-companion/kilo-free.ts";
import { applyFingerprintToChatPayload, describeZenQuotaError } from "../plugin/pi-companion/zen-v2-wire.ts";
import { enrichModelThinkingLevels, isAxumBaselineLevelMap } from "../plugin/pi-companion/thinking-levels.ts";

// Hermetic tests: the /usemodel Kilo sync is disabled file-wide; the sync
// itself is covered by the dedicated tests at the bottom. The retired
// OpenCode Zen lane is no longer reachable from /usemodel at all.
process.env.PI_COMPANION_ZEN_SYNC_DISABLE = "1";
process.env.PI_COMPANION_KILO_SYNC_DISABLE = "1";

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
  const setModelCalls = [];
  const registeredProviders = new Map();
  const pi = {
    commands,
    messages,
    listeners,
    emitted,
    registerProvider(name, config) {
      registeredProviders.set(name, config);
    },
    registeredProviders,
    registerCommand(name, command) {
      commands.set(name, command);
    },
    getModel() { return undefined; },
    setModelCalls,
    setModel(model) {
      setModelCalls.push(model);
      return Promise.resolve(true);
    },
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

// Hermetic HOME: the plan command reads ~/.pi/agent/plan-prompt.md, so without
// isolation the developer's real user template would shadow the built-in prompt.
function withBareHome(fn) {
  return async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-companion-home-bare-"));
    const previousHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      await fn();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  };
}

test("plan command still sends the plan-first prompt", withBareHome(async () => {
  const pi = createPi();
  const { ctx } = createContext();

  await pi.commands.get("plan").handler("add login", ctx);

  assert.equal(pi.messages.length, 1);
  assert.ok(pi.messages[0].message.includes("【总则】\n需求：add login"), "should splice requirement");
  assert.match(pi.messages[0].message, /角色：首席规划官/);
  assert.match(pi.messages[0].message, /【模式铁律】/);
  assert.match(pi.messages[0].message, /我的语气、催促或祈使句不解除规划态/);
  assert.match(pi.messages[0].message, /【终稿契约】/);
  assert.match(pi.messages[0].message, /<proposed_plan>/);
  // First plan in session uses "new" streamingBehavior to bypass followUp scheduling overhead
  assert.equal(pi.messages[0].options.streamingBehavior, "new");
}));

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

test("plan command applies the same no-code rules for CJK input", withBareHome(async () => {
  const pi = createPi();
  const { ctx } = createContext();

  await pi.commands.get("plan").handler("实现登录功能", ctx);

  // CJK input gets the identical built-in template:
  // research/discuss only, no code, and an expected outcome in plain language.
  assert.ok(pi.messages[0].message.includes("【总则】\n需求：实现登录功能"), "should splice requirement");
  assert.match(pi.messages[0].message, /角色：首席规划官/);
  assert.match(pi.messages[0].message, /【模式铁律】/);
  assert.match(pi.messages[0].message, /全程处于规划态，直到我明确说“开始写”或“生成”才可实施/);
  assert.match(pi.messages[0].message, /<proposed_plan>/);
}));

test("claude command sends the claude-driver skill prompt", async () => {
  const pi = createPi();
  const { ctx } = createContext();

  await pi.commands.get("claude").handler("add login", ctx);

  assert.equal(pi.messages.length, 1);
  assert.match(pi.messages[0].message, /=== claude-driver skill ===/);
  assert.match(pi.messages[0].message, /=== requirement ===\nadd login/);
  assert.match(pi.messages[0].message, /dangerously-skip-permissions/);
  assert.match(pi.messages[0].message, /Preflight \(always first\)/);
});

test("claude command requires a requirement", async () => {
  const pi = createPi();
  const { ctx, notifications } = createContext();

  await pi.commands.get("claude").handler("", ctx);

  assert.equal(pi.messages.length, 0);
  assert.ok(
    notifications.some(
      (n) => n.level === "warning" && /Please provide a requirement: \/claude <requirement>/.test(n.message)
    )
  );
});

test("claude command notifies when the skill file is missing", async () => {
  const pi = createPi();
  const { ctx, notifications } = createContext();
  const missingPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "axum-claude-skill-")), "SKILL.md");

  await pi.commands.get("claude").handler("add login", ctx, missingPath);

  assert.equal(pi.messages.length, 0);
  assert.ok(notifications.some((n) => n.level === "error" && /Failed to load claude-driver skill/.test(n.message)));
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
    getContextUsage() { return { tokens: 100, contextWindow: 100 }; },
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
  // 0% keeps this hermetic for any persisted threshold in 1-99.
  ctx.getContextUsage = () => ({ tokens: 0, contextWindow: 100 });

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

test("dual-threshold compaction: settled uses soft, in-flight events use hard", async () => {
  const pi = createPi();
  const { ctx, compactCalls } = createCompactContext();
  // Pin the thresholds: a real $HOME config.json must not leak into this test.
  await pi.commands.get("cthreshold").handler("75 95", ctx);
  ctx.getContextUsage = () => ({ tokens: 80, contextWindow: 100 }); // ≥ soft 75, < hard 95

  await emit(pi, "turn_start", {}, ctx);
  assert.equal(compactCalls.length, 0, "soft threshold must not fire at in-flight event points");

  await emit(pi, "agent_settled", {}, ctx);
  await waitFor(() => compactCalls.length === 1);
  assert.equal(compactCalls.length, 1, "idle boundary compacts at the soft threshold");
  compactCalls[0].onComplete({ summary: "ledger" });
  // Let the settled compaction task's microtasks flush so pendingCompact clears
  // before the hard-threshold probe (a real session emits turn_start continuously).
  await new Promise((resolve) => setTimeout(resolve, 20));

  ctx.getContextUsage = () => ({ tokens: 95, contextWindow: 100 }); // ≥ hard 95
  await emit(pi, "turn_start", {}, ctx);
  await waitFor(() => compactCalls.length === 2);
  assert.equal(compactCalls.length, 2, "hard threshold fires at any event point");
  compactCalls[1].onComplete({ summary: "ledger" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.rmSync(ctx.cwd, { recursive: true, force: true });

});

test("cthreshold shows defaults, rejects bad input, persists soft+hard, and rejects soft>=hard", withBareHome(async () => {
  const pi = createPi();
  const { ctx, notifications } = createContext();
  const command = pi.commands.get("cthreshold");

  await command.handler("", ctx);
  assert.match(notifications.at(-1).message, /thresholds: soft 75%, hard 95% \(defaults 75%\/95%/);

  await command.handler("0", ctx);
  assert.equal(notifications.at(-1).level, "warning");
  await command.handler("100", ctx);
  assert.equal(notifications.at(-1).level, "warning");
  await command.handler("abc", ctx);
  assert.equal(notifications.at(-1).level, "warning");
  await command.handler("90 80", ctx);
  assert.equal(notifications.at(-1).level, "warning");
  assert.match(notifications.at(-1).message, /soft 75%, hard 95%/);

  await command.handler("60", ctx);
  assert.match(notifications.at(-1).message, /soft 75% → 60%, hard 95% → 60% \(saved\)/);
  const configPath = path.join(process.env.HOME, ".pi", "agent", "extensions", "pi-companion", "config.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), { compactThreshold: 60, compactHardThreshold: 60 });

  await command.handler("70 90", ctx);
  assert.match(notifications.at(-1).message, /soft 60% → 70%, hard 60% → 90% \(saved\)/);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), { compactThreshold: 70, compactHardThreshold: 90 });

  // Restore the module defaults so other tests stay independent of this one.
  await command.handler("75 95", ctx);
}));

test("cthreshold loads persisted threshold at extension init", withBareHome(async () => {
  const agentDir = path.join(process.env.HOME, ".pi", "agent", "extensions", "pi-companion");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "config.json"), JSON.stringify({ compactThreshold: 50 }), "utf8");

  const pi = createPi();
  const { ctx, notifications } = createContext();

  // The loader is fire-and-forget at init; poll until it has applied the value.
  await waitFor(() => {
    if (!notifications.some((n) => /soft 50%/.test(n.message))) {
      void pi.commands.get("cthreshold").handler("", ctx);
    }
    return notifications.some((n) => /soft 50%/.test(n.message));
  });

  await pi.commands.get("cthreshold").handler("75 95", ctx);
}));

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

test("auto-compact proof timeout resumes once late compaction completes", async () => {
  // Scoped env: a module-scope assignment would leak the 20ms proof timeout
  // into every earlier auto-compact test and race their late onComplete proofs.
  process.env.PI_COMPANION_COMPACT_PROOF_TIMEOUT_MS = "20";
  try {
    const pi = createPi();
    const { ctx, compactCalls, notifications } = createCompactContext();
    // Mirror pi's real prompt(): sending while a compaction is in progress throws
    // "Cannot submit a prompt while compaction is in progress.".
    let compactionInFlight = true;
    pi.sendUserMessage = async (message, options) => {
      if (compactionInFlight) {
        throw new Error("Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.");
      }
      pi.messages.push({ message, options });
    };
    // The incident scenario: compaction starts mid-turn, so the turn counts active.
    let idle = false;
    ctx.isIdle = () => idle;

    const startRun = emit(pi, "agent_start", {}, ctx);
    await waitFor(() => compactCalls.length === 1);

    // The aborted turn settles long before the slow compaction finishes.
    idle = true;
    await emit(pi, "agent_settled", {}, ctx);

    // Proof timeout fires while compaction is still running: pi rejects the
    // immediate drain, so no resume must be sent yet (this is the stall point).
    await waitFor(() => notifications.some((n) => /Auto-compact failed: compaction proof timeout/.test(n.message)));
    await waitFor(() => notifications.some((n) => /Auto-compact continue failed: Cannot submit a prompt/.test(n.message)));
    assert.equal(pi.messages.length, 0, "no resume while compaction is still in progress");

    // Compaction finally completes: the late proof must drain the pending resume.
    compactionInFlight = false;
    compactCalls[0].onComplete({ summary: "late ledger" });
    await startRun;
    await waitFor(() => pi.messages.length === 1);
    assert.match(pi.messages[0].message, /continuation handoff summary/i);
    assert.equal(pi.messages[0].options.streamingBehavior, "followUp");

    fs.rmSync(ctx.cwd, { recursive: true, force: true });
  } finally {
    delete process.env.PI_COMPANION_COMPACT_PROOF_TIMEOUT_MS;
  }
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

test("session_start clears deferred auto-continue state from the previous session", async () => {
  const pi = createPi();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-companion-reset-"));
  const ctx = {
    cwd: tmpDir,
    hasUI: true,
    ui: { notify() {} },
    hasPendingMessages() { return false; },
    isIdle() { return true; },
    getContextUsage() { return { tokens: 0, contextWindow: 100 }; },
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

    // Session switches (e.g. /new) before agent_settled drains the deferred retry.
    await emit(pi, "session_start", {}, ctx);
    await emit(pi, "agent_settled", {}, ctx);

    assert.equal(pi.messages.length, 0, "stale deferred retry must not fire in the new session");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── /usemodel ─────────────────────────────────────────────────────────────

function createModelSwitchContext({ models = [], selectResult, currentModel } = {}) {
  const notifications = [];
  const selectCalls = [];
  const ctx = {
    notifications,
    model: currentModel,
    ui: {
      notify(message, level) { notifications.push({ message, level }); },
      select(title, options, opts) {
        selectCalls.push({ title, options, opts });
        return Promise.resolve(typeof selectResult === "function" ? selectResult(options) : selectResult);
      },
    },
    modelRegistry: {
      refreshCalls: [],
      async refresh(options) { this.refreshCalls.push(options ?? {}); },
      find(provider, modelId) {
        return models.find((m) => m.provider === provider && m.id === modelId);
      },
      hasConfiguredAuth(_model) { return true; },
    },
    cwd: process.cwd(),
  };
  return { ctx, notifications, selectCalls };
}

test("parseModelManifest flattens providers/models and marks defaults", () => {
  const entries = parseModelManifest({
    providers: {
      openai: { models: [{ id: "gpt-5", default: true }, { id: "gpt-4" }] },
      anthropic: { models: [{ id: "claude-sonnet" }] },
    },
  });
  assert.deepEqual(entries, [
    { provider: "openai", model: "gpt-5", isDefault: true },
    { provider: "openai", model: "gpt-4", isDefault: false },
    { provider: "anthropic", model: "claude-sonnet", isDefault: false },
  ]);
});

test("parseModelManifest drops malformed entries", () => {
  assert.deepEqual(parseModelManifest(null), []);
  assert.deepEqual(parseModelManifest({}), []);
  assert.deepEqual(parseModelManifest({
    providers: {
      ok: { models: [{ id: "a" }] },
      noModels: { baseUrl: "x" },
      junk: "nope",
      missingId: { models: [{ name: "no-id" }] },
    },
  }), [{ provider: "ok", model: "a", isDefault: false }]);
});

test("buildModelOptions annotates the default entry", () => {
  const options = buildModelOptions([
    { provider: "openai", model: "gpt-5", isDefault: true },
    { provider: "openai", model: "gpt-4", isDefault: false },
  ]);
  assert.deepEqual(options, ["openai/gpt-5  (default)", "openai/gpt-4"]);
});

test("resolveModelSelection parses plain and default-annotated labels", () => {
  assert.deepEqual(resolveModelSelection("openai/gpt-5  (default)"), { provider: "openai", model: "gpt-5" });
  assert.deepEqual(resolveModelSelection("anthropic/claude-sonnet"), { provider: "anthropic", model: "claude-sonnet" });
  assert.equal(resolveModelSelection(""), null);
  assert.equal(resolveModelSelection("no-slash"), null);
  assert.equal(resolveModelSelection("   "), null);
});

test("applyDefaultSelection preserves existing settings keys", () => {
  const config = { defaultProvider: "a", defaultModel: "b", defaultThinkingLevel: "high", other: 1 };
  const next = applyDefaultSelection(config, { provider: "openai", model: "gpt-5" });
  assert.equal(next.defaultProvider, "openai");
  assert.equal(next.defaultModel, "gpt-5");
  assert.equal(next.defaultThinkingLevel, "high");
  assert.equal(next.other, 1);
});

test("/usemodel warns when no models are configured", async () => {
  const pi = createPi();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-companion-usemodel-empty-"));
  const agentDir = path.join(tmpHome, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({}), "utf8");
  const previousHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const { ctx, notifications } = createModelSwitchContext();
  try {
    await pi.commands.get("usemodel").handler("", ctx);
    assert.ok(notifications.some((n) => n.level === "warning" && /No models configured/.test(n.message)));
    assert.equal(pi.setModelCalls.length, 0);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("/usemodel lists all models and switches on selection", async () => {
  const pi = createPi();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-companion-usemodel-select-"));
  const agentDir = path.join(tmpHome, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      openai: { models: [{ id: "gpt-5", default: true }, { id: "gpt-4" }] },
      anthropic: { models: [{ id: "claude-sonnet" }] },
    },
  }), "utf8");
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultThinkingLevel: "high" }), "utf8");
  const { ctx, notifications, selectCalls } = createModelSwitchContext({
    models: [
      { provider: "openai", id: "gpt-5", name: "gpt-5" },
      { provider: "openai", id: "gpt-4", name: "gpt-4" },
      { provider: "anthropic", id: "claude-sonnet", name: "claude-sonnet" },
    ],
    selectResult: (options) => options.find((o) => o.startsWith("openai/gpt-4")),
  });
  const previousHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    await pi.commands.get("usemodel").handler("", ctx);

    assert.equal(selectCalls.length, 1, "should open the selector");
    assert.deepEqual(selectCalls[0].options, [
      "openai/gpt-5  (default)",
      "openai/gpt-4",
      "anthropic/claude-sonnet",
    ]);

    assert.equal(pi.setModelCalls.length, 1);
    assert.equal(pi.setModelCalls[0].provider, "openai");
    assert.equal(pi.setModelCalls[0].id, "gpt-4");
    assert.ok(notifications.some((n) => n.level === "info" && /persisted as default/.test(n.message)));

    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(settings.defaultProvider, "openai");
    assert.equal(settings.defaultModel, "gpt-4");
    assert.equal(settings.defaultThinkingLevel, "high");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("findCurrentModelIndex locates the session model and falls back to 0", () => {
  const entries = [
    { provider: "openai", model: "gpt-5", isDefault: true },
    { provider: "openai", model: "gpt-4", isDefault: false },
    { provider: "anthropic", model: "claude-sonnet", isDefault: false },
  ];
  assert.equal(findCurrentModelIndex(entries, "openai", "gpt-4"), 1);
  assert.equal(findCurrentModelIndex(entries, "anthropic", "claude-sonnet"), 2);
  assert.equal(findCurrentModelIndex(entries, "openai", "missing"), 0);
  assert.equal(findCurrentModelIndex(entries, undefined, "gpt-4"), 0);
  assert.equal(findCurrentModelIndex(entries, "openai", undefined), 0);
});

test("/usemodel opens the selector preselected on the current model", async () => {
  const pi = createPi();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-companion-usemodel-preselect-"));
  const agentDir = path.join(tmpHome, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      openai: { models: [{ id: "gpt-5", default: true }, { id: "gpt-4" }] },
      anthropic: { models: [{ id: "claude-sonnet" }] },
    },
  }), "utf8");
  const { ctx, selectCalls } = createModelSwitchContext({
    models: [
      { provider: "openai", id: "gpt-5", name: "gpt-5" },
      { provider: "openai", id: "gpt-4", name: "gpt-4" },
      { provider: "anthropic", id: "claude-sonnet", name: "claude-sonnet" },
    ],
    currentModel: { provider: "anthropic", id: "claude-sonnet" },
    selectResult: () => undefined,
  });
  const previousHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    await pi.commands.get("usemodel").handler("", ctx);
    assert.equal(selectCalls.length, 1, "should open the selector");
    assert.equal(selectCalls[0].opts?.initialSelectedIndex, 2, "cursor should open on the current model");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("/usemodel selects the default-annotated model", async () => {
  const pi = createPi();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-companion-usemodel-default-"));
  const agentDir = path.join(tmpHome, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: { openai: { models: [{ id: "gpt-5", default: true }] } },
  }), "utf8");
  const { ctx } = createModelSwitchContext({
    models: [{ provider: "openai", id: "gpt-5", name: "gpt-5" }],
    selectResult: (options) => options[0],
  });
  const previousHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    await pi.commands.get("usemodel").handler("", ctx);
    assert.equal(pi.setModelCalls.length, 1);
    assert.equal(pi.setModelCalls[0].id, "gpt-5");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("/usemodel cancels cleanly when the selector is dismissed", async () => {
  const pi = createPi();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-companion-usemodel-cancel-"));
  const agentDir = path.join(tmpHome, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: { openai: { models: [{ id: "gpt-5" }] } },
  }), "utf8");
  const previousHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const { ctx, notifications } = createModelSwitchContext({
    models: [{ provider: "openai", id: "gpt-5", name: "gpt-5" }],
    selectResult: undefined,
  });
  try {
    await pi.commands.get("usemodel").handler("", ctx);
    assert.ok(notifications.some((n) => n.level === "info" && /cancelled/.test(n.message)));
    assert.equal(pi.setModelCalls.length, 0);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("/usemodel errors when the selected model is missing from the registry", async () => {
  const pi = createPi();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-companion-usemodel-missing-"));
  const agentDir = path.join(tmpHome, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: { openai: { models: [{ id: "ghost" }] } },
  }), "utf8");
  const previousHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const { ctx, notifications } = createModelSwitchContext({
    models: [],
    selectResult: (options) => options[0],
  });
  try {
    await pi.commands.get("usemodel").handler("", ctx);
    assert.ok(notifications.some((n) => n.level === "error" && /not found in the registry/.test(n.message)));
    assert.equal(pi.setModelCalls.length, 0);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("/usemodel reloads models.json so providers added by other processes become visible", async () => {
  const pi = createPi();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-companion-usemodel-stale-"));
  const agentDir = path.join(tmpHome, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: { maxx: { models: [{ id: "grok-4.6", default: true }] } },
  }), "utf8");
  const previousHome = process.env.HOME;
  process.env.HOME = tmpHome;
  // registry holds the startup snapshot: the provider is still unknown until refresh lands
  const deferred = [{ provider: "maxx", id: "grok-4.6", name: "grok-4.6" }];
  const { ctx, notifications } = createModelSwitchContext({
    models: [],
    selectResult: (options) => options[0],
  });
  ctx.modelRegistry.find = (provider, modelId) =>
    deferred.length > 1
      ? deferred.find((m) => m.provider === provider && m.id === modelId)
      : undefined;
  ctx.modelRegistry.refresh = async () => { deferred.push(deferred[0]); ctx.modelRegistry.refreshCalls.push({ allowNetwork: false }); return { aborted: false, errors: new Map() }; };
  try {
    await pi.commands.get("usemodel").handler("", ctx);

    assert.equal(ctx.modelRegistry.refreshCalls.length, 1, "must reload models.json before the lookup");
    assert.deepEqual(ctx.modelRegistry.refreshCalls[0], { allowNetwork: false });
    assert.equal(pi.setModelCalls.length, 1);
    assert.equal(pi.setModelCalls[0].provider, "maxx");
    assert.equal(pi.setModelCalls[0].id, "grok-4.6");
    assert.ok(notifications.some((n) => n.level === "info" && /persisted as default/.test(n.message)));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("/usemodel surfaces registry reload failures instead of silently proceeding", async () => {
  const pi = createPi();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-companion-usemodel-refresh-error-"));
  const agentDir = path.join(tmpHome, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: { openai: { models: [{ id: "gpt-5", default: true }] } },
  }), "utf8");
  const previousHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const { ctx, notifications } = createModelSwitchContext({
    models: [{ provider: "openai", id: "gpt-5", name: "gpt-5" }],
    selectResult: (options) => options[0],
  });
  ctx.modelRegistry.refresh = async () => { throw new Error("disk on fire"); };
  try {
    await pi.commands.get("usemodel").handler("", ctx);
    assert.ok(notifications.some((n) => n.level === "error" && /Failed to reload provider config: disk on fire/.test(n.message)));
    assert.equal(pi.setModelCalls.length, 0);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ── /ctx ───────────────────────────────────────────────────────────────────

function createCtxCommandContext({ currentModel } = {}) {
  const notifications = [];
  const ctx = {
    model: currentModel,
    ui: {
      notify(message, level) { notifications.push({ message, level }); },
    },
    cwd: process.cwd(),
  };
  return { ctx, notifications };
}

function withTempCtxHome(prefix, fn) {
  return async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const agentDir = path.join(tmpHome, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const previousHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      await fn(agentDir);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  };
}

test("/ctx without arguments reports the current model and contextWindow", withTempCtxHome("pi-companion-ctx-show-", async () => {
  const pi = createPi();
  const { ctx, notifications } = createCtxCommandContext({
    currentModel: { provider: "maxx", id: "grok-4.6", contextWindow: 328000 },
  });
  await pi.commands.get("ctx").handler("", ctx);
  assert.ok(notifications.some((n) => n.level === "info" && /maxx\/grok-4\.6: contextWindow = 328000/.test(n.message)));
}));

test("/ctx sets the session model in place and persists to models.json", withTempCtxHome("pi-companion-ctx-set-", async (agentDir) => {
  const pi = createPi();
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: { maxx: { models: [{ id: "grok-4.6", contextWindow: 328000, default: true }] } },
  }), "utf8");
  const { ctx, notifications } = createCtxCommandContext({
    currentModel: { provider: "maxx", id: "grok-4.6", contextWindow: 328000 },
  });
  await pi.commands.get("ctx").handler(" 200000 ", ctx);

  assert.equal(ctx.model.contextWindow, 200000, "session model must update in place");
  const modelsJson = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
  assert.equal(modelsJson.providers.maxx.models[0].contextWindow, 200000);
  assert.ok(notifications.some((n) => n.level === "info" && /328000 → 200000 \(saved to models\.json\)/.test(n.message)));
  assert.ok(!fs.existsSync(path.join(agentDir, "models.json.tmp")), "atomic rename must not leave a temp file behind");
  assert.ok(pi.emitted.some((e) => e.event === "pi-companion:context-changed"), "/ctx must announce the change so pi-bar refreshes immediately");
}));

test("/ctx rejects non-positive or non-integer input without touching state", withTempCtxHome("pi-companion-ctx-invalid-", async (agentDir) => {
  const pi = createPi();
  const modelsPath = path.join(agentDir, "models.json");
  fs.writeFileSync(modelsPath, JSON.stringify({
    providers: { maxx: { models: [{ id: "grok-4.6", contextWindow: 328000 }] } },
  }), "utf8");
  const before = fs.readFileSync(modelsPath, "utf8");
  const { ctx, notifications } = createCtxCommandContext({
    currentModel: { provider: "maxx", id: "grok-4.6", contextWindow: 328000 },
  });

  for (const bad of ["abc", "0", "-5", "12.5"]) {
    await pi.commands.get("ctx").handler(bad, ctx);
  }
  assert.equal(ctx.model.contextWindow, 328000, "session model must stay untouched");
  assert.equal(fs.readFileSync(modelsPath, "utf8"), before, "models.json must stay untouched");
  assert.equal(notifications.filter((n) => n.level === "warning" && /Invalid contextWindow/.test(n.message)).length, 4);
  assert.ok(!pi.emitted.some((e) => e.event === "pi-companion:context-changed"), "rejected input must not fire the change event");
}));

test("/ctx applies session-only when the model is absent from models.json", withTempCtxHome("pi-companion-ctx-unpersisted-", async (agentDir) => {
  const pi = createPi();
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: { other: { models: [{ id: "unrelated" }] } },
  }), "utf8");
  const { ctx, notifications } = createCtxCommandContext({
    currentModel: { provider: "builtin", id: "mystery", contextWindow: 128000 },
  });
  await pi.commands.get("ctx").handler("64000", ctx);

  assert.equal(ctx.model.contextWindow, 64000);
  const modelsJson = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
  assert.ok(!modelsJson.providers.builtin, "nothing must be persisted for unknown models");
  assert.ok(notifications.some((n) => n.level === "info" && /nothing persisted/.test(n.message)));
  assert.ok(pi.emitted.some((e) => e.event === "pi-companion:context-changed"), "session-only writes still fire the change event");
}));

test("/ctx re-caps the Kilo completion budget in the session and on disk", withTempCtxHome("pi-companion-ctx-kilo-", async (agentDir) => {
  const pi = createPi();
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { kilo: { models: [{ id: "acme/model:free", contextWindow: 262144, maxTokens: 131072 }] } } }), "utf8");
  const { ctx } = createCtxCommandContext({ currentModel: { provider: "kilo", id: "acme/model:free", contextWindow: 262144, maxTokens: 131072 } });
  await pi.commands.get("ctx").handler("100000", ctx);
  assert.equal(ctx.model.maxTokens, 50000, "the session budget follows the new window");
  const modelsJson = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
  assert.equal(modelsJson.providers.kilo.models[0].maxTokens, 50000, "the persisted budget follows too");
}));

// ── opencode-zen: OpenCode Zen dynamic provider sync ──────────────────────

test("canonicalSessionID encodes gateway-valid session ids", () => {
  const session = canonicalSessionID("pi-companion:opencode2dsh:static-session", 1_770_000_000_000);
  assert.match(session, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.ok(isGatewaySessionID(session), "freshly derived ids decode to a legal counter");
  assert.equal(session, canonicalSessionID("pi-companion:opencode2dsh:static-session", 1_770_000_000_000), "same signal + same ms is stable");
  assert.notEqual(canonicalSessionID("sig", 1_000), canonicalSessionID("sig", 1_001), "time moves the hex part");
  assert.notEqual(canonicalSessionID("sig-a", 1_000), canonicalSessionID("sig-b", 1_000), "signal still seeds the tail");
  assert.equal(canonicalSessionID(session), session, "gateway-valid ids pass through unchanged");
  const digestEra = "ses_d5be45fca3354RWTz41XYmjwNd";
  assert.ok(!isGatewaySessionID(digestEra), "pre-2026-10-13 digest ids fail the decode");
  assert.notEqual(canonicalSessionID(digestEra), digestEra, "shape-matching ids with an illegal counter are re-encoded");
});

test("buildDisguiseHeaders mirrors the upstream v2 CLI header set", () => {
  const session = stableSessionID("test-signal");
  const headers = buildDisguiseHeaders({ session });
  assert.equal(headers["user-agent"], "opencode/latest/2.0.26/cli", "v2 UA is sent alone, undecorated");
  assert.equal(headers["x-opencode-client"], "cli");
  assert.equal(headers["x-opencode-request"], undefined, "v1-only request header must not be sent");
  for (const key of ["x-opencode-session", "x-opencode-session-id", "x-session-affinity", "x-session-id"]) {
    assert.equal(headers[key], session, `${key} mirrors the session id`);
  }
  assert.equal(headers["x-opencode-project"], "global");
  assert.ok(isGatewaySessionID(buildDisguiseHeaders()["x-opencode-session"]), "derived session decodes to a legal counter");
});

test("stableSessionID pins one conversation signal to one gateway session", () => {
  const first = stableSessionID("session-abc");
  const second = stableSessionID("session-abc");
  assert.equal(first, second, "same signal → same upstream session id");
  assert.notEqual(stableSessionID("session-xyz"), first, "different signal → different id");
  assert.match(first, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.ok(isGatewaySessionID(first), "digest-derived time part stays inside the accepted counter window");
  assert.equal(stableSessionID(first), first, "gateway-valid ids pass through unchanged");
});

test("staticZenCatalog keeps only live ids from the original hard-coded list", () => {
  const catalog = staticZenCatalog();
  assert.equal(catalog.source, "static");
  assert.deepEqual(catalog.models.map((m) => m.id), [
    "big-pickle",
    "mimo-v2.6-flash-free",
    "nemotron-3.5-lightning-free",
    "jev-1.13-free",
  ]);
  assert.deepEqual(catalog.models.map((m) => m.id), [...STATIC_FREE_MODEL_IDS]);
  assert.ok(!catalog.models.some((m) => ["ling-3.1-flash-free", "cat-jam-free", "step-5-preview-free"].includes(m.id)));
});

test("buildZenModelInfo maps models.dev metadata onto the pi model entry", () => {
  const vision = buildZenModelInfo("v-free", {
    input: 0, output: 0, deprecated: false, reasoning: true,
    effortValues: ["low", "high"], contextWindow: 192000, maxOutput: 32000,
    modalities: ["text", "image"],
  });
  assert.equal(vision.reasoning, true);
  assert.equal(vision.contextWindow, 192000);
  assert.equal(vision.maxTokens, 32000);
  assert.deepEqual(vision.input, ["text", "image"]);
  assert.deepEqual(vision.thinkingLevelMap, { off: "none", low: "low", high: "high" });

  const plain = buildZenModelInfo("m-free");
  assert.equal(plain.reasoning, false);
  assert.equal(plain.thinkingLevelMap, undefined);
  assert.equal(plain.input, undefined);

  const noEfforts = buildZenModelInfo("r-free", { input: 0, output: 0, deprecated: false, reasoning: true });
  assert.deepEqual(noEfforts.thinkingLevelMap, { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high" });
});

const MODELS_DEV_FIXTURE = {
  "opencode-zen": {
    models: {
      "big-pickle": { id: "big-pickle", cost: { input: 0, output: 0 }, limit: { context: 192000, output: 32000 }, modalities: { input: ["text"] } },
      "paid-model": { id: "paid-model", cost: { input: 1, output: 2 } },
      "dead-free": { id: "dead-free", deprecated: true, cost: { input: 0, output: 0 } },
    },
  },
  openai: { id: "openai", name: "OpenAI", models: { "gpt-x": { cost: { input: 0, output: 0 } } } },
};

test("decodeModelsDev prefers the OpenCode section and decide() mirrors upstream", () => {
  const prices = decodeModelsDev(MODELS_DEV_FIXTURE);
  assert.ok(prices.has("big-pickle"));
  assert.equal(prices.get("big-pickle").contextWindow, 192000);
  assert.ok(!prices.has("gpt-x"), "non-opencode providers are ignored");
  assert.equal(decide("big-pickle", prices, true).allowed, true);
  assert.equal(decide("paid-model", prices, true).allowed, false);
  assert.equal(decide("dead-free", prices, true).allowed, false);
  assert.equal(decide("whatever-free", prices, true).allowed, true, "unknown ids fall back to the name heuristic");
  assert.equal(decide("mystery", prices, true).allowed, false);
  assert.equal(decide("mystery", new Map(), false).allowed, false);
});

function createZenMockFetch({ zenIds, modelsDev = MODELS_DEV_FIXTURE, failModelsDev = false } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, headers: init?.headers });
    if (url === "https://opencode.ai/inference/v1/models") {
      return { ok: true, json: async () => ({ data: zenIds.map((id) => ({ id })) }) };
    }
    if (url === "https://models.dev/api.json") {
      if (failModelsDev) throw new Error("metadata down");
      return { ok: true, json: async () => modelsDev };
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { calls, fetch: impl };
}

test("fetchZenCatalog intersects the live list with the free decision", async () => {
  const { calls, fetch } = createZenMockFetch({ zenIds: ["big-pickle", "paid-model", "mystery-free"] });
  const catalog = await fetchZenCatalog({ fetchImpl: fetch });
  assert.deepEqual(catalog.models.map((m) => m.id), ["big-pickle", "mystery-free"]);
  assert.equal(catalog.source, "live");
  assert.equal(catalog.models[0].contextWindow, 192000);
  assert.equal(calls[0].headers.Authorization, "Bearer public");
  assert.equal(calls[0].headers["x-opencode-client"], "cli");
});

test("fetchZenCatalog degrades to the name heuristic when models.dev fails", async () => {
  const { fetch } = createZenMockFetch({ zenIds: ["big-pickle", "mystery-free", "paid-model"], failModelsDev: true });
  const catalog = await fetchZenCatalog({ fetchImpl: fetch });
  assert.deepEqual(catalog.models.map((m) => m.id), ["mystery-free"], "non-free-looking ids are dropped when metadata is unavailable");
});

test("fetchZenCatalog rejects on a bad /v1/models payload", async () => {
  const fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(fetchZenCatalog({ fetchImpl: fetch }), /HTTP 403/);
});

test("parseModelManifest pins the opencode provider to the top", () => {
  const entries = parseModelManifest({
    providers: {
      openai: { models: [{ id: "gpt-5" }] },
      opencode: { models: [{ id: "big-pickle" }] },
      anthropic: { models: [{ id: "claude-sonnet" }] },
    },
  });
  assert.deepEqual(entries.map((e) => e.provider), ["opencode", "openai", "anthropic"]);
});

test("mergeZenProvider merges idempotently and preserves other providers", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-zen-merge-"));
  try {
    const modelsJsonPath = path.join(tmp, "models.json");
    fs.writeFileSync(modelsJsonPath, JSON.stringify({
      providers: { openai: { apiKey: "sk-x", models: [{ id: "gpt-5", default: true }] } },
      otherKey: 1,
    }), "utf8");
    const catalog = staticZenCatalog();
    assert.equal(await mergeZenProvider(modelsJsonPath, catalog.models), true);
    const merged = JSON.parse(fs.readFileSync(modelsJsonPath, "utf8"));
    assert.equal(merged.otherKey, 1);
    assert.equal(merged.providers.openai.apiKey, "sk-x");
    assert.equal(merged.providers.opencode.baseUrl, "https://opencode.ai/inference/v1");
    assert.equal(merged.providers.opencode.apiKey, "public");
    assert.equal(merged.providers.opencode.api, "openai-completions");
    assert.match(merged.providers.opencode.headers["x-opencode-session"], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assert.equal(merged.providers.opencode.headers["x-opencode-request"], undefined);
    assert.equal(merged.providers.opencode.models.length, STATIC_FREE_MODEL_IDS.length);
    const firstContent = fs.readFileSync(modelsJsonPath, "utf8");
    assert.equal(await mergeZenProvider(modelsJsonPath, catalog.models), false, "second merge is a no-op");
    assert.equal(fs.readFileSync(modelsJsonPath, "utf8"), firstContent);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("mergeZenProvider preserves user-set contextWindow overrides", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-zen-ctx-"));
  try {
    const modelsJsonPath = path.join(tmp, "models.json");
    fs.writeFileSync(modelsJsonPath, JSON.stringify({
      providers: { opencode: { baseUrl: ZEN_CHAT_BASE_URL, apiKey: "public", headers: buildDisguiseHeaders(), models: [{ id: "big-pickle", contextWindow: 999000 }, { id: "other-free", contextWindow: 128000 }, { id: "third-free" }] } },
    }), "utf8");
    const catalog = [{ id: "big-pickle", name: "big-pickle", reasoning: false }];
    const incoming = [...catalog, { id: "other-free", contextWindow: 400000 }, { id: "third-free", contextWindow: 256000 }];
    assert.equal(await mergeZenProvider(modelsJsonPath, incoming), true);
    const merged = JSON.parse(fs.readFileSync(modelsJsonPath, "utf8"));
    const kept = Object.fromEntries(merged.providers.opencode.models.map((m) => [m.id, m.contextWindow]));
    assert.equal(kept["big-pickle"], 999000, "/ctx-set window survives the catalog rebuild");
    assert.equal(kept["other-free"], 128000, "on-disk override wins over the incoming catalog value");
    assert.equal(kept["third-free"], 256000, "models without an on-disk override take the catalog value");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("mergeZenProvider migrates a legacy opencode2dsh block away", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-zen-migrate-"));
  try {
    const modelsJsonPath = path.join(tmp, "models.json");
    const legacyHeaders = buildDisguiseHeaders();
    fs.writeFileSync(modelsJsonPath, JSON.stringify({
      providers: {
        opencode2dsh: { baseUrl: "https://opencode.ai/zen/v1", apiKey: "public", headers: legacyHeaders, models: [{ id: "old-free" }] },
        openai: { models: [{ id: "gpt-5" }] },
      },
    }), "utf8");
    assert.equal(await mergeZenProvider(modelsJsonPath, staticZenCatalog().models), true);
    const merged = JSON.parse(fs.readFileSync(modelsJsonPath, "utf8"));
    assert.equal(merged.providers.opencode2dsh, undefined, "legacy key is removed");
    assert.equal(merged.providers.openai.models[0].id, "gpt-5");
    assert.equal(merged.providers.opencode.baseUrl, "https://opencode.ai/inference/v1");
    assert.equal(merged.providers.opencode.models.length, STATIC_FREE_MODEL_IDS.length);
    assert.equal(merged.providers.opencode.headers["x-opencode-session"], legacyHeaders["x-opencode-session"], "the legacy block's gateway-recipe session id is reused");
    assert.equal(merged.providers.opencode.headers["x-opencode-request"], undefined, "the v1-only request header is rebuilt away");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("mergeZenProvider repairs a stored session id that predates the gateway recipe", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-zen-repair-"));
  try {
    const modelsJsonPath = path.join(tmp, "models.json");
    const digestEra = "ses_d5be45fca3354RWTz41XYmjwNd";
    fs.writeFileSync(modelsJsonPath, JSON.stringify({
      providers: {
        opencode: {
          baseUrl: ZEN_CHAT_BASE_URL,
          apiKey: "public",
          headers: {
            "user-agent": "opencode/1.18.31 (linux x64; node24)",
            "x-opencode-client": "cli",
            "x-opencode-request": "req_stored",
            "x-opencode-session": digestEra,
            "x-session-affinity": digestEra,
            "X-Session-Id": digestEra,
          },
          models: [{ id: "old-free" }],
        },
      },
    }), "utf8");
    assert.equal(await mergeZenProvider(modelsJsonPath, staticZenCatalog().models), true);
    const merged = JSON.parse(fs.readFileSync(modelsJsonPath, "utf8"));
    const session = merged.providers.opencode.headers["x-opencode-session"];
    assert.ok(isGatewaySessionID(session), "stored session is re-encoded with the gateway recipe");
    assert.equal(merged.providers.opencode.headers["x-opencode-session-id"], session, "v2 mirror header follows the session");
    assert.equal(merged.providers.opencode.headers["x-session-affinity"], session);
    assert.equal(merged.providers.opencode.headers["x-session-id"], session);
    assert.equal(merged.providers.opencode.headers["X-Session-Id"], undefined, "v1 capitalized variant is rebuilt away");
    assert.equal(merged.providers.opencode.headers["x-opencode-request"], undefined, "v1 request header is rebuilt away");
    assert.equal(merged.providers.opencode.headers["user-agent"], "opencode/latest/2.0.26/cli", "UA rebuilt to the v2 string");
    const repaired = fs.readFileSync(modelsJsonPath, "utf8");
    assert.equal(await mergeZenProvider(modelsJsonPath, staticZenCatalog().models), false, "repaired headers are stable on the next merge");
    assert.equal(fs.readFileSync(modelsJsonPath, "utf8"), repaired);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("mergeZenProvider refuses to clobber a foreign opencode provider", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-zen-foreign-"));
  try {
    const modelsJsonPath = path.join(tmp, "models.json");
    fs.writeFileSync(modelsJsonPath, JSON.stringify({
      providers: { opencode: { baseUrl: "https://my-own-gateway.example/v1", apiKey: "sk-mine", models: [{ id: "my-model" }] } },
    }), "utf8");
    await assert.rejects(mergeZenProvider(modelsJsonPath, staticZenCatalog().models), /non-Zen "opencode" provider/);
    const after = JSON.parse(fs.readFileSync(modelsJsonPath, "utf8"));
    assert.equal(after.providers.opencode.apiKey, "sk-mine", "foreign block left untouched");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensureZenProvider caches live results and falls back to the static list", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-zen-ensure-"));
  delete process.env.PI_COMPANION_ZEN_SYNC_DISABLE;
  try {
    const agentDir = path.join(tmp, "agent");
    const { calls, fetch } = createZenMockFetch({ zenIds: ["big-pickle"] });

    const live = await ensureZenProvider(agentDir, { fetchImpl: fetch, now: () => 1_000_000 });
    assert.equal(live.source, "live");
    assert.equal(live.changed, true);
    assert.equal(live.count, 1);
    const cache = JSON.parse(fs.readFileSync(path.join(agentDir, CATALOG_CACHE_FILE), "utf8"));
    assert.equal(cache.writtenAt, 1_000_000);
    assert.equal(cache.models.length, 1);
    const callsAfterLive = calls.length;

    const cached = await ensureZenProvider(agentDir, { fetchImpl: fetch, now: () => 1_001_000 });
    assert.equal(cached.source, "cache", "fresh cache short-circuits the live fetch");
    assert.equal(calls.length, callsAfterLive);
    assert.equal(cached.changed, false);

    fs.writeFileSync(path.join(agentDir, CATALOG_CACHE_FILE),
      JSON.stringify({ writtenAt: 0, models: [{ id: "big-pickle", name: "big-pickle", reasoning: false }] }));
    process.env.PI_COMPANION_ZEN_OFFLINE = "1";
    try {
      const stale = await ensureZenProvider(agentDir, { fetchImpl: fetch, now: () => 9_000_000_000 });
      assert.equal(stale.source, "cache", "offline + stale cache still beats the static list");
      assert.equal(stale.count, 1);
      let merged = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
      assert.equal(merged.providers.opencode.models.length, 1);

      fs.rmSync(path.join(agentDir, CATALOG_CACHE_FILE));
      const floored = await ensureZenProvider(agentDir, { fetchImpl: fetch, now: () => 9_000_000_000 });
      assert.equal(floored.source, "static", "no cache + offline → static floor");
      assert.equal(floored.count, STATIC_FREE_MODEL_IDS.length);
      merged = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
      assert.equal(merged.providers.opencode.models.length, STATIC_FREE_MODEL_IDS.length);
    } finally {
      delete process.env.PI_COMPANION_ZEN_OFFLINE;
    }

    process.env.PI_COMPANION_ZEN_SYNC_DISABLE = "1";
    try {
      const disabled = await ensureZenProvider(agentDir, { fetchImpl: fetch });
      assert.deepEqual(disabled, { changed: false, source: "disabled", count: 0 });
    } finally {
      delete process.env.PI_COMPANION_ZEN_SYNC_DISABLE;
    }
  } finally {
    process.env.PI_COMPANION_ZEN_SYNC_DISABLE = "1";
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensureZenProviderLocal never touches the network and flags a due live refresh", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-zen-local-"));
  delete process.env.PI_COMPANION_ZEN_SYNC_DISABLE;
  try {
    const agentDir = path.join(tmp, "agent");
    const fetch = async () => {
      throw new Error("network must not be touched");
    };

    const boot = await ensureZenProviderLocal(agentDir, { fetchImpl: fetch, now: () => 1_000_000 });
    assert.equal(boot.source, "static", "no cache → static floor, merged locally");
    assert.equal(boot.changed, true);
    assert.equal(boot.needsLiveRefresh, true);
    let cache = JSON.parse(fs.readFileSync(path.join(agentDir, CATALOG_CACHE_FILE), "utf8"));
    assert.equal(cache.writtenAt, 0, "bootstrap cache is never faked fresh");

    fs.writeFileSync(path.join(agentDir, CATALOG_CACHE_FILE),
      JSON.stringify({ writtenAt: 0, models: [{ id: "big-pickle", name: "big-pickle", reasoning: false }] }));
    const stale = await ensureZenProviderLocal(agentDir, { fetchImpl: fetch, now: () => 1_000_000_000 });
    assert.equal(stale.source, "cache", "stale cache still beats the static floor");
    assert.equal(stale.count, 1);
    assert.equal(stale.needsLiveRefresh, true);

    fs.writeFileSync(path.join(agentDir, CATALOG_CACHE_FILE),
      JSON.stringify({ writtenAt: 999_000_000, models: [{ id: "big-pickle", name: "big-pickle", reasoning: false }] }));
    const fresh = await ensureZenProviderLocal(agentDir, { fetchImpl: fetch, now: () => 1_000_000_000 });
    assert.equal(fresh.source, "cache");
    assert.equal(fresh.needsLiveRefresh, false, "fresh cache → no refresh due");

    fs.writeFileSync(path.join(agentDir, CATALOG_CACHE_FILE),
      JSON.stringify({ writtenAt: 0, lastFailedAttemptAt: 999_900_000, models: [{ id: "big-pickle", name: "big-pickle", reasoning: false }] }));
    const cooling = await ensureZenProviderLocal(agentDir, { fetchImpl: fetch, now: () => 1_000_000_000 });
    assert.equal(cooling.needsLiveRefresh, false, "failure cooldown suppresses the live refresh");
    const afterCooldown = await ensureZenProviderLocal(agentDir, {
      fetchImpl: fetch,
      now: () => 999_900_000 + LIVE_FETCH_FAILURE_COOLDOWN_MS + 1,
    });
    assert.equal(afterCooldown.needsLiveRefresh, true, "cooldown expiry re-arms the refresh");
  } finally {
    process.env.PI_COMPANION_ZEN_SYNC_DISABLE = "1";
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("refreshZenProviderLive stamps a failure cooldown and clears it on success", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-zen-refresh-"));
  delete process.env.PI_COMPANION_ZEN_SYNC_DISABLE;
  try {
    const agentDir = path.join(tmp, "agent");
    const cachePath = path.join(agentDir, CATALOG_CACHE_FILE);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ writtenAt: 0, models: [{ id: "big-pickle", name: "big-pickle", reasoning: false }] }));
    const failingFetch = async () => {
      throw new Error("gateway down");
    };

    const failed = await refreshZenProviderLive(agentDir, { fetchImpl: failingFetch, now: () => 1_000_000_000 });
    assert.equal(failed.changed, false);
    assert.equal(failed.source, "cache");
    assert.ok(failed.error.includes("gateway down"));
    let cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    assert.equal(cache.writtenAt, 0, "stale cache is not faked fresh on failure");
    assert.equal(cache.lastFailedAttemptAt, 1_000_000_000, "failure attempt is stamped for the cooldown");
    assert.equal(cache.models.length, 1);

    const cooling = await ensureZenProviderLocal(agentDir, { fetchImpl: failingFetch, now: () => 1_000_000_001 });
    assert.equal(cooling.needsLiveRefresh, false, "cooldown suppresses live retries");

    const { fetch } = createZenMockFetch({ zenIds: ["big-pickle", "mystery-free"] });
    const live = await refreshZenProviderLive(agentDir, { fetchImpl: fetch, now: () => 1_000_000_002 });
    assert.equal(live.source, "live");
    assert.equal(live.count, 2);
    cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    assert.equal(cache.writtenAt, 1_000_000_002);
    assert.equal(cache.lastFailedAttemptAt, undefined, "success clears the cooldown stamp");
    const after = await ensureZenProviderLocal(agentDir, { fetchImpl: fetch, now: () => 1_000_000_003 });
    assert.equal(after.needsLiveRefresh, false, "fresh cache after a successful sync");
  } finally {
    process.env.PI_COMPANION_ZEN_SYNC_DISABLE = "1";
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("/usemodel drops the retired opencode lane and keeps the Kilo free floor", async () => {
  const pi = createPi();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-companion-usemodel-zen-"));
  const agentDir = path.join(tmpHome, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      openai: { models: [{ id: "gpt-5", default: true }] },
      opencode: { baseUrl: ZEN_CHAT_BASE_URL, apiKey: "public", models: [{ id: "big-pickle" }] },
      opencode2dsh: { models: [{ id: "old-free" }] },
    },
  }), "utf8");
  const { ctx, notifications, selectCalls } = createModelSwitchContext({ models: [], selectResult: () => undefined });
  const previousHome = process.env.HOME;
  process.env.HOME = tmpHome;
  delete process.env.PI_COMPANION_ZEN_SYNC_DISABLE;
  delete process.env.PI_COMPANION_KILO_SYNC_DISABLE;
  process.env.PI_COMPANION_KILO_OFFLINE = "1";
  try {
    await pi.commands.get("usemodel").handler("", ctx);
    assert.equal(selectCalls.length, 1);
    const options = selectCalls[0].options;
    assert.ok(options.includes("openai/gpt-5  (default)"), "user providers stay listed");
    assert.ok(options.includes("kilo/kilo-auto/free"), "the Kilo free floor is listed");
    assert.ok(!options.some((option) => option.startsWith("opencode/") || option.startsWith("opencode2dsh/")), "the retired Zen lane stays hidden");
    assert.ok(!notifications.some((n) => /opencode/i.test(n.message)), "no Zen sync is announced");
    assert.ok(!fs.existsSync(path.join(agentDir, CATALOG_CACHE_FILE)), "no Zen catalog cache is written");
    const merged = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    assert.equal(merged.providers.opencode.models.length, 1, "the on-disk opencode block is left untouched");
    assert.ok(merged.providers.opencode2dsh, "the legacy block stays on disk");
  } finally {
    process.env.PI_COMPANION_ZEN_SYNC_DISABLE = "1";
    process.env.PI_COMPANION_KILO_SYNC_DISABLE = "1";
    delete process.env.PI_COMPANION_KILO_OFFLINE;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ── Custom *-prompt.md commands ────────────────────────────────────────────

test("customCommandNameFromFile maps *-prompt.md stems to command names", () => {
  assert.equal(customCommandNameFromFile("spec-prompt.md"), "spec");
  assert.equal(customCommandNameFromFile("Design-Prompt.md"), "design");
  assert.equal(customCommandNameFromFile("plan-prompt.md"), undefined);
  assert.equal(customCommandNameFromFile("plan.md"), undefined);
  assert.equal(customCommandNameFromFile("notes.md"), undefined);
  assert.equal(customCommandNameFromFile("-prompt.md"), undefined);
  assert.equal(customCommandNameFromFile("bad name-prompt.md"), undefined);
});

test("agentPromptDir resolves the sibling dir of plan-prompt.md", () => {
  assert.equal(agentPromptDir("/tmp/home"), path.join("/tmp/home", ".pi", "agent"));
});

test("discoverCustomPromptTemplates lists sibling *-prompt.md files, skipping plan", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-custom-discover-"));
  try {
    fs.writeFileSync(path.join(dir, "spec-prompt.md"), "x {{requirement}}", "utf8");
    fs.writeFileSync(path.join(dir, "plan-prompt.md"), "x {{requirement}}", "utf8");
    fs.writeFileSync(path.join(dir, "notes.md"), "unrelated", "utf8");
    fs.mkdirSync(path.join(dir, "nested-prompt.md"));
    const found = discoverCustomPromptTemplates(dir);
    assert.deepEqual(found.map((t) => t.name), ["spec"]);
    assert.equal(found[0].file, "spec-prompt.md");
    assert.equal(found[0].path, path.join(dir, "spec-prompt.md"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverCustomPromptTemplates returns [] when the dir is missing", () => {
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-custom-missing-")), "nope");
  assert.deepEqual(discoverCustomPromptTemplates(missing), []);
});

test("buildCustomPrompt substitutes {{requirement}}, allowing an empty requirement", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-custom-build-"));
  try {
    const file = path.join(dir, "spec-prompt.md");
    fs.writeFileSync(file, "before {{requirement}} after\n", "utf8");
    assert.equal(await buildCustomPrompt(file, "add login"), "before add login after\n");
    assert.equal(await buildCustomPrompt(file, ""), "before  after\n");
    assert.equal(await buildCustomPrompt(file, "   "), "before     after\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildCustomPrompt still rejects empty templates", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-custom-build-err-"));
  try {
    const empty = path.join(dir, "empty-prompt.md");
    fs.writeFileSync(empty, "   \n", "utf8");
    await assert.rejects(buildCustomPrompt(empty, "x"), /Prompt template is empty/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildCustomPrompt appends the requirement when the template has no placeholder", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-custom-build-static-"));
  try {
    const file = path.join(dir, "dispatcher-prompt.md");
    fs.writeFileSync(file, "static rules\n", "utf8");
    assert.equal(await buildCustomPrompt(file, ""), "static rules\n");
    assert.equal(await buildCustomPrompt(file, "   "), "static rules\n");
    assert.equal(await buildCustomPrompt(file, "do the thing"), "static rules\n\ndo the thing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("registerCustomPromptCommands registers /<name> for each template and sends with/without requirement", async () => {
  const pi = createPi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-custom-register-"));
  try {
    fs.writeFileSync(path.join(dir, "spec-prompt.md"), "spec: {{requirement}}\n", "utf8");
    registerCustomPromptCommands(pi, discoverCustomPromptTemplates(dir));
    assert.ok(pi.commands.has("spec"), "command appears only because its file exists");
    const { ctx } = createContext();
    await pi.commands.get("spec").handler("add login", ctx);
    assert.equal(pi.messages.length, 1);
    assert.equal(pi.messages[0].message, "spec: add login\n");
    assert.equal(pi.messages[0].options.streamingBehavior, "followUp");
    await pi.commands.get("spec").handler("   ", ctx);
    assert.equal(pi.messages.length, 2);
    assert.equal(pi.messages[1].message, "spec: \n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("custom command with a static template sends it verbatim or with appended requirement", async () => {
  const pi = createPi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-custom-register-static-"));
  try {
    fs.writeFileSync(path.join(dir, "dispatcher-prompt.md"), "static rules\n", "utf8");
    registerCustomPromptCommands(pi, discoverCustomPromptTemplates(dir));
    const { ctx } = createContext();
    await pi.commands.get("dispatcher").handler("   ", ctx);
    assert.equal(pi.messages.length, 1);
    assert.equal(pi.messages[0].message, "static rules\n");
    await pi.commands.get("dispatcher").handler("do the thing", ctx);
    assert.equal(pi.messages.length, 2);
    assert.equal(pi.messages[1].message, "static rules\n\ndo the thing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("registerCustomPromptCommands registers nothing when no sibling file exists", () => {
  const pi = createPi();
  const before = pi.commands.size;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-custom-register-empty-"));
  try {
    fs.writeFileSync(path.join(dir, "plan-prompt.md"), "x {{requirement}}", "utf8");
    registerCustomPromptCommands(pi, discoverCustomPromptTemplates(dir));
    assert.equal(pi.commands.size, before);
    assert.ok(!pi.commands.has("spec"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("registerCustomPromptCommands skips names colliding with built-ins", () => {
  const pi = createPi();
  const before = pi.commands.size;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-custom-register-clash-"));
  try {
    fs.writeFileSync(path.join(dir, "spec-prompt.md"), "x {{requirement}}", "utf8");
    registerCustomPromptCommands(pi, discoverCustomPromptTemplates(dir), new Set(["spec"]));
    assert.equal(pi.commands.size, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("custom command notifies on empty template instead of sending", async () => {
  const pi = createPi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-custom-register-bad-"));
  try {
    fs.writeFileSync(path.join(dir, "spec-prompt.md"), "   \n", "utf8");
    registerCustomPromptCommands(pi, discoverCustomPromptTemplates(dir));
    const { ctx, notifications } = createContext();
    await pi.commands.get("spec").handler("add login", ctx);
    assert.equal(pi.messages.length, 0);
    assert.ok(notifications.some((n) => n.level === "error" && /Prompt template is empty/.test(n.message)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── zen-v2-wire: OpenCode v2 fingerprint gate ──────────────────────────────

const ZEN_PI_READ_TOOL = {
	type: "function",
	function: {
		name: "read",
		description: "pi's own read tool",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
};

test("applyFingerprintToChatPayload satisfies the v2 tool gate", () => {
	const body = {
		messages: [
			{ role: "system", content: "You are pi." },
			{ role: "user", content: "hi" },
		],
		tools: [
			ZEN_PI_READ_TOOL,
			{ type: "function", function: { name: "bash", description: "run a command", parameters: { type: "object", properties: { cmd: { type: "string" } } } } },
		],
		tool_choice: "none",
	};
	const sentToCaller = applyFingerprintToChatPayload(body);
	const tools = body.tools;
	const names = tools.map((t) => t.function?.name);
	assert.ok(names.includes("read") && names.includes("shell"), "official read/shell definitions are declared");
	assert.deepEqual(names.filter((n) => n === "read").length, [1].length, "no duplicate read declarations");
	assert.ok(names.includes("read_client"), "pi's conflicting read tool is renamed");
	assert.equal(sentToCaller.get("read_client"), "read", "alias map points back at the caller's name");
	const officialRead = tools.find((t) => t.function?.name === "read");
	assert.equal(officialRead.function.description.length > 100, true, "official definition is verbatim, not a stub");
	assert.equal(body.tool_choice, undefined, "tool_choice none is stripped (v2 403s it)");
	const system = body.messages[0];
	assert.match(system.content, /Do not call the `read` or `shell` tools/, "placeholder note is appended");
	// history + tool_choice retargeting
	const history = {
		messages: [{ role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] }],
		tools: [ZEN_PI_READ_TOOL],
		tool_choice: { type: "function", function: { name: "read" } },
	};
	applyFingerprintToChatPayload(history);
	const assistant = history.messages.find((m) => m.role === "assistant");
	assert.equal(assistant.tool_calls[0].function.name, "read_client", "prior-turn calls follow the rename");
	assert.equal(history.tool_choice.function.name, "read_client", "explicit tool_choice follows the rename");
});

test("describeZenQuotaError turns the Zen quota rejection into an actionable message", () => {
	const raw = '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached."}}';
	const described = describeZenQuotaError(raw);
	assert.ok(described.includes(raw), "the original upstream error is kept");
	assert.match(described, /配额已耗尽/);
	assert.match(described, /Kilo 免费通道/);
	assert.equal(describeZenQuotaError("boom"), "boom", "unrelated errors pass through unchanged");
});

// ── kilo-free: Kilo free-pool provider sync ────────────────────────────────

test("kiloThinkingLevelMap maps declared efforts onto pi levels", () => {
	assert.deepEqual(kiloThinkingLevelMap(undefined, true), { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high" });
	assert.deepEqual(kiloThinkingLevelMap(["none", "medium", "high"], true), {
		off: "none", minimal: null, low: null, medium: "medium", high: "high", xhigh: null, max: null,
	});
	const wide = kiloThinkingLevelMap(["low", "medium", "high", "xhigh", "max"], true);
	assert.equal(wide.xhigh, "xhigh");
	assert.equal(wide.max, "max");
	assert.equal(wide.minimal, null);
	assert.deepEqual(kiloThinkingLevelMap(undefined, false), { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high" }, "mandatory-reasoning families lose the off rung (gateway 400s reasoning_effort none)");
	assert.equal(kiloThinkingLevelMap(["low", "medium", "high", "xhigh", "max"], false).off, null);
});

test("kiloCanDisableThinking pins the mandatory-reasoning families", () => {
	assert.equal(kiloCanDisableThinking("liquid/lfm-2.5-2.6b:free"), false);
	assert.equal(kiloCanDisableThinking("minimax/minimax-m3.1-flash:free"), false);
	assert.equal(kiloCanDisableThinking("stepfun/step-5-preview:free"), false);
	assert.equal(kiloCanDisableThinking("kilo-auto/free"), true);
	assert.equal(kiloCanDisableThinking("nvidia/nemotron-3.5-lightning:free"), true);
});

test("staticKiloCatalog keeps only live ids from the original hard-coded list", () => {
	const catalog = staticKiloCatalog();
	assert.equal(catalog.source, "static");
	assert.equal(catalog.models.length, 15);
	const ids = catalog.models.map((m) => m.id);
	assert.ok(ids.includes("kilo-auto/free") && ids.includes("openrouter/free"));
	assert.ok(!ids.includes("minimax/minimax-m3.1-flash:free"), "retired hard-coded model stays excluded");
	for (const model of catalog.models) {
		assert.equal(model.reasoning, true, "every free-pool row declares reasoning support");
		assert.ok(model.contextWindow > 0);
		assert.ok(model.thinkingLevelMap, "thinking menu is always declared");
	}
	assert.equal(catalog.models.find((m) => m.id === "liquid/lfm-2.5-2.6b:free").thinkingLevelMap.off, null, "mandatory-reasoning families never offer off");
	assert.equal(catalog.models.find((m) => m.id === "nvidia/nemotron-3-ultra-550b-a55b:free").thinkingLevelMap.off, "none");
	const vision = catalog.models.find((m) => m.id === "nvidia/nemotron-3.5-super-vl:free");
	assert.deepEqual(vision.input, ["text", "image"]);
});

const KILO_LISTING_FIXTURE = {
	data: [
		{
			id: "acme/model-a:free", name: "ACME: Model A (free)", isFree: true,
			context_length: 32000, top_provider: { max_completion_tokens: 8192 },
			architecture: { input_modalities: ["text", "image"] },
			opencode: { reasoning_options: [{ type: "effort", values: ["low", "high"] }] },
		},
		{ id: "acme/paid", isFree: false, context_length: 1000 },
		{ id: "acme/model-a:free", isFree: true, context_length: 32000 },
		{ id: "acme/broken", isFree: true },
	],
};

test("decodeKiloListing slices the isFree roster and maps metadata", () => {
	const models = decodeKiloListing(KILO_LISTING_FIXTURE);
	assert.equal(models.length, 2, "paid rows, dup ids and keyless ids are dropped");
	const a = models[0];
	assert.equal(a.id, "acme/model-a:free");
	assert.equal(a.name, "Model A", "vendor prefix and (free) qualifier are stripped");
	assert.equal(a.contextWindow, 32000);
	assert.equal(a.maxTokens, 8192);
	assert.deepEqual(a.input, ["text", "image"]);
	assert.deepEqual(a.thinkingLevelMap, { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null });
	const broken = models[1];
	assert.equal(broken.id, "acme/broken");
	assert.equal(broken.contextWindow, 131072, "upstream fallback window applies when the row omits it");
	assert.equal(broken.maxTokens, undefined);
});

test("capKiloMaxTokens and buildKiloModelInfo keep the completion budget inside half the context window", () => {
	assert.equal(capKiloMaxTokens(262144, 235929), 131072);
	assert.equal(capKiloMaxTokens(262144, 8192), 8192, "a smaller declared budget is kept");
	assert.equal(capKiloMaxTokens(262144, null), undefined, "no declared budget stays unset");
	assert.equal(capKiloMaxTokens(undefined, 235929), 235929, "an unknown window does not cap");
	const capped = buildKiloModelInfo("acme/model:free", { contextWindow: 262144, maxTokens: 235929 });
	assert.equal(capped.maxTokens, 131072, "buildKiloModelInfo applies the cap");
	const mandatory = buildKiloModelInfo("acme/model:free", { contextWindow: 262144, maxTokens: 235929, mandatoryReasoning: true });
	assert.equal(mandatory.thinkingLevelMap.off, null, "mandatory reasoning cannot be switched off");
	assert.equal(mandatory.thinkingLevelMap.minimal, "minimal");
});

test("decodeKiloListing drops rows without tool support and pins empty reasoning menus to mandatory", () => {
	const models = decodeKiloListing({ data: [
		{ id: "acme/no-tools:free", isFree: true, supported_parameters: ["max_tokens"] },
		{ id: "acme/dup:free", isFree: true, supported_parameters: ["max_tokens"] },
		{ id: "acme/dup:free", isFree: true, context_length: 32000, supported_parameters: ["tools"] },
		{ id: "acme/mandatory:free", isFree: true, context_length: 64000, supported_parameters: ["tools"], opencode: { reasoning_options: [] } },
		{ id: "acme/legacy:free", isFree: true, context_length: 64000 },
	] });
	assert.deepEqual(models.map((m) => m.id), ["acme/dup:free", "acme/mandatory:free", "acme/legacy:free"]);
	assert.equal(models.find((m) => m.id === "acme/mandatory:free").thinkingLevelMap.off, null);
	assert.equal(models.find((m) => m.id === "acme/legacy:free").thinkingLevelMap.off, "none");
});

test("mergeKiloProvider re-caps the completion budget for a pinned context window", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kilo-pin-"));
	try {
	const modelsJsonPath = path.join(tmp, "models.json");
	fs.writeFileSync(modelsJsonPath, JSON.stringify({ providers: { kilo: { baseUrl: KILO_CHAT_BASE_URL, apiKey: " ", models: [{ id: "acme/model:free", contextWindow: 100000 }] } } }), "utf8");
	const incoming = [buildKiloModelInfo("acme/model:free", { contextWindow: 262144, maxTokens: 235929 })];
	assert.equal(await mergeKiloProvider(modelsJsonPath, incoming), true);
	const model = JSON.parse(fs.readFileSync(modelsJsonPath, "utf8")).providers.kilo.models[0];
	assert.equal(model.contextWindow, 100000, "the /ctx-pinned window survives the catalog rebuild");
	assert.equal(model.maxTokens, 50000, "the pinned window re-caps the completion budget");
	} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("mergeKiloProvider merges idempotently with a blank bearer key", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kilo-merge-"));
	try {
		const modelsJsonPath = path.join(tmp, "models.json");
		fs.writeFileSync(modelsJsonPath, JSON.stringify({
			providers: { openai: { apiKey: "sk-x", models: [{ id: "gpt-5", default: true }] } },
			otherKey: 1,
		}), "utf8");
		const catalog = staticKiloCatalog();
		assert.equal(await mergeKiloProvider(modelsJsonPath, catalog.models), true);
		const merged = JSON.parse(fs.readFileSync(modelsJsonPath, "utf8"));
		assert.equal(merged.otherKey, 1);
		assert.equal(merged.providers.openai.apiKey, "sk-x");
		assert.equal(merged.providers.kilo.baseUrl, "https://api.kilo.ai/api/gateway");
		assert.equal(merged.providers.kilo.apiKey, " ", "blank bearer: the gateway 401s any non-empty token");
		assert.equal(merged.providers.kilo.api, "openai-completions");
		assert.match(merged.providers.kilo.name, /may log prompts/);
		assert.equal(merged.providers.kilo.models.length, 15);
		const firstContent = fs.readFileSync(modelsJsonPath, "utf8");
		assert.equal(await mergeKiloProvider(modelsJsonPath, catalog.models), false, "second merge is a no-op");
		assert.equal(fs.readFileSync(modelsJsonPath, "utf8"), firstContent);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("mergeKiloProvider refuses to clobber a foreign kilo provider", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kilo-foreign-"));
	try {
		const modelsJsonPath = path.join(tmp, "models.json");
		fs.writeFileSync(modelsJsonPath, JSON.stringify({
			providers: { kilo: { baseUrl: "https://my-kilo-proxy.example", apiKey: "sk-mine", models: [{ id: "my-model" }] } },
		}), "utf8");
		await assert.rejects(mergeKiloProvider(modelsJsonPath, staticKiloCatalog().models), /non-Kilo "kilo" provider/);
		const after = JSON.parse(fs.readFileSync(modelsJsonPath, "utf8"));
		assert.equal(after.providers.kilo.apiKey, "sk-mine", "foreign block left untouched");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("ensureKiloProvider caches live results and falls back to the static list", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kilo-ensure-"));
	delete process.env.PI_COMPANION_KILO_SYNC_DISABLE;
	try {
		const agentDir = path.join(tmp, "agent");
		const calls = [];
		const fetch = async (url) => {
			calls.push(url);
			return { ok: true, json: async () => KILO_LISTING_FIXTURE };
		};

		const live = await ensureKiloProvider(agentDir, { fetchImpl: fetch, now: () => 1_000_000 });
		assert.equal(live.source, "live");
		assert.equal(live.changed, true);
		assert.equal(live.count, 2);
		const cache = JSON.parse(fs.readFileSync(path.join(agentDir, KILO_CATALOG_CACHE_FILE), "utf8"));
		assert.equal(cache.writtenAt, 1_000_000);
		const callsAfterLive = calls.length;

		const cached = await ensureKiloProvider(agentDir, { fetchImpl: fetch, now: () => 1_001_000 });
		assert.equal(cached.source, "cache", "fresh cache short-circuits the live fetch");
		assert.equal(calls.length, callsAfterLive);

		fs.rmSync(path.join(agentDir, KILO_CATALOG_CACHE_FILE));
		process.env.PI_COMPANION_KILO_OFFLINE = "1";
		try {
			const floored = await ensureKiloProvider(agentDir, { fetchImpl: fetch, now: () => 9_000_000_000 });
			assert.equal(floored.source, "static", "no cache + offline → static floor");
			assert.equal(floored.count, staticKiloCatalog().models.length);
		} finally {
			delete process.env.PI_COMPANION_KILO_OFFLINE;
		}

		process.env.PI_COMPANION_KILO_SYNC_DISABLE = "1";
		try {
			const disabled = await ensureKiloProvider(agentDir, { fetchImpl: fetch });
			assert.deepEqual(disabled, { changed: false, source: "disabled", count: 0 });
		} finally {
			delete process.env.PI_COMPANION_KILO_SYNC_DISABLE;
		}
	} finally {
		process.env.PI_COMPANION_KILO_SYNC_DISABLE = "1";
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("ensureKiloProviderLocal discards a cache written by an older catalog version", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kilo-cachever-"));
	delete process.env.PI_COMPANION_KILO_SYNC_DISABLE;
	try {
	const agentDir = path.join(tmp, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, KILO_CATALOG_CACHE_FILE), JSON.stringify({ version: KILO_CATALOG_CACHE_VERSION - 1, writtenAt: Date.now(), models: [{ id: "stale/model:free", name: "stale", reasoning: true }] }), "utf8");
	const local = await ensureKiloProviderLocal(agentDir, { now: () => Date.now() });
	assert.equal(local.source, "static", "a cache from an older catalog version is discarded");
	const cache = JSON.parse(fs.readFileSync(path.join(agentDir, KILO_CATALOG_CACHE_FILE), "utf8"));
	assert.equal(cache.version, KILO_CATALOG_CACHE_VERSION, "the rewritten cache carries the current version");
	} finally {
	process.env.PI_COMPANION_KILO_SYNC_DISABLE = "1";
	fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("thinking-level enrichment hardcodes xhigh/max onto Axum's baseline map", () => {
	const model = { id: "minimaxai/minimax-m3.1-flash", api: "openai-completions", reasoning: true, thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high" } };
	assert.equal(isAxumBaselineLevelMap(model.thinkingLevelMap), true);
	assert.equal(enrichModelThinkingLevels(model), true);
	assert.deepEqual(model.thinkingLevelMap, { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });

	// Upstream and curated maps keep the rungs their provider declares.
	const curated = { id: "openai/gpt-5.6-sol", api: "openai-responses", reasoning: true, thinkingLevelMap: { off: null, high: "high", xhigh: "curated" } };
	assert.equal(enrichModelThinkingLevels(curated), false);
	assert.deepEqual(curated.thinkingLevelMap, { off: null, high: "high", xhigh: "curated" });

	// Non-reasoning models and already extended maps are left alone.
	const plain = { id: "glm-5.3", api: "openai-completions", reasoning: false, thinkingLevelMap: {} };
	assert.equal(enrichModelThinkingLevels(plain), false);
	assert.deepEqual(plain.thinkingLevelMap, {});
	const done = { id: "ss2api/minimaxai/minimax-m3.1-flash", api: "openai-completions", reasoning: true, thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } };
	assert.equal(enrichModelThinkingLevels(done), false);
});
