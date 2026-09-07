import assert from "node:assert/strict";
import test from "node:test";
import register from "../plugin/pi-todo/index.ts";
import { renderTodoLines, truncateToWidth } from "../plugin/pi-todo/index.ts";

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
  assert.equal(lines[0].includes("0/2"), true, "in_progress does not count as done");
  assert.ok(lines.some((l) => /\[([-\\|/])\]/.test(l) && l.includes("Task A")), "in_progress renders the spinner glyph");
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
  assert.ok(lines.some((l) => l.includes("1/2")), "progress header counts completed only");
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

test("truncateToWidth counts wide CJK characters as two columns", () => {
  const cjk = "任务步骤一二三四五六七八九十";
  const ascii = truncateToWidth("abcdefghij", 5);
  const wide = truncateToWidth(cjk, 9);
  assert.equal(ascii, "abcd…");
  assert.equal(wide, "任务步骤…");
  assert.equal(truncateToWidth("short", 20), "short", "short text untouched");
});

test("renderTodoLines keeps CJK lines within the panel width", () => {
  const items = [{ content: "修复进度计数并把长中文内容全部塞到一行展示测试", status: "in_progress" }];
  const width = 20;
  const lines = renderTodoLines(theme, items, width);
  const [, itemLine] = lines;
  assert.ok(itemLine.endsWith("…"), "CJK content truncated with ellipsis");
  const visualWidth = [...itemLine].reduce((w, ch) => w + (/[\u1100-\u115f\u2e80-\u9fff\uff00-\uff60]/.test(ch) ? 2 : 1), 0);
  assert.ok(visualWidth <= width, `line width ${visualWidth} exceeds ${width}`);
});

test("renderTodoLines keeps the in_progress item visible beyond the panel limit", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    content: `Step ${i + 1}`,
    status: i === 11 ? "in_progress" : "completed",
  }));
  const lines = renderTodoLines(theme, items, 60);
  assert.ok(lines.some((l) => l.includes("Step 12")), "active item visible even when it overflows the window");
  assert.equal(lines.some((l) => /\[√\] Step 1\b/.test(l)), false, "earlier items yield to the active one");
  assert.equal(lines.some((l) => l.includes("more")), false, "active item is the last entry, nothing hidden after it");
});

test("renderTodoLines keeps the panel full when the active item passes the limit", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    content: `Step ${i + 1}`,
    status: i === 11 ? "in_progress" : "completed",
  }));
  const lines = renderTodoLines(theme, items, 60);
  const rows = lines.filter((l) => /^\[.\] /.test(l));
  assert.equal(rows.length, 8, "window stays at MAX_PANEL_ITEMS instead of collapsing to the tail");
  assert.ok(rows.some((l) => l.includes("Step 12")), "active item still visible");
  assert.ok(rows.some((l) => l.includes("Step 5")), "window clamps to the tail end, keeping trailing context");
  assert.equal(rows.some((l) => /Step [1-4]\b/.test(l)), false, "overflowed leading items stay hidden");
});

test("/todo shows the full checklist as a multiline notification", async () => {
  const pi = createPi();
  register(pi.pi);
  const uiState = makeUi();
  await startSession(pi, uiState.ui);
  const tool = pi.tools.get("todo");
  await tool.execute("tc-11", {
    todos: [
      { content: "First step", status: "completed" },
      { content: "Second step", status: "in_progress" },
      { content: "Third step", status: "pending" },
    ],
  }, undefined, undefined, undefined);
  const cmd = pi.commands.get("todo");
  await cmd.handler("", { ui: uiState.ui, hasUI: true, mode: "tui" });
  const message = uiState.notifications.at(-1).message;
  assert.ok(message.includes("\n"), "notification spans multiple lines");
  assert.ok(message.includes("Todo 1/3"), "header reports completed count");
  assert.ok(message.includes("[>] Second step"), "in_progress row present");
  assert.ok(message.includes("[ ] Third step"), "pending row present");
});
