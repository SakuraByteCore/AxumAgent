/**
 * pi-bar
 *
 * High-performance powerline-style status bar for pi-coding-agent.
 * Single-file, zero native deps, inline settings (no external settings pkg).
 * Segment producers are bundled; no external usage provider is required.
 *
 *  - "coralline" barStyle renders each segment as a rounded pill: a dark
 *    role-color background block sealed by rounded caps (U+E0B6 /
 *    U+E0B4), with the segment's own bright semantic color as the text.
 *    Pills are separated by a clean single space (no powerline triangle),
 *    so each chip reads as its own self-contained block against the
 *    terminal base, and the dark ground + bright ink pairs stay readable.
 *  - Context usage renders as a threshold gauge: green below 50%, yellow
 *    50-75%, red above 75%, using the U+25B0 / U+25B1 glyphs.
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
	bg?: string;
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
	bg?: string;
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
	barStyle: "continuous" | "blocks" | "coralline";
}

// ---------------------------------------------------------------------------
// Settings (inline, no pi-extension-settings dependency)
// ---------------------------------------------------------------------------

const AGENT_DIR = process.env["PI_CODING_AGENT_DIR"] || join(homedir(), ".pi", "agent");
const SETTINGS_FILE = join(AGENT_DIR, "settings-extensions.json");
const EXT_NAME = "pi-bar";

const DEFAULTS: Settings = {
	left: ["git-branch", "git-head", "tokens-up", "tokens-down", "context-tokens", "context-usage"],
	right: ["messages", "model"],
	placement: "belowEditor",
	barWidth: 10,
	barStyle: "coralline",
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
	const bstyle = (v: string | undefined): Settings["barStyle"] =>
		v === "continuous" ? "continuous" : v === "blocks" ? "blocks" : "coralline";
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

// coralline pill caps (powerline glyphs, Nerd Font).
// CAP_L seals the left edge of a pill, CAP_R the right; both are solid
// glyph shapes drawn with the pill's own role color so each cap reads as
// a seamless rounded end of the bg block, not a stray arc.
const CAP_L = "\uE0B6";
const CAP_R = "\uE0B4";
// Powerline separator triangle: drawn between adjacent pills in a train so
// two bg blocks flow into one shape. Its foreground is the previous pill's
// ground (dints the triangle into the last block) and its background is the
// next pill's ground (the transition).
const SEP = "\uE0B0";

// Context gauge glyph: U+25B0 (▰) filled. Only filled cells render; no
// hollow-trailing glyph is emitted so the % sits right after the fill.
const GAUGE_FILL = "\u25B0";
const GAUGE_WARN_PCT = 50;
const GAUGE_HOT_PCT = 75;

// Pill ground palette: each visible segment gets its own warm, low-luminance
// RGB ground so every pill background is distinct yet the hues form one
// coherent warm family (brick reds, ambers, ochres, wine, olive). Luminance is
// kept low so the HOST's own "text" foreground (light on dark terminals,
// dark on light terminals) stays high-contrast against any of these grounds
// in both built-in themes, without depending on a per-theme color name.
// These are emitted as raw 24-bit ANSI escapes (\x1b[48;2;r;g;bm), so no
// theme color-name slot is consumed and the grounds render identically
// regardless of whether the host picked the dark or light theme.
type Rgb = readonly [number, number, number];
const PALETTE: Record<string, Rgb> = {
	"git-branch": [122, 59, 59],   // muted brick red
	"git-head":   [125, 90, 60],   // dark amber / ochre
	"tokens-up":   [120, 70, 78],   // warm rose
	"tokens-down": [110, 80, 58],   // burnt orange
	"context-tokens": [128, 78, 64],   // warm rust-brown
	"context-usage": [94, 90, 58], // dark olive
	messages:      [120, 104, 56],  // warm amber/gold
	model:        [94, 58, 90],    // warm mulberry
};

// Resolve a segment's warm ground RGB from the PALETTE. Returns undefined for
// ids that are not in the palette (none of the current visible segments fall
// outside it after splitting tokens/context).
function segGround(s: Segment | undefined): Rgb | undefined {
	if (!s) return undefined;
	return PALETTE[s.id];
}

// Build a 24-bit background escape from an RGB triple.
function rgbBg(rgb: Rgb): string {
	return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

// Build a 24-bit foreground escape from an RGB triple (used for caps/sep
// glyphs so they blend into the adjacent ground).
function rgbFg(rgb: Rgb): string {
	return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

const RESET_FG = "\x1b[39m";
const RESET_BG = "\x1b[49m";
const RESET_BOTH = "\x1b[39m\x1b[49m";

function thresholdColor(pct: number): ThemeColor {
	return pct >= GAUGE_HOT_PCT ? "error" : pct >= GAUGE_WARN_PCT ? "warning" : "success";
}

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
	const reset = RESET_BOTH;
	let out = "";
	for (let i = 0; i < n; i++) {
		if (i > 0) out += " ";
		const level = Math.round(Math.max(0, Math.min(1, filledFloat - i)) * 8);
		const g = BLOCKS[level];
		out += level > 0 ? `${dimBg}${fg}${g}${reset}` : `${dimBg}${g}${reset}`;
	}
	return out;
}

// coralline gauge: filled U+25B0 glyph recolored by threshold. Width is the
// number of gauge cells. pct drives both the fill count and the threshold
// color (green -> yellow -> red), mirroring coralline's limit bars. No empty
// trailing glyph is rendered, so the bar reads as a compact filled run.
function renderGauge(percent: number, n: number, theme: Theme): string {
	// Only filled cells (U+25B0) are emitted; the trailing hollow cells are
	// omitted so the % reads right after the filled run instead of being
	// pushed aside by a row of empty placeholders.
	const p = percent < 0 ? 0 : percent > 100 ? 100 : percent;
	const filled = Math.round((p / 100) * n);
	const fillColor = thresholdColor(p);
	return theme.fg(fillColor, GAUGE_FILL.repeat(filled));
}

function renderSegment(s: Segment, settings: Settings, theme: Theme): string {
	const c = segColor(s);
	const parts: string[] = [];
	if (s.bar !== undefined) {
		// bar-only segments emit bar first, then text/suffix (statusline convention)
		const bw = s.barSegments ?? settings.barWidth;
		parts.push(settings.barStyle === "blocks" ? renderBlocks(s.bar, bw, theme, c) : settings.barStyle === "coralline" ? renderGauge(s.bar, bw, theme) : renderContinuous(s.bar, bw, theme, c));
	}
	if (s.text) parts.push(theme.fg(c, s.text));
	if (s.suffix) parts.push(theme.fg(c, s.suffix));
	return parts.join(" ");
}

// coralline pill: a warm, segment-specific RGB ground block (see PALETTE)
// carrying the host's own "text" foreground as the ink, so contrast is
// governed by the host theme (light on dark terminals, dark on light) and
// stays readable on every warm ground. The gauge (context-usage) keeps its
// threshold color since that encodes state. Caps/separator are applied by
// joinPills at the train level.
function renderPill(s: Segment, settings: Settings, theme: Theme): string {
	const ground = segGround(s);
	if (!ground) return renderSegment(s, settings, theme);
	const textFg = theme.getFgAnsi("text");
	const parts: string[] = [];
	if (s.bar !== undefined) {
		const bw = s.barSegments ?? settings.barWidth;
		// gauge keeps threshold color; blocks/continuous use the bar color.
		if (settings.barStyle === "coralline") {
			parts.push(renderGauge(s.bar, bw, theme));
		} else {
			parts.push(settings.barStyle === "blocks" ? renderBlocks(s.bar, bw, theme, s.color as ThemeColor) : renderContinuous(s.bar, bw, theme, s.color as ThemeColor));
		}
	}
	if (s.text) parts.push(`${textFg}${s.text}`);
	if (s.suffix) parts.push(`${textFg}${s.suffix}`);
	const inner = parts.length ? parts.join(" ") : "";
	const reset = parts.length ? RESET_FG : "";
	return `${rgbBg(ground)}${inner}${reset}${RESET_BG}`;
}

interface RSeg {
	text: string;
	width: number;
	seg?: Segment;
}

function renderSide(ids: string[], segs: Map<string, Segment>, settings: Settings, theme: Theme): RSeg[] {
	const out: RSeg[] = [];
	for (const id of ids) {
		const s = segs.get(id);
		if (!s || !s.visible) continue;
		const t = settings.barStyle === "coralline" ? renderPill(s, settings, theme) : renderSegment(s, settings, theme);
		out.push({ text: t, width: visibleWidth(t), seg: s });
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
	// Single-line layout: every active segment shares one row. The configured
	// left-side segments cluster left, the configured right-side segments
	// cluster right, and the gap between the two trains fills with spaces so
	// the left/right split stays visually clear.
	const lineLeft = settings.left;
	const lineRight = settings.right;
	const singleLine = renderLine(lineLeft, lineRight, segs, settings, theme, width);
	return [singleLine];
}

// Render the single bar line. The context-usage segment is elastic: it sits
// between the left train and the right train and expands to fill all leftover
// columns so the bar spans the full width. The messages count (`#N`) and the
// per-message token counts (`↑/↓`) live in their own separate pills in the
// right and left trains; the left/right trains keep their rounded outer caps
// (U+E0B6 / U+E0B4) and meet the elastic segment via the powerline separator
// (U+E0B0) so all bg blocks flow into one continuous shape. Non-pill style
// falls back to plain space-separated segments with the elastic gap as spaces.
function renderLine(lineLeft: string[], lineRight: string[], segs: Map<string, Segment>, settings: Settings, theme: Theme, width: number): string {
	const pill = settings.barStyle === "coralline";
	// Split the elastic context-usage segment out of the left train; it is rendered
	// separately as the expanding middle block. The token count and messages
	// count are separate pills and are not part of this elastic block.
	const elasticId = "context-usage";
	const fixedLeft = lineLeft.filter((id) => id !== elasticId);
	const hasElastic = lineLeft.includes(elasticId);
	const left = renderSide(fixedLeft, segs, settings, theme);
	const right = renderSide(lineRight, segs, settings, theme);
	const elastic = hasElastic ? segs.get(elasticId) : undefined;
	const all = left.concat(right);
	// Fixed-width cost of the two trains: caps at the outer ends (U+E0B6/E0B4)
	// and a separator (U+E0B0) at every shared boundary, plus one column joining
	// each train to the elastic block. Non-pill style joins on plain spaces
	// (1 column each) and has no caps.
	const trainCaps = pill ? (left.length > 0 ? 1 : 0) + (right.length > 0 ? 1 : 0) : 0;
	const innerJoints = pill ? Math.max(0, left.length - 1) + Math.max(0, right.length - 1) : (Math.max(0, left.length - 1) + Math.max(0, right.length - 1)) * 1;
	const elasticSeams = hasElastic ? (left.length > 0 ? 1 : 0) + (right.length > 0 ? 1 : 0) : 0;
	const trainW = all.reduce((a, s) => a + s.width, 0);
	// Minimum width for the elastic block: percent text + messages tail + 1 gap.
	const ellMin = hasElastic ? elasticMinWidth(elastic, segs, theme, settings) : 0;
	const minGap = hasElastic ? 0 : 1;
	let need = trainW + trainCaps + innerJoints + elasticSeams + ellMin + minGap;
	if (need > width) {
		let overflow = need - width;
		for (let i = 0; i < all.length && overflow > 0; i++) {
			shrinkWidest(all, overflow);
			overflow = all.reduce((a, s) => a + s.width, 0) + trainCaps + innerJoints + elasticSeams + ellMin + minGap - width;
		}
	}
	const l = left.length ? joinPills(left, pill, theme, /*leftCap*/ true, /*rightCap*/ !hasElastic && right.length === 0) : { text: "", width: 0 };
	const r = right.length ? joinPills(right, pill, theme, /*leftCap*/ !hasElastic && left.length === 0, /*rightCap*/ true) : { text: "", width: 0 };
	if (!hasElastic) {
		const pad = Math.max(minGap, width - l.width - r.width);
		return truncateToWidth(`${l.text}${" ".repeat(pad)}${r.text}`, width, "\u2026");
	}
	// Elastic block: fill everything between the trains. Its width is whatever
	// remains after the trains and their seams, floored to its minimum.
	const elasticW = Math.max(ellMin, width - l.width - r.width - (left.length > 0 ? 1 : 0) - (right.length > 0 ? 1 : 0));
	const e = renderElastic(elastic, segs, theme, settings, pill, elasticW, /*leftSeam*/ left.length > 0, /*rightSeam*/ right.length > 0);
	// Stitch: left train | seam | elastic | seam | right train.
	let parts: string[] = [];
	if (left.length > 0) {
		parts.push(l.text);
		if (pill) parts.push(seamInto(elastic, left[left.length - 1]!.seg, theme));
		else parts.push(" ");
	}
	parts.push(e.text);
	if (right.length > 0) {
		if (pill) parts.push(seamInto(right[0]!.seg, elastic, theme));
		else parts.push(" ");
		parts.push(r.text);
	}
	return truncateToWidth(parts.join(""), width, "\u2026");
}

