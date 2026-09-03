import fs from "node:fs";
import path from "node:path";
import { getBundledPiNodeModules } from "./bundled-pi-cache.js";
import { isAndroidLike } from "./bundled-pi-platform.js";

const PI_TUI_PACKAGE = "@earendil-works/pi-tui";
const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const UNBRACKETED_PASTE_PATCH_MARKER = "looksLikeUnbracketedPaste";
const TERMUX_AUTOINSTALL_PATCH_MARKER = "AXUM_TERMUX_AUTOINSTALL";
const UNDICI_MARK_AS_UNCLONEABLE_PATCH_MARKER = "AXUM_UNDICI_MARK_AS_UNCLONEABLE_FALLBACK";
const PI_GOAL_PACKAGE = "@narumitw/pi-goal";
const PI_GOAL_LINKSYNC_FALLBACK_PATCH_MARKER = "AXUM_PI_GOAL_LINKSYNC_FALLBACK";
const PI_GOAL_AUTO_RESUME_PATCH_MARKER = "AXUM_PI_GOAL_AUTO_RESUME";
const PI_VERSION_NOTIFICATION_SUPPRESSED_MARKER = "AXUM_PI_VERSION_NOTIFICATION_SUPPRESSED";
const PI_LOADED_SKILLS_EXTENSIONS_HIDDEN_MARKER = "AXUM_PI_LOADED_SKILLS_EXTENSIONS_HIDDEN";
const PI_STARTUP_CHANGELOG_COLLAPSED_MARKER = "AXUM_PI_STARTUP_CHANGELOG_COLLAPSED";
const PI_JITI_LAZY_LOADER_MARKER = "AXUM_JITI_LAZY_LOADER";
const PI_ALT_SCREEN_SCROLL_ON_SUBMIT_MARKER = "AXUM_PI_ALT_SCREEN_SCROLL_ON_SUBMIT";
const PI_AI_PACKAGE = "@earendil-works/pi-ai";
const PI_RATE_LIMIT_RETRY_EXEMPT_MARKER = "AXUM_PI_429_RETRY_EXEMPT";
const PI_RATE_LIMIT_DISPLAY_SOFTENING_MARKER = "AXUM_PI_429_DISPLAY_SOFTENING";
const PI_422_RETRYABLE_MARKER = "AXUM_PI_422_RETRYABLE";
const PI_HTTP_IDLE_TIMEOUT_PATCH_MARKER = "AXUM_PI_HTTP_IDLE_TIMEOUT_120S";
const PI_HTTP_IDLE_TIMEOUT_LEGACY_MARKER = "AXUM_PI_HTTP_IDLE_TIMEOUT_45S";
const PI_ERROR_DEDUP_MARKER = "AXUM_PI_ERROR_DEDUP";
const PI_ASSISTANT_ERROR_DEDUP_MARKER = "AXUM_PI_ASSISTANT_ERROR_DEDUP";
// Strict 429 shape: only an error message that *starts* with the HTTP status
// (e.g. `Error: 429: {"message":"Too Many Requests"}`) counts as provider
// throttling; incidental occurrences of the digits 429 must never match.
const PI_RATE_LIMIT_429_PATTERN_SOURCE = "^\\s*(?:Error:\\s*)?429[:\\s]";

function packageDirName(packageName) {
  if (packageName.startsWith("@")) {
    const [scope, name] = packageName.split("/");
    return path.join(scope, name);
  }
  return packageName;
}

function resolveBundledPackageRoot(packageName, options) {
  return path.join(getBundledPiNodeModules(options), packageDirName(packageName));
}

function patchPiTuiStdinBuffer(content) {
  if (content.includes(UNBRACKETED_PASTE_PATCH_MARKER)) return content;

  const constantsNeedle = 'const BRACKETED_PASTE_END = "\\x1b[201~";\n';
  if (!content.includes(constantsNeedle)) {
    throw new Error("unable to patch bundled Pi TUI stdin buffer: paste constants not found");
  }

  let patched = content.replace(
    constantsNeedle,
    `${constantsNeedle}\nfunction looksLikeUnbracketedPaste(data) {\n    if (data.length <= 1 || data.includes(ESC))\n        return false;\n    return data.includes("\\n") || data.includes("\\r") || data.length > 100;\n}\n`,
  );

  const processNeedle = `        if (str.length === 0 && this.buffer.length === 0) {\n            this.emitDataSequence("");\n            return;\n        }\n`;
  if (!patched.includes(processNeedle)) {
    throw new Error("unable to patch bundled Pi TUI stdin buffer: process insertion point not found");
  }

  patched = patched.replace(
    processNeedle,
    `        if (!this.pasteMode && this.buffer.length === 0 && !str.includes(BRACKETED_PASTE_START) && looksLikeUnbracketedPaste(str)) {\n            this.pendingKittyPrintableCodepoint = undefined;\n            this.emit("paste", str);\n            return;\n        }\n\n${processNeedle}`,
  );

  return patched;
}

function patchUndiciMarkAsUncloneableFallback(content) {
  if (content.includes(UNDICI_MARK_AS_UNCLONEABLE_PATCH_MARKER)) return content;

  const needle = "webidl.util.markAsUncloneable = markAsUncloneable\n";
  if (!content.includes(needle)) {
    throw new Error("unable to patch bundled undici webidl: markAsUncloneable assignment not found");
  }

  return content.replace(
    needle,
    "webidl.util.markAsUncloneable = markAsUncloneable || (() => {}) // AXUM_UNDICI_MARK_AS_UNCLONEABLE_FALLBACK\n",
  );
}

function patchTermuxAutoInstall(content) {
  if (content.includes(TERMUX_AUTOINSTALL_PATCH_MARKER)) return content;

  const needle = [
    '    if (platform() === "android") {',
    '        const pkgName = TERMUX_PACKAGES[tool] ?? tool;',
    '        onStatus?.({ type: "warning", message: `${config.name} not found. Install with: pkg install ${pkgName}` });',
    '        return undefined;',
    '    }',
  ].join("\n");
  if (!content.includes(needle)) {
    // Upstream tools-manager may lack the Android install block (e.g. newer Pi
    // versions or a stub). The auto-install patch is a UX nicety, not a core
    // need, so skip it instead of hard-failing startup.
    return content;
  }

  const replacement = [
    '    if (platform() === "android") { // AXUM_TERMUX_AUTOINSTALL',
    '        const pkgName = TERMUX_PACKAGES[tool] ?? tool;',
    '        try {',
    '            const result = spawnSync("pkg", ["install", "-y", pkgName], { stdio: "inherit" });',
    '            if ((result.status ?? 1) === 0) {',
    '                const resolved = getToolPath(tool);',
    '                if (resolved) return resolved;',
    '            }',
    '        } catch (e) {',
    '            onStatus?.({ type: "warning", message: `Failed to auto-install ${config.name}: ${e instanceof Error ? e.message : e}` });',
    '        }',
    '        onStatus?.({ type: "warning", message: `${config.name} not found. Install with: pkg install ${pkgName}` });',
    '        return undefined;',
    '    }',
  ].join("\n");
  return content.replace(needle, replacement);
}

function patchPiGoalLinkSyncFallback(content) {
  if (content.includes(PI_GOAL_LINKSYNC_FALLBACK_PATCH_MARKER)) return content;

  const T = "\t";
  const needle = [
    "\n" + T + T + "try {",
    T + T + T + "fs.linkSync(temporaryPath, settingsPath);",
    T + T + "} catch (error) {",
    T + T + T + "if (!isAlreadyExistsError(error)) throw error;",
    T + T + "}",
    "\n",
  ].join("\n");
  if (!content.includes(needle)) {
    // Upstream pi-goal settings init may reshape this linkSync block in a
    // future version. The fallback only suppresses a startup warning on
    // Android/Termux where hard links are denied, so skip it instead of
    // hard-failing startup when the block shape changes.
    return content;
  }

  const replacement = [
    "\n" + T + T + "try {",
    T + T + T + "fs.linkSync(temporaryPath, settingsPath);",
    T + T + "} catch (error) {",
    T + T + T + "// " + PI_GOAL_LINKSYNC_FALLBACK_PATCH_MARKER,
    T + T + T + "if (isAlreadyExistsError(error)) {",
    T + T + T + T + "// Another process won the race; reuse the existing settings.",
    T + T + T + "} else {",
    T + T + T + T + "try {",
    T + T + T + T + T + "fs.writeFileSync(settingsPath, DEFAULT_GOAL_SETTINGS_DOCUMENT, {",
    T + T + T + T + T + T + "encoding: \"utf8\",",
    T + T + T + T + T + T + "flag: \"wx\",",
    T + T + T + T + T + "});",
    T + T + T + T + "} catch (fallbackError) {",
    T + T + T + T + T + "if (!isAlreadyExistsError(fallbackError)) throw fallbackError;",
    T + T + T + T + "}",
    T + T + T + "}",
    T + T + "}",
    "\n",
  ].join("\n");

  return content.replace(needle, replacement);
}

