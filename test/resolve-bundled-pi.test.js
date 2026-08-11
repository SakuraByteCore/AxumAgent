import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getBundledPiCacheRoot } from "../src/bundled-pi-cache.js";
import { ensureBundledPi, npmInstallEnv, resolveNpmInstallCommand } from "../src/ensure-bundled-pi.js";
import { patchPiGoalLinkSyncFallback, patchPiTuiStdinBuffer, patchPiVersionNotificationSuppress, patchUndiciMarkAsUncloneableFallback } from "../src/bundled-pi-patches.js";
import { resolvePiCli, resolveBundledExtensions, existingBundledExtensions } from "../src/resolve-bundled-pi.js";

function writePackage(root, name, files = {}) {
  const dir = path.join(root, "node_modules", ...name.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", type: "module" }));
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

test("resolves bundled Pi from Axum cache directory", () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "axum-bundled-cache-"));
  const options = { platform: "linux", env: { AXUM_BUNDLED_PI_DIR: cache } };
  writePackage(cache, "@earendil-works/pi-coding-agent", { "dist/cli.js": "" });
  writePackage(cache, "pi-bar", { "index.ts": "" });
  writePackage(cache, "pi-header", { "index.ts": "" });
  writePackage(cache, "pi-guard", { "index.ts": "" });
  writePackage(cache, "@narumitw/pi-goal", { "src/index.ts": "" });

  const piCli = resolvePiCli(options);
  const extensions = resolveBundledExtensions(options);
  assert.equal(piCli, path.join(cache, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"));
  assert.equal(fs.existsSync(piCli), true);
  assert.equal(extensions.length, 4);
  assert.equal(existingBundledExtensions(options).length, 4);
});

test("Android loads pi-guard and pi-goal", () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "axum-bundled-android-cache-"));
  const options = { platform: "android", env: { AXUM_BUNDLED_PI_DIR: cache } };
  writePackage(cache, "@earendil-works/pi-coding-agent", { "dist/cli.js": "" });
  writePackage(cache, "pi-bar", { "index.ts": "" });
  writePackage(cache, "pi-header", { "index.ts": "" });
  writePackage(cache, "pi-guard", { "index.ts": "" });
  writePackage(cache, "@narumitw/pi-goal", { "src/index.ts": "" });

  const extensions = resolveBundledExtensions(options);
  assert.equal(extensions.length, 4);
  assert.equal(extensions[0], path.join(cache, "node_modules", "pi-bar", "index.ts"));
  assert.equal(extensions[1], path.join(cache, "node_modules", "pi-header", "index.ts"));
  assert.equal(extensions[2], path.join(cache, "node_modules", "pi-guard", "index.ts"));
  assert.equal(extensions[3], path.join(cache, "node_modules", "@narumitw", "pi-goal", "src", "index.ts"));
  assert.equal(existingBundledExtensions(options).length, 4);
});

test("Windows loads same extension set as other platforms", () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "axum-bundled-win-cache-"));
  const options = { platform: "win32", env: { AXUM_BUNDLED_PI_DIR: cache } };
  writePackage(cache, "@earendil-works/pi-coding-agent", { "dist/cli.js": "" });
  writePackage(cache, "pi-bar", { "index.ts": "" });
  writePackage(cache, "pi-header", { "index.ts": "" });
  writePackage(cache, "pi-guard", { "index.ts": "" });
  writePackage(cache, "@narumitw/pi-goal", { "src/index.ts": "" });

  const extensions = resolveBundledExtensions(options);
  assert.equal(extensions.length, 4);
  assert.equal(extensions[0], path.join(cache, "node_modules", "pi-bar", "index.ts"));
  assert.equal(extensions[1], path.join(cache, "node_modules", "pi-header", "index.ts"));
  assert.equal(extensions[2], path.join(cache, "node_modules", "pi-guard", "index.ts"));
  assert.equal(extensions[3], path.join(cache, "node_modules", "@narumitw", "pi-goal", "src", "index.ts"));
  assert.equal(existingBundledExtensions(options).length, 4);
});


