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
const PI_VERSION_NOTIFICATION_SUPPRESSED_MARKER = "AXUM_PI_VERSION_NOTIFICATION_SUPPRESSED";
const PI_LOADED_SKILLS_EXTENSIONS_HIDDEN_MARKER = "AXUM_PI_LOADED_SKILLS_EXTENSIONS_HIDDEN";

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
    '        if (!silent) {',
    '            console.log(chalk.yellow(`${config.name} not found. Install with: pkg install ${pkgName}`));',
    '        }',
    '        return undefined;',
    '    }',
    '',
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
    '            const { spawnSync } = await import("node:child_process");',
    '            const result = spawnSync("pkg", ["install", "-y", pkgName], { stdio: "inherit" });',
    '            if ((result.status ?? 1) === 0) {',
    '                const resolved = getToolPath(tool);',
    '                if (resolved) return resolved;',
    '            }',
    '        } catch (e) {',
    '            if (!silent) {',
    '                console.log(chalk.yellow(`Failed to auto-install ${config.name}: ${e instanceof Error ? e.message : e}`));',
    '            }',
    '        }',
    '        if (!silent) {',
    '            console.log(chalk.yellow(`${config.name} not found. Install with: pkg install ${pkgName}`));',
    '        }',
    '        return undefined;',
    '    }',
    '',
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
 * Hide the duplicate `[Skills]` / `[Extensions]` sections that Pi's
 * `showLoadedResources` prints in the startup banner. Axum's SAKURA CYBERDECK
 * header already frames these same lists in sakura cards, so leaving Pi's plain
 * `[Skills] find-skills, impeccable` / `[Extensions] pi-edit, pi-bar, ...` lines
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
  const piInteractiveModePath = path.join(piRoot, "dist", "modes", "interactive", "interactive-mode.js");
  if (fs.existsSync(piInteractiveModePath)) {
    const piInteractiveOriginal = fs.readFileSync(piInteractiveModePath, "utf8");
    let piInteractivePatched = patchPiVersionNotificationSuppress(piInteractiveOriginal);
    piInteractivePatched = patchPiLoadedSkillsExtensionsHide(piInteractivePatched);
    if (piInteractivePatched !== piInteractiveOriginal) {
      fs.writeFileSync(piInteractiveModePath, piInteractivePatched);
    }
    results.push({ patched: piInteractivePatched !== piInteractiveOriginal, file: piInteractiveModePath });
  } else {
    results.push({ patched: false, file: piInteractiveModePath });
  }
  return results;
}

export { patchPiGoalLinkSyncFallback, patchPiLoadedSkillsExtensionsHide, patchPiTuiStdinBuffer, patchPiVersionNotificationSuppress, patchTermuxAutoInstall, patchUndiciMarkAsUncloneableFallback };