/**
 * Make pi-goal auto-resume when the automatic-run checkpoint pause would
 * fire. pi-goal intentionally pauses at `continuationLimits.automaticTurns`
 * (default 25) and aborts the turn so the human must run `/goal resume` to
 * continue. For Axum's autonomous /goal workflow this leaves long goals
 * silently stalled at the "Warning: Goal paused: 25 automatic model
 * responses; ... Run /goal resume to continue" prompt.
 *
 * This patch rewires `pauseGoalForSafety` so `continuation_limit` and
 * `no_progress` safety pauses reset their matching counters, keep the goal
 * active, and dispatch a follow-up continuation in place. The net effect is
 * exactly "auto-send /goal resume when the pause prompt appears", so goals run
 * to completion without manual intervention for the two automatic-run
 * checkpoints that otherwise surface `Run /goal resume to continue`. Other
 * pause causes (user abort, usage limits) are untouched.
 *
 * The behavior honors `settings.autoResumeOnContinuationLimit` and
 * `settings.autoResumeOnNoProgress`; absent fields default to enabled so new
 * users get autonomy without any config. Set either to false to restore the
 * upstream pause-and-require-manual-resume semantics for that cause. For the
 * two automatic-run checkpoints (`continuation_limit` and `no_progress`) the
 * auto-resume fires unconditionally whenever enabled, so goals never display
 * the upstream pause-and-require-manual-resume prompt.
 */
function patchPiGoalAutoResume(content) {
  const T = "\t";
  const needle = [
    T + "if (goal?.status !== \"active\") return false;",
    T + T + "this.cancelContinuationWork();",
    T + T + "this.clearGoalRecoveryForGoal(goal.id);",
    T + T + "this.clearBudgetWrapUp();",
    T + T + "this.blockStaleGoalToolCalls();",
  ].join("\n");

  const branch = [
    T + "if (goal?.status !== \"active\") return false;",
    T + T + "// " + PI_GOAL_AUTO_RESUME_PATCH_MARKER + ": auto-resume automatic-run",
    T + T + "// checkpoint pauses instead of requiring manual /goal resume. Absent",
    T + T + "// settings default to enabled; set autoResumeOnContinuationLimit=false",
    T + T + "// or autoResumeOnNoProgress=false to restore upstream pause behavior.",
    T + T + "if (cause === \"continuation_limit\" || cause === \"no_progress\") {",
    T + T + T + "const isNoProgress = cause === \"no_progress\";",
    T + T + T + "const autoResumeEnabled = isNoProgress ? this.settings?.autoResumeOnNoProgress !== false : this.settings?.autoResumeOnContinuationLimit !== false;",
    T + T + T + "if (autoResumeEnabled) {",
    T + T + T + T + "const countKey = isNoProgress ? \"axumNoProgressAutoResumeCount\" : \"axumAutoResumeCount\";",
    T + T + T + T + "this.cancelContinuationWork();",
    T + T + T + T + "this.clearGoalRecoveryForGoal(goal.id);",
    T + T + T + T + "this.clearBudgetWrapUp();",
    T + T + T + T + "if (isNoProgress) {",
    T + T + T + T + T + "goal.toolFreeRepeatCount = 0;",
    T + T + T + T + T + T + "goal.lastToolFreeOutputFingerprint = undefined;",
    T + T + T + T + T + "} else {",
    T + T + T + T + T + T + "goal.automaticModelTurns = 0;",
    T + T + T + T + T + "}",
    T + T + T + T + "const autoResumeCount = Math.max(0, Math.floor(Number((goal as any)[countKey] ?? 0)));",
    T + T + T + T + "(goal as any)[countKey] = autoResumeCount + 1;",
    T + T + T + T + "this.persistGoal(goal);",
    T + T + T + T + "this.updateStatus(ctx, goal);",
    T + T + T + T + "const checkpoint = isNoProgress ? \"no-progress checkpoint\" : \"automatic-turns checkpoint\";",
    T + T + T + T + "this.setTerminalReason(goal.id, `auto-resumed at ${checkpoint}`);",
    T + T + T + T + "ctx.ui.notify(`Goal reached the ${checkpoint}; auto-resumed without pausing.`, \"info\");",
    T + T + T + T + "this.requestContinuation(goal);",
    T + T + T + T + "this.dispatchContinuationIfSettled(ctx);",
    T + T + T + T + "return false;",
    T + T + T + "}",
    T + T + "}",
    T + T + "this.cancelContinuationWork();",
    T + T + "this.clearGoalRecoveryForGoal(goal.id);",
    T + T + "this.clearBudgetWrapUp();",
    T + T + "this.blockStaleGoalToolCalls();",
  ].join("\n");

  if (content.includes(PI_GOAL_AUTO_RESUME_PATCH_MARKER)) {
    if (content.includes("autoResumeOnNoProgress")) return content;
    const start = content.lastIndexOf(T + "if (goal?.status !== \"active\") return false;", content.indexOf(PI_GOAL_AUTO_RESUME_PATCH_MARKER));
    const endNeedle = T + T + "this.blockStaleGoalToolCalls();";
    const end = content.indexOf(endNeedle, start);
    if (start >= 0 && end >= 0) {
      return content.slice(0, start) + branch + content.slice(end + endNeedle.length);
    }
    return content;
  }

  if (!content.includes(needle)) return content;
  return content.replace(needle, branch);
}

function patchPiJitiLazyLoader(content) {
  if (content.includes(PI_JITI_LAZY_LOADER_MARKER)) return content;

  const staticImportNeedle = 'import { createJiti } from "jiti/static";\n';
  if (!content.includes(staticImportNeedle)) return content;

  const createJitiNeedle = "    const jiti = createJiti(import.meta.url, {\n";
  if (!content.includes(createJitiNeedle)) return content;

  const nativeFastPath = [
    "    // " + PI_JITI_LAZY_LOADER_MARKER + ": plain-JS entries skip jiti entirely; defer jiti/babel until a TS entry needs it.",
    "    if (!extensionPath.endsWith(\".ts\")) {",
    "        const nativeModule = await import(\"node:url\").then((u) => u.pathToFileURL(extensionPath)).then((u) => import(u.href));",
    "        const nativeFactory = nativeModule?.default;",
    "        if (typeof nativeFactory === \"function\") {",
    "            if (isCurrentCacheToken(cacheToken)) extensionCache.set(extensionPath, nativeFactory);",
    "            return nativeFactory;",
    "        }",
    "        return undefined;",
    "    }",
    "    // " + PI_JITI_LAZY_LOADER_MARKER + ": defer jiti/babel loading until a TS extension needs it.",
    "    const { createJiti } = await import(\"jiti/static\");",
    "",
  ].join("\n");

  return content
    .replace(staticImportNeedle, "")
    .replace(createJitiNeedle, nativeFastPath + createJitiNeedle);
}

// Scroll the fullscreen transcript to the bottom on every editor submit. The
// alt-screen ScrollView drops followEnd as soon as the user scrolls up, and
// upstream never re-engages it on submit, so pressing Enter after reading
// earlier history leaves the viewport frozen. Re-anchoring on submit mirrors
// the /pi-agent viewer fix in a382ff6; passive streaming output still keeps
// the user's scroll position because the ScrollView follow logic is untouched.
function patchPiAltScreenScrollOnSubmit(content) {
  if (content.includes(PI_ALT_SCREEN_SCROLL_ON_SUBMIT_MARKER)) return content;

  const needle = "            if (!text)\n                return;\n";
  if (!content.includes(needle)) return content;
  const injection =
    "            // " + PI_ALT_SCREEN_SCROLL_ON_SUBMIT_MARKER + ": Enter re-anchors the fullscreen transcript to the latest message.\n" +
    "            if (this.renderer instanceof TuiAltScreen) this.renderer.scrollToBottom();\n";
  return content.replace(needle, needle + injection);
}

