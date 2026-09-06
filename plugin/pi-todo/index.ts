/**
 * pi-todo
 *
 * Codex-style task progress panel for pi-coding-agent. Registers a `todo`
 * tool the model uses to maintain a task plan (pending / in_progress /
 * completed), renders the checklist in the transcript for each call, and
 * keeps a live progress widget above the editor.
 *
 * Single file, zero native deps. Widget state is per-process; the panel
 * appears once a plan exists and hides again when the plan empties, so
 * stale todos never survive /resume.
 */

import { Type } from "typebox";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";

// ── Types ──────────────────────────────────────────────────────────────────

type TodoStatus = "pending" | "in_progress" | "completed";

interface TodoItem {
	content: string;
	status: TodoStatus;
}

// ── Constants ──────────────────────────────────────────────────────────────

const WIDGET_KEY = "pi-todo";
const TOOL_NAME = "todo";
const MAX_PANEL_ITEMS = 8;
/** ASCII glyphs keep the panel dependency-free and safe in every terminal. */
/** Single-cell glyphs keep column math exact in every terminal. */
const STATUS_GLYPH: Record<TodoStatus, string> = {
	completed: "[√]",
	in_progress: "[>]",
	pending: "[ ]",
};

const TODO_PARAMETERS = Type.Object({
	todos: Type.Array(
		Type.Object({
			content: Type.String({ description: "One concrete task step, phrased imperatively." }),
			status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
				description: "Task status. Exactly one task may be in_progress at a time.",
			}),
		}),
		{ description: "The full task list (replaces the previous one entirely)." },
	),
});

// ── Module state ───────────────────────────────────────────────────────────

let todos: TodoItem[] = [];
let ui: ExtensionUIContext | undefined;
let tui: TUI | undefined;
let theme: Theme | undefined;
let widgetRegistered = false;

// ── Rendering ──────────────────────────────────────────────────────────────


export function renderTodoLines(th: Theme, items: TodoItem[], width: number): string[] {
	const progress = items.filter((t) => t.status !== "pending").length;
	const lines: string[] = [];
	const allDone = items.length > 0 && progress === items.length;
	const detail = allDone ? `${progress}/${items.length} done` : `${progress}/${items.length}`;
	const header = `${th.fg("accent", "Todo")} ${th.fg("dim", detail)}`;
	lines.push(header);
	const visible = items.slice(0, MAX_PANEL_ITEMS);
	for (const item of visible) {
		const glyph = STATUS_GLYPH[item.status];
		const prefix = `${glyph} `;
		const maxContent = Math.max(1, width - prefix.length);
		const text = item.content.length > maxContent ? item.content.slice(0, maxContent - 1) + "…" : item.content;
		let line = `${glyph} ${text}`;
		if (item.status === "completed") line = th.fg("dim", line);
		else if (item.status === "in_progress") line = th.fg("accent", line);
		lines.push(line);
	}
	if (items.length > visible.length) {
		lines.push(th.fg("dim", `… ${items.length - visible.length} more`));
	}
	return lines;
}

function makeTodoComponent(): Component {
	return {
		render(width: number): string[] {
			if (!theme) return [];
			if (todos.length === 0) return [];
			return renderTodoLines(theme, todos, width);
		},
		invalidate() {
			widgetRegistered = false;
			tui = undefined;
		},
		dispose() {
			widgetRegistered = false;
			tui = undefined;
		},
	};
}

function refreshWidget(): void {
	if (!ui) return;
	if (todos.length === 0) {
		if (widgetRegistered) {
			ui.setWidget(WIDGET_KEY, undefined);
			widgetRegistered = false;
			tui = undefined;
		}
		return;
	}
	if (!widgetRegistered) {
		ui.setWidget(
			WIDGET_KEY,
			(t, th) => {
				tui = t;
				theme = th;
				return makeTodoComponent();
			},
			{ placement: "aboveEditor" },
		);
		widgetRegistered = true;
		return;
	}
	tui?.requestRender();
}

