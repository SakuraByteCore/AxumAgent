import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildDispatchArgs,
  buildDispatchPrompt,
  registerDispatch,
} from "../plugin/pi-agent/dispatch.ts";
import { buildPlanPrompt } from "../plugin/pi-agent/plan-prompt.ts";
import {
  AGENT_PRESETS,
  buildPresetArgs,
  registerPresets,
} from "../plugin/pi-agent/presets.ts";
import {
  PLAN_RESULT_DIRECTIVE,
  planResultDirectiveLines,
} from "../plugin/pi-agent/result-message.ts";
import {
  AGENT_OPTIONS,
  parseAgentCommand,
} from "../plugin/pi-agent/command-line.ts";

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

test("session lifecycle: shutdown latches agents cleanup, start resets the latch", async () => {
  const { registerSessionLifecycle } = await import("../plugin/pi-agent/session-lifecycle.ts");
  const handlers = new Map();
  const pi = { on(name, handler) { handlers.set(name, handler); } };
  const disposed = [];
  let shuttingDown = false;
  let mainCtx = undefined;
  const retired = [];
  const runningAgents = new Set([
    { session: { abort() { this.aborted = true; }, dispose() { disposed.push(this); }, aborted: false }, retire: () => retired.push("a"), finished: Promise.resolve() },
  ]);
  registerSessionLifecycle(pi, {
    runningAgents,
    setShuttingDown: (value) => { shuttingDown = value; },
    setMainSessionContext: (ctx) => { mainCtx = ctx; },
    disposeWidget: () => disposed.push("widget"),
  });

  assert.equal(shuttingDown, false);
  await handlers.get("session_shutdown")({}, {});
  assert.equal(shuttingDown, true);
  assert.equal(runningAgents.size, 0);
  assert.deepEqual(retired, ["a"]);
  assert.equal(disposed[0], "widget");

  const nextCtx = { marker: "new-session" };
  handlers.get("session_start")({ reason: "new" }, nextCtx);
  assert.equal(shuttingDown, false);
  assert.equal(mainCtx, nextCtx);
});

// ── -P/--plan option: declaration ─────────────────────────────────────────

test("AGENT_OPTIONS declares the -P/--plan extension option with autocomplete", () => {
  const option = AGENT_OPTIONS.find((entry) => entry.semanticId === "plan");
  assert.ok(option);
  assert.deepEqual(option.names, ["-P", "--plan"]);
  assert.equal(option.role, "extension");
  assert.equal(option.arity, "boolean");
  assert.equal(option.autocomplete, true);
});

// ── -P/--plan option: parsing ─────────────────────────────────────────────

test("parseAgentCommand consumes -P and --plan as the plan flag", () => {
  const short = parseAgentCommand("-P fix the login flow", "agent");
  assert.equal(short.plan, true);
  assert.equal(short.task, "fix the login flow");
  const long = parseAgentCommand("--plan fix the login flow", "agent");
  assert.equal(long.plan, true);
  assert.equal(long.task, "fix the login flow");
  assert.equal(parseAgentCommand("fix it", "agent").plan, false);
});

test("parseAgentCommand combines -P with isolate, squash, model, and thinking", () => {
  const parsed = parseAgentCommand(
    "-s -P -i -m gpt-5 --thinking high design the retry layer",
    "agent",
  );
  assert.equal(parsed.plan, true);
  assert.equal(parsed.isolate, true);
  assert.equal(parsed.squash, true);
  assert.deepEqual(parsed.forwardedArgs, ["--model", "gpt-5", "--thinking", "high"]);
  assert.equal(parsed.task, "design the retry layer");
});

test("parseAgentCommand with -P but no task fails with the usage error", () => {
  assert.throws(
    () => parseAgentCommand("-P", "agent"),
    /Usage: \/agent .*\[-P\|--plan\].*"<task>"/,
  );
});

test("parseAgentCommand keeps lowercase -p blocked (plan uses uppercase -P)", () => {
  assert.throws(
    () => parseAgentCommand("-p do the thing", "agent"),
    /does not support -p/,
  );
});

// ── plan prompt assembly ──────────────────────────────────────────────────

async function withTemplate(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), "pi-agent-plan-"));
  const templatePath = content === null ? join(dir, "missing.md") : join(dir, "plan-prompt.md");
  if (content !== null) await writeFile(templatePath, content);
  return fn(templatePath);
}