function patchPiVersionNotificationSuppress(content) {
  if (content.includes(PI_VERSION_NOTIFICATION_SUPPRESSED_MARKER)) return content;

  const I = "        ";
  const needle = [
    I + "// Start version check asynchronously",
    I + "checkForNewPiVersion(this.version).then((newRelease) => {",
    I + "    if (newRelease) {",
    I + "        this.showNewVersionNotification(newRelease);",
    I + "    }",
    I + "});",
  ].join("\n");
  if (!content.includes(needle)) {
    // Upstream interactive-mode may restructure the version check in a future
    // release. Suppression is a UX preference, not a correctness need, so skip
    // it instead of hard-failing startup when the block shape changes.
    return content;
  }

  const replacement = [
    I + "// Start version check asynchronously",
    I + "// " + PI_VERSION_NOTIFICATION_SUPPRESSED_MARKER + ": Axum pins the bundled Pi",
    I + "// version for the bundled runtime, so the upstream \"update available\" notice",
    I + "// for a newer npm release is noise here. Keep the check running (for any",
    I + "// side effects) but skip the notification render.",
    I + "checkForNewPiVersion(this.version).then((newRelease) => {",
    I + "    void newRelease;",
    I + "});",
  ].join("\n");

  return content.replace(needle, replacement);
}


/**
 * Lower the bundled HTTP idle timeout default. An upstream-cancelled stream
 * whose socket is never closed (common behind relays and proxies) keeps the
 * SSE read blocked until undici bodyTimeout fires; the stock 300s default hid
 * an already-cancelled generation for five minutes before any retry fired.
 * The original 45s patch surfaced the `Body Timeout Error` promptly but proved
 * too aggressive for long-thinking providers whose relays buffer the reasoning
 * phase without streaming bytes: a stream silent for 45s was aborted, the relay
 * reported `client disconnected: context canceled`, and pi bounced the request
 * into a retry. 120s (matching the 2min `httpIdleTimeoutMs` option) keeps the
 * fail-fast property while tolerating silent thinking phases; the `timeout`
 * keyword still routes that error into the connection-error lane (fixed 5s
 * cadence, no retry-budget drain). Relays that buffer entire generations
 * should raise `httpIdleTimeoutMs` further. Existing caches that already carry
 * the legacy 45s patch are upgraded in place.
 */
function patchPiHttpIdleTimeoutDefault(content) {
  if (content.includes(PI_HTTP_IDLE_TIMEOUT_PATCH_MARKER)) return content;

  if (content.includes(PI_HTTP_IDLE_TIMEOUT_LEGACY_MARKER)) {
    return content
      .replace(PI_HTTP_IDLE_TIMEOUT_LEGACY_MARKER, PI_HTTP_IDLE_TIMEOUT_PATCH_MARKER)
      .replace("export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 45_000;", "export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 120_000;");
  }

  const needle = "export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;";
  if (!content.includes(needle)) {
    throw new Error("unable to patch bundled Pi http dispatcher: idle timeout default anchor not found");
  }

  return content.replace(
    needle,
    [
      `// ${PI_HTTP_IDLE_TIMEOUT_PATCH_MARKER}: upstream-cancelled streams that never close must`,
      `// fail fast; stock default was 300s. Streams silent for 120s surface as a`,
      `// body-timeout error routed into the connection-retry lane. Long-thinking`,
      `// providers with silent phases may need a higher httpIdleTimeoutMs override.`,
      `export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 120_000;`,
    ].join("\n"),
  );
}
/**
 * Hide the duplicate `[Skills]` / `[Extensions]` sections that Pi's
 * `showLoadedResources` prints in the startup banner. Axum's SAKURA CYBERDECK
 * header already frames these same lists in sakura cards, so leaving Pi's plain
 * `[Skills] find-skills, impeccable` / `[Extensions] pi-bar, pi-header, ...` lines
 * would render the information twice. Conflicts/diagnostics are untouched.
 */
function patchPiLoadedSkillsExtensionsHide(content) {
  if (content.includes(PI_LOADED_SKILLS_EXTENSIONS_HIDDEN_MARKER)) return content;

  // Skills listing block:
  //   const skills = skillsResult.skills;
  //   if (skills.length > 0) { ... addLoadedSection("Skills", skillCompactList, skillList); }
  const skillsBlockNeedle = [
    "            const skills = skillsResult.skills;",
    "            if (skills.length > 0) {",
    "                const groups = this.buildScopeGroups(skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })));",
    "                const skillList = this.formatScopeGroups(groups, {",
    "                    formatPath: (item) => this.formatDisplayPath(item.path),",
    "                    formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),",
    "                });",
    "                const skillCompactList = formatCompactList(skills.map((skill) => skill.name));",
    "                addLoadedSection(\"Skills\", skillCompactList, skillList);",
    "            }",
  ].join("\n");

  // Extensions listing block:
  //   if (extensions.length > 0) { ... addLoadedSection("Extensions", extensionCompactList, extList, "mdHeading"); }
  const extensionsBlockNeedle = [
    "            if (extensions.length > 0) {",
    "                const groups = this.buildScopeGroups(extensions);",
    "                const extList = this.formatScopeGroups(groups, {",
    "                    formatPath: (item) => this.formatExtensionDisplayPath(item.path),",
    "                    formatPackagePath: (item) => this.formatExtensionDisplayPath(this.getShortPath(item.path, item.sourceInfo)),",
    "                });",
    "                const extensionCompactList = formatCompactList(this.getCompactExtensionLabels(extensions));",
    "                addLoadedSection(\"Extensions\", extensionCompactList, extList, \"mdHeading\");",
    "            }",
  ].join("\n");

  if (!content.includes(skillsBlockNeedle) || !content.includes(extensionsBlockNeedle)) {
    // Upstream interactive-mode may restructure the loaded-resources section in a
    // future release. Hiding is a dedup UX preference, not a correctness need, so
    // skip it instead of hard-failing startup when the block shape changes.
    return content;
  }

  // Keep `const skills = skillsResult.skills;` so later diagnostic code (which may
  // reference `skills`) still resolves; only drop the listing `if`-block.
  const skillsReplacement = [
    "            const skills = skillsResult.skills;",
    "            // " + PI_LOADED_SKILLS_EXTENSIONS_HIDDEN_MARKER + ": Skills listing moved into the SAKURA CYBERDECK header.",
    "            void skills;",
  ].join("\n");
  const extensionsReplacement = [
    "            // " + PI_LOADED_SKILLS_EXTENSIONS_HIDDEN_MARKER + ": Extensions listing moved into the SAKURA CYBERDECK header.",
  ].join("\n");

  return content
    .replace(skillsBlockNeedle, skillsReplacement)
    .replace(extensionsBlockNeedle, extensionsReplacement);
}

/**
 * Pi renders the full bundled changelog during interactive startup when the
 * `collapseChangelog` setting is off. The complete multi-release body is noise
 * in a pinned bundled runtime, so force the condensed one-line summary always,
 * matching the `collapseChangelog=true` path. `/changelog` (a separate handler)
 * is untouched so the full text stays on demand.
 */
function patchPiStartupChangelogCollapse(content) {
  if (content.includes(PI_STARTUP_CHANGELOG_COLLAPSED_MARKER)) return content;

  const needle = [
    "        if (this.settingsManager.getCollapseChangelog()) {",
    "            const versionMatch = this.changelogMarkdown.match(/##\\s+\\[?(\\d+\\.\\d+\\.\\d+)\\]?/);",
    "            const latestVersion = versionMatch ? versionMatch[1] : this.version;",
    "            const condensedText = `Updated to v${latestVersion}. Use ${theme.bold(\"/changelog\")} to view full changelog.`;",
    "            this.chatContainer.addChild(new Text(condensedText, 1, 0));",
    "        }",
    "        else {",
    "            this.chatContainer.addChild(new Text(theme.bold(theme.fg(\"accent\", \"What's New\")), 1, 0));",
    "            this.chatContainer.addChild(new Spacer(1));",
    "            this.chatContainer.addChild(new Markdown(this.changelogMarkdown.trim(), 1, 0, this.getMarkdownThemeWithSettings()));",
    "            this.chatContainer.addChild(new Spacer(1));",
    "        }",
  ].join("\n");
  if (!content.includes(needle)) {
    // Upstream interactive-mode may restructure the startup notices block. The
    // condensed line is a UX preference, not correctness, so skip on shape change.
    return content;
  }

  const replacement = [
    "        // " + PI_STARTUP_CHANGELOG_COLLAPSED_MARKER + ": always condensed; full body on /changelog.",
    "        const versionMatch = this.changelogMarkdown.match(/##\\s+\\[?(\\d+\\.\\d+\\.\\d+)\\]?/);",
    "        const latestVersion = versionMatch ? versionMatch[1] : this.version;",
    "        const condensedText = `Updated to v${latestVersion}. Use ${theme.bold(\"/changelog\")} to view full changelog.`;",
    "        this.chatContainer.addChild(new Text(condensedText, 1, 0));",
  ].join("\n");
  return content.replace(needle, replacement);
}

