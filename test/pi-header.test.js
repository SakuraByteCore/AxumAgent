import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import bar from "../plugin/pi-bar/index.ts";

// The sakura cyberdeck header was merged into pi-bar; render the header through
// pi-bar's session_start flow with a minimal mock that satisfies pi-bar's full
// startup contract (status-bar producers + header installation).
const headerSource = fs.readFileSync(path.join(process.cwd(), "plugin", "pi-bar", "index.ts"), "utf8");
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

const MOCK_COMMANDS = [
  { name: "pi-debug", description: "debugger", source: "extension", sourceInfo: { path: "/mock/bundled/pi-debug/index.js", source: "cli", scope: "temporary", origin: "top-level" } },
  { name: "goal", description: "goal mode", source: "extension", sourceInfo: { path: "/mock/bundled/pi-goal/index.js", source: "cli", scope: "temporary", origin: "top-level" } },
  { name: "clear", description: "clear", source: "extension", sourceInfo: { path: "/mock/bundled/pi-companion/index.js", source: "cli", scope: "temporary", origin: "top-level" } },
  { name: "plan", description: "plan", source: "extension", sourceInfo: { path: "/mock/bundled/pi-companion/index.js", source: "cli", scope: "temporary", origin: "top-level" } },
  { name: "implement", description: "implement", source: "extension", sourceInfo: { path: "/mock/bundled/pi-companion/index.js", source: "cli", scope: "temporary", origin: "top-level" } },
  { name: "ralph", description: "ralph", source: "extension", sourceInfo: { path: "/mock/bundled/pi-companion/index.js", source: "cli", scope: "temporary", origin: "top-level" } },
  { name: "rules", description: "rules", source: "extension", sourceInfo: { path: "/mock/bundled/pi-companion/index.js", source: "cli", scope: "temporary", origin: "top-level" } },
  { name: "plugin-create-mode", description: "plugin guide", source: "extension", sourceInfo: { path: "/mock/bundled/pi-companion/index.js", source: "cli", scope: "temporary", origin: "top-level" } },
  { name: "fff", description: "file search", source: "extension", sourceInfo: { path: "/mock/bundled/pi-fff/index.js", source: "cli", scope: "temporary", origin: "top-level" } },
  { name: "pi-companion:setup", description: "internal setup", source: "extension", sourceInfo: { path: "/mock/bundled/pi-companion/index.js", source: "cli", scope: "temporary", origin: "top-level" } },
  { name: "user-cmd", description: "user ext", source: "extension", sourceInfo: { path: "/home/user/.pi/agent/extensions/user-ext/index.ts", source: "local", scope: "user", origin: "top-level" } },
  { name: "proj-cmd", description: "project ext", source: "extension", sourceInfo: { path: "/proj/.pi/extensions/proj-ext/index.ts", source: "local", scope: "project", origin: "top-level" } },
  { name: "templ", description: "prompt template", source: "prompt", sourceInfo: { path: "/home/user/.pi/prompts/templ.md", source: "local", scope: "user", origin: "top-level" } },
];

const EXPECTED_COMMANDS = MOCK_COMMANDS.filter(
  (c) => c.source === "extension" && c.sourceInfo.scope === "temporary" && !c.name.includes(":"),
).map((c) => `/${c.name}`);

function getSourceArtRows() {
  const artBlock = headerSource.match(/const ANIME_ART = \[(.*?)\] as const;/s)?.[1] ?? "";
  return [...artBlock.matchAll(/^\s+"(.*)",?\r?$/gm)].map((match) => match[1]);
}

