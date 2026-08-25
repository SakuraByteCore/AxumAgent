/**
 * pi-bar
 *
 * High-performance powerline-style status bar for pi-coding-agent, merged
 * with the sakura cyberdeck startup header (formerly pi-header). Single-file,
 * zero native deps, inline settings (no external settings pkg). Segment
 * producers are bundled; no external usage provider is required.
 *
 * The extension registers two independent UI surfaces from one entry point:
 *  - ctx.ui.setHeader(): the sakura cyberdeck ASCII header with skill /
 *    extension cards, shown once per session start and cached by width.
 *  - ctx.ui.setWidget("pi-bar"): the live coralline status bar driven by
 *    the pi-bar:update / pi-bar:register-segment event contract.
 *
 * Status bar stylistic notes:
 *  - "coralline" barStyle renders each segment as a rounded pill: a dark
 *    role-color background block sealed by rounded caps (U+E0B6 /
 *    U+E0B4), with the segment's own bright semantic color as the text.
 *   Pills are separated by a clean single space (no powerline triangle),
 *   so each chip reads as its own self-contained block against the
 *   terminal base, and the dark ground + bright ink pairs stay readable.
 * - Context usage renders as a threshold gauge: green below 50%, yellow
 *   50-75%, red above 75%, using the U+25B0 / U+25B1 glyphs.
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

import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Header (merged from pi-header): sakura cyberdeck startup header + dashed
// border editor. Renders an ASCII header with skill / extension cards once
// per session start and installs a dashed-rule CustomEditor. State below is
// module-local to the extension entry; the header factory is built per
// session_start and reused across render() calls.
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

type RGB = readonly [number, number, number];

function rgb([r, g, b]: RGB, text: string, bold = false): string {
  return `${bold ? BOLD : ""}\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
}

function gradient(text: string, from: RGB, to: RGB, bold = false): string {
  const chars = [...text];
  const span = Math.max(1, chars.length - 1);
  return chars.map((char, index) => {
    if (char === " ") return char;
    const t = index / span;
    const color: RGB = [
      Math.round(from[0] + (to[0] - from[0]) * t),
      Math.round(from[1] + (to[1] - from[1]) * t),
      Math.round(from[2] + (to[2] - from[2]) * t),
    ];
    return rgb(color, char, bold);
  }).join("");
}

/** Truecolor macaron stops shared with the SAKURA CYBERDECK palette. */
const SAKURA_STOPS: readonly RGB[] = [
  [242, 167, 198], // sakura pink  #F2A7C6
  [252, 201, 185], // sakura-iro   #FCC9B9
  [239, 195, 230], // petal        #EFC3E6
  [199, 184, 245], // lavender     #C7B8F5
  [159, 211, 242], // sky macaron  #9FD3F2
];

function mix(a: RGB, b: RGB, t: number): RGB {
  const u = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * u),
    Math.round(a[1] + (b[1] - a[1]) * u),
    Math.round(a[2] + (b[2] - a[2]) * u),
  ];
}

function sampleStops(position: number): RGB {
  const p = Math.max(0, Math.min(1, position));
  const scaled = p * (SAKURA_STOPS.length - 1);
  const i = Math.min(SAKURA_STOPS.length - 2, Math.floor(scaled));
  const from = SAKURA_STOPS[i] ?? SAKURA_STOPS[0];
  const to = SAKURA_STOPS[i + 1] ?? from;
  return mix(from, to, scaled - i);
}

function headerRgbFg(color: RGB, text: string, bold = false): string {
  const open = bold ? BOLD : "";
  const close = bold ? "\x1b[22m\x1b[39m" : "\x1b[39m";
  return `${open}\x1b[38;2;${color[0]};${color[1]};${color[2]}m${text}${close}`;
}

/**
 * Symmetric sakura gradient like the cyberdeck tool frames:
 * mirrored so both corners share sakura, the macaron spectrum through the middle.
 */
