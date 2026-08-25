import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { getBundledPiCacheRoot } from "../src/bundled-pi-cache.js";
import { ensureBundledPi, ensureBundledSkills, npmInstallEnv, pruneStaleCompileCaches, resolveNpmInstallCommand } from "../src/ensure-bundled-pi.js";
import { supportedBundledPiSkills } from "../src/bundled-pi-platform.js";
import { patchPiGoalAutoResume, patchPiHljsLazy, patchPiJitiLazyLoader, patchPiTuiStdinBuffer, patchPiVersionNotificationSuppress, patchUndiciMarkAsUncloneableFallback } from "../src/bundled-pi-patches.js";
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
  writePackage(cache, "@narumitw/pi-goal", { "src/index.ts": "" });
  writePackage(cache, "pi-companion", { "index.ts": "" });
  writePackage(cache, "pi-debug", { "index.ts": "" });
  writePackage(cache, "pi-web-access", { "index.ts": "" });
  writePackage(cache, "@ff-labs/pi-fff", { "src/index.ts": "" });

  const piCli = resolvePiCli(options);
  const extensions = resolveBundledExtensions(options);
  assert.equal(piCli, path.join(cache, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"));
  assert.equal(fs.existsSync(piCli), true);
  assert.equal(extensions.length, 6);
  assert.equal(existingBundledExtensions(options).length, 6);
});

test("checks available Pi extensions on Android", () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "axum-bundled-android-cache-"));
  const options = { platform: "android", env: { AXUM_BUNDLED_PI_DIR: cache } };
  writePackage(cache, "@earendil-works/pi-coding-agent", { "dist/cli.js": "" });
  writePackage(cache, "pi-bar", { "index.ts": "" });
  writePackage(cache, "@narumitw/pi-goal", { "src/index.ts": "" });
  writePackage(cache, "pi-companion", { "index.ts": "" });
  writePackage(cache, "pi-debug", { "index.ts": "" });
  writePackage(cache, "pi-web-access", { "index.ts": "" });

  const extensions = resolveBundledExtensions(options);
  assert.equal(extensions.length, 5);
  assert.equal(extensions[0], path.join(cache, "node_modules", "pi-bar", "index.ts"));
  assert.equal(extensions[1], path.join(cache, "node_modules", "pi-debug", "index.ts"));
  assert.equal(extensions[2], path.join(cache, "node_modules", "@narumitw", "pi-goal", "src", "index.ts"));
  assert.equal(extensions[3], path.join(cache, "node_modules", "pi-companion", "index.ts"));
  assert.equal(extensions[4], path.join(cache, "node_modules", "pi-web-access", "index.ts"));
  assert.equal(existingBundledExtensions(options).length, 5);
});

test("Windows loads same extension set as other platforms", () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "axum-bundled-win-cache-"));
  const options = { platform: "win32", env: { AXUM_BUNDLED_PI_DIR: cache } };
  writePackage(cache, "@earendil-works/pi-coding-agent", { "dist/cli.js": "" });
  writePackage(cache, "pi-bar", { "index.ts": "" });
  writePackage(cache, "@narumitw/pi-goal", { "src/index.ts": "" });
  writePackage(cache, "pi-companion", { "index.ts": "" });
  writePackage(cache, "pi-debug", { "index.ts": "" });
  writePackage(cache, "pi-web-access", { "index.ts": "" });
  writePackage(cache, "@ff-labs/pi-fff", { "src/index.ts": "" });

  const extensions = resolveBundledExtensions(options);
  assert.equal(extensions.length, 6);
  assert.equal(extensions[0], path.join(cache, "node_modules", "pi-bar", "index.ts"));
  assert.equal(extensions[1], path.join(cache, "node_modules", "pi-debug", "index.ts"));
  assert.equal(extensions[2], path.join(cache, "node_modules", "@narumitw", "pi-goal", "src", "index.ts"));
  assert.equal(extensions[3], path.join(cache, "node_modules", "pi-companion", "index.ts"));
  assert.equal(extensions[4], path.join(cache, "node_modules", "pi-web-access", "index.ts"));
  assert.equal(extensions[5], path.join(cache, "node_modules", "@ff-labs", "pi-fff", "src", "index.ts"));
  assert.equal(existingBundledExtensions(options).length, 6);
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
pkg("@narumitw/pi-goal", { "src/index.ts": "" });
pkg("pi-debug", { "index.ts": "" });
pkg("pi-companion", { "index.ts": "" });
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

