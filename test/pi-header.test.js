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
  assert.ok(artRows.every((line) => [...line].length === 102));
  assert.equal(artRows[0].startsWith("▒████▒"), true);
  assert.doesNotMatch(headerSource, /░░░░░░░░▒▒▒▒▓████/);
});

test("pi-header renders ASCII art without the 50 percent scale pass", () => {
  const artRows = getSourceArtRows();
  const renderedArt = renderHeaderLines(120).filter((line) => /[█▓▒░]/.test(line));

  assert.doesNotMatch(headerSource, /ART_SCALE|resizeAsciiArt|SCALED_ANIME_ART/);
  assert.equal(renderedArt.length, artRows.length);
  assert.equal(renderedArt[0].trimStart(), artRows[0]);
});

test("pi-header still downsamples only for narrow terminals", () => {
  const renderedArt = renderHeaderLines(40).filter((line) => /[█▓▒░]/.test(line));

  assert.equal(renderedArt.length, 36);
  assert.ok(renderedArt.every((line) => [...line].length <= 40));
});

test("pi-header centers the Extensions card and uses fixed top padding", () => {
 const argv = [
 "-e", "C:/x/pi-bar/index.ts",
 "-e", "C:/x/pi-header/index.ts",
  "-e", "C:/x/src/index.ts",
 ];

 for (const width of [80, 120]) {
 const lines = renderHeaderLines(width, 80, argv);
 const topRuleIndex = lines.findIndex((line) => line.includes("AXUM"));
 const firstArtIndex = lines.findIndex((line) => /[█▓▒░]/.test(line));
 const lastArtIndex = lines.findLastIndex((line) => /[█▓▒░]/.test(line));
 const extensionsTopIndex = lines.findIndex((line) => line.includes("Extensions"));
 const extensionsBottomIndex = lines.findLastIndex((line) => line.includes("╰"));
 const bottomRuleIndex = lines.findLastIndex((line) => line.includes("AXUM"));
 const extensionsTop = lines[extensionsTopIndex];

 assert.notEqual(topRuleIndex, -1);
 assert.notEqual(firstArtIndex, -1);
 assert.notEqual(lastArtIndex, -1);
 assert.notEqual(extensionsTopIndex, -1);
 assert.notEqual(extensionsBottomIndex, -1);
 assert.notEqual(bottomRuleIndex, -1);
 assert.ok(extensionsTop);
 assert.equal(lines.some((line) => line.includes("pi-bar, pi-header, src")), true);

 const cardWidth = [...extensionsTop.trimStart()].length;
 assert.equal(extensionsTop.search(/\S/), Math.floor((width - cardWidth) / 2));
 assert.equal(topRuleIndex, 1, "fixed top padding");
 assert.equal(firstArtIndex - topRuleIndex - 1, 1, "gap above art");
 const firstCardIndex = lines.findIndex((line) => line.includes("╭"));
 assert.notEqual(firstCardIndex, -1, "first card rendered");
 assert.equal(firstCardIndex - lastArtIndex - 1, 1, "gap below art into first card");
 assert.equal(bottomRuleIndex - extensionsBottomIndex - 1, 1, "gap below last card");
 }
});

test("pi-header labels node_modules extensions by package name, not entry dir", () => {
  const argv = [
    "-e", "/home/u/AxumAgent/node_modules/pi-bar/index.ts",
    "-e", "/home/u/AxumAgent/plugin/pi-header/index.ts",
  ];

  const lines = renderHeaderLines(120, 80, argv);
  const cardLine = lines.find((line) => line.includes("Extensions"));
  const nextLine = lines[lines.indexOf(cardLine) + 1];

  assert.ok(nextLine.includes("pi-bar, pi-header"));
  assert.equal(nextLine.includes("src"), false);
  assert.equal(nextLine.includes("dist"), false);
  assert.equal(nextLine.includes("@narumitw"), false);
});

test("pi-header wraps the Extensions card body onto multiple lines", () => {
  const argv = [
    "-e", "/x/node_modules/pi-bar/index.ts",
    "-e", "/x/node_modules/pi-response-guard/index.ts",
        "-e", "/x/plugin/pi-header/index.ts",
    "-e", "/x/node_modules/pi-extra-one/index.ts",
    "-e", "/x/node_modules/pi-extra-two/index.ts",
  ];

  const lines = renderHeaderLines(120, 80, argv);
  const extTopIndex = lines.findIndex((line) => line.includes("Extensions"));
  const extBottomIndex = lines.findIndex((line, i) => i > extTopIndex && line.includes("╰"));
  const bodyLines = lines.slice(extTopIndex + 1, extBottomIndex);

  assert.ok(bodyLines.length >= 2);
  assert.equal(bodyLines.some((l) => l.includes("pi-extra-one")), true);
  assert.equal(bodyLines.some((l) => l.includes("pi-extra-two")), true);
});