test("buildPlanPrompt falls back to the built-in skeleton when no template exists", async () => {
  await withTemplate(null, async (missing) => {
    const prompt = await buildPlanPrompt("ship webhooks", missing);
    assert.ok(prompt.startsWith("[Requirement] ship webhooks"));
    assert.ok(prompt.includes("[Objective]"));
    assert.ok(prompt.includes("[Rules]"));
    assert.ok(prompt.includes("do not write code"));
  });
});

test("buildPlanPrompt substitutes {{requirement}} in the template file", async () => {
  await withTemplate("Header\n{{requirement}}\nFooter", async (templatePath) => {
    const prompt = await buildPlanPrompt("add dark mode", templatePath);
    assert.equal(prompt, "Header\nadd dark mode\nFooter");
  });
});

test("buildPlanPrompt rejects an empty template", async () => {
  await withTemplate("   \n", async (templatePath) => {
    await assert.rejects(
      buildPlanPrompt("x", templatePath),
      /Plan prompt template is empty/,
    );
  });
});

test("buildPlanPrompt rejects a template without the placeholder", async () => {
  await withTemplate("no placeholder here", async (templatePath) => {
    await assert.rejects(
      buildPlanPrompt("x", templatePath),
      /must include \{\{requirement\}\}/,
    );
  });
});

function createPresetDeps(overrides = {}) {
  const runs = [];
  return {
    runs,
    deps: {
      async run(presetArgs, invocation, _ctx) {
        runs.push({ presetArgs, invocation });
      },
      ...overrides,
    },
  };
}

test("registerPresets registers spawn, scout, and blueprint", () => {
  const pi = createPi();
  registerPresets(pi, createPresetDeps().deps);
  for (const preset of AGENT_PRESETS) {
    assert.ok(pi.commands.has(preset.name), `missing command /${preset.name}`);
  }
  assert.deepEqual(
    AGENT_PRESETS.map((preset) => preset.name),
    ["spawn", "scout", "blueprint"],
  );
});

test("preset command with empty args warns and does not launch", async () => {
  const pi = createPi();
  const { runs, deps } = createPresetDeps();
  registerPresets(pi, deps);
  const { ctx, notifications } = createCtx();
  await pi.commands.get("spawn").handler("   ", ctx);
  assert.equal(runs.length, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
  assert.ok(notifications[0].message.includes("/spawn <task>"));
});

test("/spawn prefixes -s so the result is delivered back automatically", async () => {
  const pi = createPi();
  const { runs, deps } = createPresetDeps();
  registerPresets(pi, deps);
  const { ctx } = createCtx();
  await pi.commands.get("spawn").handler("fix the login bug", ctx);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].presetArgs, "-s fix the login bug");
  assert.equal(runs[0].invocation, "/spawn fix the login bug");
});

test("/scout prefixes -i so the agent starts without session context", async () => {
  const pi = createPi();
  const { runs, deps } = createPresetDeps();
  registerPresets(pi, deps);
  const { ctx } = createCtx();
  await pi.commands.get("scout").handler("isolate the crash cause", ctx);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].presetArgs, "-i isolate the crash cause");
});

test("/blueprint prefixes -P -s so the plan comes back automatically", async () => {
  const pi = createPi();
  const { runs, deps } = createPresetDeps();
  registerPresets(pi, deps);
  const { ctx } = createCtx();
  await pi.commands.get("blueprint").handler("redesign the settings page", ctx);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].presetArgs, "-P -s redesign the settings page");
});

test("buildPresetArgs preserves user-supplied flags after the preset prefix", () => {
  const spawn = AGENT_PRESETS.find((preset) => preset.name === "spawn");
  assert.equal(buildPresetArgs(spawn, "-m gpt-5 fix the bug"), "-s -m gpt-5 fix the bug");
  const parsed = parseAgentCommand(buildPresetArgs(spawn, "-m gpt-5 fix the bug"), "agent");
  assert.equal(parsed.squash, true);
  assert.equal(parsed.isolate, false);
  assert.equal(parsed.task, "fix the bug");
  assert.deepEqual(parsed.forwardedArgs, ["--model", "gpt-5"]);
});

test("buildPresetArgs emits flags only for a blank task", () => {
  const blueprint = AGENT_PRESETS.find((preset) => preset.name === "blueprint");
  assert.equal(buildPresetArgs(blueprint, "   "), "-P -s");
});

test("planResultDirectiveLines emits the directive only for plan mode", () => {
  assert.deepEqual(planResultDirectiveLines(true), [PLAN_RESULT_DIRECTIVE]);
  assert.deepEqual(planResultDirectiveLines(false), []);
  assert.ok(PLAN_RESULT_DIRECTIVE.includes("present it to the user verbatim"));
});
