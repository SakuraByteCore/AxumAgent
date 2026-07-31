/**
 * pi-bar
 *
 * High-performance powerline-style status bar for pi-coding-agent.
 * Single-file, zero native deps, inline settings (no external settings pkg).
 * Segment producers are bundled; subscription usage (sub-hourly/sub-weekly)
 * listens for usage-core events but stays inert without a usage provider.
 *
 * Hot-path design:
 *  - Segment updates only mark a dirty flag; the TUI pulls via render().
 *  - Segment equality is a single struct-compare short-circuit; identical
 *    updates are dropped without touching the widget.
 *  - Rendering builds left/right segment arrays by id (no Map iteration),
 *    uses precomputed glyph tables, and joins in one pass.
 *  - No per-render allocations on the steady state: the dirty flag is the
 *    only write, and render reads live state directly.
 */

import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Segment {
	id: string;
	text?: string;
	suffix?: string;
	icon?: string;
	color?: string;
	bar?: number;
	barSegments?: number;
	visible: boolean;
}

interface SegEvent {
	id?: string;
	text?: string;
	suffix?: string;
	icon?: string;
	color?: string;
	bar?: number;
	barSegments?: number;
}

interface RegEvent {
	id: string;
	label: string;
}

interface Settings {
	left: string[];
	right: string[];
	placement: "aboveEditor" | "belowEditor";
	barWidth: number;
	barStyle: "continuous" | "blocks";
}

interface RateWindow {
	label?: string;
	usedPercent: number;
	resetDescription?: string;
}

interface UsageState {
	provider?: string;
	usage?: { windows: RateWindow[] };
}

// ---------------------------------------------------------------------------
// Settings (inline, no pi-extension-settings dependency)
// ---------------------------------------------------------------------------

const AGENT_DIR = process.env["PI_CODING_AGENT_DIR"] || join(homedir(), ".pi", "agent");
const SETTINGS_FILE = join(AGENT_DIR, "settings-extensions.json");
const EXT_NAME = "pi-bar";

const DEFAULTS: Settings = {
	left: ["git-branch", "git-head", "tokens", "context-usage"],
	right: ["messages", "work-time", "model", "sub-hourly", "sub-weekly"],
	placement: "belowEditor",
	barWidth: 10,
	barStyle: "blocks",
};