// Helpers injected into bundled Pi sources; shared by the pi-ai retry loop and
// the AgentSession retry driver so both layers treat strict 429s identically.
function buildRateLimitRetryHelpers() {
  return [
    `// ${PI_RATE_LIMIT_RETRY_EXEMPT_MARKER}: strict 429 rate-limit errors retry on a`,
    "// fixed cadence with a dedicated counter so provider throttling never",
    "// consumes the user-configured retry budget.",
    "const RATE_LIMIT_DELAY_MS = 5000;",
    "const RATE_LIMIT_MAX_ATTEMPTS = 30;",
    "const RETRY_JITTER_MS = 1500;",
    "function jitteredDelay(baseMs) {",
    "    return baseMs + Math.floor(Math.random() * RETRY_JITTER_MS);",
    "}",
    "function isRateLimit429Error(errorMessage) {",
    `    return typeof errorMessage === \"string\" && /${PI_RATE_LIMIT_429_PATTERN_SOURCE}/.test(errorMessage);`,
    "}",
    "",
  ].join("\n");
}

function patchPiAiRateLimitRetry(content) {
  if (content.includes(PI_RATE_LIMIT_RETRY_EXEMPT_MARKER)) return content;

  const helperAnchor = "class RetrySleepAbortError extends Error {\n";
  if (!content.includes(helperAnchor)) {
    throw new Error("unable to patch bundled pi-ai retry loop: RetrySleepAbortError anchor not found");
  }
  let patched = content.replace(helperAnchor, buildRateLimitRetryHelpers() + helperAnchor);

  const stateNeedle = "    let attempt = 0;\n    let lastRetry;\n";
  if (!patched.includes(stateNeedle)) {
    throw new Error("unable to patch bundled pi-ai retry loop: attempt counter anchor not found");
  }
  patched = patched.replace(stateNeedle, stateNeedle + "    let rateLimitAttempt = 0;\n");

  const decisionNeedle = [
    "        // Non-retryable, or budget exhausted: return the final error message.",
    "        if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {",
    "            if (lastRetry)",
    "                await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);",
    "            return response;",
    "        }",
    "        attempt++;",
    "        lastRetry = { attempt, errorMessage: response.errorMessage || \"Unknown error\" };",
    "        const delayMs = policy.baseDelayMs * 2 ** (attempt - 1);",
    "        await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);",
  ].join("\n");
  if (!patched.includes(decisionNeedle)) {
    throw new Error("unable to patch bundled pi-ai retry loop: retry decision anchor not found");
  }
  const decisionReplacement = [
    "        // Non-retryable, or budget exhausted: return the final error message.",
    "        if (!isRetryableAssistantError(response)) {",
    "            if (lastRetry)",
    "                await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);",
    "            return response;",
    "        }",
    "        let delayMs;",
    "        let scheduledMaxAttempts;",
    "        if (isRateLimit429Error(response.errorMessage)) {",
    "            if (rateLimitAttempt >= (policy?.enabled ? RATE_LIMIT_MAX_ATTEMPTS : 0)) {",
    "                if (lastRetry)",
    "                    await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);",
    "                return response;",
    "            }",
    "            rateLimitAttempt++;",
    "            lastRetry = { attempt: rateLimitAttempt, errorMessage: response.errorMessage || \"Unknown error\" };",
    "            delayMs = jitteredDelay(RATE_LIMIT_DELAY_MS);",
    "            scheduledMaxAttempts = RATE_LIMIT_MAX_ATTEMPTS;",
    "        }",
    "        else {",
    "            if (attempt >= maxAttempts) {",
    "                if (lastRetry)",
    "                    await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);",
    "                return response;",
    "            }",
    "            attempt++;",
    "            lastRetry = { attempt, errorMessage: response.errorMessage || \"Unknown error\" };",
    "            delayMs = policy.baseDelayMs;",
    "            scheduledMaxAttempts = maxAttempts;",
    "        }",
    "        await callbacks?.onRetryScheduled?.(lastRetry.attempt, scheduledMaxAttempts, delayMs, lastRetry.errorMessage);",
  ].join("\n");
  patched = patched.replace(decisionNeedle, decisionReplacement);

  const abortEmitNeedle = "            await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);";
  if (!patched.includes(abortEmitNeedle)) {
    throw new Error("unable to patch bundled pi-ai retry loop: abort emit anchor not found");
  }
  patched = patched.replace(abortEmitNeedle, "            await callbacks?.onRetryFinished?.(false, lastRetry.attempt, lastRetry.errorMessage);");

  return patched;
}