function createHeaderRenderer(rows = 80, argv = []) {
  let sessionStart;
  let headerComponent;
  const originalArgv = process.argv.slice();
  process.argv.push(...argv);

  try {
    bar({
      on(name, callback) {
        if (name === "session_start") sessionStart = callback;
      },
      events: { on() {}, emit() {} },
      getCommands: () => MOCK_COMMANDS,
    });
    assert.equal(typeof sessionStart, "function");

    // Minimal ctx stub covering pi-bar's session_start: header installation plus
    // the status-bar producers (git probe, tokens, context, model, thinking,
    // widget refresh). All producer outputs are dropped via the noop events.emit
    // on the mock pi, so only the header factory is captured.
    const sessionManager = {
      getEntries: () => [],
      getBranch: () => [],
    };
    sessionStart({}, {
      hasUI: true,
      cwd: process.cwd(),
      model: undefined,
      thinkingLevel: "off",
      sessionManager,
      getContextUsage: () => undefined,
      ui: {
        setHeader(factory) {
          headerComponent = factory({ terminal: { rows } });
        },
        setEditorComponent() {},
        setWorkingMessage() {},
        setWorkingIndicator() {},
        setWidget() {},
        setFooter() {
          return { render: () => [], invalidate() {} };
        },
      },
    });
    assert.equal(typeof headerComponent?.render, "function");

    return {
      render: (width) => headerComponent.render(width),
      invalidate: () => headerComponent.invalidate(),
      restore() {
        process.argv.length = 0;
        process.argv.push(...originalArgv);
      },
    };
  } catch (error) {
    process.argv.length = 0;
    process.argv.push(...originalArgv);
    throw error;
  }
}

function renderHeaderLines(width, rows = 80, argv = []) {
  const headerRenderer = createHeaderRenderer(rows, argv);
  try {
    return headerRenderer.render(width).map((line) => line.replace(ANSI_PATTERN, ""));
  } finally {
    headerRenderer.restore();
  }
}

test("pi-header reuses rendered lines until width changes or the theme invalidates", () => {
  const headerRenderer = createHeaderRenderer();
  try {
    const initialLines = headerRenderer.render(120);
    assert.strictEqual(headerRenderer.render(120), initialLines);

    const narrowLines = headerRenderer.render(80);
    assert.notStrictEqual(narrowLines, initialLines);

    headerRenderer.invalidate();
    assert.notStrictEqual(headerRenderer.render(80), narrowLines);
  } finally {
    headerRenderer.restore();
  }
});

test("pi-header keeps the trimmed ASCII source", () => {
  const artRows = getSourceArtRows();

  assert.equal(artRows.length, 36);
  assert.ok(artRows.every((line) => [...line].length === 77));
  assert.equal(artRows[0].trim().startsWith("██████████████████░"), true);
  assert.doesNotMatch(headerSource, /░░░░░░░░▒▒▒▒▓████/);
});

test("pi-header renders the scaled ASCII art inside the sakura frame", () => {
  const artRows = getSourceArtRows();
  const renderedArt = renderHeaderLines(120).filter((line) => /[█▓▒░]/.test(line));

  assert.doesNotMatch(headerSource, /ART_SCALE|resizeAsciiArt|SCALED_ANIME_ART/);
  assert.equal(renderedArt.length, artRows.length);
  assert.ok(renderedArt.every((line) => [...line].length <= 62));
  assert.ok(renderedArt.every((line) => line.startsWith("│") && line.endsWith("│")));
});

test("pi-header downsamples the art to a compact target on every width", () => {
  const renderedArt = renderHeaderLines(40).filter((line) => /[█▓▒░]/.test(line));

  assert.equal(renderedArt.length, 36);
  assert.ok(renderedArt.every((line) => [...line].length <= 40));
});

