import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

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

function rgbFg(color: RGB, text: string, bold = false): string {
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
function visibleWidth(text: string): number {
  // Only single-width glyphs are emitted by cyberdeck content; one text-codepoint == one cell.
  return [...text.replace(/\x1b\[[0-9;]*m/g, "")].length;
}

function truncateLine(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const chars = [...text];
  let used = 0;
  let out = "";
  for (const ch of chars) {
    const cw = visibleWidth(ch);
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
    const cw = visibleWidth(ch);
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

/** Center `content`, pad inner with spaces, keep symmetrical sakura rails. */
function boxedLine(content: string, width: number, rail: string): string {
  if (width <= 0) return "";
  const railW = visibleWidth(rail);
  if (railW * 2 > width) return truncateLine(rail, width);
  const inner = Math.max(0, width - railW * 2);
  const body = truncateLine(content, inner);
  const bw = visibleWidth(body);
  const padR = Math.max(0, inner - bw);
  const padL = Math.floor(padR / 2);
  const padG = padR - padL;
  const edgeColor = sampleStops(0);
  const railBg = `\x1b[38;2;${edgeColor[0]};${edgeColor[1]};${edgeColor[2]}m${rail}\x1b[39m`;
  return `${railBg}${" ".repeat(padL)}${body}${" ".repeat(padG)}${railBg}`;
}

const ANIME_ART = [
  "████████████████████████████████████████████████████████████████████████████████▒██▓▒▓██▓███████████  ",
  "████████████████████████████████████████████████████████████████████████████████░██▓▒███▒███████████  ",
  "██████████████████████████████████████████████████████████████████▓░░░░░░▒████░░░░▒▒▒▒░███████████    ",
  "█████████████████████████████████████████████████████████████████▒░░░░░    ░▒██▓▒▒▒▓▓▓▓▓▓███████████  ",
  "██████████████████░███████████████████████████████████████████▓░░░ ░░░     ░░▒█▒▒▒▓▓▓▓▓▓▓███████████  ",
  "█████████████████░░  ░  ░░▓▓▓█████████▓░░░     ░▒▓███████████░░░░░░░░░   ░   ░█░░░░░▒▒▒▒▓███████████  ",
  "█████████████████░░ ░        ░░░ ░░░█▒░░          ░░░▒▓█▓▒▒▒▒░░░░░░░░░    ░  ▒█░░░░░▒▒▒░████████████  ",
  "████████████████▒░░            ░░░  █▒░░░░        ░░░░░▒░░░░▒▒░░░░░░░░░ ░    ▓█░░░░░▒▒▒▒████████████  ",
  "████████████████▓▒▒░░░          ░░  █▒░░         ░░░░░░░▒░░░▒▒░░░░░░░░       ▓█░░░░░▒▒▒░████████████  ",
  "████████████████████████▓▓▓▓▓▒░░    █▒░          ░░░░░░░▒▒▒▓██▓░             ▓▓░░░░░▒▒▒▒████████████  ",
  "█████████████████████████████████████▒          ░ ░░░  ▒███████████▒░░░     ░▓▒░░░░░▒▒▒▒████████████  ",
  "██████████████████████████████████████░         ░  ░░▓██████████████████████████████████████████████  ",
  "██████████████████████████████████████▒░         ░▓█████████████████████████████████████████████████  ",
  "███████████████████████████████████████░      ░▓████████████████████████████████████████████████████  ",
  "████████████████████████████████████████▒░▒█████████████████████████████████████████████████████████  ",
  "████████████████████████████████████████████████████████████████████████████████████████████████████  ",
  "████████████████████████████████████████████████████████████████████████████████████████████████████  ",
  "████████████████████████████████████████████████████████████████████████████████████████████████████  ",
  "░░░░░░░░░░░░░░░░░▒▒▒▒▒▒▒▓▓██████████████████████████████████████████████████████████████████████████  ",
  "▒████▒░░░░░   ▒██░░░░ ░   ░▓█░░░░░░░░░░░░▒▒▓▓████████████████████████████████████▓▒▒▒░░░░░░░░░░░░▓██▓▓",
  "▓▓▓▓█▓▓███████░░░▒▓███████▒░░▓██▒░░░░░░░░░░▓▓▒░░░░░░░░░░░▓███▒░░░░░░░░░░░░▓███▒░░░░░▒▓██████████▓▓▓▓█ ",
  "▓▓▓▓█▒░█░░░░░░░░░░░░░█▓░░░░░░░░░▒▓▓█▓▓▓▓▓▒░░░▒▓▓▓██▓▓▓▒▒░░░░▒▓█▓▓▓██▓▓▓▓▓▒▒▒░░░▒▒▒▒░░░▒▓▒░░░░▒██████  ",
  "▓▓▓▓▓░▓▒░░░░░░░░░█░░░█▓░░░░░░░░░░▓▒█░░░░░░░░░░░░░▒▓░░░░░░░░░░░░░▒█▓░░░░░░░▒▒░░░░░░░░░░░▓▒░░░░▒██████  ",
  "▓▓▓█▓░▓░░░░░░░░░░█░░░█▓░░░░░░░░░░▓░█▒░░░░░░░░░░░░▒▓░░░░░░░░░░░░░░░░░▓▓▒▒░░▒░░░░░░░░░░░░▒█░░░░░▓█████  ",
  "▓▓▓█▓▒▓░░░░░░░░░░█░░▒█▓░░░░░░░░░░▓░▓▒░░░░░░░░░░░░▓▒░░░░░░░░░░░░░░░░░░░░▒▓▓░▒░░░░░░░░░░░░▓▒░░░░▒█████  ",
  "██▓█▒▓▒░░░░░░░░░▒█░░▓▒▓░░░░░░░░░░▓░▓▓░░░░░░░░░░░░▓▒░░░░░░░░░░░░░░░░░░░░░░░▒█▒░░░░░░░░░░░▓█░░░░▒█████  ",
  "████░▓▒░░░░░░░░░▒█▓░▓▒▓░░░░░░░░░░▓░▒▓░░░░▒▒▒▒▒▒▒▒█░░░░░░░░░░░░░░░░▓██▒░░░░░▓▓░░░░░░░░░░░░█▒░░░▒█████  ",
  "████▒▓▒░░░░░░░░░▓▒▓░▓▒▓▓▓▓▓▓▓▓▓▓▓▒░░▒▒▒▒▒▒▒░░░░░░░░░░░░░░▓▓██████████▓░░░░░▒▓░░░░░░░░░░░░▒▓░░░▒█████  ",
  "████▒▓▒░░░░░░░░░▓░▓▒▓▒░▓█████████▓░░░░░░░░░░░░░░░░░░░░▒███▓▒░░░▒▒▒▒▓████▓░░░▓░░░░░░░░░░░░░█▒░░▒█████  ",
  "████▓▓░░░░░░░░░░▓░░▓▒▓▒█████████████▒░░░░░░░░░░░░░░░░██▒░ ░▒██▓▒▓▒▓██▒▒███▒░▓░░░░░░░░░░░░░▒▓░░▒█████  ",
  "█████▒░░░░░░░░░░▓░░░▓███▓░░░▒▓█▓▓▓██▓░░░░░░░░░░░░░░░░░░░░░░█▓▒▓▒▒▒░░░░▒█▒░▓██▓░░░░░░░░░░░░░░▓▒░▒▓████ ",
  "███▓█▒░░░░░░░░░▒▓░░▒██▒░░░░█▓▒▓▓▒░░░▓▓░░░░░░░░░░░░░░░░░░░█▓▒▓▒▒░░░░░░░▒█▓░░█▒░░░░░░░░░░░░░░▒█░░▓████  ",
  "████▓▒░░░░░░░░░▒▒░░██░░░░░█▓▒▒▒▒░░░ ░▓▒░░░░░░░░░░░░░░░░░█▓▒░░░░░░░░░░░░▒█▒░█▒░░░▒░░░░░░░░▒▒░▒▓░▓████  ",
  "████▓░░░░░░░░░░▒▒░█▓░ ░░░▓▓▒▒░░░░░░░░▒█░░░░░░░░░░░░░░░░░█░░░░░░░░░░░░░░░▒▓▒▓░░░▒▒░░░░░░░░░▓▒░▓▓░████  ",
  "████▒░░░░░░░░░░▒▒░█░░ ░░░█▒░░░░░░░░░░░▒▓░░░░░░░░░░░░░░░░█░░░░░░░░░░░░░░░▒▓█▒░░▒▒░░░░░░░░░▓█░▒▓▒████   ",
  "████░░░░░░░░░░░▒▒░░░░   ░█░░░░░░░░░░░░░█░░░░░░░░░░░░░░░░▓▓░░░░░░░░░░░░░░▒█▓░░▒█░░░░░░░░░░░▒█▓░▒█▒███  ",
  "███▓░▓▒░░░░░░░░▒▓░░░░░░ ░█▒░░░░░░░░░░░▒▒░░░░░░░░░░░░░░░░░█▒░░░░░░░░░░░░░▓▓░░▓▓█▒░░░░░░▒░░░░▒██▓░▓▒███ ",
  "███▒░▓▒░░░░░░░░▒▓▒░░░    ░▓░░░░░░░░░░░▓░░░░░░░░░░░░░░░░░░░▓▓░░░░░░░░░░░█▓░▓▓░░█░░░░░░▓░░░░▒▓▓▓░▓█▒██  ",
  "███░▒█▒░░░░░░░░▒▓▓░░░░░  ░▒▒░░░░░░░░░▒░░░░░░░░░░░░░░░░░░░░░░█▓░░░░░░▒███▓▓░░░▒█░░░░░░▓░░░░▒███▒▒█▒██  ",
  "███░▓█▒░░░░░░░░░▓▒▒░░░░░░░░▒█▒░░░░░░▒░░░░░░░░░░░░░░░░░░░░░░░░░░▒▓▒░░░▒█▓▒░░░░▒▓█░░░░░▒▒░░░░▒▓░▓▓▒█░▓█ ",
  "██▓░██▒░░░░▒░░░░▓▓░▒░░░░░░░░░░▒▓▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▒▓▓▒░░░░░▒▒░░░░█▒░▒▓▓█░▒█  ",
  "██▓░█▓▓░░░░▒░░░░░█░▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░█▓▓▓░░░░░▒▒░░░░█▓░░▒▓█▓░░▓  ",
  "██▓░▓▒█░░░░▒▒░░░░▒▓░▒▒░░░░░░░░▒▓▓▓█▒░░░░░░░░░▒▒▒░░░░░░░░░░░░░░░░░░░░░░░▒▓█▒▒█▒░░░░▒▒░░░▒█▓░░░▓██░░░▒  ",
  "███░█▒▓▓░░░░▒░░░░░▓▓▒▒█▒░░░░░▒▓░░░░▒█▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓█▓▒▒▒█▒░░░▒▒▒░░░▓▓▒░░░░▓▓▒░░░░  ",
  "███▒█▒░▓▓░░░▒▒░░░░░▓▓▒▒▓█▒░░░░▓░░░░░░▓░░░░░░░░░░░░░░░░░░░░░░░░░░░▒██▒▒▒▒▒▓█░░░▒▓▒░░░▒▓█▒░░░░░▒▓▓▒░░░░ ",
  "████▓▒░░░▒▓░░░▒▓▒░░░░▓▓▒▒▒▒▓█▒▒▓░░░░░░▓▓▒▓▓▓▓▓▓▒▒▒▓▓█▓░░░░░░▒▒▓▓▓▒▒▒▒▒▒▒▒▓▓▓▓▓▓▓▓▓▓█▒░░░▒▒▒▒░░░░▒▓░░░ ",
  "████▓█▒░░▒█▓░░░▒▒▒░░░▒█▓▒▒▒▒▒▒▓▓░░░░░░░░░░░░░░░░░░░░▓█▓█▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▓░░░░░▒▒░░░░░░▒▓░░  ",
  "███▓░░░░░░░░▓█▒░░░▒▓████▓▒▒▒▒▒▓▓░░░░░░░░░░░░░░░░░░░▓███████▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒█░░░░░░░░░░░░░░▓░░   ",
  "███░░░░░▒░░░░░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▒░░░░░░░░░░░░▒▒████████████▓░▓▓▒▒█▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▒░░░░░░░░░░▒█▓▒░  ",
  "██▓░░░░░▒░░░░░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▓░░░░░░░░░░░░░░░░▓███████████▒▒░░░▒█▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▓▒░░░░░░▒▓░░▒▒   ",
  "██▒░░░░▒▒░░░░░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▒░░░░░░░░░░░░░░░▓▒█████████▓░▒░░░█░▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓░░▒▒░▒▒░░▓▓░▒  ",
  "█▓░░░░░▒░░░░░░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒█░░░░░░░░░░░░░▒▒█▒▒████▓░░░░░▒░░░▓▒░▓█▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒█░░░░░▒▒░░░░░▓▒   ",
  "█░░░░░▒░░░░░░░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓█░░░░░░░░░░░░░░█▒░█████▒░░ ░░░░░█░░░░▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▓█░░░░░░░░░░░░░█  ",
  "░░░░░▒▒░░░░░░░░▒▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒██▒░░░░░░░░░░░█▒░░█████▓░░░▒░░▒▒█░░░░░░▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒█▓░░░░░░░░░░░▒█ ",
  "░░░░░▒░░░░░░░░▒▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▓░░░▓█▓▒▒▒▒▒▓███░░ ░█████░░░▒░░░▓░░ ░░░ ▓█▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▒▒░░░░░░░▒█▒  "
] as const;

function getAvailableRows(tui: unknown): number {
  try {
    const terminal = (tui as { terminal?: { rows?: unknown } }).terminal;
    const rows = terminal?.rows;
    return typeof rows === "number" && Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
  } catch {
    return 0;
  }
}

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
 * Detect active Pi extensions from the launching argv: every `-e <path>`
 * becomes a card labelled by its entry directory (`basename(dirname(path))`),
 * so pi-goal's `src/index.ts` shows up as "src" exactly as seen at runtime.
 */
function detectExtensions(argv: readonly string[]): string[] {
  const names: string[] = [];
  for (let i = 0; i + 1 < argv.length; i++) {
    if (argv[i] === "-e") {
      const p = argv[i + 1];
      try {
        names.push(basename(dirname(p)));
      } catch {
        names.push(p);
      }
      i++;
    }
  }
  return names;
}

/** A sakura-framed card listing entries, centred, with the cyberdeck palette. */
function renderCard(label: string, entries: string[], width: number): string[] {
  if (width < 8) return [];
  if (entries.length === 0) entries = ["—"];
  const body = entries.join(", ");
  const rail = "│";
  return [
    frameGradient(fitBorderLabel(label, width)),
    boxedLine(gradient(body, [199, 184, 245], [252, 201, 185], true), width, rail),
    frameGradient(bottomBorder(width)),
    "",
  ];
}

/** Render the project title on a single full-width rule line:
 *  left `-` reach the left edge, right `-` reach the right edge,
 *  `AXUM` sits centered between the two rule segments.
 *  Uses the sakura→sky rule gradient for the dashes and the
 *  lavender→peach gradient for the title text, matching the cyberdeck palette. */
function dashTitleLine(width: number, edgeA: RGB, edgeB: RGB, textA: RGB, textB: RGB): string {
  if (width <= 0) return "";
  const title = " AXUM ";
  const titleLen = Math.min([...title].length, width);
  const visibleTitle = [...title].slice(0, titleLen).join("");
  if (titleLen >= width) return gradient(visibleTitle, textA, textB, true);
  const gap = width - titleLen;
  const leftLen = Math.floor(gap / 2);
  const rightLen = gap - leftLen;
  const left = "-".repeat(leftLen);
  const right = "-".repeat(rightLen);
  return gradient(left, edgeA, edgeB) + gradient(visibleTitle, textA, textB, true) + gradient(right, edgeB, edgeA);
}

function renderHeader(width: number, availableRows = 0, skills: string[] = [], extensions: string[] = []): string[] {
  if (width <= 0) return [];

  const sakura: RGB = [242, 167, 198];
  const peach: RGB = [252, 201, 185];
  const lavender: RGB = [199, 184, 245];
  const sky: RGB = [159, 211, 242];

  const artWidth = Math.max(...ANIME_ART.map((line) => [...line].length));
  // Termux and other narrow terminals can't show the full 80-col cyberdeck art
  // without it looking huge and unreadable. Downsample columns proportionally
  // so the whole silhouette stays visible at any width, preserving the sakura→sky
  // gradient feel; center the artwork once it fits natively.
  const fitsNatively = width >= artWidth;
  const visibleArtWidth = fitsNatively ? artWidth : Math.min(artWidth, width);
  const artPad = " ".repeat(Math.max(0, Math.floor((width - visibleArtWidth) / 2) - 2));

  const art = ANIME_ART.map((line) => {
    const src = [...line];
    let row: string;
    if (fitsNatively) {
      row = src.slice(0, visibleArtWidth).join("");
    } else {
      // nearest-column sampling keeps every silhouette column represented;
      // the cyberdeck art mixes █▓▒░ for shading, so preserve the sample's
      // exact glyph rather than collapsing it to a single block.
      let scaled = "";
      const span = src.length;
      for (let x = 0; x < visibleArtWidth; x++) {
        const sx = Math.round((x * span) / visibleArtWidth);
        const glyph = src[Math.min(sx, span - 1)];
        scaled += glyph === " " ? " " : glyph;
      }
      row = scaled;
    }
    return `${artPad}${gradient(row, sakura, sky)}`;
  });

  const hasCards = skills.length > 0 || extensions.length > 0;
  const visualHeight = ANIME_ART.length + 3 + (hasCards ? 1 : 0); // artwork + gap + divider + label (+card gap)
  const extraTopPadding = Math.max(0, Math.floor((availableRows - visualHeight) / 2) - 1);

  const cards: string[] = [];
  const cardWidth = Math.min(width, 52);
  const cardPad = " ".repeat(Math.max(0, Math.floor((width - cardWidth) / 2)));
  if (hasCards) {
    const mk = (lines: string[]): string[] => lines.map((l) => `${cardPad}${l}`);
    if (skills.length) cards.push(...mk(renderCard("Skills", skills, cardWidth)));
    if (extensions.length) cards.push(...mk(renderCard("Extensions", extensions, cardWidth)));
  }

  return [
    ...Array(extraTopPadding).fill(""),
    "",
    `${dashTitleLine(width, sakura, sky, lavender, peach)}`,
    "",
    ...art,
    "",
    ...cards,
    "",
    `${dashTitleLine(width, sakura, sky, lavender, peach)}`,
    "",
  ];
}

export default function sakuraCyberdeckHeader(pi: ExtensionAPI): void {
  let skillsCache: string[] = [];
  let extensionsCache: string[] = [];

  pi.on("session_start", (event, ctx) => {
    if (!ctx.hasUI) return;
    // Probe on every start so freshly installed skills / extensions surface.
    skillsCache = detectSkills(ctx.cwd);
    extensionsCache = detectExtensions(process.argv);
    ctx.ui.setHeader((tui) => ({
      render: (width) => renderHeader(width, getAvailableRows(tui), skillsCache, extensionsCache),
      invalidate() {},
    }));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setHeader(undefined);
  });
}