// Stitch rendered pill segments into one train. leftCap/rightCap choose
// which outer ends get a rounded cap (U+E0B6 / U+E0B4): only the train's
// true left end and true right end round off, while shared boundaries
// between adjacent pills use the powerline separator (U+E0B0) carrying the
// previous ground as foreground (forms the notch) and the next ground as
// background (the transition), so two bg blocks merge into one shape. In
// non-pill style segments are joined by plain spaces.
interface Train { text: string; width: number }
function joinPills(arr: RSeg[], pill: boolean, theme: Theme, leftCap: boolean, rightCap: boolean): Train {
	if (arr.length === 0) return { text: "", width: 0 };
	if (!pill) {
		const text = arr.map((s) => s.text).join(" ");
		return { text, width: visibleWidth(text) };
	}
	// Each train has a rounded left cap (U+E0B6) at its first pill and a
	// rounded right cap (U+E0B4) at its last; adjacent pills inside the train
	// meet at a separator triangle (U+E0B0). Each cap/sep is 1 visible column,
	// so the final width = caps + sum(segWidth) + joints.
	let parts: string[] = [];
	let widthSum = 0;
	if (leftCap && arr.length > 0) {
		const firstGround = segGround(arr[0]!.seg);
		const firstFg = firstGround ? rgbFg(firstGround) : "";
		parts.push(`${firstFg}${CAP_L}${RESET_FG}`);
		widthSum += 1;
	}
	for (let i = 0; i < arr.length; i++) {
		if (i > 0) {
			// Separator between the previous pill and this one: foreground is
			// the previous pill's ground (dints the triangle into the last
			// block) and background is this pill's ground (starts the new
			// block), so the two colored grounds flow through the glyph.
			const prevGround = segGround(arr[i - 1]!.seg);
			const prevFg = prevGround ? rgbFg(prevGround) : "";
			const curGround = segGround(arr[i]!.seg);
			const curBg = curGround ? rgbBg(curGround) : "";
			parts.push(`${prevFg}${curBg}${SEP}${RESET_BOTH}`);
			widthSum += 1;
		}
		parts.push(arr[i]!.text);
		widthSum += arr[i]!.width;
	}
	if (rightCap && arr.length > 0) {
		const lastGround = segGround(arr[arr.length - 1]!.seg);
		const lastFg = lastGround ? rgbFg(lastGround) : "";
		parts.push(`${lastFg}${CAP_R}${RESET_BOTH}`);
		widthSum += 1;
	}
	return { text: parts.join(""), width: widthSum };
}

