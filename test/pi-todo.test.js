import assert from "node:assert/strict";
import test from "node:test";
import register from "../plugin/pi-todo/index.ts";
import { renderTodoLines } from "../plugin/pi-todo/index.ts";

// ── Mock pi runtime ────────────────────────────────────────────────────────

function createPi() {
  const tools = new Map();
  const commands = new Map();
  const listeners = new Map();
  const entries = [];
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, cmd) { commands.set(name, cmd); },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
  };
  const sessionManager = { getEntries: () => entries };
  return { pi, tools, commands, listeners, entries, sessionManager };
}

async function emit(pi, event, ctx = {}, extra = {}) {
  for (const handler of pi.listeners.get(event) ?? []) {
    await handler({ type: event, ...extra }, ctx);
  }
}

const theme = { fg: (_color, text) => text };

function makeUi() {
  const widgets = new Map();
  const notifications = [];
  return {
    widgets,
    notifications,
    ui: {
      notify(message, level) { notifications.push({ message, level }); },
      setWidget(key, content, _options) {
        if (content === undefined) widgets.delete(key);
        else widgets.set(key, content);
      },
    },
  };
}

function startSession(pi, ui, opts = {}) {
  const ctx = pi.sessionManager
    ? { hasUI: true, mode: "tui", ui, sessionManager: pi.sessionManager }
    : { hasUI: true, mode: "tui", ui };
  return emit(pi, "session_start", ctx, { reason: opts.reason ?? "startup" });
}

// ── Tests ──────────────────────────────────────────────────────────────────

test("registers todo tool and /todo command", () => {
  const pi = createPi();
  register(pi.pi);
  assert.ok(pi.tools.has("todo"), "todo tool registered");
  assert.ok(pi.commands.has("todo"), "/todo command registered");
});

test("todo tool execution updates list and returns summary", async () => {
  const pi = createPi();
  register(pi.pi);
  const tool = pi.tools.get("todo");
  const result = await tool.execute("tc-1", {
    todos: [
      { content: "Inspect code", status: "completed" },
      { content: "Write tests", status: "in_progress" },
      { content: "Run suite", status: "pending" },
    ],
  }, undefined, undefined, undefined);
  assert.match(result.content[0].text, /1\/3 completed/);
  assert.equal(result.details.todos.length, 3);
  assert.equal(result.details.todos[1].status, "in_progress");
});

test("normalizes duplicate in_progress entries to first-wins, rest-pending", async () => {
  const pi = createPi();
  register(pi.pi);
  const tool = pi.tools.get("todo");
  const result = await tool.execute("tc-2", {
    todos: [
      { content: "A", status: "in_progress" },
      { content: "B", status: "in_progress" },
      { content: "C", status: "in_progress" },
    ],
  }, undefined, undefined, undefined);
  const statuses = result.details.todos.map((t) => t.status);
  assert.deepEqual(statuses, ["in_progress", "pending", "pending"]);
});

test("widget is absent at session start until the first todo call", async () => {
  const pi = createPi();
  register(pi.pi);
  const uiState = makeUi();
  await startSession(pi, uiState.ui);

  assert.equal(uiState.widgets.has("pi-todo"), false, "no widget before a plan exists");
});

test("todo tool registers the widget; emptying the plan hides it again", async () => {
  const pi = createPi();
  register(pi.pi);
  const uiState = makeUi();
  await startSession(pi, uiState.ui);

  const tool = pi.tools.get("todo");
  await tool.execute("tc-3", {
    todos: [{ content: "Task A", status: "in_progress" }, { content: "Task B", status: "pending" }],
  }, undefined, undefined, undefined);
  const widgetFactory = uiState.widgets.get("pi-todo");
  assert.ok(widgetFactory, "widget registered once a plan exists");
  const component = widgetFactory({ requestRender() {} }, theme);
  const lines = component.render(80);
  assert.equal(lines[0].includes("Todo"), true);
  assert.equal(lines[0].includes("1/2"), true, "in_progress counts toward progress");
  assert.ok(lines.some((l) => l.includes("[>]") && l.includes("Task A")));
  assert.ok(lines.some((l) => l.includes("[ ]") && l.includes("Task B")));

  await tool.execute("tc-4", { todos: [] }, undefined, undefined, undefined);
  assert.equal(uiState.widgets.has("pi-todo"), false, "widget hidden once the plan is empty");
  assert.deepEqual(component.render(80), [], "empty widget renders nothing");
});

test("renderTodoLines truncates long lists and marks all-done header", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    content: `Step ${i + 1}`,
    status: i < 12 ? "completed" : "pending",
  }));
  const lines = renderTodoLines(theme, items, 60);
  assert.equal(lines[0].includes("12/12 done"), true);
  assert.ok(lines.some((l) => l.includes("[√]")), "completed items use the checkmark glyph");
  const moreLine = lines.find((l) => l.includes("more"));
  assert.ok(moreLine && moreLine.includes("4"), "overflow line shows hidden count");
});