function frameGradient(text: string): string {
  const chars = [...text];
  if (chars.length === 0) return text;
  const span = Math.max(1, chars.length - 1);
  return `${chars
    .map((char, index) => {
      if (char === " " || char === RESET) return char;
      const pos = index / span;
      const mirrored = pos <= 0.5 ? pos * 2 : (1 - pos) * 2;
      const color = sampleStops(mirrored);
      return `\x1b[38;2;${color[0]};${color[1]};${color[2]}m${char}\x1b[39m`;
    })
    .join("")}${RESET}`;
}

/** Strip CSI/SCS escape sequences so measurable width tracks only visible glyphs. */
function headerVisibleWidth(text: string): number {
  // Only single-width glyphs are emitted by cyberdeck content; one text-codepoint == one cell.
  return [...text.replace(/\x1b\[[0-9;]*m/g, "")].length;
}

function truncateLine(text: string, width: number): string {
  if (width <= 0) return "";
  if (headerVisibleWidth(text) <= width) return text;
  const chars = [...text];
  let used = 0;
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "\x1b") {
      let seq = ch;
      while (i + 1 < chars.length && chars[i + 1] !== "m") {
        i++;
        seq += chars[i];
      }
      if (i + 1 < chars.length) {
        i++;
        seq += "m";
      }
      out += seq;
      continue;
    }
    const cw = headerVisibleWidth(ch);
    if (used + cw > width) break;
    out += ch;
    used += cw;
  }
  return out;
}

/** Top border with an inset `[Label]` chip — `╭─ Label ───╮` style. */
function fitBorderLabel(label: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return "╭";
  const inner = Math.max(0, width - 2);
  const lead = `─ ${label} `;
  const leadChars = [...lead];
  let head = "";
  let used = 0;
  for (const ch of leadChars) {
    const cw = headerVisibleWidth(ch);
    if (used + cw > inner) break;
    head += ch;
    used += cw;
  }
  return `╭${head}${"─".repeat(Math.max(0, inner - used))}╮`;
}

function bottomBorder(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return "╰";
  return `╰${"─".repeat(Math.max(0, width - 2))}╯`;
}

const ANIME_ART = [
  "                                ██████████████████░                          ",
  "                            ██████████████████░░░░░░███                      ",
  "                         ████████████████████░░░░░░░░░▒██                    ",
  "                      ▓██████████████████████░░░░░░░░░░░████                 ",
  "                     █▓░░░░░░░░░░░░░▒████████░░░░░░░░░░░░░████               ",
  "                   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░████              ",
  "        █████████████████████████████▒░░░░░░░░░░░░░░░░░░░░░░████▒            ",
  "  ░█████████████████████████████████████████▒░░░░░░░░░░░░░░░░█████    ░░░░   ",
  " ███████████████▒▒▒▒▒▒▒▒▒▒▒▒▒▒███████████████████▒░░░░░░░░░░░░░█░░░░░░░░░░░░ ",
  "██████████▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒████████████████░░░░░░░░░░░░░░░░░░░░░░ ",
  "█████████████▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒█████████████▒░░░░░░░░░░░░░░░░░░ ",
  " ████████▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓███████████░░░░░░░░░░░░░   ",
  "   ████▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒█████████▒░░░░░░░░░    ",
  "     ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒████████░░░░░░░    ",
  "    ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░▒▒▒▒▒▒▒▒▒▒▒▒▒░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒██████░░░░     ",
  "   ▒▒▒░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░░▒▒░▒▒▒▒▒▒▒▒▒▒░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒█████▓      ",
  "  ▒▒▒ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░░░▒▒░▒▒▒▒▒▒▒▒▒▒░░░░▒▒░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒████     ",
  "  ▒▒  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░░░░░▒░▒▒▒▒▒▒▒▒▒░░░░░░▒▒░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒█████   ",
  "  ▒   ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░░░░░░▒░▒▒▒▒▒▒▒▒▒░░░░░░░▒░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒█████  ",
  "      ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░░░██░░░░░▒▒▒▒▒▒▒▒░░▓███░░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒██████ ",
  "      ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░░░████░░░░░░░░░▒░░░░████░░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒████████",
  "  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░▒░░░████░░░░░░░░░░░░░░████░░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒███████",
  "      ▒▒▒▒▒▒▒▒▒▒▒▒▒░░░░░▓███░░░░░░░░░░░░░░████░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒█████ ",
  "    ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░░░░░░███░░░░░░░░░░░░░░░██▒░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒    ",
  "   ▒▒▒░▒▒▒▒▒▒▒▒▒▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░▒░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒ ▒▒▒░  ",
  "  ▒▒▒ ▒▒▒▒▒▒▒▒▒▒▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒       ",
  "   ▒▒  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒       ",
  "    ▒░ ░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓░░░░░▓▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒        ",
  "          ▒▒▒▒   ▒▒▒▒  ▒▒▒▒▒▒▒▒▒█▓▓░░▓▓▓▓▓▓▓▓▒▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒           ",
  "           ▒      ▒▒▒   ▒▒▒▒░▒█▓▓▓▒▓▓▓▓▓▓▓▓▓▓████▒▒▒▒░░█▒▒▒▒▒  ▒▒            ",
  "                         ▒░░█▓▓░░░░▓▓▓▓▓▓▓▓███▒░░░▒░█░░░▒▒████               ",
  "                           █░░░░░░░░████████░░░░░░░░░░░░░░░███               ",
  "                          ░░░░░░░░██████████░░░░░░░░░░░░████                 ",
  "                         ░░░░░░░░░███████████░░▓█████████                    ",
  "                                  ███████████████                            ",
  "                                    ███████                                  ",
] as const;


/**
 * Detect skills available to the agent from the Pi skill discovery roots
 * (home `~/.agents/skills/<name>/SKILL.md` and project `<cwd>/.agents/skills/...`),
 * matching Pi's own `collectAutoSkillEntries` naming (basename(skillDir)).
 */
function detectSkills(cwd: string | undefined): string[] {
  const dirs: string[] = [];
  try {
    dirs.push(join(homedir(), ".agents", "skills"));
  } catch {
    /* homedir() may throw in some sandboxes — skip home root */
  }
  if (cwd) dirs.push(join(cwd, ".agents", "skills"));
  const names = new Set<string>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      if (!existsSync(dir)) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const skillDir = join(dir, entry);
      try {
        if (!statSync(skillDir).isDirectory()) continue;
      } catch {
        continue;
      }
      try {
        if (!existsSync(join(skillDir, "SKILL.md"))) continue;
      } catch {
        continue;
      }
      names.add(entry);
    }
  }
  return [...names].sort();
}

