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

test("git-branch shows path on line 1, git-head shows branch on line 2", () => {
  assert.match(statuslineSource, /function displayPath\(cwd: string, home: string\): string \{/);
  // Line 1: git-branch holds the display path only.
  assert.match(statuslineSource, /pi\.events\.emit\("pi-bar:update", \{ id: "git-branch", text: displayPath\(ctx\.cwd, homedir\(\)\), color: "mdHeading" \}\)/);
  // Line 2 leftmost: git-head holds the bare branch name in mdLink.
  assert.match(statuslineSource, /pi\.events\.emit\("pi-bar:update", \{ id: "git-head", text: b, color: "mdLink" \}\)/);
});

test("renderBar returns a two-line array with git-branch isolated on the first line", () => {
  // The bar switched to a two-line layout: line 1 = path+branch, line 2 = rest.
  assert.match(statuslineSource, /function renderBar\(segs: Map<string, Segment>, settings: Settings, theme: Theme, width: number\): string\[\]/);
  const body = statuslineSource.match(/function renderBar\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(body, /const header = segs\.get\("git-branch"\)/);
  assert.match(body, /const msgs = segs\.get\("messages"\)/);
  assert.match(body, /return \[firstLine, secondLine\]/);
  // Second line renders left/right after filtering git-branch and messages out.
  assert.match(body, /settings\.left\.filter\(\(id\) => id !== "git-branch" && id !== "messages"\)/);
  assert.match(body, /settings\.right\.filter\(\(id\) => id !== "git-branch" && id !== "messages"\)/);
});

test("messages segment counts session messages and sits on the right before model", () => {
  // Counter accumulates message entries inside the token pass to avoid a second traversal.
  assert.match(statuslineSource, /let msgCount = 0;/);
  assert.match(statuslineSource, /if \(e\.type !== "message"\) continue;[\s\S]*?msgCount \+= 1;/);
  assert.match(statuslineSource, /pi\.events\.emit\("pi-bar:update", \{ id: "messages", text: `#\$\{msgCount\}`, color: "thinkingMedium" \}\)/);
  assert.match(statuslineSource, /right: \["messages", "work-time", "model", "sub-hourly", "sub-weekly"\]/);
});

test("model segment strips provider prefix from model id", () => {
  assert.match(statuslineSource, /const name = m\.id\.lastIndexOf\("\/"\) >= 0 \? m\.id\.slice\(m\.id\.lastIndexOf\("\/"\) \+ 1\) : m\.id;/);
  assert.match(statuslineSource, /text = lvl === "off" \? `\$\{name\} \\u00b7 off` : `\$\{name\} \\u00b7 \$\{lvl\}`/);
});

test("work-time segment shows current run / session total from agent_start to settled", () => {
  assert.match(statuslineSource, /function fmtDuration\(ms: number\): string \{/);
  assert.match(statuslineSource, /let workStartMs: number \| undefined;/);
  // agent_start sets the active run start, agent_settled clears it.
  assert.match(statuslineSource, /pi\.on\("agent_start", async \(_event, ctx\) => \{[\s\S]*?workStartMs = Date\.now\(\)/);
  assert.match(statuslineSource, /pi\.on\("agent_settled", async \(_event, ctx\) => \{[\s\S]*?workStartMs = undefined/);
  // Segment text formats as "cur / total" in syntaxComment green.
  assert.match(statuslineSource, /pi\.events\.emit\("pi-bar:update", \{ id: "work-time", text: `\$\{fmtDuration\(workMs\)\} \/ \$\{fmtDuration\(totalMs\)\}`, color: "syntaxComment" \}\)/);
});