// Minimum width of the elastic context-usage block: just its percent text
// plus, in pill style, the two outer cap/seam columns. The messages count is
// no longer part of this block (it is a separate right-side pill).
function elasticMinWidth(elastic: Segment | undefined, _segs: Map<string, Segment>, _theme: Theme, _settings: Settings): number {
	const pctTxt = elastic?.suffix ?? "0%";
	const hasGround = elastic ? Boolean(segGround(elastic)) : false;
	return visibleWidth(pctTxt) + (hasGround ? 2 : 0);
}

// Render the elastic context-usage block at a target visible width. Its body
// is the percent text left-anchored, with the rest as plain space padding so
// the block spans the whole gap between the left and right trains. In pill
// style the block is a warm RGB ground carrying the host text; if
// leftSeam/rightSeam are false the corresponding outer end gets a rounded cap
// (U+E0B6 / U+E0B4) instead of being joined by a separator to a neighboring
// train. The messages count is rendered as its own separate pill in the
// right train, separated from this block by a powerline seam.
function renderElastic(elastic: Segment | undefined, _segs: Map<string, Segment>, theme: Theme, _settings: Settings, pill: boolean, targetW: number, leftSeam: boolean, rightSeam: boolean): Train {
	const pctTxt = elastic?.suffix ?? "";
	const textFg = theme.getFgAnsi("text");
	const ground = elastic ? segGround(elastic) : undefined;
	if (!pill || !ground) {
		const gap = Math.max(1, targetW - visibleWidth(pctTxt));
		const text = `${textFg}${pctTxt}${" ".repeat(gap)}${RESET_FG}`;
		return { text, width: visibleWidth(text) };
	}
	const bg = rgbBg(ground);
	const caps = (leftSeam ? 0 : 1) + (rightSeam ? 0 : 1);
	const innerW = Math.max(0, targetW - caps);
	const leftCapTxt = leftSeam ? "" : `${rgbFg(ground)}${CAP_L}${RESET_FG}`;
	const rightCapTxt = rightSeam ? "" : `${rgbFg(ground)}${CAP_R}${RESET_BOTH}`;
	const gap = Math.max(1, innerW - visibleWidth(pctTxt));
	const body = `${bg}${textFg}${pctTxt}${" ".repeat(gap)}${RESET_FG}${RESET_BG}`;
	return { text: `${leftCapTxt}${body}${rightCapTxt}`, width: targetW };
}