/**
 * Return the representative slash commands provided by bundled extensions.
 * Only the primary/entry command per extension is shown for brevity.
 */
function getBundledCommands(): string[] {
  return [
    "/pi-debug",
    "/goal",
    "/clear",
    "/plan",
    "/ralph",
    "/rules",
    "/plugin-create-mode",
    "/websearch",
    "/curator",
    "/google-account",
    "/search",
    "/fff-mode",
    "/fff-health",
    "/fff-rescan",
  ];
}

const HEADER_ART_TARGET = 34;
const HEADER_BOX_MAX = 60;
const WELCOME_GLYPHS: readonly string[] = ["\u273b", "\u273d", "\u2736", "\u2733"];
const DEFAULT_WELCOME_GLYPH = "\u273b";
let welcomeGlyph: string | undefined;
let cachedAxumVersion: string | undefined;
let axumVersionProbed = false;

function axumVersion(): string | undefined {
  if (axumVersionProbed) return cachedAxumVersion;
  axumVersionProbed = true;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === "axum" && typeof pkg.version === "string") {
        cachedAxumVersion = pkg.version;
        break;
      }
    } catch {
      void 0;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cachedAxumVersion;
}

function scaleArt(target: number): string[] {
  if (target <= 0) return [];
  const artWidth = ANIME_ART.length > 0 ? [...ANIME_ART[0]].length : 0;
  const visible = Math.min(artWidth, target);
  return ANIME_ART.map((line) => {
    const src = [...line];
    if (src.length <= visible) return line;
    let scaled = "";
    for (let x = 0; x < visible; x++) {
      const glyph = src[Math.min(Math.round((x * src.length) / visible), src.length - 1)];
      scaled += glyph ?? " ";
    }
    return scaled;
  });
}

function framedLine(content: string, inner: number): string {
  if (inner < 2) return "";
  const edgeColor = sampleStops(0);
  const railBg = `\x1b[38;2;${edgeColor[0]};${edgeColor[1]};${edgeColor[2]}m\u2502\x1b[39m`;
  const body = truncateLine(content, inner - 1);
  const padR = Math.max(0, inner - 1 - headerVisibleWidth(body));
  return `${railBg} ${body}${" ".repeat(padR)}${railBg}`;
}

function centerInBox(colored: string, plainWidth: number, inner: number): string {
  const w = Math.min(plainWidth, inner);
  const padL = Math.max(0, Math.floor((inner - w) / 2));
  const padR = Math.max(0, inner - padL - w);
  return `${" ".repeat(padL)}${truncateLine(colored, w)}${" ".repeat(padR)}`;
}

function wrapLabeledList(label: string, items: string[], width: number): string[] {
  const head = `${label}: `;
  if (items.length === 0 || width <= head.length) return [];
  const indent = " ".repeat(head.length);
  const lines: string[] = [];
  let current: string | null = null;
  for (const item of items) {
    const candidate = current === null ? `${head}${item}` : `${current}, ${item}`;
    if (current !== null && headerVisibleWidth(candidate) > width) {
      lines.push(current);
      current = `${indent}${item}`;
    } else {
      current = candidate;
    }
  }
  if (current !== null) lines.push(current);
  return lines;
}