function patchPiAgentSessionRateLimitRetry(content) {
  if (content.includes(PI_RATE_LIMIT_RETRY_EXEMPT_MARKER)) return content;

  const classAnchor = "export class AgentSession {"; 
  if (!content.includes(classAnchor)) {
    throw new Error("unable to patch bundled Pi agent session retry: class anchor not found");
  }
  let patched = content.replace(classAnchor, buildRateLimitRetryHelpers() + classAnchor);

  const fieldNeedle = "    _retryAttempt = 0;\n";
  if (!patched.includes(fieldNeedle)) {
    throw new Error("unable to patch bundled Pi agent session retry: retry counter field anchor not found");
  }
  patched = patched.replace(fieldNeedle, fieldNeedle + "    _rateLimitRetryAttempt = 0;\n");

  const successResetNeedle = [
    "                if (assistantMsg.stopReason !== \"error\" && this._retryAttempt > 0) {",
    "                    this._emit({",
    "                        type: \"auto_retry_end\",",
    "                        success: true,",
    "                        attempt: this._retryAttempt,",
    "                    });",
    "                    this._retryAttempt = 0;",
    "                }",
  ].join("\n");
  const successResetReplacement = [
    "                if (assistantMsg.stopReason !== \"error\" && (this._retryAttempt > 0 || this._rateLimitRetryAttempt > 0)) {",
    "                    this._emit({",
    "                        type: \"auto_retry_end\",",
    "                        success: true,",
    "                        attempt: this._retryAttempt + this._rateLimitRetryAttempt,",
    "                    });",
    "                    this._retryAttempt = 0;",
    "                    this._rateLimitRetryAttempt = 0;",
    "                }",
  ].join("\n");
  if (!patched.includes(successResetNeedle)) {
    throw new Error("unable to patch bundled Pi agent session retry: success reset anchor not found");
  }
  patched = patched.replace(successResetNeedle, successResetReplacement);

  const failureResetNeedle = [
    "        if (msg.stopReason === \"error\" && this._retryAttempt > 0) {",
    "            this._emit({",
    "                type: \"auto_retry_end\",",
    "                success: false,",
    "                attempt: this._retryAttempt,",
    "                finalError: msg.errorMessage,",
    "            });",
    "            this._retryAttempt = 0;",
    "        }",
  ].join("\n");
  const failureResetReplacement = [
    "        if (msg.stopReason === \"error\" && (this._retryAttempt > 0 || this._rateLimitRetryAttempt > 0)) {",
    "            this._emit({",
    "                type: \"auto_retry_end\",",
    "                success: false,",
    "                attempt: this._retryAttempt + this._rateLimitRetryAttempt,",
    "                finalError: msg.errorMessage,",
    "            });",
    "            this._retryAttempt = 0;",
    "            this._rateLimitRetryAttempt = 0;",
    "        }",
  ].join("\n");
  if (!patched.includes(failureResetNeedle)) {
    throw new Error("unable to patch bundled Pi agent session retry: failure reset anchor not found");
  }
  patched = patched.replace(failureResetNeedle, failureResetReplacement);

  const willRetryNeedle = [
    "        const settings = this.settingsManager.getRetrySettings();",
    "        if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {",
    "            return false;",
    "        }",
    "        for (let i = event.messages.length - 1; i >= 0; i--) {",
    "            const message = event.messages[i];",
    "            if (message.role === \"assistant\") {",
    "                return this._isRetryableError(message);",
    "            }",
    "        }",
    "        return false;",
  ].join("\n");
  const willRetryReplacement = [
    "        const settings = this.settingsManager.getRetrySettings();",
    "        if (!settings.enabled) {",
    "            return false;",
    "        }",
    "        for (let i = event.messages.length - 1; i >= 0; i--) {",
    "            const message = event.messages[i];",
    "            if (message.role === \"assistant\") {",
    "                if (isRateLimit429Error(message.errorMessage)) {",
    "                    return this._isRetryableError(message) && this._rateLimitRetryAttempt < RATE_LIMIT_MAX_ATTEMPTS;",
    "                }",
    "                if (this._retryAttempt >= settings.maxRetries) {",
    "                    return false;",
    "                }",
    "                return this._isRetryableError(message);",
    "            }",
    "        }",
    "        return false;",
  ].join("\n");
  if (!patched.includes(willRetryNeedle)) {
    throw new Error("unable to patch bundled Pi agent session retry: agent-end retry gate anchor not found");
  }
  patched = patched.replace(willRetryNeedle, willRetryReplacement);

  const prepareNeedle = [
    "        this._retryAttempt++;",
    "        if (this._retryAttempt > settings.maxRetries) {",
    "            // Preserve the completed attempt count so post-run handling can emit the final failure.",
    "            this._retryAttempt--;",
    "            return false;",
    "        }",
    "        const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);",
    "        this._emit({",
    "            type: \"auto_retry_start\",",
    "            attempt: this._retryAttempt,",
    "            maxAttempts: settings.maxRetries,",
    "            delayMs,",
    "            errorMessage: message.errorMessage || \"Unknown error\",",
    "        });",
  ].join("\n");
  const prepareReplacement = [
    "        let attempt;",
    "        let delayMs;",
    "        let maxAttempts;",
    "        if (isRateLimit429Error(message.errorMessage)) {",
    "            if (this._rateLimitRetryAttempt >= RATE_LIMIT_MAX_ATTEMPTS) {",
    "                return false;",
    "            }",
    "            this._rateLimitRetryAttempt++;",
    "            attempt = this._rateLimitRetryAttempt;",
    "            maxAttempts = RATE_LIMIT_MAX_ATTEMPTS;",
    "            delayMs = jitteredDelay(RATE_LIMIT_DELAY_MS);",
    "        }",
    "        else {",
    "            this._retryAttempt++;",
    "            if (this._retryAttempt > settings.maxRetries) {",
    "                // Preserve the completed attempt count so post-run handling can emit the final failure.",
    "                this._retryAttempt--;",
    "                return false;",
    "            }",
    "            attempt = this._retryAttempt;",
    "            maxAttempts = settings.maxRetries;",
    "            delayMs = settings.baseDelayMs;",
    "        }",
    "        this._emit({",
    "            type: \"auto_retry_start\",",
    "            attempt,",
    "            maxAttempts,",
    "            delayMs,",
    "            errorMessage: message.errorMessage || \"Unknown error\",",
    "        });",
  ].join("\n");
  if (!patched.includes(prepareNeedle)) {
    throw new Error("unable to patch bundled Pi agent session retry: prepare-retry anchor not found");
  }
  patched = patched.replace(prepareNeedle, prepareReplacement);

  const abortResetNeedle = "            const attempt = this._retryAttempt;\n            this._retryAttempt = 0;";
  if (!patched.includes(abortResetNeedle)) {
    throw new Error("unable to patch bundled Pi agent session retry: abort reset anchor not found");
  }
  patched = patched.replace(abortResetNeedle, [
    "            const attempt = this._retryAttempt + this._rateLimitRetryAttempt;",
    "            this._retryAttempt = 0;",
    "            this._rateLimitRetryAttempt = 0;",
  ].join("\n"));

  return patched;
}

// Transport/connection failures (network drops, DNS, sockets, TLS resets) are
// transient environment noise: like strict 429s they retry on a fixed cadence
// with a dedicated counter so a flaky link never wastes the user retry budget.
const PI_CONNECTION_RETRY_EXEMPT_MARKER = "AXUM_PI_CONNECTION_RETRY_EXEMPT";
const PI_CONNECTION_ERROR_PATTERN_SOURCE = "connection.?(error|refused|reset|lost)|client.?disconnected|context.?cancell?ed|fetch.?failed|ECONN(?:RESET|REFUSED)|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket.?(hang.?up|connection.?was.?closed)|other.?side.?closed|upstream.?connect|reset.?before.?headers|timed?.?out|timeout|terminated|network.?error";

function buildConnectionRetryHelpers() {
  return [
    `// ${PI_CONNECTION_RETRY_EXEMPT_MARKER}: transport/connection errors retry on a`,
    "// fixed cadence with a dedicated counter so transient network failures",
    "// never consume the user-configured retry budget.",
    "const CONNECTION_DELAY_MS = 5000;",
    "const CONNECTION_MAX_ATTEMPTS = 30;",
    "function isConnectionError(errorMessage) {",
    `    return typeof errorMessage === \"string\" && /${PI_CONNECTION_ERROR_PATTERN_SOURCE}/i.test(errorMessage);`,
    "}",
    "",
  ].join("\n");
}

