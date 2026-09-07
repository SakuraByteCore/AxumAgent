/**
 * pi-todo
 *
 * Codex-style task progress panel for pi-coding-agent. Registers a `todo`
 * tool the model uses to maintain a task plan (pending / in_progress /
 * completed), renders the checklist in the transcript for each call, and
 * keeps a live progress widget above the editor.
 *
 * Single file, zero native deps. Widget state is per-process; the panel
 * appears once a plan exists and hides again when the plan empties. On
 * /resume (or fork) the latest plan is restored from session entries.
 */

import { Type } from "typebox";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, SessionMessageEntry, Theme } from "@earendil-works/pi-coding-agent";

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
const STATUS_GLYPH: Record<Exclude<TodoStatus, "in_progress">, string> = {
	completed: "[√]",
	pending: "[ ]",
};
const IN_PROGRESS_GLYPH = "[>]";
const SPINNER_FRAMES = ["-", "\\", "|", "/"];
const SPINNER_INTERVAL_MS = 120;
const ELLIPSIS = "\u2026";

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
let spinnerFrame = 0;
let spinnerTimer: ReturnType<typeof setInterval> | undefined;

// ── Rendering ──────────────────────────────────────────────────────────────

function charDisplayWidth(codePoint: number): number {
	return (
		(codePoint >= 0x1100 && codePoint <= 0x115f) ||
		(codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
		(codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
		(codePoint >= 0xff00 && codePoint <= 0xff60) ||
		(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
		(codePoint >= 0x20000 && codePoint <= 0x3fffd)
	) ? 2 : 1;
}

function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) width += charDisplayWidth(char.codePointAt(0) ?? 0);
	return width;
}

export function truncateToWidth(text: string, maxWidth: number): string {
	if (maxWidth < 1) return "";
	if (displayWidth(text) <= maxWidth) return text;
	const limit = maxWidth - 1;
	let result = "";
	let width = 0;
	for (const char of text) {
		const charWidth = charDisplayWidth(char.codePointAt(0) ?? 0);
		if (width + charWidth > limit) break;
		width += charWidth;
		result += char;
	}
	return result + ELLIPSIS;
}

function inProgressGlyph(): string {
	return `[${SPINNER_FRAMES[spinnerFrame]}]`;
}

function visibleItems(items: TodoItem[]): { visible: TodoItem[]; hiddenAfter: number } {
	if (items.length <= MAX_PANEL_ITEMS) return { visible: items, hiddenAfter: 0 };
	const activeIndex = items.findIndex((t) => t.status === "in_progress");
	// Slide the window so it stays full: clamp the start at the tail end
	// instead of anchoring on the active item, which would collapse the
	// panel to the trailing few rows once the active index passes the limit.
	const start = activeIndex >= MAX_PANEL_ITEMS ? Math.min(activeIndex, items.length - MAX_PANEL_ITEMS) : 0;
	const visible = items.slice(start, start + MAX_PANEL_ITEMS);
	return { visible, hiddenAfter: items.length - start - visible.length };
}

export function renderTodoLines(th: Theme, items: TodoItem[], width: number): string[] {
	const completed = items.filter((t) => t.status === "completed").length;
	const lines: string[] = [];
	const allDone = items.length > 0 && completed === items.length;
	const detail = allDone ? `${completed}/${items.length} done` : `${completed}/${items.length}`;
	const header = `${th.fg("accent", "Todo")} ${th.fg("dim", detail)}`;
	lines.push(header);
	const { visible, hiddenAfter } = visibleItems(items);
	for (const item of visible) {
		const glyph = item.status === "in_progress" ? inProgressGlyph() : STATUS_GLYPH[item.status];
		const prefix = `${glyph} `;
		const maxContent = Math.max(1, width - glyph.length - 1);
		const text = truncateToWidth(item.content, maxContent);
		let line = `${prefix}${text}`;
		if (item.status === "completed") line = th.fg("dim", line);
		else if (item.status === "in_progress") line = th.fg("accent", line);
		lines.push(line);
	}
	if (hiddenAfter > 0) {
		lines.push(th.fg("dim", `… ${hiddenAfter} more`));
	}
	return lines;
}

function stopSpinner(): void {
	if (!spinnerTimer) return;
	clearInterval(spinnerTimer);
	spinnerTimer = undefined;
	spinnerFrame = 0;
}

function updateSpinner(): void {
	const hasActive = todos.some((t) => t.status === "in_progress");
	if (!hasActive || !tui) {
		stopSpinner();
		return;
	}
	if (spinnerTimer) return;
	spinnerTimer = setInterval(() => {
		spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
		tui?.requestRender();
	}, SPINNER_INTERVAL_MS);
	spinnerTimer.unref?.();
}

function makeTodoComponent(): Component {
	return {
		render(width: number): string[] {
			if (!theme) return [];
			if (todos.length === 0) return [];
			return renderTodoLines(theme, todos, width);
		},
		invalidate() {
			stopSpinner();
			widgetRegistered = false;
			tui = undefined;
		},
		dispose() {
			stopSpinner();
			widgetRegistered = false;
			tui = undefined;
		},
	};
}

function refreshWidget(): void {
	if (!ui) {
		stopSpinner();
		return;
	}
	if (todos.length === 0) {
		stopSpinner();
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
				updateSpinner();
				return makeTodoComponent();
			},
			{ placement: "aboveEditor" },
		);
		widgetRegistered = true;
		return;
	}
	tui?.requestRender();
	updateSpinner();
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

