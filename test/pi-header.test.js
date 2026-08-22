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
 const argv = [
 "-e", "C:/x/pi-bar/index.ts",
 "-e", "C:/x/pi-header/index.ts",
  "-e", "C:/x/src/index.ts",
 ];

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
 assert.ok(lines.some((l) => l.includes("cwd: ")));
 assert.ok(lines.some((l) => l.includes("skills: ")));
 const extLine = lines.find((l) => l.includes("extensions: "));
 assert.ok(extLine, "extensions info line present");
 assert.ok(extLine.includes("pi-bar"));
 assert.ok(extLine.includes("pi-header"));
 assert.ok(extLine.includes("src"));
 }
});

test("pi-header labels node_modules extensions by package name, not entry dir", () => {
  const argv = [
    "-e", "/home/u/AxumAgent/node_modules/pi-bar/index.ts",
    "-e", "/home/u/AxumAgent/plugin/pi-header/index.ts",
  ];

  const lines = renderHeaderLines(120, 80, argv);
  const extLine = lines.find((line) => line.includes("extensions: "));

  assert.ok(extLine);
  assert.ok(extLine.includes("pi-bar"));
  assert.ok(extLine.includes("pi-header"));
  assert.equal(extLine.includes("dist"), false);
  assert.equal(extLine.includes("@narumitw"), false);
});

test("pi-header truncates long info lines to stay inside the frame", () => {
  const argv = [
    "-e", "/x/node_modules/pi-bar/index.ts",
        "-e", "/x/plugin/pi-header/index.ts",
    "-e", "/x/node_modules/pi-extra-one/index.ts",
    "-e", "/x/node_modules/pi-extra-two/index.ts",
  ];

  const lines = renderHeaderLines(60, 80, argv);
  const boxWidth = Math.min(...lines.filter(Boolean).map((line) => [...line].length));
  const maxInner = Math.max(...lines.map((line) => [...line].length));

  assert.equal(maxInner, 60);
  const extLine = lines.find((line) => line.includes("extensions: "));
  assert.ok(extLine);
  assert.ok([...extLine].length <= boxWidth);
  assert.ok(extLine.trimEnd().endsWith("│"));
});