// Extends the strict-429-exempted agent session with a connection-error lane:
// transient transport failures retry on a fixed cadence with their own
// counter instead of aborting the turn after the default retry budget.
function patchPiAgentSessionConnectionRetry(content) {
  if (content.includes(PI_CONNECTION_RETRY_EXEMPT_MARKER)) return content;

  let patched = patchPiAgentSessionRateLimitRetry(content);

  const classAnchor = "export class AgentSession {";
  if (!patched.includes(classAnchor)) {
    throw new Error("unable to patch bundled Pi agent session connection retry: class anchor not found");
  }
  patched = patched.replace(classAnchor, buildConnectionRetryHelpers() + classAnchor);

  const fieldNeedle = "    _rateLimitRetryAttempt = 0;\n";
  if (!patched.includes(fieldNeedle)) {
    throw new Error("unable to patch bundled Pi agent session connection retry: retry counter field anchor not found");
  }
  patched = patched.replace(fieldNeedle, fieldNeedle + "    _connectionRetryAttempt = 0;\n");

  const successResetNeedle = [
    "                if (assistantMsg.stopReason !== \"error\" && (this._retryAttempt > 0 || this._rateLimitRetryAttempt > 0)) {",
    "                    this._emit({",
    "                        type: \"auto_retry_end\",",
    "                        success: true,",
    "                        attempt: this._retryAttempt + this._rateLimitRetryAttempt,",
    "                    });",
    "                    this._retryAttempt = 0;",
    "                    this._rateLimitRetryAttempt = 0;",
    "                }",
  ].join("\n");
  const successResetReplacement = [
    "                if (assistantMsg.stopReason !== \"error\" && (this._retryAttempt > 0 || this._rateLimitRetryAttempt > 0 || this._connectionRetryAttempt > 0)) {",
    "                    this._emit({",
    "                        type: \"auto_retry_end\",",
    "                        success: true,",
    "                        attempt: this._retryAttempt + this._rateLimitRetryAttempt + this._connectionRetryAttempt,",
    "                    });",
    "                    this._retryAttempt = 0;",
    "                    this._rateLimitRetryAttempt = 0;",
    "                    this._connectionRetryAttempt = 0;",
    "                }",
  ].join("\n");
  if (!patched.includes(successResetNeedle)) {
    throw new Error("unable to patch bundled Pi agent session connection retry: success reset anchor not found");
  }
  patched = patched.replace(successResetNeedle, successResetReplacement);

  const failureResetNeedle = [
    "        if (msg.stopReason === \"error\" && (this._retryAttempt > 0 || this._rateLimitRetryAttempt > 0)) {",
    "            this._emit({",
    "                type: \"auto_retry_end\",",
    "                success: false,",
    "                attempt: this._retryAttempt + this._rateLimitRetryAttempt,",
    "                finalError: msg.errorMessage,",
    "            });",
    "            this._retryAttempt = 0;",
    "            this._rateLimitRetryAttempt = 0;",
    "        }",
  ].join("\n");
  const failureResetReplacement = [
    "        if (msg.stopReason === \"error\" && (this._retryAttempt > 0 || this._rateLimitRetryAttempt > 0 || this._connectionRetryAttempt > 0)) {",
    "            this._emit({",
    "                type: \"auto_retry_end\",",
    "                success: false,",
    "                attempt: this._retryAttempt + this._rateLimitRetryAttempt + this._connectionRetryAttempt,",
    "                finalError: msg.errorMessage,",
    "            });",
    "            this._retryAttempt = 0;",
    "            this._rateLimitRetryAttempt = 0;",
    "            this._connectionRetryAttempt = 0;",
    "        }",
  ].join("\n");
  if (!patched.includes(failureResetNeedle)) {
    throw new Error("unable to patch bundled Pi agent session connection retry: failure reset anchor not found");
  }
  patched = patched.replace(failureResetNeedle, failureResetReplacement);

  const willRetryNeedle = [
    "                if (isRateLimit429Error(message.errorMessage)) {",
    "                    return this._isRetryableError(message) && this._rateLimitRetryAttempt < RATE_LIMIT_MAX_ATTEMPTS;",
    "                }",
    "                if (this._retryAttempt >= settings.maxRetries) {",
  ].join("\n");
  const willRetryReplacement = [
    "                if (isRateLimit429Error(message.errorMessage)) {",
    "                    return this._isRetryableError(message) && this._rateLimitRetryAttempt < RATE_LIMIT_MAX_ATTEMPTS;",
    "                }",
    "                if (isConnectionError(message.errorMessage)) {",
    "                    return this._isRetryableError(message) && this._connectionRetryAttempt < CONNECTION_MAX_ATTEMPTS;",
    "                }",
    "                if (this._retryAttempt >= settings.maxRetries) {",
  ].join("\n");
  if (!patched.includes(willRetryNeedle)) {
    throw new Error("unable to patch bundled Pi agent session connection retry: agent-end retry gate anchor not found");
  }
  patched = patched.replace(willRetryNeedle, willRetryReplacement);

  const prepareNeedle = [
    "            delayMs = jitteredDelay(RATE_LIMIT_DELAY_MS);",
    "        }",
    "        else {",
  ].join("\n");
  const prepareReplacement = [
    "            delayMs = jitteredDelay(RATE_LIMIT_DELAY_MS);",
    "        }",
    "        else if (isConnectionError(message.errorMessage)) {",
    "            if (this._connectionRetryAttempt >= CONNECTION_MAX_ATTEMPTS) {",
    "                return false;",
    "            }",
    "            this._connectionRetryAttempt++;",
    "            attempt = this._connectionRetryAttempt;",
    "            maxAttempts = CONNECTION_MAX_ATTEMPTS;",
    "            delayMs = jitteredDelay(CONNECTION_DELAY_MS);",
    "        }",
    "        else {",
  ].join("\n");
  if (!patched.includes(prepareNeedle)) {
    throw new Error("unable to patch bundled Pi agent session connection retry: prepare-retry anchor not found");
  }
  patched = patched.replace(prepareNeedle, prepareReplacement);

  const abortResetNeedle = [
    "            const attempt = this._retryAttempt + this._rateLimitRetryAttempt;",
    "            this._retryAttempt = 0;",
    "            this._rateLimitRetryAttempt = 0;",
  ].join("\n");
  if (!patched.includes(abortResetNeedle)) {
    throw new Error("unable to patch bundled Pi agent session connection retry: abort reset anchor not found");
  }
  patched = patched.replace(abortResetNeedle, [
    "            const attempt = this._retryAttempt + this._rateLimitRetryAttempt + this._connectionRetryAttempt;",
    "            this._retryAttempt = 0;",
    "            this._rateLimitRetryAttempt = 0;",
    "            this._connectionRetryAttempt = 0;",
  ].join("\n"));

  return patched;
}


const RATE_LIMIT_DISPLAY_NOTICE = "模型提供方限流（429），已在后台静默重试；请稍后再继续。";

function patchPiInteractiveRateLimitDisplay(content) {
  if (content.includes(PI_RATE_LIMIT_DISPLAY_SOFTENING_MARKER)) return content;
  const I12 = " ".repeat(12);
  const I16 = " ".repeat(16);
  const I20 = " ".repeat(20);
  const I24 = " ".repeat(24);
  const classAnchor = "export class InteractiveMode {";
  if (!content.includes(classAnchor)) {
    throw new Error("unable to patch bundled Pi interactive mode: class anchor not found");
  }
  let updated = content.replace(
    classAnchor,
    `// ${PI_RATE_LIMIT_DISPLAY_SOFTENING_MARKER}
const AXUM_RATE_LIMIT_429_NOTICE = ${JSON.stringify(RATE_LIMIT_DISPLAY_NOTICE)};
function isAxumRateLimit429Message(message) {
  return typeof message === "string" && new RegExp(${JSON.stringify(PI_RATE_LIMIT_429_PATTERN_SOURCE)}).test(message);
}
${classAnchor}`,
  );
  const summarizationAnchor = [
    I12 + 'case "summarization_retry_scheduled": {',
    I16 + "this.showError(event.errorMessage);",
  ].join("\n") ;
  const summarizationReplacement = [
    I12 + 'case "summarization_retry_scheduled": {',
    I16 + "if (!isAxumRateLimit429Message(event.errorMessage)) {",
    I20 + "this.showError(event.errorMessage);",
    I16 + "}",
  ].join("\n");
  if (!updated.includes(summarizationAnchor)) {
    throw new Error("unable to patch bundled Pi interactive mode: summarization retry anchor not found");
  }
  updated = updated.replace(summarizationAnchor, summarizationReplacement);
  const retryEndAnchor = [
    I16 + "if (!event.success) {",
    I20 + 'this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);',
    I16 + "}",
  ].join("\n");
  const retryEndReplacement = [
    I16 + "if (!event.success) {",
    I20 + "if (isAxumRateLimit429Message(event.finalError)) {",
    I24 + "this.chatContainer.addChild(new Text(AXUM_RATE_LIMIT_429_NOTICE, 1, 0));",
    I20 + "}",
    I20 + "else {",
    I24 + 'this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);',
    I20 + "}",
    I16 + "}",
  ].join("\n");
  if (!updated.includes(retryEndAnchor)) {
    throw new Error("unable to patch bundled Pi interactive mode: auto retry end anchor not found");
  }
  updated = updated.replace(retryEndAnchor, retryEndReplacement);
  const compactionAnchor = [
    I16 + "else if (event.errorMessage) {",
    I20 + 'if (event.reason === "manual") {',
    I24 + "this.showError(event.errorMessage);",
    I20 + "}",
    I20 + "else {",
    I24 + "this.chatContainer.addChild(new Spacer(1));",
    I24 + 'this.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));',
    I20 + "}",
    I16 + "}",
  ].join("\n");
  const compactionReplacement = [
    I16 + "else if (event.errorMessage) {",
    I20 + "if (isAxumRateLimit429Message(event.errorMessage)) {",
    I24 + "this.chatContainer.addChild(new Spacer(1));",
    I24 + "this.chatContainer.addChild(new Text(AXUM_RATE_LIMIT_429_NOTICE, 1, 0));",
    I20 + "}",
    I20 + 'else if (event.reason === "manual") {',
    I24 + "this.showError(event.errorMessage);",
    I20 + "}",
    I20 + "else {",
    I24 + "this.chatContainer.addChild(new Spacer(1));",
    I24 + 'this.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));',
    I20 + "}",
    I16 + "}",
  ].join("\n");
  if (!updated.includes(compactionAnchor)) {
    throw new Error("unable to patch bundled Pi interactive mode: compaction error anchor not found");
  }
  updated = updated.replace(compactionAnchor, compactionReplacement);
  return updated;
}