function renderHeader(width: number, skills: string[] = [], commands: string[] = [], cwd?: string): string[] {
  if (width <= 0) return [];

  const sakura: RGB = [242, 167, 198];
  const sky: RGB = [159, 211, 242];
  const dim: RGB = [199, 184, 245];

  const boxWidth = Math.max(10, Math.min(width, HEADER_BOX_MAX + 2));
  const inner = Math.max(0, boxWidth - 2);
  const artTarget = Math.min(HEADER_ART_TARGET, Math.max(0, inner - 2));

  const artRows = scaleArt(artTarget);
  const artWidth = artRows.length > 0 ? [...artRows[0]].length : 0;

  let displayCwd: string | undefined;
  if (cwd) {
    const home = homedir();
    displayCwd = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  }

  const version = axumVersion();
  const welcome = `${welcomeGlyph ?? DEFAULT_WELCOME_GLYPH} Welcome to AxumAgent${version ? ` · v${version}` : ""}`;

  const infoLines: string[] = [
    rgb(sakura, welcome, true),
    "",
  ];
  const infoLabelWidth = Math.max("cwd".length, "skills".length, "commands".length);
  if (displayCwd) infoLines.push(rgb(dim, `${"cwd".padEnd(infoLabelWidth)}: ${displayCwd}`));
  const listWidth = Math.max(1, inner - 1);
  for (const line of wrapLabeledList("skills".padEnd(infoLabelWidth), skills, listWidth)) infoLines.push(rgb(dim, line));
  for (const line of wrapLabeledList("commands".padEnd(infoLabelWidth), commands, listWidth)) infoLines.push(rgb(dim, line));

  return [
    "",
    frameGradient(fitBorderLabel("Axum", boxWidth)),
    ...artRows.map((row) => framedLine(centerInBox(gradient(row, sakura, sky), artWidth, inner - 2), inner)),
    framedLine("", inner),
    ...infoLines.map((line) => framedLine(line, inner)),
    frameGradient(bottomBorder(boxWidth)),
  ];
}

/*
 * Dashed border editor: delegates every field to the default CustomEditor
 * but intercepts `borderColor` writes so the solid box-drawing glyph `─`
 * (U+2500) used for the input box top/bottom rules is rewritten to the
 * dashed glyph `╌` (U+254C) before the theme colour callback is applied.
 * The override rides on every `updateEditorBorderColor()` reassignment that
 * Pi performs per thinking/bash level, so it stays in effect for the lifetime
 * of the editor without extension-side re-hooks.
 */
type ColorFn = (text: string) => string;

class DashedBorderEditor extends CustomEditor {
  private dashedBorderFn: ColorFn | undefined;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    options?: ConstructorParameters<typeof CustomEditor>[3],
  ) {
    super(tui, theme, keybindings, options);
    // The parent Editor declares `borderColor;` as a class field, which at
    // construction time installs an own { value: undefined, writable: true }
    // property on the instance, shadowing any prototype-level accessor we
    // could declare. To reliably intercept writes from Pi's
    // updateEditorBorderColor(), we re-declare the property as an accessor
    // directly on the instance (configurable so it is replaceable).
    const self = this as unknown as {
      dashedBorderFn: ColorFn | undefined;
      borderColor: ColorFn | undefined;
    };
    Object.defineProperty(self, "borderColor", {
      configurable: true,
      enumerable: true,
      get() { return self.dashedBorderFn; },
      set(fn: ColorFn | undefined) {
        if (!fn) { self.dashedBorderFn = fn; return; }
        self.dashedBorderFn = (text: string) =>
          fn(text.replaceAll("\u2500", "\u254c"));
      },
    });
    self.dashedBorderFn = (text: string) =>
      theme.borderColor(text.replaceAll("\u2500", "\u254c"));
  }
}

const dashedEditorFactory =
  (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) =>
    new DashedBorderEditor(tui, theme, keybindings);

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
	left: ["git-branch", "thinking", "tps", "context-tokens", "context-usage"],
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