/** Custom session entry that persists the plan so /resume can restore it. */
export const TODO_ENTRY_TYPE = "pi-todo-state";

interface TodoEntryData {
	todos: TodoItem[];
}

/**
 * Restore the newest persisted plan: custom entries win over legacy tool
 * results (sessions recorded before state persistence existed). Returns
 * null when the session holds no plan at all.
 */
function restoreTodos(ctx: ExtensionContext): TodoItem[] | null {
	const entries = ctx.sessionManager?.getEntries?.() ?? [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === TODO_ENTRY_TYPE) {
			const data = (entry as { data?: TodoEntryData }).data;
			return Array.isArray(data?.todos) ? normalizeTodos(data.todos) : [];
		}
		if (entry.type !== "message") continue;
		const message = (entry as SessionMessageEntry).message;
		if (message.role !== "toolResult" || message.toolName !== TOOL_NAME) continue;
		const details = (message as { details?: TodoEntryData }).details;
		if (Array.isArray(details?.todos)) return normalizeTodos(details.todos);
	}
	return null;
}

function summarized(todos_: TodoItem[]): string {
	const done = todos_.filter((t) => t.status === "completed").length;
	const active = todos_.find((t) => t.status === "in_progress");
	const head = `Todo list updated: ${done}/${todos_.length} completed.`;
	return active ? `${head} Current: ${active.content}` : head;
}

function formatChecklist(items: TodoItem[]): string {
	const done = items.filter((t) => t.status === "completed").length;
	const lines = [`Todo ${done}/${items.length}`];
	for (const item of items) {
		const glyph = item.status === "in_progress" ? IN_PROGRESS_GLYPH : STATUS_GLYPH[item.status];
		lines.push(`${glyph} ${item.content}`);
	}
	return lines.join("\n");
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
			"Update the plan immediately when the work changes: add newly discovered steps as pending and drop entries that are no longer needed.",
		],
		parameters: TODO_PARAMETERS,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<any> {
			todos = normalizeTodos(params.todos);
			pi.appendEntry<TodoEntryData>(TODO_ENTRY_TYPE, { todos });
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
				pi.appendEntry<TodoEntryData>(TODO_ENTRY_TYPE, { todos });
				refreshWidget();
				ctx.ui.notify("Todo list cleared", "info");
				return;
			}
			if (todos.length === 0) {
				ctx.ui.notify("No active todo list. The agent creates one with the todo tool for multi-step work.", "info");
				return;
			}
			ctx.ui.notify(formatChecklist(todos), "info");
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

	pi.on("session_start", async (event, ctx) => {
		stopSpinner();
		ui = ctx.hasUI && ctx.mode === "tui" ? ctx.ui : undefined;
		// Resume/fork continue an existing session: restore the latest persisted
		// plan. Startup/reload/new sessions start blank.
		const resumed = event.reason === "resume" || event.reason === "fork";
		todos = (resumed && restoreTodos(ctx)) || [];
		// Drop any widget still registered by a previous session.
		if (ui && widgetRegistered) {
			ui.setWidget(WIDGET_KEY, undefined);
		}
		widgetRegistered = false;
		tui = undefined;
		refreshWidget();
	});

	pi.on("session_shutdown", async () => {
		stopSpinner();
		if (ui && widgetRegistered) {
			ui.setWidget(WIDGET_KEY, undefined);
		}
		todos = [];
		ui = undefined;
		tui = undefined;
		widgetRegistered = false;
	});
}