test("ensureBundledPi skips unchanged plugin source copies", () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "axum-plugin-sync-"));
  const calls = path.join(cache, "npm-calls.log");
  const fakeNpm = path.join(cache, "fake-npm.js");
  const stdinBuffer = `const ESC = "\\x1b";
const BRACKETED_PASTE_START = "\\x1b[200~";
const BRACKETED_PASTE_END = "\\x1b[201~";
class StdinBuffer {
  process(data) {
    let str = Buffer.isBuffer(data) ? data.toString() : data;
        if (str.length === 0 && this.buffer.length === 0) {
            this.emitDataSequence("");
            return;
        }
  }
}
`;

  fs.writeFileSync(fakeNpm, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const root = process.cwd();
fs.appendFileSync(${JSON.stringify(calls)}, "run\\n");
function pkg(name, files = {}) {
  const dir = path.join(root, "node_modules", ...name.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", type: "module" }));
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}
const stdinBuffer = ${JSON.stringify(stdinBuffer)};
pkg("@earendil-works/pi-coding-agent", {
  "dist/cli.js": "",
  "dist/utils/tools-manager.js": "export async function ensureTool() { return undefined; }\\n",
  "node_modules/undici/lib/web/webidl/index.js": "webidl.util.markAsUncloneable = markAsUncloneable\\n",
});
pkg("@earendil-works/pi-ai", { "dist/index.js": "" });
pkg("@earendil-works/pi-agent-core", { "dist/index.js": "" });
pkg("@earendil-works/pi-tui", { "dist/index.js": "", "dist/stdin-buffer.js": stdinBuffer });
pkg("pi-bar", { "index.ts": "" });
pkg("pi-header", { "index.ts": "" });
pkg("pi-guard", { "index.ts": "" });
pkg("@narumitw/pi-goal", { "src/index.ts": "" });
`);
  fs.chmodSync(fakeNpm, 0o755);

  const options = { platform: "win32", env: { AXUM_BUNDLED_PI_DIR: cache }, npmCommand: fakeNpm };
  ensureBundledPi(options);
  const pluginDir = path.join(cache, "plugin", "pi-bar");
  const before = fs.statSync(pluginDir).mtimeMs;
  ensureBundledPi(options);
  const after = fs.statSync(pluginDir).mtimeMs;

  assert.equal(fs.readFileSync(calls, "utf8"), "run\n");
  assert.equal(fs.existsSync(`${pluginDir}.fingerprint`), true);
  assert.equal(after, before);
});
test("cache root is stable and short outside npm package install directory", () => {
  const env = { XDG_CACHE_HOME: "/tmp/axum-cache-home" };
  const root = getBundledPiCacheRoot({ env, platform: "linux", arch: "x64" });
  assert.match(root.replaceAll("\\", "/"), /^\/tmp\/axum-cache-home\/axum-agent\/bundled-pi\/v4\/linux-x64\/pi-[a-f0-9]{12}$/);
  assert.doesNotMatch(root, /node_modules\/axum-agent/);
  assert.ok(root.length < 100);
});

// Windows reports misleading npm ENOENT failures when package install cwd paths
// exceed legacy MAX_PATH limits. Keep the generated cache segment compact instead
// of embedding every bundled package name in the directory path.
test("Windows bundled Pi cache root avoids long package-name paths", () => {
  const root = getBundledPiCacheRoot({
    env: { LOCALAPPDATA: "C:\\Users\\Ymkiux\\AppData\\Local", XDG_CACHE_HOME: "C:\\Users\\Ymkiux\\.cache" },
    platform: "win32",
    arch: "x64",
  });
  assert.match(root.replaceAll("\\", "/"), /\/axum-agent\/bundled-pi\/v4\/win32-x64\/pi-[a-f0-9]{12}$/);
  assert.doesNotMatch(root, /earendil|google|hermes|subagents|optimizer/);
  assert.ok(root.length < 120);
});

test("patches bundled Pi TUI stdin buffer to keep unbracketed paste atomic", () => {
  const vulnerable = `const ESC = "\\x1b";
const BRACKETED_PASTE_START = "\\x1b[200~";
const BRACKETED_PASTE_END = "\\x1b[201~";
class StdinBuffer {
  process(data) {
    let str;
    if (Buffer.isBuffer(data)) {
      str = data.toString();
    } else {
      str = data;
    }
        if (str.length === 0 && this.buffer.length === 0) {
            this.emitDataSequence("");
            return;
        }
  }
}
`;
  const patched = patchPiTuiStdinBuffer(vulnerable);
  assert.match(patched, /function looksLikeUnbracketedPaste/);
  assert.match(patched, /this\.emit\("paste", str\)/);
  assert.equal(patchPiTuiStdinBuffer(patched), patched);
});

test("patches bundled undici markAsUncloneable fallback for current Node 22", () => {
  const vulnerable = "const { markAsUncloneable } = require('node:worker_threads')\nwebidl.util.markAsUncloneable = markAsUncloneable\n";
  const patched = patchUndiciMarkAsUncloneableFallback(vulnerable);
  assert.match(patched, /AXUM_UNDICI_MARK_AS_UNCLONEABLE_FALLBACK/);
  assert.match(patched, /markAsUncloneable \|\| \(\(\) => \{\}\)/);
  assert.equal(patchUndiciMarkAsUncloneableFallback(patched), patched);
});

test("patches pi-goal linkSync EACCES to fall back to a direct write", () => {
  const T = "\t";
  const source = [
    "export const DEFAULT_GOAL_SETTINGS_DOCUMENT = \"{}\\n\";",
    "function isAlreadyExistsError(error) { return error && error.code === \"EEXIST\"; }",
    "function readGoalSettings(p) { return p ? { kind: \"loaded\", settings: {} } : { kind: \"missing\" }; }",
    "export function loadOrCreateGoalSettings(settingsPath, overrides = {}) {",
    T + "const fs = { mkdirSync: () => {}, writeFileSync: () => {}, linkSync: () => { throw Object.assign(new Error(\"EACCES\"), { code: \"EACCES\" }); } };",
    T + "const temporaryPath = \".pi-goal.json.tmp\";",
    T + "try {",
    T + T + "fs.mkdirSync(\"x\", { recursive: true });",
    T + T + "fs.writeFileSync(temporaryPath, DEFAULT_GOAL_SETTINGS_DOCUMENT, { encoding: \"utf8\", flag: \"wx\" });",
    T + T + "try {",
    T + T + T + "fs.linkSync(temporaryPath, settingsPath);",
    T + T + "} catch (error) {",
    T + T + T + "if (!isAlreadyExistsError(error)) throw error;",
    T + T + "}",
    "",
    T + T + "const published = readGoalSettings(settingsPath);",
    T + T + "return published;",
    T + "} catch (error) {",
    T + T + "return { kind: \"create-failed\", reason: String(error) };",
    T + "}",
    "}",
  ].join("\n");
  const patched = patchPiGoalLinkSyncFallback(source);
  assert.notEqual(patched, source, "patch should change the source");
  assert.match(patched, /AXUM_PI_GOAL_LINKSYNC_FALLBACK/);
  assert.match(patched, /fs\.writeFileSync\(settingsPath, DEFAULT_GOAL_SETTINGS_DOCUMENT/);
  // Falling back must keep the original linkSync call so the happy path is unchanged.
  assert.match(patched, /fs\.linkSync\(temporaryPath, settingsPath\)/);
  // Idempotent: re-running the patch on already-patched content is a no-op.
  assert.equal(patchPiGoalLinkSyncFallback(patched), patched);
  // Unknown block shape is left untouched rather than crashing.
  const reshaped = source.replace("if (!isAlreadyExistsError(error)) throw error;", "// link removed upstream");
  assert.equal(patchPiGoalLinkSyncFallback(reshaped), reshaped);
});

test("suppresses the bundled Pi new-version notification render", () => {
  const I = "        ";
  const source = [
    "run() {",
    I + "// Start version check asynchronously",
    I + "checkForNewPiVersion(this.version).then((newRelease) => {",
    I + "    if (newRelease) {",
    I + "        this.showNewVersionNotification(newRelease);",
    I + "    }",
    I + "});",
    "}",
  ].join("\n");
  const patched = patchPiVersionNotificationSuppress(source);
  assert.notEqual(patched, source, "patch should change the source");
  assert.match(patched, /AXUM_PI_VERSION_NOTIFICATION_SUPPRESSED/);
  // The async version check keeps running so side effects are unaffected;
  // only the notification render is suppressed.
  assert.match(patched, /checkForNewPiVersion\(this\.version\)/);
  assert.doesNotMatch(patched, /showNewVersionNotification/);
  // Idempotent.
  assert.equal(patchPiVersionNotificationSuppress(patched), patched);
  // Unknown block shape is left untouched rather than crashing.
  const reshaped = source.replace("// Start version check asynchronously", "// version check changed upstream");
  assert.equal(patchPiVersionNotificationSuppress(reshaped), reshaped);
});

test("filters invalid Windows env keys before npm install", () => {
  const env = npmInstallEnv({
    platform: "win32",
    env: {
      "=C:": "C:\\Users\\runner",
      PATH: "C:\\Windows\\System32",
      npm_config_cache: "bad-cache",
      npm_config_user_agent: "keep-me",
      AXUM_BUNDLED_PI_DIR: "C:\\axum-cache",
    },
  });

  assert.equal(Object.hasOwn(env, "=C:"), false);
  assert.equal(env.PATH, "C:\\Windows\\System32");
  assert.equal(Object.hasOwn(env, "npm_config_cache"), false);
  assert.equal(env.npm_config_user_agent, "keep-me");
  assert.equal(env.npm_config_prefix, "C:\\axum-cache");
});

test("resolves Windows npm through node npm-cli when available", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-node-npm-"));
  const nodePath = path.join(dir, "node.exe");
  const npmCli = path.join(dir, "node_modules", "npm", "bin", "npm-cli.js");
  fs.mkdirSync(path.dirname(npmCli), { recursive: true });
  fs.writeFileSync(nodePath, "");
  fs.writeFileSync(npmCli, "");

  assert.deepEqual(resolveNpmInstallCommand({ platform: "win32", nodePath }), {
    command: nodePath,
    argsPrefix: [npmCli],
    shell: false,
  });
});

test("falls back to shell npm.cmd on Windows when npm-cli is unavailable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-no-npm-cli-"));
  const nodePath = path.join(dir, "node.exe");
  fs.writeFileSync(nodePath, "");

  assert.deepEqual(resolveNpmInstallCommand({ platform: "win32", nodePath }), {
    command: "npm.cmd",
    argsPrefix: [],
    shell: true,
  });
});

test("runs explicit Windows cmd npm through shell", () => {
  assert.deepEqual(resolveNpmInstallCommand({ platform: "win32", npmCommand: "C:\\Program Files\\nodejs\\npm.cmd" }), {
    command: "C:\\Program Files\\nodejs\\npm.cmd",
    argsPrefix: [],
    shell: true,
  });
});

test("runs explicit Windows Node npm scripts through Node", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-explicit-npm-script-"));
  const nodePath = path.join(dir, "node.exe");
  const npmScript = path.join(dir, "npm-cli.js");
  fs.writeFileSync(nodePath, "");
  fs.writeFileSync(npmScript, "");

  assert.deepEqual(resolveNpmInstallCommand({ platform: "win32", nodePath, npmCommand: npmScript }), {
    command: nodePath,
    argsPrefix: [npmScript],
    shell: false,
  });
});

test("ensure installs missing bundled Pi into cache root once and patches Pi TUI", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-fake-npm-"));
  const cache = path.join(dir, "cache");
  const calls = path.join(dir, "calls.log");
  const fakeNpm = path.join(dir, "fake-npm.js");
  // Node 18+ requires explicit ESM opt-in for .js files using import syntax.
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(fakeNpm, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
fs.appendFileSync(${JSON.stringify(calls)}, process.argv.join(' ') + '\\n');
function pkg(name, files) { const root = path.join(prefix, 'node_modules', ...name.split('/')); fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version: '0.0.0' })); for (const [file, content] of Object.entries(files)) { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); } }
pkg('@earendil-works/pi-coding-agent', { 'dist/cli.js': '', 'node_modules/undici/lib/web/webidl/index.js': 'webidl.util.markAsUncloneable = markAsUncloneable\\n' });
pkg('@earendil-works/pi-ai', { 'dist/index.js': '' });
pkg('@earendil-works/pi-agent-core', { 'dist/index.js': '' });
pkg('@earendil-works/pi-tui', { 'dist/index.js': '', 'dist/stdin-buffer.js': ${JSON.stringify(`const ESC = "\\x1b";
const BRACKETED_PASTE_START = "\\x1b[200~";
const BRACKETED_PASTE_END = "\\x1b[201~";
class StdinBuffer {
  process(data) {
    let str;
    if (Buffer.isBuffer(data)) {
      str = data.toString();
    } else {
      str = data;
    }
        if (str.length === 0 && this.buffer.length === 0) {
            this.emitDataSequence("");
            return;
        }
  }
}
`)} });
pkg('pi-bar', { 'index.ts': '' });
pkg('pi-header', { 'index.ts': '' });
pkg('pi-guard', { 'index.ts': '' });
pkg('@narumitw/pi-goal', { 'src/index.ts': '' });
`);
  fs.chmodSync(fakeNpm, 0o755);
  const options = { platform: "win32", env: { AXUM_BUNDLED_PI_DIR: cache }, npmCommand: fakeNpm };
  ensureBundledPi(options);
  ensureBundledPi(options);
  assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 1);
  assert.equal(fs.existsSync(resolvePiCli(options)), true);
  assert.equal(existingBundledExtensions(options).length, 4);
  const patchedStdinBuffer = fs.readFileSync(path.join(cache, "node_modules", "@earendil-works", "pi-tui", "dist", "stdin-buffer.js"), "utf8");
  assert.match(patchedStdinBuffer, /looksLikeUnbracketedPaste/);
  const patchedUndici = fs.readFileSync(path.join(cache, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "undici", "lib", "web", "webidl", "index.js"), "utf8");
  assert.match(patchedUndici, /AXUM_UNDICI_MARK_AS_UNCLONEABLE_FALLBACK/);
});