function patchPiAiRetryable422(content) {
  const upgradedPattern = "const STRICT_TRANSIENT_STATUS_PATTERN = /^\\s*(?:Error:\\s*)?(?:422|520)[:\\s]/;";
  if (content.includes(PI_422_RETRYABLE_MARKER)) {
    if (content.includes(upgradedPattern)) return content;
    const legacyPattern = "const STRICT_422_PATTERN = /^\\s*(?:Error:\\s*)?422[:\\s]/;";
    if (!content.includes(legacyPattern)) {
      throw new Error("unable to upgrade bundled Pi retry.js: legacy 422 pattern not found");
    }
    return content
      .replaceAll(legacyPattern, upgradedPattern)
      .replaceAll("STRICT_422_PATTERN.test(errorMessage)", "STRICT_TRANSIENT_STATUS_PATTERN.test(errorMessage)");
  }
  const fnAnchor = "export function isRetryableAssistantError(message) {";
  if (!content.includes(fnAnchor)) {
    throw new Error("unable to patch bundled Pi retry.js: isRetryableAssistantError anchor not found");
  }
  let updated = content.replace(
    fnAnchor,
    `// ${PI_422_RETRYABLE_MARKER}: gateway-originated transient statuses (422,
// 520) must not terminate the turn immediately; route them through the
// caller's normal retry budget. Strict shape only: a leading status code,
// never digits embedded in body text.
const STRICT_TRANSIENT_STATUS_PATTERN = /^\\s*(?:Error:\\s*)?(?:422|520)[:\\s]/;
${fnAnchor}`,
  );
  const retAnchor = "    return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);";
  if (!updated.includes(retAnchor)) {
    throw new Error("unable to patch bundled Pi retry.js: retryable return anchor not found");
  }
  updated = updated.replace(
    retAnchor,
    "    if (STRICT_TRANSIENT_STATUS_PATTERN.test(errorMessage))\n        return true;\n" + retAnchor,
  );
  return updated;
}


function patchPiInteractiveErrorDedup(content) {
  if (content.includes(PI_ERROR_DEDUP_MARKER)) return content;
  const methodAnchor = [
    "    showError(errorMessage) {",
    "        this.chatContainer.addChild(new Spacer(1));",
    "        this.chatContainer.addChild(new Text(theme.fg(\"error\", `Error: ${errorMessage}`), this.outputPad, 0));",
    "        this.ui.requestRender();",
    "    }",
  ].join("\n");
  if (!content.includes(methodAnchor)) {
    throw new Error("unable to patch bundled Pi interactive mode: showError anchor not found");
  }
  const replacement = [
    "    // " + PI_ERROR_DEDUP_MARKER + ": consecutive identical errors collapse to",
    "    // one line so provider error storms stay readable.",
    "    _axumLastShownError = undefined;",
    "    showError(errorMessage) {",
    "        if (errorMessage === this._axumLastShownError)",
    "            return;",
    "        this._axumLastShownError = errorMessage;",
    "        this.chatContainer.addChild(new Spacer(1));",
    "        this.chatContainer.addChild(new Text(theme.fg(\"error\", `Error: ${errorMessage}`), this.outputPad, 0));",
    "        this.ui.requestRender();",
    "    }",
  ].join("\n");
  return content.replace(methodAnchor, replacement);
}


function patchPiAssistantMessageErrorDedup(content) {
  if (content.includes(PI_ASSISTANT_ERROR_DEDUP_MARKER)) return content;
  const classAnchor = "export class AssistantMessageComponent extends Container {";
  if (!content.includes(classAnchor)) {
    throw new Error("unable to patch bundled Pi assistant message: class anchor not found");
  }
  let updated = content.replace(
    classAnchor,
    `// ${PI_ASSISTANT_ERROR_DEDUP_MARKER}: consecutive identical failure
// signatures across assistant message instances collapse into one rendered
// block, so provider error storms stay readable.
let axumLastBubbleFailure = undefined;
${classAnchor}`,
  );
  const abortedAnchor = [
    '                this.contentContainer.addChild(new Spacer(1));',
    '                this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));',
  ].join("\n");
  if (!updated.includes(abortedAnchor)) {
    throw new Error("unable to patch bundled Pi assistant message: aborted render anchor not found");
  }
  updated = updated.replace(
    abortedAnchor,
    [
      '                if (axumLastBubbleFailure !== `aborted:${abortMessage}`) {',
      '                    axumLastBubbleFailure = `aborted:${abortMessage}`;',
      '                this.contentContainer.addChild(new Spacer(1));',
      '                this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));',
      '                }',
    ].join("\n"),
  );
  const errorAnchor = [
    '                this.contentContainer.addChild(new Spacer(1));',
    '                this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));',
  ].join("\n");
  if (!updated.includes(errorAnchor)) {
    throw new Error("unable to patch bundled Pi assistant message: error render anchor not found");
  }
  updated = updated.replace(
    errorAnchor,
    [
      '                if (axumLastBubbleFailure !== `error:${errorMsg}`) {',
      '                    axumLastBubbleFailure = `error:${errorMsg}`;',
      '                this.contentContainer.addChild(new Spacer(1));',
      '                this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));',
      '                }',
    ].join("\n"),
  );
  return updated;
}

const PI_RETRY_JITTER_MARKER = "AXUM_PI_RETRY_JITTER";

function patchPiRetryJitter(content) {
  if (!content.includes(PI_RATE_LIMIT_RETRY_EXEMPT_MARKER)) return content;
  if (content.includes("RETRY_JITTER_MS")) return content;
  const attemptsAnchor = "const RATE_LIMIT_MAX_ATTEMPTS = 30;";
  if (!content.includes(attemptsAnchor)) {
    throw new Error("unable to upgrade bundled Pi retry jitter: rate-limit attempts anchor not found");
  }
  if (!content.includes("delayMs = RATE_LIMIT_DELAY_MS;")) {
    throw new Error("unable to upgrade bundled Pi retry jitter: rate-limit delay anchor not found");
  }
  const jitterBlock = [
    `// ${PI_RETRY_JITTER_MARKER}: exemption-lane delays get positive jitter so`,
    "// concurrent clients do not retry in lockstep against the same endpoint.",
    "const RETRY_JITTER_MS = 1500;",
    "function jitteredDelay(baseMs) {",
    "    return baseMs + Math.floor(Math.random() * RETRY_JITTER_MS);",
    "}",
  ].join("\n");
  return content
    .replace(attemptsAnchor, jitterBlock + "\n" + attemptsAnchor)
    .replaceAll("delayMs = RATE_LIMIT_DELAY_MS;", "delayMs = jitteredDelay(RATE_LIMIT_DELAY_MS);")
    .replaceAll("delayMs = CONNECTION_DELAY_MS;", "delayMs = jitteredDelay(CONNECTION_DELAY_MS);");
}