test("renderTodoLines truncates long content to width", () => {
  const long = "x".repeat(200);
  const lines = renderTodoLines(theme, [{ content: long, status: "pending" }], 40);
  const itemLine = lines[1];
  assert.ok(itemLine.length <= 40, `line ${itemLine.length} exceeds width`);
  assert.ok(itemLine.endsWith("…"), "truncation ellipsis at end");
});

test("/todo clear empties the list and notifys user", async () => {
  const pi = createPi();
  register(pi.pi);
  const uiState = makeUi();
  await startSession(pi, uiState.ui);
  const tool = pi.tools.get("todo");
  await tool.execute("tc-5", { todos: [{ content: "X", status: "pending" }] }, undefined, undefined, undefined);
  assert.ok(uiState.widgets.has("pi-todo"));

  const cmd = pi.commands.get("todo");
  await cmd.handler("clear", { ui: uiState.ui, hasUI: true, mode: "tui" });
  assert.equal(uiState.widgets.has("pi-todo"), false, "panel hidden after /todo clear");
  assert.equal(uiState.notifications.at(-1).message, "Todo list cleared");
});

test("/todo reports empty state when no plan exists", async () => {
  const pi = createPi();
  register(pi.pi);
  const uiState = makeUi();
  await startSession(pi, uiState.ui);
  const cmd = pi.commands.get("todo");
  await cmd.handler("", { ui: uiState.ui, hasUI: true, mode: "tui" });
  assert.match(uiState.notifications.at(-1).message, /No active todo list/);
});

test("session_start wipes the plan and hides the panel", async () => {
  const pi = createPi();
  register(pi.pi);
  const uiState = makeUi();
  await startSession(pi, uiState.ui);
  const tool = pi.tools.get("todo");
  await tool.execute("tc-6", { todos: [{ content: "Stale", status: "pending" }] }, undefined, undefined, undefined);
  assert.ok(uiState.widgets.has("pi-todo"));

  await startSession(pi, uiState.ui);
  assert.equal(uiState.widgets.has("pi-todo"), false, "widget hidden after session restart");
});

test("session_shutdown disposes widget and state", async () => {
  const pi = createPi();
  register(pi.pi);
  const uiState = makeUi();
  await startSession(pi, uiState.ui);
  const tool = pi.tools.get("todo");
  await tool.execute("tc-7", { todos: [{ content: "Live", status: "in_progress" }] }, undefined, undefined, undefined);
  assert.ok(uiState.widgets.has("pi-todo"));
  await emit(pi, "session_shutdown", {});
  assert.equal(uiState.widgets.has("pi-todo"), false, "widget removed on shutdown");
});

test("/resume restores the latest persisted plan and its panel", async () => {
  const pi = createPi();
  register(pi.pi);
  const uiState = makeUi();
  await startSession(pi, uiState.ui);
  const tool = pi.tools.get("todo");
  await tool.execute("tc-8", {
    todos: [
      { content: "First step", status: "completed" },
      { content: "Second step", status: "in_progress" },
    ],
  }, undefined, undefined, undefined);

  const uiState2 = makeUi();
  await startSession(pi, uiState2.ui, { reason: "resume" });
  const widgetFactory = uiState2.widgets.get("pi-todo");
  assert.ok(widgetFactory, "widget restored after resume");
  const component = widgetFactory({ requestRender() {} }, theme);
  const lines = component.render(80);
  assert.ok(lines.some((l) => l.includes("2/2")), "progress header restored");
  assert.ok(lines.some((l) => l.includes("Second step")));
});

test("/resume after /todo clear keeps the panel hidden", async () => {
  const pi = createPi();
  register(pi.pi);
  const uiState = makeUi();
  await startSession(pi, uiState.ui);
  const tool = pi.tools.get("todo");
  await tool.execute("tc-9", { todos: [{ content: "Task", status: "pending" }] }, undefined, undefined, undefined);
  const cmd = pi.commands.get("todo");
  await cmd.handler("clear", { ui: uiState.ui, hasUI: true, mode: "tui" });

  const uiState2 = makeUi();
  await startSession(pi, uiState2.ui, { reason: "resume" });
  assert.equal(uiState2.widgets.has("pi-todo"), false, "cleared plan stays cleared after resume");
});

test("fresh startup ignores session entries", async () => {
  const pi = createPi();
  register(pi.pi);
  const uiState = makeUi();
  await startSession(pi, uiState.ui);
  const tool = pi.tools.get("todo");
  await tool.execute("tc-10", { todos: [{ content: "Task", status: "pending" }] }, undefined, undefined, undefined);

  const uiState2 = makeUi();
  await startSession(pi, uiState2.ui, { reason: "startup" });
  assert.equal(uiState2.widgets.has("pi-todo"), false, "startup always starts blank");
});
