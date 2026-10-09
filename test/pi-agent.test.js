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
import {
  describeClearCounts,
  registerClear,
} from "../plugin/pi-agent/clear.ts";
import {
  DEFAULT_ORCHESTRATION_BUDGET_MS,
  MAX_ORCHESTRATION_BUDGET_MS,
  buildOrchestrationPrompt,
  parseOrchestrationArgs,
  registerOrchestrate,
} from "../plugin/pi-agent/orchestrate.ts";
import { buildPlanPrompt } from "../plugin/pi-agent/plan-prompt.ts";
import {
	assistantText,
	EmptyAgentTextError,
	getFinalAssistantText,
	NO_TEXT_RESPONSE_NUDGE,
} from "../plugin/pi-agent/final-response.ts";
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

import {
	PLAN_REF_LATEST,
	composeRelayInstruction,
	resolvePlanRelay,
	selectPlanCandidate,
} from "../plugin/pi-agent/plan-relay.ts";
import {
	MESSAGE_TYPE,
	agentArgsFromInvocation,
	collectFailedAgentTargets,
	planFailedAgentResume,
	selectResumeTargets,
} from "../plugin/pi-agent/shared.ts";
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

test("parseAgentCommand consumes lowercase -p as plan-relay (latest blueprint)", () => {
  const parsed = parseAgentCommand("-p do the thing", "agent");
  assert.equal(parsed.planRef, "latest");
  assert.equal(parsed.plan, false);
  assert.equal(parsed.task, "do the thing");
  assert.throws(() => parseAgentCommand("--print now", "agent"), /does not support --print/);
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
    assert.ok(prompt.includes("do not modify files"));
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
      disabledCommands: new Set(),
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

test("preset command disabled by auto-removal notifies and does not launch", async () => {
  const pi = createPi();
  const { runs, deps } = createPresetDeps();
  deps.disabledCommands.add("spawn");
  registerPresets(pi, deps);
  const { ctx, notifications } = createCtx();
  await pi.commands.get("spawn").handler("fix the login bug", ctx);
  assert.equal(runs.length, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "info");
  assert.ok(notifications[0].message.includes("Command /spawn has completed and been removed"));
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

function assistantMessage(parts, stopReason = "stop", errorMessage = undefined) {
  return { role: "assistant", content: parts, stopReason, errorMessage };
}

function fakeSession(messages) {
  return { agent: { state: { messages } } };
}

const TEXT_PART = (text) => ({ type: "text", text });
const THINKING_PART = { type: "thinking", text: "reasoning silently" };
const TOOL_PART = { type: "tool_use", id: "tool-1", name: "read" };

test("assistantText joins only text parts", () => {
  const text = assistantText(assistantMessage([THINKING_PART, TEXT_PART("plan body"), TOOL_PART]));
  assert.equal(text, "plan body");
});

test("getFinalAssistantText returns the final message text when present", () => {
  const session = fakeSession([
    { role: "user", content: [TEXT_PART("task")] },
    assistantMessage([TEXT_PART("  finished plan  ")]),
  ]);
  assert.equal(getFinalAssistantText(session, 0, { sessionId: "s1" }), "finished plan");
});

test("getFinalAssistantText falls back to the last non-empty text in the turn", () => {
  const session = fakeSession([
    assistantMessage([TEXT_PART("earlier turn answer")]),
    { role: "user", content: [TEXT_PART("next instruction")] },
    assistantMessage([TEXT_PART("research notes")]),
    { role: "tool", content: [] },
    assistantMessage([THINKING_PART, TEXT_PART("   ")]),
  ]);
  assert.equal(getFinalAssistantText(session, 2, { sessionId: "s1" }), "research notes");
});

test("getFinalAssistantText does not reach into a previous turn", () => {
  const session = fakeSession([
    assistantMessage([TEXT_PART("stale answer from the previous turn")]),
    assistantMessage([THINKING_PART]),
  ]);
  assert.throws(() => getFinalAssistantText(session, 1, { sessionId: "s1" }), EmptyAgentTextError);
});

test("getFinalAssistantText throws a diagnosable error when the turn has no text", () => {
  const session = fakeSession([
    { role: "user", content: [TEXT_PART("task")] },
    assistantMessage([THINKING_PART, TOOL_PART]),
  ]);
  assert.throws(
    () => getFinalAssistantText(session, 0, { sessionId: "session-9" }),
    (error) => {
      assert.ok(error instanceof EmptyAgentTextError);
      assert.match(error.message, /no text response/);
      assert.match(error.message, /1 assistant messages this turn/);
      assert.match(error.message, /\/resume session-9/);
      return true;
    },
  );
});

test("getFinalAssistantText surfaces error and abort stop reasons", () => {
  const errored = fakeSession([assistantMessage([TEXT_PART("partial")], "error", "boom")]);
  assert.throws(() => getFinalAssistantText(errored, 0, { sessionId: "s1" }), /boom/);
  const aborted = fakeSession([assistantMessage([TEXT_PART("partial")], "aborted")]);
  assert.throws(() => getFinalAssistantText(aborted, 0, { sessionId: "s1" }), /User agent aborted/);
});

test("getFinalAssistantText throws when the turn produced no assistant message", () => {
  const session = fakeSession([{ role: "user", content: [TEXT_PART("task")] }]);
  assert.throws(
    () => getFinalAssistantText(session, 0, { sessionId: "s1" }),
    /finished without an assistant message/,
  );
});

test("NO_TEXT_RESPONSE_NUDGE asks for a plain-text final answer", () => {
  assert.ok(NO_TEXT_RESPONSE_NUDGE.length > 0);
  assert.match(NO_TEXT_RESPONSE_NUDGE, /plain text/);
});

test("parser: -p/--plan-relay parses latest, attached ids, and keeps task optional", () => {
  const bare = parseAgentCommand("-p", "spawn");
  assert.equal(bare.planRef, "latest");
  assert.equal(bare.plan, false);
  assert.equal(bare.task, "");
  const withFlags = parseAgentCommand("-s -p", "spawn");
  assert.equal(withFlags.planRef, "latest");
  assert.equal(withFlags.squash, true);
  assert.equal(withFlags.task, "");
  const pinned = parseAgentCommand("-p=user-3 -s do it with Postgres", "spawn");
  assert.equal(pinned.planRef, "user-3");
  assert.equal(pinned.squash, true);
  assert.equal(pinned.task, "do it with Postgres");
  const long = parseAgentCommand("--plan-relay=agent-9", "spawn");
  assert.equal(long.planRef, "agent-9");
  const prose = parseAgentCommand("deploy with -p flag on", "spawn");
  assert.equal(prose.planRef, undefined);
  assert.equal(prose.task, "deploy with -p flag on");
});

test("parser: -p gates empty-task usage and rejects -P/-p combination", () => {
  assert.throws(() => parseAgentCommand("-s", "spawn"), /Usage:/);
  assert.throws(() => parseAgentCommand("-P", "spawn"), /Usage:/);
  assert.throws(() => parseAgentCommand("-P -p fix it", "spawn"), /cannot combine -P/);
  assert.throws(() => parseAgentCommand("--print", "spawn"), /does not support --print/);
  const relayOnly = parseAgentCommand("-p", "spawn");
  assert.equal(relayOnly.plan, false);
  assert.equal(relayOnly.planRef, "latest");
});

test("selectPlanCandidate pins by id and picks the newest blueprint for latest", () => {
  const older = { id: "agent-1", sessionId: "s1", task: "t1", startedAt: 1, planText: "p1", ok: true };
  const newer = { id: "agent-2", sessionId: "s2", task: "t2", startedAt: 2, planText: "p2", ok: true };
  assert.equal(selectPlanCandidate("agent-1", [], [older, newer]).id, "agent-1");
  assert.equal(selectPlanCandidate(PLAN_REF_LATEST, [], [older, newer]).id, "agent-2");
  assert.equal(selectPlanCandidate(PLAN_REF_LATEST, [older], [newer]).id, "agent-2");
  assert.equal(selectPlanCandidate("agent-9", [older], [newer]), undefined);
});

test("resolvePlanRelay waits for a live blueprint, then relays the finished plan", async () => {
  const runningList = [{ id: "agent-1", sessionId: "s-bp", task: "plan the migration", startedAt: 5, live: true }];
  const completedList = [];
  const notified = [];
  const lookup = {
    running: () => runningList,
    completed: () => completedList,
    notify: (message) => notified.push(message),
    sleep: async () => {},
  };
  const relay = resolvePlanRelay(PLAN_REF_LATEST, lookup);
  runningList.length = 0;
  completedList.push({
    id: "agent-1",
    sessionId: "s-bp",
    task: "plan the migration",
    startedAt: 5,
    planText: "# Migration plan\n1. first step",
    ok: true,
  });
  const source = await relay;
  assert.equal(source.id, "agent-1");
  assert.equal(source.sessionId, "s-bp");
  assert.equal(source.planText, "# Migration plan\n1. first step");
  assert.equal(source.task, "plan the migration");
  assert.equal(notified.length, 1);
  assert.match(notified[0], /still running/);
});

test("resolvePlanRelay relays a blueprint that parks idle after its turn", async () => {
  const runningList = [{ id: "bp", sessionId: "s-bp", task: "plan it", startedAt: 1, live: true }];
  const lookup = { running: () => runningList, completed: () => [], sleep: async () => {} };
  const relay = resolvePlanRelay("bp", lookup);
  runningList[0] = {
    id: "bp",
    sessionId: "s-bp",
    task: "plan it",
    startedAt: 1,
    planText: "# parked plan",
    ok: true,
  };
  const source = await relay;
  assert.equal(source.planText, "# parked plan");
});

test("resolvePlanRelay rejects a blueprint whose turn ends interrupted", async () => {
  const runningList = [{ id: "bp", sessionId: "s", task: "t", startedAt: 1, live: true }];
  const lookup = { running: () => runningList, completed: () => [], sleep: async () => {} };
  const relay = resolvePlanRelay(PLAN_REF_LATEST, lookup);
  runningList[0] = {
    id: "bp",
    sessionId: "s",
    task: "t",
    startedAt: 1,
    planText: "Interrupted by user.\npartial",
    ok: false,
  };
  await assert.rejects(relay, /did not finish with a usable plan/);
});

test("resolvePlanRelay rejects a blueprint that vanishes without finishing", async () => {
  const runningList = [{ id: "bp", sessionId: "s", task: "t", startedAt: 1, live: true }];
  const lookup = { running: () => runningList, completed: () => [], sleep: async () => {} };
  const relay = resolvePlanRelay(PLAN_REF_LATEST, lookup);
  runningList.length = 0;
  await assert.rejects(relay, /did not finish with a usable plan/);
});

test("resolvePlanRelay rejects sources without a usable plan", async () => {
  const emptyLookup = { running: () => [], completed: () => [] };
  await assert.rejects(resolvePlanRelay(PLAN_REF_LATEST, emptyLookup), /No plan-mode agent to relay/);
  await assert.rejects(resolvePlanRelay("agent-7", emptyLookup), /No plan-mode agent with id agent-7/);
  const failed = { id: "a", sessionId: "s", task: "t", startedAt: 1, planText: "", ok: false };
  await assert.rejects(
    resolvePlanRelay(PLAN_REF_LATEST, { running: () => [failed], completed: () => [] }),
    /did not finish with a usable plan/,
  );
  // ok:false mirrors what runningPlanCandidate/completedPlanCandidate compute for interrupted text.
  const interrupted = { id: "a", sessionId: "s", task: "t", startedAt: 1, planText: "Interrupted by user.\npartial", ok: false };
  await assert.rejects(
    resolvePlanRelay(PLAN_REF_LATEST, { running: () => [interrupted], completed: () => [] }),
    /did not finish with a usable plan/,
  );
});

test("composeRelayInstruction embeds the plan verbatim with an optional supplement", () => {
  const source = { id: "agent-1", sessionId: "s-bp", task: "plan it", planText: "PLAN BODY" };
  const bare = composeRelayInstruction(source, "");
  assert.match(bare, /do not re-plan/);
  assert.match(bare, /verbatim, from blueprint agent-1/);
  assert.ok(bare.includes("PLAN BODY"));
  assert.ok(!bare.includes("Additional instruction"));
  const withNote = composeRelayInstruction(source, "use Postgres");
  assert.match(withNote, /Additional instruction from the user: use Postgres/);
  assert.ok(withNote.includes("PLAN BODY"));
});

// ── /agent resume: failed-agent recovery ─────────────────────────────────────

function agentResultEntry(agentId, { ok, sessionId, invocation, error } = {}) {
  return {
    type: "custom_message",
    customType: MESSAGE_TYPE,
    content: [
      "<user_agent_error command=\"/agent\">",
      "<user_invocation>",
      invocation ?? `/agent -s fix it (${agentId})`,
      "</user_invocation>",
      "<task>",
      "fix it",
      "</task>",
      `<error>\n${error ?? "boom"}\n</error>`,
      "</user_agent_error>",
    ].join("\n"),
    details: {
      agentId,
      sessionId,
      command: "agent",
      inheritedContext: true,
      model: "prov/m",
      modelLabel: "m",
      task: "fix it",
      ok,
      error: ok ? undefined : (error ?? "boom"),
    },
  };
}

const dispatchErrorEntry = () => ({
  type: "custom_message",
  customType: MESSAGE_TYPE,
  content: "<user_agent_error command=\"/agent\">…</user_agent_error>",
  details: {
    command: "agent",
    inheritedContext: true,
    model: "",
    modelLabel: "",
    task: "resume",
    ok: false,
    error: "bad flag",
  },
});

test("collectFailedAgentTargets: latest status per agentId wins — failure → success drops it", () => {
  const targets = collectFailedAgentTargets([
    agentResultEntry("user-3", { ok: false }),
    agentResultEntry("user-3", { ok: true }),
  ]);
  assert.equal(targets.length, 0);
});

test("collectFailedAgentTargets: success → later failure is collected (resumable again)", () => {
  const targets = collectFailedAgentTargets([
    agentResultEntry("user-3", { ok: true }),
    agentResultEntry("user-3", { ok: false, error: "second crash" }),
  ]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].agentId, "user-3");
  assert.equal(targets[0].error, "second crash");
});

test("collectFailedAgentTargets: extracts agentId, sessionId, invocation, and task from failures", () => {
  const [target] = collectFailedAgentTargets([
    agentResultEntry("user-5", {
      ok: false,
      sessionId: "0199c4f2",
      invocation: "/agent -i -m prov/m fix it",
      error: "empty response",
    }),
  ]);
  assert.equal(target.agentId, "user-5");
  assert.equal(target.sessionId, "0199c4f2");
  assert.equal(target.invocation, "/agent -i -m prov/m fix it");
  assert.equal(target.task, "fix it");
  assert.equal(target.error, "empty response");
});

test("collectFailedAgentTargets: skips entries without an agentId (dispatch-time errors)", () => {
  const targets = collectFailedAgentTargets([
    dispatchErrorEntry(),
    agentResultEntry("user-4", { ok: false }),
  ]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].agentId, "user-4");
});

test("selectResumeTargets: merges persisted entries with live widget cards, persisted wins per id", () => {
  const selection = selectResumeTargets({
    isShuttingDown: false,
    entries: [
      agentResultEntry("user-3", { ok: false, sessionId: "s-3" }),
      agentResultEntry("user-4", { ok: false }),
    ],
    widgetTargets: [
      // Same id as a persisted failure: persisted data must win.
      { agentId: "user-3", command: "agent", task: "stale card task" },
      // Live-only failure (e.g. never persisted during shutdown): still resumable.
      { agentId: "user-9", command: "agent", task: "card-only task" },
    ],
    runningAgentIds: [],
  });
  assert.deepEqual(
    selection.targets.map((target) => target.agentId).sort(),
    ["user-3", "user-4", "user-9"],
  );
  const user3 = selection.targets.find((target) => target.agentId === "user-3");
  assert.equal(user3.sessionId, "s-3");
  assert.equal(user3.task, "fix it");
  assert.equal(selection.targets.find((target) => target.agentId === "user-9").task, "card-only task");
  assert.equal(selection.skipped.length, 0);
});

test("selectResumeTargets: a widget failure card whose id later succeeded is not resumed", () => {
  const selection = selectResumeTargets({
    isShuttingDown: false,
    entries: [agentResultEntry("user-3", { ok: false }), agentResultEntry("user-3", { ok: true })],
    widgetTargets: [{ agentId: "user-3", command: "agent", task: "fix it" }],
    runningAgentIds: [],
  });
  assert.equal(selection.targets.length, 0);
});

test("selectResumeTargets: skips ids that are already running again, with a reason", () => {
  const selection = selectResumeTargets({
    isShuttingDown: false,
    entries: [agentResultEntry("user-3", { ok: false })],
    widgetTargets: [],
    runningAgentIds: ["user-3"],
  });
  assert.equal(selection.targets.length, 0);
  assert.deepEqual(selection.skipped, [{ agentId: "user-3", reason: "already running again" }]);
});

test("selectResumeTargets: refuses to resume while shutting down", () => {
  const selection = selectResumeTargets({
    isShuttingDown: true,
    entries: [agentResultEntry("user-3", { ok: false })],
    widgetTargets: [],
    runningAgentIds: [],
  });
  assert.ok(selection.blocked);
  assert.match(selection.blocked, /shutting down/);
  assert.equal(selection.targets.length, 0);
});

test("planFailedAgentResume: continues the session file when it exists", () => {
  const plan = planFailedAgentResume({ agentId: "user-3", command: "agent", task: "fix it" }, "/sessions/x.jsonl", false);
  assert.deepEqual(plan, { mode: "continue", sessionFile: "/sessions/x.jsonl" });
});

test("planFailedAgentResume: falls back to a fresh re-dispatch when the session file is missing", () => {
  const withSessionId = planFailedAgentResume(
    { agentId: "user-3", command: "agent", task: "fix it", sessionId: "s-3" },
    undefined,
    false,
  );
  assert.equal(withSessionId.mode, "redispatch");
  assert.match(withSessionId.reason, /session file for user-3 is missing/);
  const legacy = planFailedAgentResume({ agentId: "user-3", command: "agent", task: "fix it" }, undefined, false);
  assert.equal(legacy.mode, "redispatch");
  assert.match(legacy.reason, /predates per-agent session tracking/);
});

test("planFailedAgentResume: plan-relay agents cannot be re-dispatched without their session", () => {
  const plan = planFailedAgentResume(
    { agentId: "user-3", command: "agent", task: "fix it", sessionId: "s-3" },
    undefined,
    true,
  );
  assert.equal(plan.mode, "skip");
  assert.match(plan.reason, /plan-relay agent cannot be re-dispatched/);
});

test("resume idempotency: a failed→resumed→succeeded history is never re-collected", () => {
  const entries = [
    agentResultEntry("user-3", { ok: false, sessionId: "s-3", error: "first crash" }),
    agentResultEntry("user-3", { ok: false, sessionId: "s-3", error: "second crash" }),
    agentResultEntry("user-3", { ok: true }),
  ];
  assert.equal(collectFailedAgentTargets(entries).length, 0);
  // Failing again after the resume restores resumability with the latest error.
  const afterAnotherFailure = [
    ...entries,
    agentResultEntry("user-3", { ok: false, sessionId: "s-3", error: "third crash" }),
  ];
  const [target] = collectFailedAgentTargets(afterAnotherFailure);
  assert.equal(target.agentId, "user-3");
  assert.equal(target.error, "third crash");
});

test("agentArgsFromInvocation: strips the leading /command token, keeps the rest verbatim", () => {
  assert.equal(agentArgsFromInvocation("/agent -s fix the bug"), "-s fix the bug");
  assert.equal(agentArgsFromInvocation("/spawn fix it"), "fix it");
  assert.equal(agentArgsFromInvocation("/agent"), "");
  assert.equal(agentArgsFromInvocation(undefined), "");
  assert.equal(agentArgsFromInvocation("dispatch_agent: fix it"), "");
});

test("resume subcommand is ordinary prose to the parser (interception happens upstream)", () => {
  // `/agent resume` is intercepted before parseAgentCommand; the parser still treats a
  // bare `resume` word as a task so a quoted first word dispatches normally.
  assert.equal(parseAgentCommand("resume everything", "agent").task, "resume everything");
  assert.equal(parseAgentCommand('"resume everything"', "agent").task, '"resume everything"');
});

test("parseOrchestrationArgs parses duration forms, bare minutes, defaults, and bounds", () => {
  assert.deepEqual(parseOrchestrationArgs("10m fix the flaky retry test"), { budgetMs: 600000, task: "fix the flaky retry test" });
  assert.deepEqual(parseOrchestrationArgs("90s quick sanity sweep"), { budgetMs: 90000, task: "quick sanity sweep" });
  assert.deepEqual(parseOrchestrationArgs("1h30m large refactor"), { budgetMs: 5400000, task: "large refactor" });
  assert.deepEqual(parseOrchestrationArgs("7 tidy the test suite"), { budgetMs: 420000, task: "tidy the test suite" });
  assert.deepEqual(parseOrchestrationArgs("fix the flaky retry test"), { budgetMs: DEFAULT_ORCHESTRATION_BUDGET_MS, task: "fix the flaky retry test" });
  assert.equal(parseOrchestrationArgs("10x not a duration").task, "10x not a duration", "unknown units fall back to task text");
  assert.equal(parseOrchestrationArgs(""), undefined);
  assert.equal(parseOrchestrationArgs("10m"), undefined, "duration without a task is rejected");
  assert.equal(parseOrchestrationArgs("48h far too long").budgetMs, MAX_ORCHESTRATION_BUDGET_MS, "budget clamped to the pi-subagents timeout ceiling");
});

test("buildOrchestrationPrompt embeds the budget, absolute deadline, and protocol rules", () => {
  const prompt = buildOrchestrationPrompt({ budgetMs: 60000, task: "audit the retry paths" }, 1700000000000);
  assert.ok(prompt.startsWith("[Orchestration Request]\naudit the retry paths"));
  assert.match(prompt, /Wall-clock budget: 60s/);
  assert.match(prompt, /absolute deadline: 2023-11-14T22:14:20\.000Z/);
  assert.match(prompt, /top-level timeoutMs = 60000/);
  assert.match(prompt, /~80% of the budget/);
  assert.match(prompt, /status \(done\|partial\|blocked\|failed\)/);
  assert.match(prompt, /Execute first: in your first action/);
  assert.match(prompt, /never open with a decomposition pass/);
  assert.match(prompt, /Add workers progressively/);
  assert.match(prompt, /Split cheaply while executing/);
  assert.doesNotMatch(prompt, /Decompose the request into non-overlapping lanes/);
});

test("registerOrchestrate registers /orchestrate and forwards the protocol prompt", async () => {
  const pi = createPi();
  registerOrchestrate(pi);
  const command = pi.commands.get("orchestrate");
  assert.ok(command, "orchestrate command must be registered");
  assert.match(command.description, /wall-clock budget/);
  const { ctx, notifications } = createCtx();
  await command.handler("15m fix the login race", ctx);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /900s wall-clock budget/);
  assert.equal(pi.messages.length, 1);
  const forwarded = pi.messages[0];
  assert.match(forwarded.message, /\[Orchestration Request\]\nfix the login race/);
  assert.match(forwarded.message, /top-level timeoutMs = 900000/);
  assert.equal(forwarded.options.streamingBehavior, "followUp");
});

test("registerClear registers /aclear", () => {
  const pi = createPi();
  registerClear(pi, { clearAll: () => ({ closedLive: 0, dismissedCompleted: 0 }) });
  const command = pi.commands.get("aclear");
  assert.ok(command, "aclear command must be registered");
  assert.match(command.description, /detach all running background agents/);
});

test("/aclear with nothing to clear informs the user", async () => {
  const pi = createPi();
  let calls = 0;
  registerClear(pi, {
    clearAll: () => {
      calls++;
      return { closedLive: 0, dismissedCompleted: 0 };
    },
  });
  const { ctx, notifications } = createCtx();
  await pi.commands.get("aclear").handler("", ctx);
  assert.equal(calls, 1);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].message, "No /agent tasks to clear.");
  assert.equal(notifications[0].level, "info");
});

test("/aclear reports what it cleared", async () => {
  const pi = createPi();
  registerClear(pi, { clearAll: () => ({ closedLive: 2, dismissedCompleted: 3 }) });
  const { ctx, notifications } = createCtx();
  await pi.commands.get("aclear").handler("anything ignored", ctx);
  assert.equal(notifications.length, 1);
  assert.equal(
    notifications[0].message,
    "Cleared /agent tasks: detached 2 running agents, dismissed 3 completed cards.",
  );
});

test("describeClearCounts pluralizes and joins parts", () => {
  assert.equal(describeClearCounts({ closedLive: 0, dismissedCompleted: 0 }), "");
  assert.equal(describeClearCounts({ closedLive: 1, dismissedCompleted: 0 }), "detached 1 running agent");
  assert.equal(
    describeClearCounts({ closedLive: 2, dismissedCompleted: 1 }),
    "detached 2 running agents, dismissed 1 completed card",
  );
});