test("pi-header frames the claude-code style welcome block", () => {
 const argv = [];

 for (const width of [80, 120]) {
 const lines = renderHeaderLines(width, 80, argv);
 const firstArtIndex = lines.findIndex((line) => /[█▓▒░]/.test(line));
 const lastArtIndex = lines.findLastIndex((line) => /[█▓▒░]/.test(line));
 const topIndex = lines.findIndex((line) => line.includes("╭─ Axum ─"));
 const bottomIndex = lines.findIndex((line) => line.includes("╰"));
 const welcomeIndex = lines.findIndex((line) => line.includes("Welcome to AxumAgent"));

 assert.notEqual(firstArtIndex, -1);
 assert.notEqual(lastArtIndex, -1);
 assert.notEqual(topIndex, -1);
 assert.notEqual(bottomIndex, -1);
 assert.notEqual(welcomeIndex, -1);
 assert.match(lines[welcomeIndex], /Welcome to AxumAgent · v\d+\.\d+\.\d+/);
 assert.equal(firstArtIndex, 2, "art directly inside the frame");
 assert.equal(topIndex, 1, "frame starts after one blank line");
 assert.equal(firstArtIndex - topIndex, 1, "art directly inside the frame");
 assert.ok(lines.some((l) => l.replace(/^│/, "").trimStart().startsWith("cwd")));
 assert.ok(lines.some((l) => l.replace(/^│/, "").trimStart().startsWith("skills")));
 const rawInfoText = (line) => line.replace(/^│/, "");
 const cmdLines = lines.filter((l) => rawInfoText(l).startsWith(" commands: ") || rawInfoText(l).startsWith("           "));
 const allCmdText = cmdLines.join(" ");
 assert.ok(cmdLines.length >= 1, "commands info line present");
 for (const cmd of EXPECTED_COMMANDS) {
 assert.ok(allCmdText.includes(cmd), `${cmd} present in commands line`);
 }
 }
});

test("pi-header shows bundled commands instead of extensions", () => {
  const argv = [];

  const lines = renderHeaderLines(120, 80, argv);
  const rawInfoText = (line) => line.replace(/^│/, "");
  const cmdLines = lines.filter((l) => rawInfoText(l).startsWith(" commands: ") || rawInfoText(l).startsWith("           "));
  const allCmdText = cmdLines.join(" ");

  assert.ok(cmdLines.length >= 1);
  for (const cmd of EXPECTED_COMMANDS) {
    assert.ok(allCmdText.includes(cmd), `${cmd} present in commands line`);
  }

  assert.ok(!allCmdText.includes("/user-cmd"));
  assert.ok(!allCmdText.includes("/proj-cmd"));
  assert.ok(!allCmdText.includes("/templ"));
  assert.ok(!allCmdText.includes("pi-companion:setup"));

  const sortedExpected = [...EXPECTED_COMMANDS].sort();
  let lastIndex = -1;
  for (const cmd of sortedExpected) {
    const index = allCmdText.indexOf(cmd);
    assert.ok(index !== -1, `${cmd} present for sort-order check`);
    assert.ok(index >= lastIndex, `${cmd} renders in sorted order`);
    lastIndex = index;
  }
});

test("pi-header wraps long commands list inside the frame", () => {
  const argv = [];

  const lines = renderHeaderLines(50, 80, argv);
  const boxWidth = Math.min(...lines.filter(Boolean).map((line) => [...line].length));
  const maxInner = Math.max(...lines.map((line) => [...line].length));

  assert.equal(maxInner, 50);
  assert.ok(lines.every((line) => [...line].length <= boxWidth), "no info line exceeds the frame");
  for (const cmd of EXPECTED_COMMANDS) {
    assert.ok(lines.some((l) => l.includes(cmd)), `${cmd} survives wrapping`);
  }
  const infoText = (line) => line.replace(/^│/, "").trimStart();
  const cmdLines = lines.filter((l) => infoText(l).startsWith("commands: "));
  assert.ok(cmdLines.length >= 1);
  const labelCols = ["cwd", "skills", "commands"].map((label) => {
    const line = lines.find((l) => infoText(l).startsWith(`${label}`) && infoText(l).includes(": "));
    assert.ok(line, `label ${label} present`);
    return line.indexOf(":");
  });
  assert.equal(new Set(labelCols).size, 1, "cwd/skills/commands colons share one column");
  assert.doesNotMatch(lines.join("\n"), /\u2026/);
});