// ── Tool registration ──────────────────────────────────────────────────────

function normalizeTodos(items: TodoItem[]): TodoItem[] {
	// Enforce the single-in_progress invariant: keep the first, demote extras.
	let seenInProgress = false;
	return items.map((item) => {
		if (item.status !== "in_progress") return item;
		if (!seenInProgress) {
			seenInProgress = true;
			return item;
		}
		return { content: item.content, status: "pending" };
	});
}

function summarized(todos_: TodoItem[]): string {
	const done = todos_.filter((t) => t.status === "completed").length;
	const active = todos_.find((t) => t.status === "in_progress");
	const head = `Todo list updated: ${done}/${todos_.length} completed.`;
	return active ? `${head} Current: ${active.content}` : head;
}

export default function register(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Todo List",
		description:
			"Maintain a task plan as a live checklist shown to the user in a progress panel. Pass the full updated list with every call: each entry is a task with status pending, in_progress, or completed. Use for multi-step work so the user can track progress.",
		promptSnippet: "todo: maintain a visible task checklist with progress tracking",
		promptGuidelines: [
			"For multi-step tasks (3+ steps), create a plan with the todo tool first, then mark each step in_progress as you start it and completed as you finish it.",
			"Keep exactly one task in_progress at a time; never leave the list stale after finishing work.",
			"When the task list is fully done, mark every entry completed rather than deleting entries.",
		],
		parameters: TODO_PARAMETERS,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<any> {
			todos = normalizeTodos(params.todos);
			refreshWidget();
			return {
				content: [{ type: "text" as const, text: summarized(todos) }],
				details: { todos },
			};
		},
		renderCall(args: any, th: Theme): Component {
			const items: TodoItem[] = Array.isArray(args?.todos) ? args.todos : [];
			return { render: (width: number) => renderTodoLines(th, items.length ? items : todos, width), invalidate() {} };
		},
		renderResult(result: any, _options: any, th: Theme): Component {
			const items: TodoItem[] = Array.isArray(result?.details?.todos) ? result.details.todos : todos;
			return { render: (width: number) => renderTodoLines(th, items, width), invalidate() {} };
		},
	});

	// ── Commands ───────────────────────────────────────────────────────────

	pi.registerCommand("todo", {
		description: "Show the current task checklist, or clear it: /todo [clear]",
		getArgumentCompletions: () => null,
		async handler(args: string, ctx: ExtensionContext) {
			const arg = args.trim().toLowerCase();
			if (arg === "clear") {
				todos = [];
				refreshWidget();
				ctx.ui.notify("Todo list cleared", "info");
				return;
			}
			if (todos.length === 0) {
				ctx.ui.notify("No active todo list. The agent creates one with the todo tool for multi-step work.", "info");
				return;
			}
			ctx.ui.notify(summarized(todos), "info");
			if (ctx.hasUI && ctx.mode === "tui") {
				refreshWidgetFrom(ctx.ui);
			}
		},
	});

	// ── Lifecycle ──────────────────────────────────────────────────────────────

	function refreshWidgetFrom(nextUi: ExtensionUIContext): void {
		ui = nextUi;
		refreshWidget();
	}

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.hasUI && ctx.mode === "tui" ? ctx.ui : undefined;
		todos = [];
		// Wipe the plan and drop any widget still registered by a previous session.
		if (ui && widgetRegistered) {
			ui.setWidget(WIDGET_KEY, undefined);
		}
		widgetRegistered = false;
		tui = undefined;
		refreshWidget();
	});

	pi.on("session_shutdown", async () => {
		if (ui && widgetRegistered) {
			ui.setWidget(WIDGET_KEY, undefined);
		}
		todos = [];
		ui = undefined;
		tui = undefined;
		widgetRegistered = false;
	});
}
