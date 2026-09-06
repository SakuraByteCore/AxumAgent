import assert from "node:assert/strict";
import test from "node:test";
import register from "../plugin/pi-todo/index.ts";
import { renderTodoLines } from "../plugin/pi-todo/index.ts";

// ── Mock pi runtime ────────────────────────────────────────────────────────

function createPi() {
  const tools = new Map();
  const commands = new Map();
  const listeners = new Map();
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, cmd) { commands.set(name, cmd); },
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
  };
  return { pi, tools, commands, listeners };
}

async function emit(pi, event, ctx = {}) {
  for (const handler of pi.listeners.get(event) ?? []) {
    await handler({ type: event }, ctx);
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

function startSession(pi, ui) {
  return emit(pi, "session_start", { hasUI: true, mode: "tui", ui })
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

test("widget is registered by default at session start with an empty state", async () => {
  const pi = createPi();
  register(pi.pi);
  const uiState = makeUi();
  await startSession(pi, uiState.ui);

  const widgetFactory = uiState.widgets.get("pi-todo");
  assert.ok(widgetFactory, "widget visible by default, before any todo call");
  assert.equal(typeof widgetFactory, "function", "widget content is a component factory");

  const component = widgetFactory({ requestRender() {} }, theme);
  const lines = component.render(80);
  assert.ok(lines[0].includes("Todo"), "empty state shows the panel header");
  assert.ok(lines[0].includes("no active plan"), "empty state explains the panel");
  assert.equal(lines.some((l) => l.includes("done")), false, "no progress counter before a plan exists");
});

test("widget swaps empty state for the live plan and back without vanishing", async () => {
  const pi = createPi();
  register(pi.pi);
  const uiState = makeUi();
  await startSession(pi, uiState.ui);

  const tool = pi.tools.get("todo");
  await tool.execute("tc-3", {
    todos: [{ content: "Task A", status: "in_progress" }, { content: "Task B", status: "pending" }],
  }, undefined, undefined, undefined);
  const widgetFactory = uiState.widgets.get("pi-todo");
  const component = widgetFactory({ requestRender() {} }, theme);
  const lines = component.render(80);
  assert.equal(lines[0].includes("Todo"), true);
  assert.equal(lines[0].includes("0/2 done"), true);
  assert.ok(lines.some((l) => l.includes("[>]") && l.includes("Task A")));
  assert.ok(lines.some((l) => l.includes("[ ]") && l.includes("Task B")));

  // Emptying the plan returns to the default empty state; the panel stays.
  await tool.execute("tc-4", { todos: [] }, undefined, undefined, undefined);
  assert.ok(uiState.widgets.has("pi-todo"), "widget still registered after empty plan");
  const emptyLines = component.render(80);
  assert.ok(emptyLines[0].includes("no active plan"), "empty plan reverts to default empty state");
});

test("renderTodoLines truncates long lists and marks all-done header", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    content: `Step ${i + 1}`,
    status: i < 12 ? "completed" : "pending",
  }));
  const lines = renderTodoLines(theme, items, 60);
  assert.equal(lines[0].includes("12/12 done"), true);
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
  assert.ok(uiState.widgets.has("pi-todo"), "panel stays visible; only the plan is cleared");
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

test("session_start wipes only the plan; the panel stays visible with an empty state", async () => {
  const pi = createPi();
  register(pi.pi);
  const uiState = makeUi();
  await startSession(pi, uiState.ui);
  const tool = pi.tools.get("todo");
  await tool.execute("tc-6", { todos: [{ content: "Stale", status: "pending" }] }, undefined, undefined, undefined);
  assert.ok(uiState.widgets.has("pi-todo"));

  // New session: the panel remains by design, but no stale plan survives.
  await startSession(pi, uiState.ui);
  const widgetFactory = uiState.widgets.get("pi-todo");
  assert.ok(widgetFactory, "widget still visible after session restart");
  const lines = widgetFactory({ requestRender() {} }, theme).render(80);
  assert.ok(lines[0].includes("no active plan"), "new session starts from the empty state");
  assert.equal(lines.some((l) => l.includes("Stale")), false, "stale plan does not survive session restart");
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