// Pill ground palette: each visible segment gets its own RGB ground that
// walks an analogous hue arc across the HSL wheel while ALSO climbing a
// perceptual luminance ladder, so adjacent pills stay distinct via BOTH a
// hue step (14-24°) AND a luminance step (Δlum >= 0.03) rather than
// blending into one near-equal-luminance mass.
//
//   left train (warm arc, luminance RISING left -> right):
//     git-branch(8°,L30) -> thinking(32°,L34) -> tokens-down(46°,L38) ->
//     context-tokens(60°,L42) -> context-usage(68°,L48)
//   right train (cool arc):
//     messages(180°,L28) -> model(210°,L44)
//
// The left train rises monotonically in both hue (red -> ochre -> olive ->
// green) and luminance (.060 -> .348), so each chip reads as a distinct
// brightness band. The context-usage hue (68°) is pulled near the olive
// (60°) family instead of the original 90° moss green: at equal L the 90°
// green perceptually under-shoots the 60° yellow, which inverted the
// luminance order and let context-tokens/usage blur together — keeping the
// hue on the warm side of green preserves the ladder.
//   Saturation is held near 32-38% and lightness 28-48%, giving every pill a
// ground whose luminance is spaced far enough from its neighbor that the
// host's own "text" foreground (light on dark terminals, dark on light)
// stays high contrast against any ground, in both built-in themes, without
// depending on a per-theme color name.
// These are emitted as raw 24-bit ANSI escapes (\x1b[48;2;r;g;bm), so no
// theme color-name slot is consumed and the grounds render identically
// regardless of whether the host picked the dark or light theme.
type Rgb = readonly [number, number, number];
const PALETTE: Record<string, Rgb> = {
	"git-branch":     [104, 56, 49],  // deep brick red (8°, L30)
	thinking:         [120, 89, 54],  // burnt umber (32°, L34)
	"tps":            [134, 117, 60], // antique bronze (46°, L38)
	"context-tokens": [146, 146, 69], // olive (60°, L42)
	"context-usage":  [155, 166, 78], // chartreuse (68°, L48)
	messages:         [49, 94, 94],   // dark teal (180°, L28)
	model:           [72, 112, 153], // steel blue (210°, L44)
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

// Final-fit helper: the rendered bar line must never exceed the terminal width,
// and the model pill sits at the right end, so when the stitched line overflows
// after all in-train shrinking and messages pruning, this keeps the RIGHT-most
// `width` columns (the model) and drops leading overflow with an elision mark.
// When the line already fits it is returned unchanged.
const ELLIPSIS = "\u2026";
function clipKeepRight(line: string, width: number): string {
	const w = visibleWidth(line);
	if (w <= width) return line;
	if (width <= 0) return "";
	if (width === 1) return ELLIPSIS;
	return `${ELLIPSIS}${trailingText(line, width - 1)}`;
}

// Take up to `budget` visible columns from the right (tail) end of an ANSI
// colored string, dropping leading overflow. ANSI escapes cost zero visible
// width so they flow through; printable cells each consume one column. Walks
// the string once from its end until the budget is spent.
function trailingText(s: string, budget: number): string {
	if (budget <= 0) return "";
	// Decompose the ANSI string into visible cells (each cell keeps its
	// preceding ANSI escape runs, which cost 0 columns), then take the tail.
	// The lift avoids the reverse-scan ambiguity when two SGR escapes abut: a
	// trailing 'm' that begins a new escape would otherwise be misread as a cell.
	const cells: string[] = [];
	let i = 0;
	let escStart = 0;
	while (i < s.length) {
		if (s.charCodeAt(i) === 0x1b) {
			let j = i + 1;
			while (j < s.length && s.charCodeAt(j) !== 0x6d) j++;
			i = j + 1;
		} else {
			cells.push(s.slice(escStart, i + 1));
			escStart = i + 1;
			i++;
		}
	}
	return cells.slice(Math.max(0, cells.length - budget)).join("");
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
	// model pill is never shrunk: its full name must stay visible.
	let wi = arr.findIndex((r) => r.seg?.id !== "model");
	if (wi < 0) return;
	for (let i = wi + 1; i < arr.length; i++) {
		if (arr[i]!.seg?.id === "model") continue;
		if (arr[i]!.width > arr[wi]!.width) wi = i;
	}
	const s = arr[wi]!;
	const tgt = Math.max(1, s.width - overflow);
	// Mutate the slot's own fields: arr shares element objects with the left/right
	// arrays (built via left.concat(right)), so replacing only arr[wi] leaves the
	// underlying train array untouched and the shrink never takes effect. Updating
	// the object's fields keeps both views in sync so the next joinPills reuses the
	// shrunk text and width.
	s.text = truncateToWidth(s.text, tgt, "\u2026");
	s.width = tgt;
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
	let left = renderSide(fixedLeft, segs, settings, theme);
	let right = renderSide(lineRight, segs, settings, theme);
	const elastic = hasElastic ? segs.get(elasticId) : undefined;
	// Pre-compute the elastic block's minimum so the right-train pruning
	// decision below can budget against it.
	const ellMin = hasElastic ? elasticMinWidth(elastic, segs, theme, settings) : 0;
	const minGap = hasElastic ? 0 : 1;
	// Goal-driven pruning: hide low-priority segments in order until fit.
	// Priority (low first): tokens-down < thinking < context-tokens < messages.
	// model is never hidden; pruning runs before shrink pass.
	const SACRIFICE_IDS = ["tps", "thinking", "context-tokens", "messages"] as const;

	function trainNeed(l: RSeg[], r: RSeg[]): number {
		const tw = l.reduce((a, s) => a + s.width, 0) + r.reduce((a, s) => a + s.width, 0);
		const c = pill ? (l.length > 0 ? 1 : 0) + (r.length > 0 ? 1 : 0) : 0;
		const j = pill
			? Math.max(0, l.length - 1) + Math.max(0, r.length - 1)
			: (Math.max(0, l.length - 1) + Math.max(0, r.length - 1)) * 1;
		const s = hasElastic ? (l.length > 0 ? 1 : 0) + (r.length > 0 ? 1 : 0) : 0;
		return tw + c + j + s + ellMin + minGap;
	}

	let pruneNeed = trainNeed(left, right);
	if (pruneNeed > width) {
		for (const id of SACRIFICE_IDS) {
			const li = left.findIndex((x) => x.seg?.id === id);
			if (li >= 0) {
				left.splice(li, 1);
				pruneNeed = trainNeed(left, right);
				if (pruneNeed <= width) break;
				continue;
			}
			const ri = right.findIndex((x) => x.seg?.id === id);
			if (ri >= 0) {
				right.splice(ri, 1);
				pruneNeed = trainNeed(left, right);
				if (pruneNeed <= width) break;
			}
		}
	}
	const all = left.concat(right);
	// Fixed-width cost of the two trains: caps at the outer ends (U+E0B6/E0B4)
	// and a separator (U+E0B0) at every shared boundary, plus one column joining
	// each train to the elastic block. Non-pill style joins on plain spaces
	// (1 column each) and has no caps.
	const trainCaps = pill ? (left.length > 0 ? 1 : 0) + (right.length > 0 ? 1 : 0) : 0;
	const innerJoints = pill ? Math.max(0, left.length - 1) + Math.max(0, right.length - 1) : (Math.max(0, left.length - 1) + Math.max(0, right.length - 1)) * 1;
	const elasticSeams = hasElastic ? (left.length > 0 ? 1 : 0) + (right.length > 0 ? 1 : 0) : 0;
	const trainW = all.reduce((a, s) => a + s.width, 0);
	const need = trainW + trainCaps + innerJoints + elasticSeams + ellMin + minGap;
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
		return clipKeepRight(`${l.text}${" ".repeat(pad)}${r.text}`, width);
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
	return clipKeepRight(parts.join(""), width);
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
// is the percent text horizontally centered, with space padding split evenly
// on both sides so the block spans the whole gap between the left and right
// trains while the percentage reads dead-center. In pill style the block is
// a warm RGB ground carrying the host text; if leftSeam/rightSeam are false
// the corresponding outer end gets a rounded cap (U+E0B6 / U+E0B4) instead
// of being joined by a separator to a neighboring train. The messages count
// is rendered as its own separate pill in the right train, separated from
// this block by a powerline seam.
function renderElastic(elastic: Segment | undefined, _segs: Map<string, Segment>, theme: Theme, _settings: Settings, pill: boolean, targetW: number, leftSeam: boolean, rightSeam: boolean): Train {
	const pctTxt = elastic?.suffix ?? "";
	const textFg = theme.getFgAnsi("text");
	const ground = elastic ? segGround(elastic) : undefined;
	if (!pill || !ground) {
		const padW = Math.max(0, targetW - visibleWidth(pctTxt));
		const lPad = Math.floor(padW / 2);
		const rPad = Math.max(0, padW - lPad);
		const text = `${textFg}${" ".repeat(lPad)}${pctTxt}${" ".repeat(rPad)}${RESET_FG}`;
		return { text, width: visibleWidth(text) };
	}
	const bg = rgbBg(ground);
	const caps = (leftSeam ? 0 : 1) + (rightSeam ? 0 : 1);
	const innerW = Math.max(0, targetW - caps);
	const leftCapTxt = leftSeam ? "" : `${rgbFg(ground)}${CAP_L}${RESET_FG}`;
	const rightCapTxt = rightSeam ? "" : `${rgbFg(ground)}${CAP_R}${RESET_BOTH}`;
	const padW = Math.max(0, innerW - visibleWidth(pctTxt));
	const lPad = Math.floor(padW / 2);
	const rPad = Math.max(0, padW - lPad);
	const body = `${bg}${textFg}${" ".repeat(lPad)}${pctTxt}${" ".repeat(rPad)}${RESET_FG}${RESET_BG}`;
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
	// All counts carry a k/M magnitude suffix so every token field reads with
	// its unit, including the zero placeholder (0 -> "0.0k"). The <10k band
	// keeps one decimal so sub-thousand counts still show a magnitude (523 ->
	// "0.5k") instead of a unit-less bare integer.
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
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

// Working timer: the working row is a single left-anchored Loader whose
// message text is the only host-exposed writable face. The elapsed duration
// is appended to that message and right-aligned by padding with spaces to
// the viewport width. Seconds are not left-padded so brackets hug the digit.
// A 1-second setInterval drives real-time ticking so the count advances even
// during pure-thinking stretches with no streaming events.
const WORKING_TIMER_INTERVAL_MS = 1000;
function fmtElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rs = s % 60;
	if (m < 60) return `${m}m${String(rs).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h${String(m % 60).padStart(2, "0")}m`;
}


// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	const segs = new Map<string, Segment>();
	let settings: Settings = DEFAULTS;
	let currentCtx: ExtensionContext | undefined;
	let dirty = false;

	// --- Header (merged from pi-header) state + installation ---
	// Skills / extensions probed once per session start and cached for the
	// render factory. The host caches the rendered header lines by width until
	// invalidate() fires, so probing here (not in render) keeps it cheap.
	let skillsCache: string[] = [];
	let commandsCache: string[] = [];
	function installHeader(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		// Probe on every start so freshly installed skills surface.
		skillsCache = detectSkills(ctx.cwd);
		commandsCache = getBundledCommands();
		const headerCwd = ctx.cwd;
		welcomeGlyph = WELCOME_GLYPHS[Math.floor(Math.random() * WELCOME_GLYPHS.length)] ?? DEFAULT_WELCOME_GLYPH;
		ctx.ui.setHeader(() => {
			let cachedWidth: number | undefined;
			let cachedLines: string[] = [];
			return {
				render: (width: number): string[] => {
					if (width !== cachedWidth) {
						cachedWidth = width;
						cachedLines = renderHeader(width, skillsCache, commandsCache, headerCwd);
					}
					return cachedLines;
				},
				invalidate(): void {
					cachedWidth = undefined;
					cachedLines = [];
				},
			};
		});
		// Replace the solid-rule input box with a dashed-rule editor. The
		// factory preserves all default editor wiring (keybindings,
		// autocomplete, onSubmit) since interactive-mode copies them onto our
		// instance after creation.
		ctx.ui.setEditorComponent(dashedEditorFactory);
	}

	// Working-row elapsed timer lifecycle. A 1-second interval drives the
	// real-time tick; it runs only between agent_start and agent_settled and
	// reuses the captured context. The host working message is the only
	// writable face, so the duration is appended and right-aligned to the
	// terminal width for a stable right anchor.
	// Working-row elapsed timer lifecycle. A 1-second interval drives the
	// real-time tick; it runs only between agent_start and agent_settled and
	// reuses the captured context. The host working message is the only
	// writable face. The default message ("Working...") is preserved and the
	// elapsed duration is appended right after it, separated by a single
	// space so the time reads immediately next to "Working" on the same line.
	let workingTimerId: ReturnType<typeof setInterval> | undefined;
	function startWorkingTimer(): void {
		stopWorkingTimer();
		const start = Date.now();
		const tick = (): void => {
			if (!currentCtx?.hasUI) return;
			const elapsed = fmtElapsed(Date.now() - start);
			// Preserve the default "Working..." label and tack the duration on
			// behind it, tight (one space) so the time hugs "Working" as asked.
			currentCtx.ui.setWorkingMessage(`Working... (${elapsed})`);
		};
		tick();
		workingTimerId = setInterval(tick, WORKING_TIMER_INTERVAL_MS);
	}
	function stopWorkingTimer(): void {
		if (workingTimerId !== undefined) clearInterval(workingTimerId);
		workingTimerId = undefined;
		if (currentCtx?.hasUI) currentCtx.ui.setWorkingMessage();
	}

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

	// Cache the last cwd probed by emitGit: branch/path probing touches the
	// filesystem (isSvn ascent + readFileSync(.git/HEAD)), and a bash tool
	// result only changes cwd if the shell actually `cd`'d, which is rare.
	// Re-probing when cwd is unchanged is pure waste, so skip it.
	let lastGitCwd: string | undefined;
	function runEmitGit(ctx: ExtensionContext): void {
		if (lastGitCwd === ctx.cwd) return;
		lastGitCwd = ctx.cwd;
		emitGit(ctx);
	}

	function emitGit(ctx: ExtensionContext): void {
		// Precedence: svn > git > empty.
		// svn outranks git: a working copy checked out under a git repo shows "svn".
		if (isSvn(ctx.cwd)) {
			pi.events.emit("pi-bar:update", { id: "git-branch", text: "svn", color: "mdHeading" });
			return;
		}
		const b = gitBranch(ctx.cwd);
		if (!b) {
			pi.events.emit("pi-bar:update", { id: "git-branch", text: undefined });
			return;
		}
		pi.events.emit("pi-bar:update", { id: "git-branch", text: b, color: "mdHeading" });
	}


	// Token accumulator cache: getEntries() returns a shallow copy of an
	// append-only array (entries cannot be modified or deleted — see
	// SessionManager contract), so the running totals survive across calls.
	// Each emitTokens call resumes from the cached index instead of rescanning
	// the whole history, turning the per-turn cost from O(history) → O(new).
	let tokenCache: { idx: number; to: number; msgCount: number } | undefined;

	// Reasoning strength: emit the model's current thinking level as a small
	// pill that always shows the current setting ("high" / "off" / "xhigh" /
	// ...). The segment stays visible at all times so the bar always reflects
	// what the runtime is configured to do; the prior tokens-up display that
	// lived in this slot is fully replaced. The host fires
	// ThinkingLevelSelectEvent on every cycle, so the displayed level stays
	// in sync without polling.
	function sessionThinkingLevel(ctx: ExtensionContext): string | undefined {
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: string; thinkingLevel?: string };
			if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
				return entry.thinkingLevel;
			}
		}
		return undefined;
	}

	function emitThinking(ctx: ExtensionContext): void {
		const level = sessionThinkingLevel(ctx) ?? ctx.thinkingLevel ?? "off";
		pi.events.emit("pi-bar:update", { id: "thinking", text: level, color: "text" });
	}

	function emitTokens(ctx: ExtensionContext): void {
		let to = 0;
		let msgCount = 0;
		const entries = ctx.sessionManager.getEntries();
		const start = tokenCache?.idx ?? 0;
		// getEntries() is the append-only source of truth, but structural
		// operations (createBranchedSession) can shorten the array below the
		// cached index — when that happens the cache is stale, so reset and
		// rescan from zero.
		if (start > 0 && start > entries.length) {
			tokenCache = undefined;
		}
		const from = tokenCache?.idx ?? 0;
		if (tokenCache) {
			to = tokenCache.to;
			msgCount = tokenCache.msgCount;
		}
		for (let i = from; i < entries.length; i++) {
			const e = entries[i]!;
			if (e.type !== "message") continue;
			const m = (e as { message: { role?: string; usage?: { output: number } } }).message;
			if (m.role === "user") msgCount += 1;
			if (m.role !== "assistant" || !m.usage) continue;
			to += m.usage.output;
		}
		tokenCache = { idx: entries.length, to, msgCount };
		pi.events.emit("pi-bar:update", { id: "messages", text: `#${msgCount}`, color: "thinkingMedium" });
	}

	// Live output speed: sampled from streaming deltas during a turn and shown
	// as an approximate tokens-per-second figure (chars/4 heuristic); idle
	// shows 0 t/s. Sampling is windowed and throttled so the per-delta event
	// storm never reaches the widget refresh path more than a few times/s.
	const TPS_SAMPLE_MS = 250;
	let tpsSamples: { chars: number; start: number } | undefined;

	function emitTps(ctx: ExtensionContext, value: number): void {
		pi.events.emit("pi-bar:update", { id: "tps", text: `${Math.round(value)} t/s`, color: "text" });
	}

	function emitTpsIdle(ctx: ExtensionContext): void {
		tpsSamples = undefined;
		emitTps(ctx, 0);
	}

	function emitTpsDelta(ctx: ExtensionContext, delta: string): void {
		const now = Date.now();
		if (!tpsSamples) tpsSamples = { chars: 0, start: now };
		tpsSamples.chars += delta.length / 4;
		if (now - tpsSamples.start < TPS_SAMPLE_MS) return;
		const seconds = (now - tpsSamples.start) / 1000;
		emitTps(ctx, seconds > 0 ? tpsSamples.chars / seconds : 0);
		tpsSamples = { chars: 0, start: now };
	}


	function emitContext(ctx: ExtensionContext): void {
		const u = ctx.getContextUsage();
		if (!u || u.tokens == null) {
			pi.events.emit("pi-bar:update", { id: "context-usage", text: "", suffix: "0%", color: "syntaxString" });
			pi.events.emit("pi-bar:update", { id: "context-tokens", text: fmtTokens(0) });
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
	const raw = m.id.lastIndexOf("/") >= 0 ? m.id.slice(m.id.lastIndexOf("/") + 1) : m.id;
	pi.events.emit("pi-bar:update", { id: "model", text: raw, color: "thinkingHigh" });
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
		installHeader(ctx);
		runEmitGit(ctx);
		emitTokens(ctx);
		emitContext(ctx);
		emitModel(ctx);
		emitThinking(ctx);
		emitTpsIdle(ctx);
		refresh();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopWorkingTimer();
		if (ctx.hasUI) {
			ctx.ui.setWidget("pi-bar", undefined);
			ctx.ui.setHeader(undefined);
			ctx.ui.setEditorComponent(undefined);
		}
		currentCtx = undefined;
		segs.clear();
		lastGitCwd = undefined;
		tpsSamples = undefined;
		tokenCache = undefined;
	});

	pi.on("model_select", async (_event, ctx) => {
		emitModel(ctx);
		emitThinking(ctx);
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		emitThinking(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		emitContext(ctx);
		if (ctx.hasUI) {
			ctx.ui.setWorkingIndicator({ frames: REIMU_FRAMES, intervalMs: REIMU_INTERVAL_MS });
			startWorkingTimer();
		}
		flushIfDirty();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		emitContext(ctx);
		emitTpsIdle(ctx);
		stopWorkingTimer();
		if (ctx.hasUI) {
			ctx.ui.setWorkingIndicator();
		}
	});

	pi.on("message_update", async (event, ctx) => {
		emitContext(ctx);
		const ev = (event as { assistantMessageEvent?: { type?: string; delta?: unknown } }).assistantMessageEvent;
		if (ev && typeof ev.delta === "string"
			&& (ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta")) {
			emitTpsDelta(ctx, ev.delta);
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
		if (event.toolName === "bash") runEmitGit(ctx);
		emitTokens(ctx);
		emitContext(ctx);
	});

	// Coalesce frequent producer bursts into a single widget re-attach per tick.
	const flush = (): void => flushIfDirty();
	pi.events.on("pi-bar:update", flush);
	pi.events.on("pi-bar:register-segment", flush);
}
