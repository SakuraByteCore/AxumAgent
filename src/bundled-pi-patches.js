import fs from "node:fs";
import path from "node:path";
import { getBundledPiNodeModules } from "./bundled-pi-cache.js";

const PI_TUI_PACKAGE = "@earendil-works/pi-tui";
const UNBRACKETED_PASTE_PATCH_MARKER = "looksLikeUnbracketedPaste";

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

export function applyBundledPiPatches(options) {
  const piTuiRoot = resolveBundledPackageRoot(PI_TUI_PACKAGE, options);
  const stdinBufferPath = path.join(piTuiRoot, "dist", "stdin-buffer.js");
  if (!fs.existsSync(stdinBufferPath)) {
    throw new Error(`bundled Pi TUI stdin buffer not found: ${stdinBufferPath}`);
  }

  const original = fs.readFileSync(stdinBufferPath, "utf8");
  const patched = patchPiTuiStdinBuffer(original);
  if (patched !== original) {
    fs.writeFileSync(stdinBufferPath, patched);
  }
  return { patched: patched !== original, file: stdinBufferPath };
}

export { patchPiTuiStdinBuffer };