test("ensureBundledPi rewrites malformed bundled chalk stubs on ready caches", () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "axum-bundled-chalk-"));
  const options = { platform: "win32", env: { AXUM_BUNDLED_PI_DIR: cache } };
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

  writePackage(cache, "@earendil-works/pi-coding-agent", {
    "dist/cli.js": "",
    "node_modules/chalk/index.js": "module.exports = {\n  reset: ((t) => t)\n  bold: ((t) => t)\n};\n",
    "node_modules/chalk/package.json": JSON.stringify({ name: "chalk", version: "5.5.1", type: "module", main: "index.js" }),
  });
  writePackage(cache, "@earendil-works/pi-ai", { "dist/index.js": "" });
  writePackage(cache, "@earendil-works/pi-agent-core", { "dist/index.js": "" });
  writePackage(cache, "@earendil-works/pi-tui", { "dist/index.js": "", "dist/stdin-buffer.js": stdinBuffer });
  writePackage(cache, "pi-bar", { "index.ts": "" });
  writePackage(cache, "@narumitw/pi-goal", { "src/index.ts": "" });
  writePackage(cache, "pi-companion", { "index.ts": "" });
  writePackage(cache, "pi-debug", { "index.ts": "" });

  ensureBundledPi(options);

  const chalkRoot = path.join(cache, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "chalk");
  const chalkIndex = path.join(chalkRoot, "index.js");
  const chalkPkg = JSON.parse(fs.readFileSync(path.join(chalkRoot, "package.json"), "utf8"));
  const chalkSource = fs.readFileSync(chalkIndex, "utf8");
  const require = createRequire(import.meta.url);
  const chalk = require(chalkIndex);

  assert.equal(chalkPkg.type, "commonjs");
  assert.doesNotThrow(() => new Function(chalkSource));
  assert.match(chalkSource, /reset[\s\S]*,\n[\s\S]*bold/);
  assert.equal(chalk.bold("x"), "\x1b[1mx");
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
  assert.doesNotMatch(root, /earendil|google|hermes|optimizer/);
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