test("reinstalls bundled Pi when cached runtime dependency is missing", () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "axum-stale-runtime-"));
  const marker = path.join(cache, "npm-ran");
  const fakeNpm = path.join(cache, "fake-npm.js");
  const writePkg = (root, name, files = {}) => {
    const dir = path.join(root, "node_modules", ...name.split("/"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", type: "module" }));
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(dir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  };

  writePkg(cache, "@earendil-works/pi-coding-agent", {
    "dist/cli.js": "",
  });
  writePkg(cache, "pi-bar", { "index.ts": "" });
  writePkg(cache, "@narumitw/pi-goal", { "src/index.ts": "" });

  fs.writeFileSync(fakeNpm, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const root = process.cwd();
fs.writeFileSync(${JSON.stringify(marker)}, "ran");
function writePkg(name, files = {}) {
  const dir = path.join(root, "node_modules", ...name.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", type: "module" }));
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}
const stdinBuffer = 'const ESC = "\\\\x1b";\\nconst BRACKETED_PASTE_START = "\\\\x1b[200~";\\nconst BRACKETED_PASTE_END = "\\\\x1b[201~";\\nclass StdinBuffer {\\n  process(data) {\\n    let str = Buffer.isBuffer(data) ? data.toString() : data;\\n        if (str.length === 0 && this.buffer.length === 0) {\\n            this.emitDataSequence("");\\n            return;\\n        }\\n  }\\n}\\n';
writePkg("@earendil-works/pi-coding-agent", {
  "dist/cli.js": "",
  "dist/utils/tools-manager.js": "export async function ensureTool() { return undefined; }\\n",
  "node_modules/undici/lib/web/webidl/index.js": "webidl.util.markAsUncloneable = markAsUncloneable\\n",
});
writePkg("@earendil-works/pi-ai", { "dist/index.js": "" });
writePkg("@earendil-works/pi-agent-core", { "dist/index.js": "" });
writePkg("@earendil-works/pi-tui", { "dist/index.js": "", "dist/stdin-buffer.js": stdinBuffer });
writePkg("pi-bar", { "index.ts": "" });
writePkg("pi-header", { "index.ts": "" });
writePkg("pi-guard", { "index.ts": "" });
writePkg("@narumitw/pi-goal", { "src/index.ts": "" });
`);
  fs.chmodSync(fakeNpm, 0o755);
  ensureBundledPi({ env: { AXUM_BUNDLED_PI_DIR: cache }, npmCommand: fakeNpm });

  assert.equal(fs.existsSync(marker), true);
  assert.equal(fs.existsSync(path.join(cache, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js")), true);
});
