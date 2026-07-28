import fs from "node:fs";
import path from "node:path";
import { getBundledPiNodeModules } from "./bundled-pi-cache.js";
import { isAndroidLike } from "./bundled-pi-platform.js";

const PI_TUI_PACKAGE = "@earendil-works/pi-tui";
const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const UNBRACKETED_PASTE_PATCH_MARKER = "looksLikeUnbracketedPaste";
const TERMUX_AUTOINSTALL_PATCH_MARKER = "AXUM_TERMUX_AUTOINSTALL";
const UNDICI_MARK_AS_UNCLONEABLE_PATCH_MARKER = "AXUM_UNDICI_MARK_AS_UNCLONEABLE_FALLBACK";

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
    throw new Error("unable to patch bundled Pi tools-manager: Termux install block not found");
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

  return results;
}

export { patchPiTuiStdinBuffer, patchTermuxAutoInstall, patchUndiciMarkAsUncloneableFallback };