export function applyBundledPiPatches(options) {
  const results = [];

  const piTuiRoot = resolveBundledPackageRoot(PI_TUI_PACKAGE, options);
  const stdinBufferPath = path.join(piTuiRoot, "dist", "stdin-buffer.js");
  if (!fs.existsSync(stdinBufferPath)) {
    throw new Error(`bundled Pi TUI stdin buffer not found: ${stdinBufferPath}`);
  }
  const tuiOriginal = fs.readFileSync(stdinBufferPath, "utf8");
  const tuiPatched = patchPiTuiStdinBuffer(tuiOriginal);
  if (tuiPatched !== tuiOriginal) {
    fs.writeFileSync(stdinBufferPath, tuiPatched);
  }
  results.push({ patched: tuiPatched !== tuiOriginal, file: stdinBufferPath });

  const piRoot = resolveBundledPackageRoot(PI_CODING_AGENT_PACKAGE, options);
  const undiciWebidlPath = path.join(piRoot, "node_modules", "undici", "lib", "web", "webidl", "index.js");
  if (fs.existsSync(undiciWebidlPath)) {
    const undiciOriginal = fs.readFileSync(undiciWebidlPath, "utf8");
    const undiciPatched = patchUndiciMarkAsUncloneableFallback(undiciOriginal);
    if (undiciPatched !== undiciOriginal) {
      fs.writeFileSync(undiciWebidlPath, undiciPatched);
    }
    results.push({ patched: undiciPatched !== undiciOriginal, file: undiciWebidlPath });
  }

  // Lower the stock 300s HTTP idle timeout so upstream-cancelled streams that
  // never close their socket surface as a retryable body-timeout quickly.
  const httpDispatcherPath = path.join(piRoot, "dist", "core", "http-dispatcher.js");
  if (fs.existsSync(httpDispatcherPath)) {
    const dispatcherOriginal = fs.readFileSync(httpDispatcherPath, "utf8");
    const dispatcherPatched = patchPiHttpIdleTimeoutDefault(dispatcherOriginal);
    if (dispatcherPatched !== dispatcherOriginal) {
      fs.writeFileSync(httpDispatcherPath, dispatcherPatched);
    }
    results.push({ patched: dispatcherPatched !== dispatcherOriginal, file: httpDispatcherPath });
  }

  // Strict-429 rate-limit exemption: patch every retry.js copy reachable from
  // pi-coding-agent (top-level and its nested dependency), plus the session-level
  // retry driver, so throttling never surfaces as a raw error or drains budgets;
  // the session driver additionally exempts transient connection failures from
  // that budget so a flaky link cannot abort the turn after a few retries.
  const piAiRetryPaths = [
    path.join(resolveBundledPackageRoot(PI_AI_PACKAGE, options), "dist", "utils", "retry.js"),
    path.join(piRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "utils", "retry.js"),
  ];
  for (const retryPath of piAiRetryPaths) {
    if (!fs.existsSync(retryPath)) continue;
    const retryOriginal = fs.readFileSync(retryPath, "utf8");
    const retryPatched = patchPiAiRateLimitRetry(retryOriginal);
    const retryPatchedFinal = patchPiRetryJitter(patchPiAiRetryable422(retryPatched));
    if (retryPatchedFinal !== retryOriginal) {
      fs.writeFileSync(retryPath, retryPatchedFinal);
    }
    results.push({ patched: retryPatchedFinal !== retryOriginal, file: retryPath });
  }

  const agentSessionPath = path.join(piRoot, "dist", "core", "agent-session.js");
  if (fs.existsSync(agentSessionPath)) {
    const sessionOriginal = fs.readFileSync(agentSessionPath, "utf8");
    const sessionPatched = patchPiAgentSessionConnectionRetry(patchPiRetryJitter(sessionOriginal));
    if (sessionPatched !== sessionOriginal) {
      fs.writeFileSync(agentSessionPath, sessionPatched);
    }
    results.push({ patched: sessionPatched !== sessionOriginal, file: agentSessionPath });
  } else {
    results.push({ patched: false, file: agentSessionPath });
  }

  const interactiveModePath = path.join(piRoot, "dist", "modes", "interactive", "interactive-mode.js");
  if (fs.existsSync(interactiveModePath)) {
    const interactiveOriginal = fs.readFileSync(interactiveModePath, "utf8");
    const interactivePatched = patchPiInteractiveRateLimitDisplay(interactiveOriginal);
    const interactiveFinal = patchPiInteractiveErrorDedup(interactivePatched);
    if (interactiveFinal !== interactiveOriginal) {
      fs.writeFileSync(interactiveModePath, interactiveFinal);
    }
    results.push({ patched: interactiveFinal !== interactiveOriginal, file: interactiveModePath });
    const assistantMessagePath = path.join(piRoot, "dist", "modes", "interactive", "components", "assistant-message.js");
    if (fs.existsSync(assistantMessagePath)) {
      const assistantOriginal = fs.readFileSync(assistantMessagePath, "utf8");
      const assistantPatched = patchPiAssistantMessageErrorDedup(assistantOriginal);
      if (assistantPatched !== assistantOriginal) {
        fs.writeFileSync(assistantMessagePath, assistantPatched);
      }
      results.push({ patched: assistantPatched !== assistantOriginal, file: assistantMessagePath });
    }
  } else {
    results.push({ patched: false, file: interactiveModePath });
  }

  if (isAndroidLike(options)) {
    const toolsManagerPath = path.join(piRoot, "dist", "utils", "tools-manager.js");
    if (!fs.existsSync(toolsManagerPath)) {
      throw new Error(`bundled Pi tools-manager not found: ${toolsManagerPath}`);
    }
    const tmOriginal = fs.readFileSync(toolsManagerPath, "utf8");
    const tmPatched = patchTermuxAutoInstall(tmOriginal);
    if (tmPatched !== tmOriginal) {
      fs.writeFileSync(toolsManagerPath, tmPatched);
    }
    results.push({ patched: tmPatched !== tmOriginal, file: toolsManagerPath });
  }

  const piGoalRoot = resolveBundledPackageRoot(PI_GOAL_PACKAGE, options);
  const piGoalSettingsPath = path.join(piGoalRoot, "src", "settings.ts");
  if (fs.existsSync(piGoalSettingsPath)) {
    const piGoalOriginal = fs.readFileSync(piGoalSettingsPath, "utf8");
    const piGoalPatched = patchPiGoalLinkSyncFallback(piGoalOriginal);
    if (piGoalPatched !== piGoalOriginal) {
      fs.writeFileSync(piGoalSettingsPath, piGoalPatched);
    }
    results.push({ patched: piGoalPatched !== piGoalOriginal, file: piGoalSettingsPath });
  } else {
    results.push({ patched: false, file: piGoalSettingsPath });
  }
  const piGoalRuntimePath = path.join(piGoalRoot, "src", "runtime.ts");
  if (fs.existsSync(piGoalRuntimePath)) {
    const piGoalRuntimeOriginal = fs.readFileSync(piGoalRuntimePath, "utf8");
    const piGoalRuntimePatched = patchPiGoalAutoResume(piGoalRuntimeOriginal);
    if (piGoalRuntimePatched !== piGoalRuntimeOriginal) {
      fs.writeFileSync(piGoalRuntimePath, piGoalRuntimePatched);
    }
    results.push({ patched: piGoalRuntimePatched !== piGoalRuntimeOriginal, file: piGoalRuntimePath });
  } else {
    results.push({ patched: false, file: piGoalRuntimePath });
  }
  const piInteractiveModePath = path.join(piRoot, "dist", "modes", "interactive", "interactive-mode.js");
  const piExtensionLoaderPath = path.join(piRoot, "dist", "core", "extensions", "loader.js");
  if (fs.existsSync(piExtensionLoaderPath)) {
    const loaderOriginal = fs.readFileSync(piExtensionLoaderPath, "utf8");
    const loaderPatched = patchPiJitiLazyLoader(loaderOriginal);
    if (loaderPatched !== loaderOriginal) {
      fs.writeFileSync(piExtensionLoaderPath, loaderPatched);
    }
    results.push({ patched: loaderPatched !== loaderOriginal, file: piExtensionLoaderPath });
  }
  if (fs.existsSync(piInteractiveModePath)) {
    const piInteractiveOriginal = fs.readFileSync(piInteractiveModePath, "utf8");
    let piInteractivePatched = patchPiVersionNotificationSuppress(piInteractiveOriginal);
    piInteractivePatched = patchPiLoadedSkillsExtensionsHide(piInteractivePatched);
    piInteractivePatched = patchPiStartupChangelogCollapse(piInteractivePatched);
    piInteractivePatched = patchPiAltScreenScrollOnSubmit(piInteractivePatched);
    if (piInteractivePatched !== piInteractiveOriginal) {
      fs.writeFileSync(piInteractiveModePath, piInteractivePatched);
    }
    results.push({ patched: piInteractivePatched !== piInteractiveOriginal, file: piInteractiveModePath });
  } else {
    results.push({ patched: false, file: piInteractiveModePath });
  }

  return results;
}

export { patchPiAgentSessionRateLimitRetry, patchPiAgentSessionConnectionRetry, patchPiHttpIdleTimeoutDefault, patchPiAiRateLimitRetry, patchPiRetryJitter, patchPiAiRetryable422, patchPiAssistantMessageErrorDedup, patchPiInteractiveErrorDedup, patchPiInteractiveRateLimitDisplay, patchPiGoalAutoResume, PI_RATE_LIMIT_429_PATTERN_SOURCE, PI_CONNECTION_ERROR_PATTERN_SOURCE, patchPiGoalLinkSyncFallback, patchPiJitiLazyLoader, patchPiLoadedSkillsExtensionsHide, patchPiStartupChangelogCollapse, patchPiTuiStdinBuffer, patchPiVersionNotificationSuppress, patchPiAltScreenScrollOnSubmit, patchTermuxAutoInstall, patchUndiciMarkAsUncloneableFallback };