test("patches pi-goal to auto-resume at the continuation-limit checkpoint", () => {
  const T = "\t";
  const source = [
    T + "pauseGoalForSafety(ctx: StatusContext, cause: SafetyPauseCause, abortTurn: boolean) {",
    T + T + "const goal = this.activeGoal;",
    T + T + "if (goal?.status !== \"active\") return false;",
    T + T + "this.cancelContinuationWork();",
    T + T + "this.clearGoalRecoveryForGoal(goal.id);",
    T + T + "this.clearBudgetWrapUp();",
    T + T + "this.blockStaleGoalToolCalls();",
    T + T + "this.activeGoal = transitionGoal({ ...goal, safetyPauseCause: cause }, \"paused\");",
    "}",
  ].join("\n");

  const patched = patchPiGoalAutoResume(source);
  assert.notEqual(patched, source, "patch should change the source");
  assert.match(patched, /AXUM_PI_GOAL_AUTO_RESUME/);
  // Auto-resume branch injected on continuation_limit and no_progress.
  assert.match(patched, /cause === \"continuation_limit\" \|\| cause === \"no_progress\"/);
  assert.match(patched, /autoResumeOnContinuationLimit/);
  assert.match(patched, /autoResumeOnNoProgress/);
  // Auto-resume runs unconditionally (no maxAutoResumes cap).
  assert.match(patched, /autoResumeCount = Math\.max\(0, Math\.floor\(Number\(\(goal as any\)\[\w+\] \?\? 0\)\)\)/);
  assert.match(patched, /axumAutoResumeCount/);
  assert.match(patched, /axumNoProgressAutoResumeCount/);
  assert.match(patched, /goal\.automaticModelTurns = 0/);
  assert.match(patched, /goal\.toolFreeRepeatCount = 0/);
  assert.match(patched, /goal\.lastToolFreeOutputFingerprint = undefined/);
  assert.match(patched, /dispatchContinuationIfSettled\(ctx\)/);
  assert.match(patched, /requestContinuation\(goal\)/);
  // No path should reach the "pausing for manual confirmation" warn branch.
  assert.doesNotMatch(patched, /pausing for manual confirmation/);
  // Original pause body still present after the branch.
  assert.match(patched, /transitionGoal\(\{ \.\.\.goal, safetyPauseCause: cause \}, \"paused\"\)/);
  // Idempotent.
  assert.equal(patchPiGoalAutoResume(patched), patched);
  // Unknown block shape is left untouched rather than crashing.
  const reshaped = source.replace("if (goal?.status !== \"active\") return false;", "if (goal?.status !== \"active\") return;");
  assert.equal(patchPiGoalAutoResume(reshaped), reshaped);
});

test("upgrades old pi-goal auto-resume patch to cover no-progress pauses", () => {
  const T = "\t";
  const oldPatched = [
    T + "pauseGoalForSafety(ctx: StatusContext, cause: SafetyPauseCause, abortTurn: boolean) {",
    T + T + "const goal = this.activeGoal;",
    T + T + "if (goal?.status !== \"active\") return false;",
    T + T + "// AXUM_PI_GOAL_AUTO_RESUME: auto-resume at the automatic-turns",
    T + T + "if (cause === \"continuation_limit\") {",
    T + T + T + "if (this.settings?.autoResumeOnContinuationLimit !== false) {",
    T + T + T + T + "goal.automaticModelTurns = 0;",
    T + T + T + T + "this.requestContinuation(goal);",
    T + T + T + T + "return false;",
    T + T + T + "}",
    T + T + "}",
    T + T + "this.cancelContinuationWork();",
    T + T + "this.clearGoalRecoveryForGoal(goal.id);",
    T + T + "this.clearBudgetWrapUp();",
    T + T + "this.blockStaleGoalToolCalls();",
    T + T + "this.activeGoal = transitionGoal({ ...goal, safetyPauseCause: cause }, \"paused\");",
    "}",
  ].join("\n");

  const upgraded = patchPiGoalAutoResume(oldPatched);
  assert.notEqual(upgraded, oldPatched, "old marker-only patch should be upgraded");
  assert.match(upgraded, /autoResumeOnNoProgress/);
  assert.match(upgraded, /goal\.toolFreeRepeatCount = 0/);
  assert.match(upgraded, /goal\.lastToolFreeOutputFingerprint = undefined/);
  assert.match(upgraded, /transitionGoal\(\{ \.\.\.goal, safetyPauseCause: cause \}, "paused"\)/);
  assert.equal(patchPiGoalAutoResume(upgraded), upgraded);
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
pkg('@narumitw/pi-goal', { 'src/index.ts': '' });
pkg('pi-debug', { 'index.ts': '' });
pkg('pi-companion', { 'index.ts': '' });
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
  writePkg(cache, "pi-debug", { "index.ts": "" });
  writePkg(cache, "pi-companion", { "index.ts": "" });

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
writePkg("@narumitw/pi-goal", { "src/index.ts": "" });
  writePkg("pi-debug", { "index.ts": "" });
writePkg("pi-companion", { "index.ts": "" });
`);
  fs.chmodSync(fakeNpm, 0o755);
  ensureBundledPi({ env: { AXUM_BUNDLED_PI_DIR: cache }, npmCommand: fakeNpm });

  assert.equal(fs.existsSync(marker), true);
  assert.equal(fs.existsSync(path.join(cache, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js")), true);
});

test("ensureBundledSkills syncs bundled skills to agent skills root", async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "axum-skills-sync-"));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "axum-home-"));
  for (const { packageName, skillPath } of supportedBundledPiSkills({ platform: "linux" })) {
    const fileName = path.basename(skillPath);
    const skillDir = path.join(cache, "node_modules", ...packageName.split("/"), skillPath);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `SKILL:${packageName}:${fileName}`);
  }
  const originalHomedir = os.homedir;
  os.homedir = () => fakeHome;
  try {
    ensureBundledSkills(cache, { platform: "linux", env: {} });
    assert.equal(
      fs.existsSync(path.join(fakeHome, ".agents", "skills")),
      false
    );
  } finally {
    os.homedir = originalHomedir;
  }
});


test("patches bundled Pi syntax highlight to lazy-load highlight.js", () => {
  const source = 'import hljs from "highlight.js/lib/index.js";\nexport function highlight(code, options = {}) {\n    const html = options.language\n        ? hljs.highlight(code, {\n            language: options.language,\n        })\n        : hljs.highlightAuto(code, options.languageSubset).value;\n    return html;\n}\nexport function supportsLanguage(name) {\n    return hljs.getLanguage(name) !== undefined;\n}\n';
  const patched = patchPiHljsLazy(source);
  assert.match(patched, /AXUM_HLJS_LAZY/);
  assert.match(patched, /createRequire\(import\.meta\.url\)/);
  assert.match(patched, /getHljs\(\)\.highlight\(code, \{/);
  assert.match(patched, /getHljs\(\)\.highlightAuto\(code, options\.languageSubset\)/);
  assert.match(patched, /getHljs\(\)\.getLanguage\(name\)/);
  assert.doesNotMatch(patched, /^import hljs from/m);
  assert.equal(patchPiHljsLazy(patched), patched);
});

test("patches bundled Pi extension loader for native JS entries and lazy jiti", () => {
  const source = [
    'import * as fs from "node:fs";',
    'import { createJiti } from "jiti/static";',
    "async function loadExtensionModule(extensionPath, cacheToken) {",
    "    const jiti = createJiti(import.meta.url, {",
    "        moduleCache: false,",
    "    });",
    '    const module = await jiti.import(extensionPath, { default: true });',
    "}",
  ].join("\n") + "\n";
  const patched = patchPiJitiLazyLoader(source);
  assert.match(patched, /AXUM_JITI_LAZY_LOADER/g);
  assert.match(patched, /extensionPath\.endsWith\("\.ts"\)/);
  assert.match(patched, /pathToFileURL\(extensionPath\)/);
  assert.doesNotMatch(patched, /^import \{ createJiti \} from "jiti\/static";/m);
  assert.match(patched, /const \{ createJiti \} = await import\("jiti\/static"\);/);
  assert.equal(patchPiJitiLazyLoader(patched), patched);
});

test("prunes stale v8-compile-cache directories for other Node versions", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "axum-v8-cache-"));
  const stale = path.join(tmp, `v8-compile-cache-v20.0.0`);
  const current = path.join(tmp, `v8-compile-cache-${process.version}`);
  const untouched = path.join(tmp, "pi-70a28339cc67");
  fs.mkdirSync(stale, { recursive: true });
  fs.mkdirSync(current, { recursive: true });
  fs.mkdirSync(untouched, { recursive: true });

  const removed = pruneStaleCompileCaches(tmp);

  assert.deepEqual(removed, [`v8-compile-cache-v20.0.0`]);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(current), true);
  assert.equal(fs.existsSync(untouched), true);
});