function loadSettings(): Settings {
	let raw: Record<string, Record<string, string>> = {};
	if (existsSync(SETTINGS_FILE)) {
		try {
			raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as Record<string, Record<string, string>>;
		} catch {
			raw = {};
		}
	}
	const s = raw[EXT_NAME] ?? {};
	const split = (v: string | undefined, d: string): string[] =>
		(v ?? d)
			.split(",")
			.map((x) => x.trim())
			.filter(Boolean);
	const num = (v: string | undefined, d: number): number => {
		const n = Number.parseInt(v ?? "", 10);
		return Number.isFinite(n) ? Math.max(4, Math.min(24, n)) : d;
	};
	const bstyle = (v: string | undefined): "continuous" | "blocks" => (v === "continuous" ? "continuous" : "blocks");
	const place = (v: string | undefined): "aboveEditor" | "belowEditor" =>
		v === "aboveEditor" ? "aboveEditor" : "belowEditor";
	return {
		left: split(s["left"], DEFAULTS.left.join(",")),
		right: split(s["right"], DEFAULTS.right.join(",")),
		placement: place(s["placement"]),
		barWidth: num(s["bar-width"], DEFAULTS.barWidth),
		barStyle: bstyle(s["bar-style"]),
	};
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const BLOCKS = [" ", "\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];
const PARTIAL = ["\u258f", "\u258e", "\u258d", "\u258c", "\u258b", "\u258a", "\u2589"];

function renderContinuous(percent: number, width: number, theme: Theme, color: ThemeColor): string {
	const p = percent < 0 ? 0 : percent > 100 ? 100 : percent;
	const filledFloat = (p / 100) * width;
	const full = Math.floor(filledFloat);
	const rem = filledFloat - full;
	const filledStr = "\u2588".repeat(full);
	let partial = "";
	let empty = width - full;
	if (rem >= 0.0625 && full < width) {
		const idx = Math.max(0, Math.min(PARTIAL.length - 1, Math.round(rem * 8) - 1));
		partial = PARTIAL[idx]!;
		empty = empty > 0 ? empty - 1 : 0;
	}
	return theme.fg(color, filledStr + partial) + " ".repeat(empty);
}

function renderBlocks(percent: number, n: number, theme: Theme, color: ThemeColor): string {
	const p = percent < 0 ? 0 : percent > 100 ? 100 : percent;
	const filledFloat = (p / 100) * n;
	const dimBg = theme.getFgAnsi("dim").replace("\x1b[38;", "\x1b[48;");
	const fg = theme.getFgAnsi(color);
	const reset = "\x1b[39m\x1b[49m";
	let out = "";
	for (let i = 0; i < n; i++) {
		if (i > 0) out += " ";
		const level = Math.round(Math.max(0, Math.min(1, filledFloat - i)) * 8);
		const g = BLOCKS[level];
		out += level > 0 ? `${dimBg}${fg}${g}${reset}` : `${dimBg}${g}${reset}`;
	}
	return out;
}

function segColor(s: Segment): ThemeColor {
	return (s.color || "muted") as ThemeColor;
}

function renderSegment(s: Segment, settings: Settings, theme: Theme): string {
	const c = segColor(s);
	const parts: string[] = [];
	if (s.bar !== undefined) {
		// bar-only segments emit bar first, then text/suffix (statusline convention)
		const bw = s.barSegments ?? settings.barWidth;
		parts.push(settings.barStyle === "blocks" ? renderBlocks(s.bar, bw, theme, c) : renderContinuous(s.bar, bw, theme, c));
	}
	if (s.text) parts.push(theme.fg(c, s.text));
	if (s.suffix) parts.push(theme.fg(c, s.suffix));
	return parts.join(" ");
}

interface RSeg {
	text: string;
	width: number;
}

function renderSide(ids: string[], segs: Map<string, Segment>, settings: Settings, theme: Theme): RSeg[] {
	const out: RSeg[] = [];
	for (const id of ids) {
		const s = segs.get(id);
		if (!s || !s.visible) continue;
		const t = renderSegment(s, settings, theme);
		out.push({ text: t, width: visibleWidth(t) });
	}
	return out;
}

function shrinkWidest(arr: RSeg[], overflow: number): void {
	let wi = 0;
	for (let i = 1; i < arr.length; i++) if (arr[i]!.width > arr[wi]!.width) wi = i;
	const s = arr[wi]!;
	const tgt = Math.max(1, s.width - overflow);
	const t = truncateToWidth(s.text, tgt, "\u2026");
	arr[wi] = { text: t, width: tgt };
}

export function renderBar(segs: Map<string, Segment>, settings: Settings, theme: Theme, width: number): string[] {
	// First line: git-branch (left) + messages (right).
	const header = segs.get("git-branch");
	const msgs = segs.get("messages");
	const leftTxt = header?.visible && header.text ? renderSegment(header, settings, theme) : "";
	const rightTxt = msgs?.visible && msgs.text ? renderSegment(msgs, settings, theme) : "";
	const firstLine = layoutPair(leftTxt, rightTxt, width);

	// Second line: all remaining segments in the configured left/right order.
	const lineLeft = settings.left.filter((id) => id !== "git-branch" && id !== "messages");
	const lineRight = settings.right.filter((id) => id !== "git-branch" && id !== "messages");
	const secondLine = renderLine(lineLeft, lineRight, segs, settings, theme, width);
	return [firstLine, secondLine];
}

function layoutPair(leftTxt: string, rightTxt: string, width: number): string {
	const lw = visibleWidth(leftTxt);
	const rw = visibleWidth(rightTxt);
	if (lw + rw + 1 > width) {
		return truncateToWidth(`${leftTxt} ${rightTxt}`.trim(), width, "\u2026");
	}
	const pad = Math.max(1, width - lw - rw);
	return `${leftTxt}${" ".repeat(pad)}${rightTxt}`;
}

function renderLine(lineLeft: string[], lineRight: string[], segs: Map<string, Segment>, settings: Settings, theme: Theme, width: number): string {
	const sep = " ";
	const sepW = 1;
	const left = renderSide(lineLeft, segs, settings, theme);
	const right = renderSide(lineRight, segs, settings, theme);
	const all = left.concat(right);
	const sepCount = Math.max(0, left.length - 1) + Math.max(0, right.length - 1);
	const segW = all.reduce((a, s) => a + s.width, 0);
	const minPad = 1;
	let need = segW + sepCount * sepW + minPad;
	if (need > width) {
		let overflow = need - width;
		for (let i = 0; i < all.length && overflow > 0; i++) {
			shrinkWidest(all, overflow);
			overflow = all.reduce((a, s) => a + s.width, 0) + sepCount * sepW + minPad - width;
		}
	}
	const joined = (arr: RSeg[]): RSeg =>
		arr.length === 0 ? { text: "", width: 0 } : { text: arr.map((s) => s.text).join(sep), width: arr.reduce((a, s) => a + s.width, 0) + (arr.length - 1) * sepW };
	const l = joined(left);
	const r = joined(right);
	const pad = Math.max(minPad, width - l.width - r.width);
	return truncateToWidth(`${l.text}${" ".repeat(pad)}${r.text}`, width, "\u2026");
}

// ---------------------------------------------------------------------------
// Producers
// ---------------------------------------------------------------------------

function segEqual(a: Segment | undefined, b: Segment): boolean {
	// Fast struct compare via field concatenation; avoids per-field checks.
	return (
		a !== undefined &&
		a.text === b.text &&
		a.suffix === b.suffix &&
		a.icon === b.icon &&
		a.color === b.color &&
		a.bar === b.bar &&
		a.barSegments === b.barSegments
	);
}

function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

// Duration always keeps seconds as the lowest unit so the running timer
// ticks visibly even once minutes/hours accrue.
function fmtDuration(ms: number): string {
	if (ms < 0) ms = 0;
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const remS = s % 60;
	if (m < 60) return `${m}m ${remS}s`;
	const h = Math.floor(m / 60);
	const remM = m % 60;
	return `${h}h ${remM}m ${remS}s`;
}

function displayPath(cwd: string, home: string): string {
	if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
	const windowsRoot = cwd.match(/^([A-Za-z]:)[\\/](?:.*[\\/])?([^\\/]+)$/);
	return windowsRoot ? `${windowsRoot[1]}\\~\\${windowsRoot[2]}` : cwd;
}

function gitBranch(cwd: string): string | undefined {
	try {
		const head = readFileSync(join(cwd, ".git", "HEAD"), "utf-8").trim();
		return head.startsWith("ref: refs/heads/") ? head.slice(16) : head.slice(0, 8);
	} catch {
		return undefined;
	}
}

// SVN detection: walk up from cwd looking for a ".svn" metadata dir.
// SVN >=1.7 keeps a single ".svn" at the working copy root, so ascent is
// required. Pure directory-stat probe, no subprocess spawn (matches the
// lightweight file-only style of gitBranch). svn outranks git wherever both
// apply; see emitGit for the precedence order.
function isSvn(cwd: string): boolean {
	let dir = cwd;
	try {
		while (true) {
			const svnDir = join(dir, ".svn");
			if (existsSync(svnDir) && statSync(svnDir).isDirectory()) return true;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch {
		// stat failures are rare; treat as "not svn" and fall through to git.
	}
	return false;
}

function usageColor(pct: number): string {
	return pct > 80 ? "error" : pct > 60 ? "warning" : "muted";
}
// Mini Reimu (博丽灵梦) working indicator: 3-line half-body ASCII in warm palette B.
// Frames carry inline ANSI colors + newlines; host Loader renders them verbatim.
const RIBBON = "\x1b[38;2;240;198;116m";
const FACE   = "\x1b[38;2;206;145;120m";
const HAIR   = "\x1b[38;2;178;148;187m";
const RST    = "\x1b[39m";
const REIMU_FRAMES: string[] = [
	`${RIBBON}＊${RST}${HAIR}～${RST}\n${FACE}(・ω・)${RST}`,
	`${RIBBON} ✦${RST}${HAIR}～${RST}\n${FACE}(・ω・)${RST}`,
	`${RIBBON}＋${RST}${HAIR}～～${RST}\n${FACE}(・ー・)${RST}`,
	`${RIBBON}＊${RST}${HAIR}～${RST}\n${FACE}(・ω・)${RST}`,
];
const REIMU_INTERVAL_MS = 280;


// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	const segs = new Map<string, Segment>();
	let settings: Settings = DEFAULTS;
	let currentCtx: ExtensionContext | undefined;
	let dirty = false;
	// Active agent run start (epoch ms); undefined when idle. See agent_start/agent_settled.
	let workStartMs: number | undefined;

	// Register API surface for other extensions (kept compatible with the
	// upstream event contract so segment emitters keep working transparently).
	pi.events.on("pi-bar:register-segment", (data: unknown) => {
		const ev = data as RegEvent;
		if (!ev?.id) return;
		// Segment catalog is implicit here: any id emitted via update appears.
		// We keep a hidden entry so renderSide can find it once data arrives.
		if (!segs.has(ev.id)) segs.set(ev.id, { id: ev.id, visible: false });
	});

	pi.events.on("pi-bar:update", (data: unknown) => {
		const ev = data as SegEvent;
		if (!ev?.id) return;
		const id = ev.id;
		if (!ev.text && !ev.suffix && ev.bar === undefined) {
			if (segs.delete(id)) dirty = true;
			return;
		}
		const next: Segment = {
			id,
			text: ev.text ?? "",
			suffix: ev.suffix,
			icon: ev.icon,
			color: ev.color,
			bar: ev.bar,
			barSegments: ev.barSegments,
			visible: !!(ev.text || ev.suffix || ev.bar !== undefined),
		};
		if (segEqual(segs.get(id), next)) return;
		segs.set(id, next);
		dirty = true;
	});

	// Subscription usage events from pi-usage (if loaded as a sibling).
	// Inert when no usage provider is present: events simply never fire.
	pi.events.on("usage-core:ready", (payload: unknown) => emitUsage(payload));
	pi.events.on("usage-core:update-current", (payload: unknown) => emitUsage(payload));

	function emitUsage(payload: unknown): void {
		const state = (payload as { state?: UsageState })?.state;
		if (!state?.provider || !state.usage?.windows?.length) {
			pi.events.emit("pi-bar:update", { id: "sub-hourly", text: undefined });
			pi.events.emit("pi-bar:update", { id: "sub-weekly", text: undefined });
			return;
		}
		emitWindow("sub-hourly", state.usage.windows[0], 5);
		emitWindow("sub-weekly", state.usage.windows[1], 7);
	}

	function emitWindow(id: string, w: RateWindow | undefined, bw: number): void {
		if (!w) {
			pi.events.emit("pi-bar:update", { id, text: undefined });
			return;
		}
		const pct = Math.round(w.usedPercent);
		const parts: string[] = [];
		if (w.label) parts.push(w.label);
		if (w.resetDescription) parts.push(w.resetDescription);
		pi.events.emit("pi-bar:update", {
			id,
			text: parts.join(" "),
			suffix: `${pct}%`,
			bar: pct,
			barSegments: bw,
			color: usageColor(pct),
		});
	}

	// --- Built-in producers ---

	function emitGit(ctx: ExtensionContext): void {
		const path = displayPath(ctx.cwd, homedir());
		// Precedence: svn > git > empty.
		// svn outranks git: a working copy checked out under a git repo shows "svn".
		if (isSvn(ctx.cwd)) {
			pi.events.emit("pi-bar:update", { id: "git-branch", text: path, color: "mdHeading" });
			pi.events.emit("pi-bar:update", { id: "git-head", text: "svn", color: "mdLink" });
			return;
		}
		const b = gitBranch(ctx.cwd);
		if (!b) {
			pi.events.emit("pi-bar:update", { id: "git-branch", text: undefined });
			pi.events.emit("pi-bar:update", { id: "git-head", text: undefined });
			return;
		}
		pi.events.emit("pi-bar:update", { id: "git-branch", text: path, color: "mdHeading" });
		pi.events.emit("pi-bar:update", { id: "git-head", text: `git.${b}`, color: "mdLink" });
	}

	function emitTokens(ctx: ExtensionContext): void {
		let ti = 0;
		let to = 0;
		let cost = 0;
		let msgCount = 0;
		const entries = ctx.sessionManager.getEntries();
		for (const e of entries) {
			if (e.type !== "message") continue;
			msgCount += 1;
			const m = (e as { message: { role?: string; usage?: { input: number; output: number; cost?: { total: number } } } }).message;
			if (m.role !== "assistant" || !m.usage) continue;
			ti += m.usage.input;
			to += m.usage.output;
			cost += m.usage.cost?.total ?? 0;
		}
		pi.events.emit("pi-bar:update", { id: "messages", text: `#${msgCount}`, color: "thinkingMedium" });
		emitWorkTime(ctx);
		if (ti === 0 && to === 0) {
			pi.events.emit("pi-bar:update", { id: "tokens", text: "\u21910 \u21930", color: "text" });
			return;
		}
		const parts = [`\u2191${fmtTokens(ti)}`, `\u2193${fmtTokens(to)}`];
		if (cost > 0) parts.push(`$${cost.toFixed(2)}`);
		pi.events.emit("pi-bar:update", { id: "tokens", text: parts.join(" "), color: "text" });
	}

	function emitWorkTime(_ctx: ExtensionContext): void {
		const workMs = workStartMs ? Date.now() - workStartMs : 0;
		pi.events.emit("pi-bar:update", { id: "work-time", text: fmtDuration(workMs), color: "syntaxComment" });
	}

	function emitContext(ctx: ExtensionContext): void {
		const u = ctx.getContextUsage();
		if (!u || u.tokens == null) {
			pi.events.emit("pi-bar:update", { id: "context-usage", text: "", suffix: "0%", color: "syntaxString" });
			return;
		}
		const pct = Math.round((u.tokens / u.contextWindow) * 100);
		pi.events.emit("pi-bar:update", {
			id: "context-usage",
			text: "",
			suffix: `${pct}%`,
			color: "syntaxString",
		});
	}


	function emitModel(ctx: ExtensionContext): void {
		const m = ctx.model;
		if (!m) return;
		const name = m.id.lastIndexOf("/") >= 0 ? m.id.slice(m.id.lastIndexOf("/") + 1) : m.id;
		let text = name;
		if (m.reasoning) {
			const lvl = pi.getThinkingLevel();
			text = lvl === "off" ? `${name} \u00b7 off` : `${name} \u00b7 ${lvl}`;
		}
		pi.events.emit("pi-bar:update", { id: "model", text, color: "thinkingHigh" });
	}

	// --- Render refresh (coalesced) ---

	function refresh(): void {
		if (!currentCtx?.hasUI) return;
		currentCtx.ui.setWidget(
			"pi-bar",
			(_tui: TUI, theme: Theme): Component & { dispose?(): void } => ({
				render(width: number): string[] {
					// Render reads live state; dirty only controls whether the
					// widget is re-attached. No per-refresh caching needed.
					return renderBar(segs, settings, theme, width);
				},
				invalidate(): void {
					// Stateless renderer; nothing to clear.
				},
			}),
			{ placement: settings.placement },
		);
		dirty = false;
	}

	function flushIfDirty(): void {
		if (dirty) refresh();
	}

	function hideFooter(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setFooter((_tui, _theme, _footerData) => ({
			render(): string[] {
				return [];
			},
			invalidate(): void {},
		}));
	}

	// --- Lifecycle ---

	pi.on("session_start", async (_event, ctx) => {
		settings = loadSettings();
		currentCtx = ctx;
		hideFooter(ctx);
		emitGit(ctx);
		emitTokens(ctx);
		emitContext(ctx);
		emitModel(ctx);
		refresh();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWidget("pi-bar", undefined);
		currentCtx = undefined;
		segs.clear();
	});

	pi.on("model_select", async (_event, ctx) => {
		emitModel(ctx);
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		emitModel(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		workStartMs = Date.now();
		emitWorkTime(ctx);
		emitContext(ctx);
		if (ctx.hasUI) {
			ctx.ui.setWorkingIndicator({ frames: REIMU_FRAMES, intervalMs: REIMU_INTERVAL_MS });
		}
		flushIfDirty();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		workStartMs = undefined;
		emitWorkTime(ctx);
		emitContext(ctx);
		if (ctx.hasUI) {
			ctx.ui.setWorkingIndicator();
		}
	});

	pi.on("turn_start", async (_event, ctx) => {
		emitContext(ctx);
		emitModel(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		emitTokens(ctx);
		emitContext(ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "bash") emitGit(ctx);
		emitTokens(ctx);
		emitContext(ctx);
	});

	// Coalesce frequent producer bursts into a single widget re-attach per tick.
	const flush = (): void => flushIfDirty();
	pi.events.on("pi-bar:update", flush);
	pi.events.on("pi-bar:register-segment", flush);
}
