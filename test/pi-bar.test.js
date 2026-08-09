import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const statuslineSource = fs.readFileSync(path.join(process.cwd(), "plugin", "pi-bar", "index.ts"), "utf8");

test("coralline pill style uses rounded caps with powerline separators", () => {
  assert.match(statuslineSource, /const CAP_L = "\\uE0B6";/);
  assert.match(statuslineSource, /const CAP_R = "\\uE0B4";/);
  assert.match(statuslineSource, /const SEP = "\\uE0B0";/);
  assert.match(statuslineSource, /barStyle: "coralline",/);
  assert.match(statuslineSource, /barStyle: "continuous" \| "blocks" \| "coralline";/);
  // joinPills seals a train's ends with caps and meets adjacent pills at SEP.
  assert.match(statuslineSource, /function joinPills\(arr: RSeg\[\], pill: boolean, theme: Theme, leftCap: boolean, rightCap: boolean\): Train \{/);
  assert.match(statuslineSource, /parts\.push\(`\$\{firstFg\}\$\{CAP_L\}\$\{RESET_FG\}`\);/);
  assert.match(statuslineSource, /parts\.push\(`\$\{prevFg\}\$\{curBg\}\$\{SEP\}\$\{RESET_BOTH\}`\);/);
  assert.match(statuslineSource, /parts\.push\(`\$\{lastFg\}\$\{CAP_R\}\$\{RESET_BOTH\}`\);/);
  assert.doesNotMatch(statuslineSource, /" - "/);
});

test("context usage renders a coralline threshold gauge and a separate token-count pill", () => {
  const contextBlock = statuslineSource.match(/function emitContext[\s\S]*?\n\t}/)?.[0] ?? "";
  // context-usage pill carries only the percent + gauge; the token count is a
  // separate context-tokens pill so the two read side by side, not merged.
  assert.match(contextBlock, /suffix:\s*`\$\{pct\}%`/);
  assert.match(contextBlock, /bar:\s*pct,/);
  assert.match(contextBlock, /color:\s*thresholdColor\(pct\)/);
  assert.match(contextBlock, /id: "context-tokens", text: fmtTokens\(u\.tokens\)/);
  assert.match(statuslineSource, /left: \["git-branch", "thinking", "tokens-down", "context-tokens", "context-usage"\]/);
  assert.match(statuslineSource, /"context-tokens":\s*\[146, 146, 69\]/);
  // gauge fill glyph and thresholds are defined; no empty-trailing glyph.
  assert.match(statuslineSource, /const GAUGE_FILL = "\\u25B0";/);
  assert.doesNotMatch(statuslineSource, /const GAUGE_EMPTY/);
  assert.match(statuslineSource, /const GAUGE_WARN_PCT = 50;/);
  assert.match(statuslineSource, /const GAUGE_HOT_PCT = 75;/);
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

test("git-branch shows the display path via emitGit", () => {
  assert.match(statuslineSource, /function displayPath\(cwd: string, home: string\): string \{/);
  // Windows paths keep the drive and leaf directory while collapsing parents.
  assert.ok(statuslineSource.includes("const windowsRoot = cwd.match(/^([A-Za-z]:)[\\\\/](?:.*[\\\\/])?([^\\\\/]+)$/);"));
  assert.ok(statuslineSource.includes("return windowsRoot ? `${windowsRoot[1]}\\\\~\\\\${windowsRoot[2]}` : cwd;"));
  // git-branch holds the display path only (both svn and git paths).
  assert.match(statuslineSource, /const path = displayPath\(ctx\.cwd, homedir\(\)\);/);
  assert.match(statuslineSource, /pi\.events\.emit\("pi-bar:update", \{ id: "git-branch", text: path, color: "mdHeading" \}\)/);
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
  assert.match(body, /if \(isSvn\(ctx\.cwd\)\) \{[\s\S]*?return;/);
  // svn keeps the path on line 1, git keeps the path on line 1 too.
  assert.match(body, /pi\.events\.emit\("pi-bar:update", \{ id: "git-branch", text: path, color: "mdHeading" \}\)/g);
  // empty placeholder: both segments cleared (text: undefined) when neither vcs applies; git-dirty was removed entirely.
  assert.match(body, /pi\.events\.emit\("pi-bar:update", \{ id: "git-branch", text: undefined \}\)/);
  assert.doesNotMatch(body, /emitGitDirty/);
});

test("renderBar returns a single-line array spreading all segments", () => {
  // The bar switched to a single-line layout: every active segment shares
  // one row, left-side segments cluster left and right-side segments right.
  assert.match(statuslineSource, /function renderBar\(segs: Map<string, Segment>, settings: Settings, theme: Theme, width: number\): string\[\]/);
  const body = statuslineSource.match(/function renderBar\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(body, /const lineLeft = settings\.left;/);
  assert.match(body, /const lineRight = settings\.right;/);
  assert.match(body, /return \[singleLine\];/);
});

test("messages count is a separate right-side pill, separated from context-usage", () => {
  // Counter accumulates message entries inside the token pass to avoid a second traversal.
  assert.match(statuslineSource, /let msgCount = 0;/);
  assert.match(statuslineSource, /if \(e\.type !== "message"\) continue;[\s\S]*?msgCount \+= 1;/);
  assert.match(statuslineSource, /pi\.events\.emit\("pi-bar:update", \{ id: "messages", text: `#\$\{msgCount\}`, color: "thinkingMedium" \}\)/);
  // messages is its own separate pill at the head of the right train, not
  // embedded in the elastic context-usage block.
  assert.match(statuslineSource, /right: \["messages", "model"\]/);
  // messages now has its own warm ground in the palette.
  assert.match(statuslineSource, /messages:\s+\[49, 94, 94\]/);
  // elastic context-usage block no longer reads the messages segment.
  assert.doesNotMatch(statuslineSource, /segs\.get\("messages"\)\?\.text/);
});

test("model segment strips provider prefix from model id", () => {
 assert.match(statuslineSource, /m\.id\.slice\(m\.id\.lastIndexOf\("\/"\) \+ 1\)/);
 assert.match(statuslineSource, /m\.id\.lastIndexOf\("\/"\)/);
 assert.match(statuslineSource, /pi\.events\.emit\("pi-bar:update", \{ id: "model", text: name, color: "thinkingHigh" \}\)/);
 assert.doesNotMatch(statuslineSource, /\\u00b7/);
});
test("model name truncates directly when exceeding nemotron-3-ultra width", () => {
 assert.match(statuslineSource, /const MAX_MODEL_WIDTH = visibleWidth\(".*"\)/);
 assert.match(statuslineSource, /const name = truncateToWidth\(raw, MAX_MODEL_WIDTH, ""\)/);
});
test("usage-core, last-tool and git-dirty dead segments purged", () => {
  for (const dead of [
    "usage-core",
    "sub-hourly",
    "sub-weekly",
    "RateWindow",
    "UsageState",
    "emitUsage",
    "emitWindow",
    "usageColor",
    "last-tool",
    "lastTool",
    "emitLastTool",
    "git-dirty",
    "gitDirty",
    "emitGitDirty",
  ]) {
    assert.doesNotMatch(statuslineSource, new RegExp(dead), `source must not reference ${dead}`);
  }
});

test("emitThinking shows the current reasoning strength at all times", () => {
  // The pill in the tokens-up slot now reflects pi's current thinking level
  // and is always visible (including "off") so the bar always shows what
  // the runtime is configured to do.
  const body = statuslineSource.match(/function emitThinking[\s\S]*?\n\t}/)?.[0] ?? "";
  assert.match(body, /ctx\.thinkingLevel/);
  assert.match(body, /\?\? "off"/);
  assert.match(body, /pi\.events\.emit\("pi-bar:update", \{ id: "thinking", text: level/);
  assert.doesNotMatch(body, /text: undefined/);
  // The thinking_level_select event refreshes the pill; model_select and
  // session_start also probe ctx.thinkingLevel so a stale pill never lingers
  // when the model switch resets thinking to "off".
  assert.match(statuslineSource, /pi\.on\("thinking_level_select"[\s\S]*?emitThinking\(ctx\)/);
  assert.match(statuslineSource, /emitThinking\(ctx\)/);
});

test("right-train drops low-priority segments in order when model risks clipping", () => {
 // Goal-driven pruning hides segments from lowest to highest priority until fit.
 // Order: tokens-down < thinking < context-tokens < messages. model is spared.
 assert.match(statuslineSource, /const SACRIFICE_IDS = \[.*tokens-down.*thinking.*context-tokens.*messages/);
 assert.match(statuslineSource, /function trainNeed\(l: RSeg\[\], r: RSeg\[\]\): number/);
 assert.match(statuslineSource, /for \(const id of SACRIFICE_IDS\)/);
 assert.match(statuslineSource, /left\.splice\(li, 1\)/);
 assert.match(statuslineSource, /right\.splice\(ri, 1\)/);
 assert.match(statuslineSource, /pruneNeed = trainNeed\(left, right\)/);
});
test("shrinkWidest mutates slot fields in place so left/right trains sync", () => {
  // shrinkWidest runs over left.concat(right), which shares element objects;
  // replacing arr[wi] leaves the train arrays untouched, so the shrink must
  // update the object's own fields instead.
  assert.match(statuslineSource, /s\.text = truncateToWidth\(s\.text, tgt, "\\u2026"\);/);
  assert.match(statuslineSource, /s\.width = tgt;/);
  assert.doesNotMatch(statuslineSource, /arr\[wi\] = \{ text: t, width: tgt \};/);
});

test("final line keeps the right (model) end and clips leading overflow", () => {
  // The rendered line's hard width must never clip the model name from the
  // right; overflow is dropped from the left end with an elision mark.
  assert.match(statuslineSource, /function clipKeepRight\(line: string, width: number\): string \{/);
  assert.match(statuslineSource, /return `\$\{ELLIPSIS\}\$\{trailingText\(line, width - 1\)\}`;/);
  // Both renderLine return paths route through clipKeepRight instead of a
  // plain right-truncating truncateToWidth.
  assert.match(statuslineSource, /return clipKeepRight\(`\$\{l\.text\}\$\{" ".repeat\(pad\)\}\$\{r\.text\}`, width\);/);
  assert.match(statuslineSource, /return clipKeepRight\(parts\.join\(""\), width\);/);
  // trailingText decomposes ANSI + cells forward so adjacent SGR escapes are
  // not miscounted as printable cells.
  assert.match(statuslineSource, /function trailingText\(s: string, budget: number\): string \{/);
  assert.match(statuslineSource, /return cells\.slice\(Math\.max\(0, cells\.length - budget\)\)\.join\(""\);/);
});
