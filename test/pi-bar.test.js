import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createStaleSafeEmit, isStaleRuntimeError } from "../plugin/pi-bar/runtime-safety.ts";

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
  assert.match(contextBlock, /id: "context-tokens", text: `\$\{fmtTokens\(u\.tokens\)\}\/\$\{windowText\}`/);
  assert.match(statuslineSource, /left: \["git-branch", "thinking", "context-tokens", "context-usage"\]/);
  assert.match(statuslineSource, /"context-tokens":\s*\[146, 146, 69\]/);
  // gauge fill glyph and thresholds are defined; no empty-trailing glyph.
  assert.match(statuslineSource, /const GAUGE_FILL = "\\u25B0";/);
  assert.doesNotMatch(statuslineSource, /const GAUGE_EMPTY/);
  assert.match(statuslineSource, /const GAUGE_WARN_PCT = 50;/);
  assert.match(statuslineSource, /const GAUGE_HOT_PCT = 75;/);
});

test("context-tokens shows used/window with no 0k placeholder", () => {
  const contextBlock = statuslineSource.match(/function emitContext[\s\S]*?\n\t}/)?.[0] ?? "";
  // Dual value: used tokens over the live contextWindow (e.g. "12k/200k").
  assert.match(contextBlock, /const windowText = fmtTokens\(u\.contextWindow\);/);
  assert.match(contextBlock, /text: `\$\{fmtTokens\(u\.tokens\)\}\/\$\{windowText\}`/);
  // Before the first request the pill carries the Context length alone.
  assert.match(contextBlock, /if \(u\.tokens == null\) \{[\s\S]*?text: windowText/);
  assert.doesNotMatch(contextBlock, /fmtTokens\(0\)/);
  // No model -> no window either: the pill is cleared, not a fake 0.0k.
  assert.match(contextBlock, /if \(!u\) \{[\s\S]*?id: "context-tokens", text: undefined/);
});

test("context pills refresh on /ctx changes and model switches without waiting a turn", () => {
  // pi-companion's /ctx announces the in-place window rewrite on the shared
  // bus; pi-bar listens and recomputes within the same command tick.
  assert.match(statuslineSource, /pi\.events\.on\("pi-companion:context-changed", \(\) => \{/);
  assert.match(statuslineSource, /pi-companion:context-changed"[\s\S]*?if \(currentCtx\) emitContext\(currentCtx\);/);
  // model_select recomputes the context pills too: the window can differ per model.
  assert.match(statuslineSource, /pi\.on\("model_select", async \(_event, ctx\) => \{[\s\S]*?emitContext\(ctx\);/);
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
  assert.match(statuslineSource, /pi\.on\("agent_start"/);
  assert.match(statuslineSource, /emitContext\(ctx\);[\s\S]*?flushIfDirty\(\);/);
  assert.match(statuslineSource, /pi\.on\("agent_settled"/);
});

test("working indicator shows Reimu frames via host API, with a 1s elapsed timer", () => {
  assert.match(statuslineSource, /setWorkingIndicator\(\{ frames: REIMU_FRAMES, intervalMs: REIMU_INTERVAL_MS \}\)/);
  assert.match(statuslineSource, /setWorkingIndicator\(\);/);
  assert.match(statuslineSource, /REIMU_FRAMES/);
  // A 1-second setInterval drives the real-time working-duration display and
  // is scoped to the working row (the balance poll owns the second interval).
  assert.match(statuslineSource, /WORKING_TIMER_INTERVAL_MS = 1000/);
  assert.match(statuslineSource, /setInterval\(tick, WORKING_TIMER_INTERVAL_MS\)/);
  assert.match(statuslineSource, /startWorkingTimer\(\)/);
  assert.match(statuslineSource, /stopWorkingTimer\(\)/);
  assert.doesNotMatch(statuslineSource, /BREATH_FRAMES|WORKING_LIGHT_FRAMES|WORKING_CURSOR_FRAMES|breathTimer/);
  // The elapsed duration is appended to the default "Working..." label,
  // tight (one space) so the time hugs "Working" on the same line.
  assert.match(statuslineSource, /fmtElapsed\(Date\.now\(\) - start\)/);
  assert.match(statuslineSource, /currentCtx\.ui\.setWorkingMessage\(`Working\.\.\. \(\$\{elapsed\}\)`\)/);
  // No stray plugin timer beyond the working-duration and balance intervals.
  assert.match(statuslineSource, /let workingTimerId: ReturnType<typeof setInterval> \| undefined/);
});

test("git-branch shows the branch name via emitGit", () => {
  assert.doesNotMatch(statuslineSource, /displayPath/);
  // git-branch holds the branch name; svn working copies show the "svn" label.
  assert.match(statuslineSource, /emitBarUpdate\(\{ id: "git-branch", text: b, color: "mdHeading" \}\)/);
  assert.match(statuslineSource, /\{ id: "git-branch", text: "svn", color: "mdHeading" \}/);
});

test("isSvn walks up from cwd looking for a .svn directory", () => {
  assert.match(statuslineSource, /function isSvn\(cwd: string\): boolean \{/);
  // Ascent loop with parent assignment and root termination via parent === dir.
  assert.match(statuslineSource, /const parent = dirname\(dir\);[\s\S]*?if \(parent === dir\) break;/);
  assert.match(statuslineSource, /if \(existsSync\(svnDir\) && statSync\(svnDir\)\.isDirectory\(\)\) return true;/);
  // fs/path imports extended for the probe.
  assert.match(statuslineSource, /import \{ existsSync, readdirSync, readFileSync, statSync \} from "node:fs";/);
  assert.match(statuslineSource, /import \{ basename, dirname, isAbsolute, join, resolve \} from "node:path";/);
});

test("emitGit precedence is svn > git > empty", () => {
  const body = statuslineSource.match(/function emitGit[\s\S]*?\n\t}/)?.[0] ?? "";
  // svn checked first and short-circuits before gitBranch.
  assert.match(body, /if \(isSvn\(ctx\.cwd\)\) \{[\s\S]*?return;/);
  // svn shows the "svn" label, git shows the branch name.
  assert.match(body, /emitBarUpdate\(\{ id: "git-branch", text: "svn", color: "mdHeading" \}\)/);
  assert.match(body, /emitBarUpdate\(\{ id: "git-branch", text: b, color: "mdHeading" \}\)/);
  // empty placeholder: both segments cleared (text: undefined) when neither vcs applies; git-dirty was removed entirely.
  assert.match(body, /emitBarUpdate\(\{ id: "git-branch", text: undefined \}\)/);
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
  assert.match(statuslineSource, /emitBarUpdate\(\{ id: "messages", text: `#\$\{msgCount\}`, color: "thinkingMedium" \}\)/);
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
 assert.match(statuslineSource, /emitBarUpdate\(\{ id: "model", text: raw, color: "thinkingHigh" \}\)/);
 assert.doesNotMatch(statuslineSource, /\\u00b7/);
});
test("model segment shows the full unprefixed model id without truncation", () => {
 assert.match(statuslineSource, /emitBarUpdate\(\{ id: "model", text: raw, color: "thinkingHigh" \}\)/);
 assert.doesNotMatch(statuslineSource, /MAX_MODEL_WIDTH/);
});
test("tps segment replaces tokens-down with a tokens-per-second label", () => {
  // tokens-down is fully retired: no update emissions and no palette entry.
  assert.doesNotMatch(statuslineSource, /id: "tokens-down"/);
  // Unknown throughput is not presented as a measured zero.
  assert.match(statuslineSource, /function emitTpsIdle\(ctx: ExtensionContext\): void \{[\s\S]*?emitTps\(ctx, "— t\/s"\);/);
  assert.match(statuslineSource, /pi\.on\("turn_start"[\s\S]*?if \(!tpsBorderLabel\) emitTpsIdle\(ctx\);/);
  assert.match(statuslineSource, /emitThinking\(ctx\);[\s\S]*?emitTpsIdle\(ctx\);/);
  // Only real provider usage may be labelled as token throughput.
  assert.doesNotMatch(statuslineSource, /emitTpsDelta|TPS_SAMPLE_MS|字符\/s|均值 /);
  assert.match(statuslineSource, /\{ id: "tps", text: tpsBorderLabel, color: "text" \}/);
  // The t/s readout is embedded into the input box's TOP border at the left
  // end — no background, label goes through the border colour callback —
  // instead of taking a bar segment or its own widget row.
  assert.match(statuslineSource, /function fitTpsBorder\(label: string, width: number, border: ColorFn\): string \{/);
  assert.match(statuslineSource, /const TPS_BORDER_MIN_GAP = 1;/);
  assert.match(statuslineSource, /let tpsBorderLabel = "";/);
  assert.match(statuslineSource, /tpsBorderLabel = label;/);
  assert.match(statuslineSource, /if \(tpsBorderLabel && stripSgr\(lines\[0\]\) === rule\) \{/);
  assert.match(statuslineSource, /lines\[0\] = fitTpsBorder\(border\(` \$\{tpsBorderLabel\} `\), width, border\);/);
  assert.match(statuslineSource, /split\(s\["left"\], DEFAULTS\.left\.join\(","\)\)\.filter\(\(x\) => x !== "tps" && x !== "balance"\)/);
  // No leftover aboveEditor row: the dedicated widget is fully retired.
  assert.doesNotMatch(statuslineSource, /pi-bar-tps/);
  assert.doesNotMatch(statuslineSource, /renderTpsLine/);
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
  const sessionBody = statuslineSource.match(/function sessionThinkingLevel[\s\S]*?\n\t}/)?.[0] ?? "";
  const body = statuslineSource.match(/function emitThinking[\s\S]*?\n\t}/)?.[0] ?? "";
  assert.match(sessionBody, /ctx\.sessionManager\.getBranch\(\)/);
  assert.match(sessionBody, /thinking_level_change/);
  assert.match(body, /sessionThinkingLevel\(ctx\) \?\? ctx\.thinkingLevel \?\? "off"/);
  assert.match(body, /emitBarUpdate\(\{ id: "thinking", text: level/);
  assert.doesNotMatch(body, /text: undefined/);
  // The thinking_level_select event refreshes the pill; model_select and
  // session_start also probe ctx.thinkingLevel so a stale pill never lingers
  // when the model switch resets thinking to "off".
  assert.match(statuslineSource, /pi\.on\("thinking_level_select"[\s\S]*?emitThinking\(ctx\)/);
  assert.match(statuslineSource, /emitThinking\(ctx\)/);
});

test("right-train drops low-priority segments in order when model risks clipping", () => {
 // Goal-driven pruning hides segments from lowest to highest priority until fit.
 // Order: thinking < context-tokens < messages. model is spared. tps is
 // exempt: it lives on its own aboveEditor row, never in the trains.
 assert.match(statuslineSource, /const SACRIFICE_IDS = \["thinking", "context-tokens", "messages"\] as const;/);
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
  // trailingText now delegates to the grapheme/cell-width tail slicer so wide
  // glyphs and surrogate pairs are never split mid-cluster.
  assert.match(statuslineSource, /function trailingText\(s: string, budget: number\): string \{/);
  assert.match(statuslineSource, /return takeDisplayTail\(s, budget\);/);
});

test("gitBranch resolves from repo subdirectories and git worktrees", async () => {
  const os = await import("node:os");
  const { gitBranch } = await import("../plugin/pi-bar/index.ts");

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bar-git-"));
  try {
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    const subdir = path.join(repo, "packages", "app");
    fs.mkdirSync(subdir, { recursive: true });
    assert.equal(gitBranch(repo), "main");
    assert.equal(gitBranch(subdir), "main");

    // Worktree: .git is a file pointing at the real gitdir.
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bar-wt-"));
    const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bar-gitdir-"));
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/feature-x\n");
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    const wtSub = path.join(worktree, "src");
    fs.mkdirSync(wtSub, { recursive: true });
    assert.equal(gitBranch(worktree), "feature-x");
    assert.equal(gitBranch(wtSub), "feature-x");

    // Detached HEAD shows the short hash; no .git anywhere returns undefined.
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
    assert.equal(gitBranch(repo), "01234567");
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bar-plain-"));
    assert.equal(gitBranch(plain), undefined);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("display-width helpers measure terminal cells, not UTF-16 units", async () => {
  const { displayWidth, truncateDisplayToWidth, takeDisplayTail } = await import("../plugin/pi-bar/display-width.ts");

  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("模型-x"), 6);
  assert.equal(displayWidth("🚀"), 2);
  assert.equal(displayWidth("\x1b[31mab\x1b[0m"), 2);
  assert.equal(displayWidth("é"), 1);
});

test("truncateDisplayToWidth never splits ANSI runs or wide glyphs", async () => {
  const { displayWidth, truncateDisplayToWidth } = await import("../plugin/pi-bar/display-width.ts");

  const colored = "\x1b[38;5;240m模型abc\x1b[0m";
  const cut = truncateDisplayToWidth(colored, 6, "…");
  assert.ok(displayWidth(cut) <= 6);
  assert.ok(cut.startsWith("\x1b[38;5;240m"));
  assert.ok(cut.endsWith("…"));

  const plain = truncateDisplayToWidth("模型abc", 5);
  assert.equal(displayWidth(plain), 5);
});

test("takeDisplayTail never emits lone surrogates for emoji tails", async () => {
  const { takeDisplayTail } = await import("../plugin/pi-bar/display-width.ts");
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  const s = "\x1b[32mabc🚀de\x1b[0m";
  for (let budget = 1; budget <= 7; budget++) {
    const tail = takeDisplayTail(s, budget);
    assert.ok(!lone.test(tail), "lone surrogate at budget " + budget);
  }
  assert.equal(takeDisplayTail(s, 100), s);
});

test("user agent embeds into the editor bottom-right border", () => {
  // UA value: ~/.pi/agent/axum.json is the live source of truth (/ua writes
  // it); AXUM_USER_AGENT env is only its spawn-time snapshot, so the config
  // is re-checked via an mtime-keyed cache that keeps render() allocation-
  // free in the steady state.
  assert.match(statuslineSource, /VERSION: PI_VERSION = "0\.0\.0"/);
  assert.match(statuslineSource, /const UA_TRUNCATE_WIDTH = 40;/);
  assert.match(statuslineSource, /const userAgentConfigPath = join\(agentDir, "axum\.json"\);/);
  assert.match(statuslineSource, /mtime = statSync\(userAgentConfigPath\)\.mtimeMs;/);
  assert.match(statuslineSource, /if \(cachedUserAgent === undefined \|\| mtime !== cachedUserAgentMtime\) \{/);
  assert.match(statuslineSource, /const custom = readConfiguredUserAgent\(\) \?\? process\.env\.AXUM_USER_AGENT;/);
  assert.match(statuslineSource, /cachedUserAgent = custom \|\| `pi\/\$\{PI_VERSION\} \(\$\{process\.platform\}; \$\{runtime\}; \$\{process\.arch\}\)`;/);
  assert.match(statuslineSource, /let cachedUserAgent: string \| undefined;/);

  // Border embedding follows the host's border-status-editor fitBorder
  // pattern: corners + fill run go through the border colour callback, the
  // label shrinks right-to-left on narrow terminals, and an empty label
  // degrades to a plain full-width rule.
  assert.match(statuslineSource, /const UA_BORDER_MIN_GAP = 1;/);
  assert.match(statuslineSource, /function fitUserAgentBorder\(label: string, width: number, border: ColorFn\): string \{/);
  assert.match(statuslineSource, /while \(2 \+ visibleWidth\(text\) \+ UA_BORDER_MIN_GAP > width && visibleWidth\(text\) > 0\)/);
  assert.match(statuslineSource, /text = truncateToWidth\(text, Math\.max\(0, visibleWidth\(text\) - 1\), ""\);/);
  assert.match(statuslineSource, /const gap = Math\.max\(0, width - 2 - visibleWidth\(text\)\);/);

  // Only the idle plain rule lines are rewritten: the t/s label lands on the
  // TOP border (lines[0] exactly), the UA label on the bottom rule found by
  // reverse scan; the ↑/↓ scroll-indicator borders are left untouched, and
  // autocomplete rows still pass through after the border line.
  assert.match(statuslineSource, /override render\(width: number\): string\[\] \{/);
  assert.match(statuslineSource, /const lines = super\.render\(width\);/);
  assert.match(statuslineSource, /function uaShortLabel\(ua: string\): string \{/);
  assert.match(statuslineSource, /const comment = ua\.indexOf\(" \("\);/);
  assert.match(statuslineSource, /return comment > 0 \? ua\.slice\(0, comment\) : ua;/);
  assert.match(statuslineSource, /const ua = truncateToWidth\(uaShortLabel\(getUserAgent\(\)\), UA_TRUNCATE_WIDTH, "…"\);/);
  assert.match(statuslineSource, /if \(width <= 2 \|\| lines\.length < 2\) return lines;/);
  assert.match(statuslineSource, /if \(!ua\) return lines;/);
  assert.match(statuslineSource, /function stripSgr\(text: string\): string \{/);
  assert.match(statuslineSource, /const rule = stripSgr\(border\("─"\.repeat\(width\)\)\);/);
  assert.match(statuslineSource, /if \(stripSgr\(lines\[i\]\) === rule\) \{/);
  assert.match(statuslineSource, /if \(index <= 0\) return lines;/);
  assert.match(statuslineSource, /lines\[index\] = fitUserAgentBorder\(border\(` \$\{ua\} `\), width, border\);/);

  // The built-in footer row is replaced by an empty component (same pattern
  // as the host's border-status-editor example): the status bar already
  // carries everything the footer would show, and the footer UA renderer is
  // gone for good.
  assert.doesNotMatch(statuslineSource, /renderUserAgentFooter/);
  assert.match(statuslineSource, /if \(ctx\.hasUI\) ctx\.ui\.setFooter\(\(\) => \(\{ render: \(\) => \[\], invalidate: \(\) => \{\} \}\)\);/);
  assert.doesNotMatch(statuslineSource, /PALETTE\.ua/);
  assert.doesNotMatch(statuslineSource, /"ua"/);
});

test("header renders context/skills/extensions from the kernel loaded-resources snapshot", () => {
  // Snapshot contract shared with the bundled pi patch (bundled-pi-patches.js):
  // the kernel's showLoadedResources writes globalThis.__axumLoadedResources
  // and invalidates the custom header; renderHeader reads it on every render.
  assert.match(statuslineSource, /type AxumLoadedResources = \{ context\?: string\[\]; skills\?: string\[\]; extensions\?: string\[\] \};/);
  assert.match(statuslineSource, /const globalScope = globalThis as typeof globalThis & \{ __axumLoadedResources\?: AxumLoadedResources \};/);
  assert.match(statuslineSource, /function axumLoadedResources\(\): AxumLoadedResources \{/);
  assert.match(statuslineSource, /return globalScope\.__axumLoadedResources \?\? \{\};/);
  // Context paths abbreviate under ~ like the cwd line does.
  assert.match(statuslineSource, /function abbreviateHome\(p: string\): string \{/);
  assert.match(statuslineSource, /return home && p\.startsWith\(home\) \? `~\$\{p\.slice\(home\.length\)\}` : p;/);
  // Three labeled lists render in load order between cwd and commands; the
  // label column widens to "extensions".
  assert.match(statuslineSource, /const infoLabelWidth = Math\.max\("cwd"\.length, "context"\.length, "skills"\.length, "extensions"\.length, "commands"\.length\);/);
  assert.match(statuslineSource, /const loaded = axumLoadedResources\(\);/);
  assert.match(statuslineSource, /wrapLabeledList\("context"\.padEnd\(infoLabelWidth\), \(loaded\.context \?\? \[\]\)\.map\(abbreviateHome\), listWidth\)/);
  assert.match(statuslineSource, /wrapLabeledList\("skills"\.padEnd\(infoLabelWidth\), loaded\.skills \?\? \[\], listWidth\)/);
  assert.match(statuslineSource, /wrapLabeledList\("extensions"\.padEnd\(infoLabelWidth\), loaded\.extensions \?\? \[\], listWidth\)/);
  // installHeader clears the previous session's snapshot before the kernel
  // patch rewrites it, so /new and reload never flash stale data.
  assert.match(statuslineSource, /globalScope\.__axumLoadedResources = undefined;/);
  // renderHeader no longer takes a skills param: the list comes from the
  // kernel snapshot now, not from the extension-side probe.
  assert.match(statuslineSource, /function renderHeader\(width: number, commands: string\[\] = \[\], cwd\?: string\): string\[\] \{/);
  assert.match(statuslineSource, /cachedLines = renderHeader\(width, commandsCache, headerCwd\);/);
  assert.doesNotMatch(statuslineSource, /renderHeader\(width, skillsCache/);
});

test("Codex status keeps live t/s on an independent row below the editor", async () => {
  const { renderBar } = await import("../plugin/pi-bar/index.ts");
  const segs = new Map([
    ["model", { id: "model", visible: true, text: "模型-long-name" }],
    ["context-usage", { id: "context-usage", visible: true, bar: 28 }],
    ["thinking", { id: "thinking", visible: true, text: "high" }],
    ["tps", { id: "tps", visible: true, text: "12 t/s" }],
  ]);
  const settings = { appearance: "codex", left: ["thinking", "context-usage"], right: ["model"] };
  const rows = renderBar(segs, settings, {}, 100);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^ 12 t\/s/);
  assert.equal(rows[0].indexOf("12 t/s"), 1);
  assert.ok(rows[0].endsWith(" "));
  assert.match(rows[1], /模型-long-name · 72% context left · high/);
  assert.doesNotMatch(rows[1], /t\/s/);
  assert.doesNotMatch(rows[1], /pi\//);
  assert.doesNotMatch(rows.join("\n"), /[\uE0B0\uE0B4\uE0B6]|\x1b\[48/);
  const { displayWidth } = await import("../plugin/pi-bar/display-width.ts");
  const narrow = renderBar(segs, settings, {}, 30);
  assert.match(narrow[0], /^ 12 t\/s/);
  assert.equal(narrow[0].indexOf("12 t/s"), 1);
  assert.match(narrow[1], /72% context left/);
  assert.ok(narrow.every((row) => displayWidth(row) <= 30));
  segs.get("context-usage").bar = undefined;
  assert.match(renderBar(segs, settings, {}, 100)[1], /context unknown/);
});

test("Codex editor preserves cursor marker, wrapping and completion rows", async () => {
  const { DashedBorderEditor } = await import("../plugin/pi-bar/index.ts");
  const { visibleWidth, CURSOR_MARKER } = await import("@earendil-works/pi-tui");
  const editor = new DashedBorderEditor({ terminal: { rows: 24 }, requestRender() {} }, { borderColor: s => s }, { matches: () => false });
  editor.appearance = "codex"; editor.focused = true;
  editor.setText("中文🚀\nsecond");
  editor.autocompleteState = "prefix";
  editor.autocompleteList = { render: () => ["candidate"] };
  const rows = editor.render(18);
  assert.ok(rows[1].startsWith("› ")); assert.ok(rows.join("").includes(CURSOR_MARKER));
  assert.ok(rows.at(-1).startsWith("  candidate"));
  assert.ok(rows.every(row => visibleWidth(row) <= 18));
  assert.doesNotMatch(rows.join(""), /[─╌]/);
  assert.equal(editor.getText(), "中文🚀\nsecond");
  editor.appearance = "classic";
  assert.match(editor.render(18)[0], /╌/);
});

test("Codex row 1 puts t/s left, the Sub2API balance in the middle and the UA right", async () => {
	const { renderBar } = await import("../plugin/pi-bar/index.ts");
	const { visibleWidth } = await import("@earendil-works/pi-tui");
	const segs = new Map([
		["tps", { id: "tps", visible: true, text: "12 t/s" }],
		["balance", { id: "balance", visible: true, text: "$12.34" }],
	]);
	const settings = { appearance: "codex", left: [], right: [] };
	const rows = renderBar(segs, settings, {}, 40);
	// t/s hugs the left margin, the balance sits on the content center, the UA
	// label hugs the right margin.
	assert.equal(rows[0].indexOf("12 t/s"), 1);
	const balanceStart = 1 + Math.floor((40 - 2 - visibleWidth("$12.34")) / 2);
	assert.equal(rows[0].indexOf("$12.34"), balanceStart);
	assert.ok(rows[0].slice(balanceStart + visibleWidth("$12.34")).startsWith("  "));
	const uaText = rows[0].trim().split(/\s{2,}/).at(-1);
	assert.ok(uaText.length > 0);
	assert.ok(!uaText.includes("·"));
	assert.ok(rows[0].endsWith(" "));
	assert.equal(rows[0].length, 40);
	// Without a balance the left t/s and the right UA keep their positions.
	const noBalance = renderBar(new Map([["tps", { id: "tps", visible: true, text: "12 t/s" }]]), settings, {}, 40);
	assert.equal(noBalance[0].indexOf("12 t/s"), 1);
	assert.ok(noBalance[0].trim().split(/\s{2,}/).at(-1).length > 0);
	assert.ok(!noBalance[0].includes("$"));
	// Too narrow: the balance is dropped instead of colliding with its neighbours.
	const narrow = renderBar(segs, settings, {}, 16);
	assert.match(narrow[0], /^ 12 t\/s/);
	assert.ok(!narrow[0].includes("$12.34"));
	assert.ok(narrow[0].trim().split(/\s{2,}/).length >= 2);
});

test("pi-bar probes any provider but only trusts the Sub2API schema", () => {
	const balanceBlock = statuslineSource.match(/function emitBalance[\s\S]*?\n\t}/)?.[0] ?? "";
	assert.match(balanceBlock, /settings\.appearance !== "codex"/);
	assert.match(balanceBlock, /balanceProviderAllowed\(providerId\)/);
	// Auto mode: an empty provider list probes everything, so a new user needs no setup.
	assert.match(statuslineSource, /if \(settings\.balanceProviders\.length === 0\) return true;/);
	assert.match(balanceBlock, /getApiKeyForProvider/);
	assert.match(balanceBlock, /probeSub2ApiBalance\(\{ baseUrl, apiKey \}\)/);
	assert.doesNotMatch(balanceBlock, /console\./);
	assert.match(statuslineSource, /balanceProviders: \[\]/);
	assert.match(statuslineSource, /filter\(\(x\) => x !== "tps" && x !== "balance"\)/);
});

test("balance drains live: turn_end forces a fresh probe and working turns poll", () => {
  // turn_end must bypass the 60s success TTL, or the pill replays the stale
  // balance after a consuming turn.
  assert.match(statuslineSource, /pi\.on\("turn_end", async \(_event, ctx\) => \{[\s\S]*?emitBalance\(ctx, \{ force: true \}\)/);
  // While the agent works the usage endpoint is polled so consumption shows
  // mid-turn; the timer lives exactly between agent_start and agent_settled.
  assert.match(statuslineSource, /const BALANCE_POLL_INTERVAL_MS = 5000;/);
  assert.match(statuslineSource, /let balancePollTimer: ReturnType<typeof setInterval> \| undefined/);
  assert.match(statuslineSource, /pi\.on\("agent_start", async \(_event, ctx\) => \{[\s\S]*?startBalancePolling\(ctx\)/);
  assert.match(statuslineSource, /pi\.on\("agent_settled", async \(_event, ctx\) => \{[\s\S]*?stopBalancePolling\(\)/);
  assert.match(statuslineSource, /pi\.on\("session_shutdown", async \(_event, ctx\) => \{[\s\S]*?stopBalancePolling\(\)/);
  // The forced path rides on the cache's force option, keeping inflight dedupe.
  assert.match(statuslineSource, /\{ force: options\.force, retryFailed: options\.retryFailed \}/);
});

test("stale runtime failures degrade the bar instead of crashing the process", () => {
	const stale = new Error("This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx.");
	assert.equal(isStaleRuntimeError(stale), true);
	assert.equal(isStaleRuntimeError(new Error("network down")), false);

	let staleHits = 0;
	const guarded = createStaleSafeEmit(() => { throw stale; }, () => { staleHits += 1; });
	assert.equal(guarded({ id: "balance", text: undefined }), false);
	assert.equal(staleHits, 1);

	const unexpected = createStaleSafeEmit(() => { throw new Error("boom"); }, () => {});
	assert.throws(() => unexpected({ id: "balance" }), /boom/);
});

test("bar segment updates all pass through the stale-runtime guard", () => {
	const balanceBlock = statuslineSource.match(/async function emitBalance[\s\S]*?\n\t}/)?.[0] ?? "";
	assert.match(balanceBlock, /emitBarUpdate\(/);
	assert.doesNotMatch(balanceBlock, /pi\.events\.emit/);
	// The pending no-model retry is cancelled with the poll so it cannot fire
	// into a replaced session.
	assert.match(statuslineSource, /let balanceRetryTimer: ReturnType<typeof setTimeout> \| undefined/);
	assert.match(statuslineSource, /clearTimeout\(balanceRetryTimer\)/);
});

test("/balance reports why the balance segment stays empty", async () => {
	const mod = await import("../plugin/pi-bar/index.ts");
	const commands = new Map();
	const fakePi = {
		on: () => {},
		events: { emit: () => {}, on: () => () => {} },
		tools: { register: () => {} },
		registerCommand: (name, spec) => commands.set(name, spec),
	};
	mod.default(fakePi);
	const notifications = [];
	const ctx = {
		hasUI: true,
		model: { provider: "demo", baseUrl: "https://127.0.0.1:1/v1" },
		modelRegistry: {
			getProvider: () => ({ baseUrl: "https://127.0.0.1:1/v1" }),
			getApiKeyForProvider: async () => "sk-demo",
		},
		sessionManager: { getBranch: () => [] },
		getContextUsage: () => ({ tokens: 0, contextWindow: 100 }),
		ui: { notify: (message, level) => notifications.push({ message, level }) },
	};
	await commands.get("balance").handler("", ctx);
	assert.equal(notifications.length, 1);
	assert.match(notifications[0].message, /余额不可用/);
	assert.match(notifications[0].message, /provider=demo/);
});


test("throughput shows only t/s from request usage and isolates tools", async (t) => {
  const { default: install } = await import("../plugin/pi-bar/index.ts");
  const handlers = new Map(), labels = [];
  install({ on: (name, fn) => handlers.set(name, fn), registerCommand() {},
    events: { on() {}, emit: (_name, value) => { if (value.id === "tps") labels.push(value.text); } } });
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const ctx = { hasUI: false, getContextUsage: () => undefined };
  const call = (name, message = {}) => handlers.get(name)({ message }, ctx);
  const delta = (type, text) => handlers.get("message_update")({ assistantMessageEvent: { type, delta: text } }, ctx);
  await call("turn_start");
  assert.equal(labels.at(-1), "— t/s");
  await call("message_start", { role: "assistant" });
  await delta("text_delta", "中😀"); now += 250;
  await delta("toolcall_delta", "ab");
  assert.equal(labels.at(-1), "— t/s");
  now = 11000;
  await call("message_end", { role: "assistant", timestamp: 1000, usage: { output: 100, reasoning: 80 }, stopReason: "toolUse" });
  assert.equal(labels.at(-1), "10.0 t/s");
  now += 30000;
  await call("message_end", { role: "toolResult" });
  await call("agent_settled");
  assert.equal(labels.at(-1), "10.0 t/s");
  await call("turn_start");
  await call("message_start", { role: "assistant" });
  await delta("thinking_delta", "abcd"); now += 250;
  await delta("text_delta", "abcd");
  assert.equal(labels.at(-1), "10.0 t/s");
  now = 51000;
  await call("message_end", { role: "assistant", timestamp: 41000, usage: { output: 200 }, stopReason: "stop" });
  assert.equal(labels.at(-1), `${(200 / ((now - 41000) / 1000)).toFixed(1)} t/s`);
  for (const message of [{ usage: { output: 0 } }, { usage: { output: 100 }, stopReason: "error" }, { usage: { output: 100 }, stopReason: "aborted" }]) {
    await call("message_end", { role: "assistant", timestamp: 1000, ...message });
    assert.equal(labels.at(-1), "— t/s");
  }
});
