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
  assert.match(contextBlock[0], /suffix:\s*`\$\{pct\}%`/);
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
  // Windows paths keep the drive and leaf directory while collapsing parents.
  assert.ok(statuslineSource.includes("const windowsRoot = cwd.match(/^([A-Za-z]:)[\\\\/](?:.*[\\\\/])?([^\\\\/]+)$/);"));
  assert.ok(statuslineSource.includes("return windowsRoot ? `${windowsRoot[1]}\\\\~\\\\${windowsRoot[2]}` : cwd;"));
  // emitGit hoists the display path into a local for reuse across branches.
  assert.match(statuslineSource, /const path = displayPath\(ctx\.cwd, homedir\(\)\);/);
  // Line 1: git-branch holds the display path only (both svn and git paths).
  assert.match(statuslineSource, /pi\.events\.emit\("pi-bar:update", \{ id: "git-branch", text: path, color: "mdHeading" \}\)/);
  // Line 2 leftmost: git branch name is prefixed with "git." in mdLink.
  assert.match(statuslineSource, /pi\.events\.emit\("pi-bar:update", \{ id: "git-head", text: `git\.\$\{b\}`, color: "mdLink" \}\)/);
});

test("isSvn walks up from cwd looking for a .svn directory", () => {
  assert.match(statuslineSource, /function isSvn\(cwd: string\): boolean \{/);
  // Ascent loop with parent assignment and root termination via parent === dir.
  assert.match(statuslineSource, /const parent = dirname\(dir\);[\s\S]*?if \(parent === dir\) break;/);
  assert.match(statuslineSource, /if \(existsSync\(svnDir\) && statSync\(svnDir\)\.isDirectory\(\)\) return true;/);
  // fs/path imports extended for the probe.
  assert.match(statuslineSource, /import \{ existsSync, readFileSync, statSync \} from "node:fs";/);
  assert.match(statuslineSource, /import \{ dirname, join \} from "node:path";/);
});

test("emitGit precedence is svn > git > empty", () => {
  const body = statuslineSource.match(/function emitGit[\s\S]*?\n\t}/)?.[0] ?? "";
  // svn checked first and short-circuits before gitBranch.
  assert.match(body, /if \(isSvn\(ctx\.cwd\)\) \{[\s\S]*?pi\.events\.emit\("pi-bar:update", \{ id: "git-head", text: "svn", color: "mdLink" \}\)[\s\S]*?return;/);
  // svn keeps the path on line 1, git keeps the path on line 1 too.
  assert.match(body, /pi\.events\.emit\("pi-bar:update", \{ id: "git-branch", text: path, color: "mdHeading" \}\)/g);
  // empty placeholder: both segments cleared (text: undefined) when neither vcs applies.
  assert.match(body, /pi\.events\.emit\("pi-bar:update", \{ id: "git-branch", text: undefined \}\)/);
  assert.match(body, /pi\.events\.emit\("pi-bar:update", \{ id: "git-head", text: undefined \}\)/);
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

test("work-time segment shows current run from agent_start to settled", () => {
  assert.match(statuslineSource, /function fmtDuration\(ms: number\): string \{/);
  assert.match(statuslineSource, /let workStartMs: number \| undefined;/);
  // agent_start sets the active run start, agent_settled clears it.
  assert.match(statuslineSource, /pi\.on\("agent_start", async \(_event, ctx\) => \{[\s\S]*?workStartMs = Date\.now\(\)/);
  assert.match(statuslineSource, /pi\.on\("agent_settled", async \(_event, ctx\) => \{[\s\S]*?workStartMs = undefined/);
  // Segment text formats as the current run duration in syntaxComment green.
  assert.match(statuslineSource, /pi\.events\.emit\("pi-bar:update", \{ id: "work-time", text: fmtDuration\(workMs\), color: "syntaxComment" \}\)/);
});