// Powerline separator (U+E0B0) joining two colored blocks: foreground is the
// source block's ground (dints the triangle into the last block) and
// background is the destination block's ground (starts the new block), so the
// two grounds flow into each other through the glyph.
function seamInto(toSeg: Segment | undefined, fromSeg: Segment | undefined, theme: Theme): string {
	const toGround = segGround(toSeg);
	const fromGround = segGround(fromSeg);
	const fromFg = fromGround ? rgbFg(fromGround) : "";
	const toBg = toGround ? rgbBg(toGround) : "";
	return `${fromFg}${toBg}${SEP}${RESET_BOTH}`;
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
		a.bg === b.bg &&
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

// git working-tree dirty probe (zero-subprocess heuristic).
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
			bg: ev.bg,
			bar: ev.bar,
			barSegments: ev.barSegments,
			visible: !!(ev.text || ev.suffix || ev.bar !== undefined),
		};
		if (segEqual(segs.get(id), next)) return;
		segs.set(id, next);
		dirty = true;
	});

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
		pi.events.emit("pi-bar:update", { id: "git-head", text: b, color: "mdLink" });
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
		const tiText = `\u2191${fmtTokens(ti)}`;
		pi.events.emit("pi-bar:update", { id: "tokens-up", text: cost > 0 ? `${tiText} $${cost.toFixed(2)}` : tiText, color: "text" });
		pi.events.emit("pi-bar:update", { id: "tokens-down", text: `\u2193${fmtTokens(to)}`, color: "text" });
	}


	function emitContext(ctx: ExtensionContext): void {
		const u = ctx.getContextUsage();
		if (!u || u.tokens == null) {
			pi.events.emit("pi-bar:update", { id: "context-usage", text: "", suffix: "0%", color: "syntaxString" });
			pi.events.emit("pi-bar:update", { id: "context-tokens", text: "0" });
			return;
		}
		const pct = Math.round((u.tokens / u.contextWindow) * 100);
		pi.events.emit("pi-bar:update", {
			id: "context-usage",
			text: "",
			suffix: `${pct}%`,
			bar: pct,
			color: thresholdColor(pct),
		});
		pi.events.emit("pi-bar:update", { id: "context-tokens", text: fmtTokens(u.tokens) });
	}

	function emitModel(ctx: ExtensionContext): void {
		const m = ctx.model;
		if (!m) return;
		const name = m.id.lastIndexOf("/") >= 0 ? m.id.slice(m.id.lastIndexOf("/") + 1) : m.id;
		pi.events.emit("pi-bar:update", { id: "model", text: name, color: "thinkingHigh" });
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
		emitContext(ctx);
		if (ctx.hasUI) {
			ctx.ui.setWorkingIndicator({ frames: REIMU_FRAMES, intervalMs: REIMU_INTERVAL_MS });
		}
		flushIfDirty();
	});

	pi.on("agent_settled", async (_event, ctx) => {
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
