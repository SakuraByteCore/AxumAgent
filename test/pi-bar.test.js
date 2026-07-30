import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const statuslineSource = fs.readFileSync(path.join(process.cwd(), "plugin", "pi-bar", "index.ts"), "utf8");

test("pi-bar has no separator field (plain space by default)", () => {
  assert.doesNotMatch(statuslineSource, /separator:/);
  assert.doesNotMatch(statuslineSource, /" - "/);
});

test("context usage renders percent without a leading bar", () => {
  const contextBlock = statuslineSource.match(/id: "context-usage",[\s\S]*?color: "syntaxString",[\s\S]*?}\);/);
  assert.match(contextBlock[0], /suffix:\s*`\$\{pct\}% \/ \$\{fmtTokens\(limit\)\}`/);
  assert.doesNotMatch(contextBlock[0], /bar:\s*pct/);
  assert.doesNotMatch(contextBlock[0], /barSegments:/);
});

test("suffix-only statusline segments stay visible", () => {
  assert.match(statuslineSource, /if \(!ev\.text && !ev\.suffix && ev\.bar === undefined\)/);
  assert.match(statuslineSource, /visible:\s*!!\(ev\.text \|\| ev\.suffix \|\| ev\.bar !== undefined\)/);
});

test("context usage has no working light animation", () => {
  assert.doesNotMatch(statuslineSource, /BREATH_FRAMES/);
  assert.doesNotMatch(statuslineSource, /WORKING_CURSOR_FRAMES/);
  assert.doesNotMatch(statuslineSource, /WORKING_LIGHT_FRAMES/);
  assert.doesNotMatch(statuslineSource, /breathTimer/);
  assert.doesNotMatch(statuslineSource, /setInterval\(/);
  assert.match(statuslineSource, /pi\.on\("agent_start"/);
  assert.match(statuslineSource, /emitContext\(ctx\);[\s\S]*?flushIfDirty\(\);/);
  assert.match(statuslineSource, /pi\.on\("agent_settled"/);
});

test("working indicator shows Reimu frames via host API (no plugin timer)", () => {
  assert.match(statuslineSource, /setWorkingIndicator\(\{ frames: REIMU_FRAMES, intervalMs: REIMU_INTERVAL_MS \}\)/);
  assert.match(statuslineSource, /setWorkingIndicator\(\);/);
  assert.match(statuslineSource, /REIMU_FRAMES/);
  assert.doesNotMatch(statuslineSource, /setInterval\(/);
  assert.doesNotMatch(statuslineSource, /BREATH_FRAMES|WORKING_LIGHT_FRAMES|WORKING_CURSOR_FRAMES|breathTimer/);
});

test("git-branch segment renders project path plus branch as `~/... (name)`", () => {
  assert.match(statuslineSource, /function displayPath\(cwd: string, home: string\): string \{/);
  // Branch name composed with a parenthesized display path on the same text.
  assert.match(statuslineSource, /`\$\{displayPath\(ctx\.cwd, homedir\(\)\)\} \(\$\{b\}\)`/);
});

test("renderBar returns a two-line array with git-branch isolated on the first line", () => {
  // The bar switched to a two-line layout: line 1 = path+branch, line 2 = rest.
  assert.match(statuslineSource, /function renderBar\(segs: Map<string, Segment>, settings: Settings, theme: Theme, width: number\): string\[\]/);
  const body = statuslineSource.match(/function renderBar\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(body, /const header = segs\.get\("git-branch"\)/);
  assert.match(body, /return \[firstLine, secondLine\]/);
  // Second line renders left/right after filtering git-branch out of both sides.
  assert.match(body, /settings\.left\.filter\(\(id\) => id !== "git-branch"\)/);
  assert.match(body, /settings\.right\.filter\(\(id\) => id !== "git-branch"\)/);
});

test("messages segment counts session messages and sits on the right before model", () => {
  // Counter accumulates message entries inside the token pass to avoid a second traversal.
  assert.match(statuslineSource, /let msgCount = 0;/);
  assert.match(statuslineSource, /if \(e\.type !== "message"\) continue;[\s\S]*?msgCount \+= 1;/);
  assert.match(statuslineSource, /pi\.events\.emit\("pi-bar:update", \{ id: "messages", text: `#\$\{msgCount\}`, color: "thinkingMedium" \}\)/);
  assert.match(statuslineSource, /right: \["messages", "model", "sub-hourly", "sub-weekly"\]/);
});

test("model segment strips provider prefix from model id", () => {
  assert.match(statuslineSource, /const name = m\.id\.lastIndexOf\("\/"\) >= 0 \? m\.id\.slice\(m\.id\.lastIndexOf\("\/"\) \+ 1\) : m\.id;/);
  assert.match(statuslineSource, /text = lvl === "off" \? `\$\{name\} \\u00b7 off` : `\$\{name\} \\u00b7 \$\{lvl\}`/);
});
