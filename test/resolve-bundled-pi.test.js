import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { getBundledPiCacheRoot } from "../src/bundled-pi-cache.js";
import { ensureBundledPi, ensureBundledSkills, npmInstallEnv, pruneStaleCompileCaches, resolveNpmInstallCommand } from "../src/ensure-bundled-pi.js";
import { supportedBundledPiPackages, supportedBundledPiSkills } from "../src/bundled-pi-platform.js";
import { patchPiAgentSessionRateLimitRetry, patchPiAgentSessionConnectionRetry, patchPiHttpIdleTimeoutDefault, patchPiAiRateLimitRetry, patchPiRetryJitter, patchPiAiRetryable422, patchPiAiDeadlineRetryable, patchPiAssistantMessageErrorDedup, patchPiInteractiveErrorDedup, patchPiInteractiveRateLimitDisplay, patchPiGoalAutoResume, patchPiJitiLazyLoader, patchPiTuiStdinBuffer, patchPiVersionNotificationSuppress, patchPiAltScreenScrollOnSubmit, patchUndiciMarkAsUncloneableFallback, PI_RATE_LIMIT_429_PATTERN_SOURCE, PI_CONNECTION_ERROR_PATTERN_SOURCE, PI_CONNECTION_ERROR_PATTERN_LEGACY_SOURCE } from "../src/bundled-pi-patches.js";
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
  writePackage(cache, "pi-hashline-edit-pro", { "index.ts": "" });
  writePackage(cache, "@tintinweb/pi-subagents", { "src/index.ts": "" });
  writePackage(cache, "pi-agent", { "index.ts": "" });
  writePackage(cache, "@ff-labs/pi-fff", { "src/index.ts": "" });

  const piCli = resolvePiCli(options);
  const extensions = resolveBundledExtensions(options);
  assert.equal(piCli, path.join(cache, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"));
  assert.equal(fs.existsSync(piCli), true);
  assert.equal(extensions.length, 9);
  assert.equal(existingBundledExtensions(options).length, 9);
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
  writePackage(cache, "pi-hashline-edit-pro", { "index.ts": "" });
  writePackage(cache, "@tintinweb/pi-subagents", { "src/index.ts": "" });
  writePackage(cache, "pi-agent", { "index.ts": "" });

  const extensions = resolveBundledExtensions(options);
  assert.equal(extensions.length, 8);
  assert.equal(extensions[0], path.join(cache, "node_modules", "pi-bar", "index.ts"));
  assert.equal(extensions[1], path.join(cache, "node_modules", "pi-debug", "index.ts"));
  assert.equal(extensions[2], path.join(cache, "node_modules", "@narumitw", "pi-goal", "src", "index.ts"));
  assert.equal(extensions[3], path.join(cache, "node_modules", "pi-companion", "index.ts"));
  assert.equal(extensions[4], path.join(cache, "node_modules", "pi-web-access", "index.ts"));
  assert.equal(extensions[5], path.join(cache, "node_modules", "pi-hashline-edit-pro", "index.ts"));
  assert.equal(extensions[6], path.join(cache, "node_modules", "@tintinweb", "pi-subagents", "src", "index.ts"));
  assert.equal(extensions[7], path.join(cache, "node_modules", "pi-agent", "index.ts"));
  assert.equal(existingBundledExtensions(options).length, 8);
});

test("Windows excludes bundled extensions that cannot load from published TS sources", () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "axum-bundled-win-cache-"));
  const options = { platform: "win32", env: { AXUM_BUNDLED_PI_DIR: cache } };
  writePackage(cache, "@earendil-works/pi-coding-agent", { "dist/cli.js": "" });
  writePackage(cache, "pi-bar", { "index.ts": "" });
  writePackage(cache, "@narumitw/pi-goal", { "src/index.ts": "" });
  writePackage(cache, "pi-companion", { "index.ts": "" });
  writePackage(cache, "pi-debug", { "index.ts": "" });
  writePackage(cache, "pi-web-access", { "index.ts": "" });
  writePackage(cache, "pi-hashline-edit-pro", { "index.ts": "" });
  writePackage(cache, "pi-agent", { "index.ts": "" });
  writePackage(cache, "@ff-labs/pi-fff", { "src/index.ts": "" });

  const extensions = resolveBundledExtensions(options);
  assert.equal(extensions.length, 6);
  assert.equal(extensions[0], path.join(cache, "node_modules", "pi-bar", "index.ts"));
  assert.equal(extensions[1], path.join(cache, "node_modules", "pi-debug", "index.ts"));
  assert.equal(extensions[2], path.join(cache, "node_modules", "@narumitw", "pi-goal", "src", "index.ts"));
  assert.equal(extensions[3], path.join(cache, "node_modules", "pi-companion", "index.ts"));
  assert.equal(extensions[4], path.join(cache, "node_modules", "pi-hashline-edit-pro", "index.ts"));
  assert.equal(extensions[5], path.join(cache, "node_modules", "pi-agent", "index.ts"));
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
pkg("pi-hashline-edit-pro", { "index.ts": "" });
pkg("pi-agent", { "index.ts": "" });
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
  writePackage(cache, "pi-hashline-edit-pro", { "index.ts": "" });
  writePackage(cache, "pi-agent", { "index.ts": "" });

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
pkg('pi-hashline-edit-pro', { 'index.ts': '' });
pkg('pi-agent', { 'index.ts': '' });
`);
  fs.chmodSync(fakeNpm, 0o755);
  const options = { platform: "win32", env: { AXUM_BUNDLED_PI_DIR: cache }, npmCommand: fakeNpm };
  ensureBundledPi(options);
  ensureBundledPi(options);
  assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 1);
  assert.equal(fs.existsSync(resolvePiCli(options)), true);
  assert.equal(existingBundledExtensions(options).length, 6);
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
  writePkg(cache, "pi-web-access", { "index.ts": "" });
  writePkg(cache, "pi-hashline-edit-pro", { "index.ts": "" });
  writePkg(cache, "@tintinweb/pi-subagents", { "src/index.ts": "" });
  writePkg(cache, "pi-agent", { "index.ts": "" });
  writePkg(cache, "@ff-labs/pi-fff", { "src/index.ts": "" });

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
writePkg("pi-web-access", { "index.ts": "" });
writePkg("pi-hashline-edit-pro", { "index.ts": "" });
writePkg("@tintinweb/pi-subagents", { "src/index.ts": "" });
writePkg("pi-agent", { "index.ts": "" });
writePkg("@ff-labs/pi-fff", { "src/index.ts": "" });
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


test("windows-published TS packages stay excluded when runtime compile would miss dependencies", () => {
  const packages = supportedBundledPiPackages({ platform: "win32", env: {} });
  assert.equal(packages.includes("pi-web-access@0.24.2"), false);
  assert.equal(packages.includes("@ff-labs/pi-fff@0.10.5"), false);
  assert.equal(packages.includes("@tintinweb/pi-subagents@0.19.0"), false);
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

test("patches interactive editor submit to scroll fullscreen transcript to bottom", () => {
  const source = [
    "    setupEditorSubmitHandler() {",
    "        this.defaultEditor.onSubmit = async (text) => {",
    "            text = text.trim();",
    "            if (!text)",
    "                return;",
    "            // Handle commands",
    "            if (text === \"/settings\") {",
    "                this.showSettingsSelector();",
    "            }",
    "        };",
    "    }",
  ].join("\n") + "\n";
  const patched = patchPiAltScreenScrollOnSubmit(source);
  assert.match(patched, /AXUM_PI_ALT_SCREEN_SCROLL_ON_SUBMIT/);
  assert.match(patched, /this\.renderer instanceof TuiAltScreen\) this\.renderer\.scrollToBottom\(\);/);
  const [markerLine, scrollLine, commandLine] = patched.split("\n").slice(5, 9);
  assert.ok(markerLine.includes("AXUM_PI_ALT_SCREEN_SCROLL_ON_SUBMIT"));
  assert.ok(scrollLine.includes("this.renderer.scrollToBottom()"));
  assert.ok(commandLine.includes("// Handle commands"));
  assert.equal(patchPiAltScreenScrollOnSubmit(patched), patched);
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

test("strict 429 pattern matches provider shape and rejects embedded digits", () => {
  const pattern = new RegExp(PI_RATE_LIMIT_429_PATTERN_SOURCE);
  assert.equal(pattern.test('Error: 429: {"message":"Too Many Requests","type":"api_error"}'), true);
  assert.equal(pattern.test("Error: 429: Too Many Requests"), true);
  assert.equal(pattern.test("  429 too many requests"), true);
  assert.equal(pattern.test("429"), false);
  assert.equal(pattern.test("tokens: 4290"), false);
  assert.equal(pattern.test("used 429 requests this hour"), false);
  assert.equal(pattern.test("code 42900 returned"), false);
  assert.equal(pattern.test("Error: 1429: bad gateway"), false);
});

test("patches bundled pi-ai retry loop with strict-429 exemption and fixed delays", () => {
  const I = "        ";
  const J = "            ";
  const vulnerable = [
    "class RetrySleepAbortError extends Error {",
    "}",
    "export async function retryAssistantCall(produce, policy, signal, callbacks) {",
    "    const maxAttempts = policy?.enabled ? policy.maxRetries : 0;",
    "    let attempt = 0;",
    "    let lastRetry;",
    I + "// Non-retryable, or budget exhausted: return the final error message.",
    I + "if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {",
    J + "if (lastRetry)",
    J + "    await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);",
    J + "return response;",
    I + "}",
    I + "attempt++;",
    I + 'lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };',
    I + "const delayMs = policy.baseDelayMs * 2 ** (attempt - 1);",
    I + "await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);",
    J + "    await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);",
  ].join("\n");
  const patched = patchPiAiRateLimitRetry(vulnerable);
  assert.match(patched, /AXUM_PI_429_RETRY_EXEMPT/);
  assert.match(patched, /const RATE_LIMIT_DELAY_MS = 5000;/);
  assert.match(patched, /const RATE_LIMIT_MAX_ATTEMPTS = 30;/);
  assert.match(patched, /const RETRY_JITTER_MS = 1500;/);
  assert.match(patched, /function jitteredDelay\(baseMs\) \{/);
  assert.match(patched, /let rateLimitAttempt = 0;/);
  assert.match(patched, /rateLimitAttempt\+\+;/);
  assert.match(patched, /polic\?y\.baseDelayMs|delayMs = policy\.baseDelayMs;/);
  assert.equal(patched.includes("policy.baseDelayMs * 2 **"), false);
  assert.match(patched, /onRetryScheduled\?\.\(lastRetry\.attempt, scheduledMaxAttempts, delayMs, lastRetry\.errorMessage\)/);
  assert.match(patched, /onRetryFinished\?\.\(false, lastRetry\.attempt, lastRetry\.errorMessage\)/);
  assert.equal(patchPiAiRateLimitRetry(patched), patched);
});

test("patches bundled Pi agent session retry with strict-429 exemption", () => {
  const vulnerable = [
    "export class AgentSession {",
    "    _retryAttempt = 0;",
    "                if (assistantMsg.stopReason !== \"error\" && this._retryAttempt > 0) {",
    "                    this._emit({",
    "                        type: \"auto_retry_end\",",
    "                        success: true,",
    "                        attempt: this._retryAttempt,",
    "                    });",
    "                    this._retryAttempt = 0;",
    "                }",
    "        if (msg.stopReason === \"error\" && this._retryAttempt > 0) {",
    "            this._emit({",
    "                type: \"auto_retry_end\",",
    "                success: false,",
    "                attempt: this._retryAttempt,",
    "                finalError: msg.errorMessage,",
    "            });",
    "            this._retryAttempt = 0;",
    "        }",
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
    "            const attempt = this._retryAttempt;",
    "            this._retryAttempt = 0;",
  ].join("\n");
  const patched = patchPiAgentSessionRateLimitRetry(vulnerable);
  assert.match(patched, /AXUM_PI_429_RETRY_EXEMPT/);
  assert.match(patched, /_rateLimitRetryAttempt = 0;/);
  assert.match(patched, /this\._rateLimitRetryAttempt < RATE_LIMIT_MAX_ATTEMPTS/);
  assert.match(patched, /delayMs = jitteredDelay\(RATE_LIMIT_DELAY_MS\);/);
  assert.match(patched, /delayMs = settings\.baseDelayMs;/);
  assert.equal(patched.includes("settings.baseDelayMs * 2 **"), false);
  assert.equal((patched.match(/_rateLimitRetryAttempt = 0;/g) || []).length, 4);
  assert.equal(patchPiAgentSessionRateLimitRetry(patched), patched);
});

test("upgrades legacy 429 retry patches to jittered delay lanes", () => {
  const legacy = [
    "// AXUM_PI_429_RETRY_EXEMPT: strict-429 lanes exempt from the retry budget.",
    "const RATE_LIMIT_DELAY_MS = 5000;",
    "const CONNECTION_DELAY_MS = 10000;",
    "const RATE_LIMIT_MAX_ATTEMPTS = 30;",
    "async function retryLane() {",
    "    let delayMs = 0;",
    "    delayMs = RATE_LIMIT_DELAY_MS;",
    "    delayMs = RATE_LIMIT_DELAY_MS;",
    "    delayMs = CONNECTION_DELAY_MS;",
    "}",
  ].join("\n");
  // Content without the exemption marker is untouched.
  const untouched = "export async function retry() {}";
  assert.equal(patchPiRetryJitter(untouched), untouched);
  // Content already carrying the jitter block (previously upgraded, or freshly
  // patched by patchPiAiRateLimitRetry/patchPiAgentSessionConnectionRetry) is a no-op.
  const alreadyJittered = [
    "// AXUM_PI_429_RETRY_EXEMPT",
    "const RETRY_JITTER_MS = 1500;",
    "const RATE_LIMIT_MAX_ATTEMPTS = 30;",
  ].join("\n");
  assert.equal(patchPiRetryJitter(alreadyJittered), alreadyJittered);
  // Drift: marker present but the attempts anchor moved.
  assert.throws(() => patchPiRetryJitter("// AXUM_PI_429_RETRY_EXEMPT"), /rate-limit attempts anchor not found/);
  // Drift: attempts anchor present but no fixed rate-limit delay lane.
  const missingDelay = [
    "// AXUM_PI_429_RETRY_EXEMPT",
    "const RATE_LIMIT_MAX_ATTEMPTS = 30;",
  ].join("\n");
  assert.throws(() => patchPiRetryJitter(missingDelay), /rate-limit delay anchor not found/);
  // Upgrade path rewrites every fixed-delay lane to jittered form.
  const upgraded = patchPiRetryJitter(legacy);
  assert.match(upgraded, /\/\/ AXUM_PI_RETRY_JITTER/);
  assert.match(upgraded, /const RETRY_JITTER_MS = 1500;/);
  assert.match(upgraded, /function jitteredDelay\(baseMs\) \{/);
  assert.equal(upgraded.includes("delayMs = RATE_LIMIT_DELAY_MS;"), false);
  assert.equal(upgraded.includes("delayMs = CONNECTION_DELAY_MS;"), false);
  assert.equal((upgraded.match(/delayMs = jitteredDelay\(RATE_LIMIT_DELAY_MS\);/g) || []).length, 2);
  assert.equal((upgraded.match(/delayMs = jitteredDelay\(CONNECTION_DELAY_MS\);/g) || []).length, 1);
  // Re-running on upgraded output is a no-op.
  assert.equal(patchPiRetryJitter(upgraded), upgraded);
});

test("connection error pattern matches transport failures and rejects unrelated errors", () => {
  const pattern = new RegExp(PI_CONNECTION_ERROR_PATTERN_SOURCE, "i");
  assert.equal(pattern.test("Connection error."), true);
  assert.equal(pattern.test("fetch failed"), true);
  assert.equal(pattern.test("connect ECONNRESET 203.0.113.7:443"), true);
  assert.equal(pattern.test("getaddrinfo ENOTFOUND api.example.com"), true);
  assert.equal(pattern.test("socket hang up"), true);
  assert.equal(pattern.test("socket connection was closed unexpectedly"), true);
  assert.equal(pattern.test("client disconnected: context canceled"), true);
  assert.equal(pattern.test("client disconnected: context cancelled"), true);
  assert.equal(pattern.test("context canceled"), true);
  assert.equal(pattern.test("context deadline exceeded"), true);
  assert.equal(pattern.test("Error: context deadline exceeded"), true);
  assert.equal(pattern.test("Post \"https://relay.example.com/v1/chat/completions\": context deadline exceeded (Client.Timeout exceeded while awaiting headers)"), true);
  assert.equal(pattern.test("request timed out"), true);
  assert.equal(pattern.test("stream terminated before completion"), true);
  assert.equal(pattern.test("Error: 429: Too Many Requests"), false);
  assert.equal(pattern.test("insufficient_quota"), false);
  assert.equal(pattern.test("context window exceeded"), false);
});

test("patches bundled Pi agent session retry with connection-error exemption", () => {
  const vulnerable = [
    "export class AgentSession {",
    "    _retryAttempt = 0;",
    "                if (assistantMsg.stopReason !== \"error\" && this._retryAttempt > 0) {",
    "                    this._emit({",
    "                        type: \"auto_retry_end\",",
    "                        success: true,",
    "                        attempt: this._retryAttempt,",
    "                    });",
    "                    this._retryAttempt = 0;",
    "                }",
    "        if (msg.stopReason === \"error\" && this._retryAttempt > 0) {",
    "            this._emit({",
    "                type: \"auto_retry_end\",",
    "                success: false,",
    "                attempt: this._retryAttempt,",
    "                finalError: msg.errorMessage,",
    "            });",
    "            this._retryAttempt = 0;",
    "        }",
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
    "            const attempt = this._retryAttempt;",
    "            this._retryAttempt = 0;",
  ].join("\n");
  const patched = patchPiAgentSessionConnectionRetry(vulnerable);
  assert.match(patched, /AXUM_PI_429_RETRY_EXEMPT/);
  assert.match(patched, /AXUM_PI_CONNECTION_RETRY_EXEMPT/);
  assert.equal((patched.match(/_connectionRetryAttempt = 0;/g) || []).length, 4);
  assert.match(patched, /this\._connectionRetryAttempt < CONNECTION_MAX_ATTEMPTS/);
  assert.match(patched, /delayMs = jitteredDelay\(CONNECTION_DELAY_MS\);/);
  assert.match(patched, /delayMs = jitteredDelay\(RATE_LIMIT_DELAY_MS\);/);
  assert.match(patched, /delayMs = settings\.baseDelayMs;/);
  assert.equal(patched.includes("settings.baseDelayMs * 2 **"), false);
  assert.equal((patched.match(/isConnectionError\(message\.errorMessage\)/g) || []).length, 2);
  assert.equal(patchPiAgentSessionConnectionRetry(patched), patched);
});

test("upgrades stale connection-exemption caches to the deadline-aware pattern", () => {
  const legacyV1 = "connection.?(error|refused|reset|lost)|fetch.?failed|ECONN(?:RESET|REFUSED)|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket.?(hang.?up|connection.?was.?closed)|other.?side.?closed|upstream.?connect|reset.?before.?headers|timed?.?out|timeout|terminated|network.?error";
  for (const legacy of [PI_CONNECTION_ERROR_PATTERN_LEGACY_SOURCE, legacyV1]) {
    const stale = [
      "// AXUM_PI_CONNECTION_RETRY_EXEMPT: transport/connection errors retry on a",
      `    return typeof errorMessage === \"string\" && /${legacy}/i.test(errorMessage);`,
    ].join("\n");
    const upgraded = patchPiAgentSessionConnectionRetry(stale);
    assert.ok(upgraded.includes("context.?deadline.?exceeded"));
    assert.ok(upgraded.includes(`/${PI_CONNECTION_ERROR_PATTERN_SOURCE}/i.test`));
    assert.equal(patchPiAgentSessionConnectionRetry(upgraded), upgraded);
  }
  assert.throws(
    () => patchPiAgentSessionConnectionRetry("// AXUM_PI_CONNECTION_RETRY_EXEMPT\nno pattern anchor here"),
    /legacy pattern anchor not found/,
  );
});

test("throws when bundled retry anchors drift from expected shapes", () => {
  assert.throws(() => patchPiAiRateLimitRetry("export async function retryAssistantCall() {}"), /RetrySleepAbortError anchor not found/);
  assert.throws(() => patchPiAgentSessionRateLimitRetry("class SomethingElse {}"), /class anchor not found/);
  assert.throws(() => patchPiAgentSessionConnectionRetry("class SomethingElse {}"), /class anchor not found/);
  assert.throws(() => patchPiRetryJitter("// AXUM_PI_429_RETRY_EXEMPT"), /rate-limit attempts anchor not found/);
  assert.throws(() => patchPiRetryJitter(["// AXUM_PI_429_RETRY_EXEMPT", "const RATE_LIMIT_MAX_ATTEMPTS = 30;"].join("\n")), /rate-limit delay anchor not found/);
});

test("patches bundled Pi interactive mode to soften 429 display", () => {
  const I12 = " ".repeat(12);
  const I16 = " ".repeat(16);
  const I20 = " ".repeat(20);
  const I24 = " ".repeat(24);
  const vulnerable = [
    "export class InteractiveMode {",
    I16 + "else if (event.errorMessage) {",
    I20 + 'if (event.reason === "manual") {',
    I24 + "this.showError(event.errorMessage);",
    I20 + "}",
    I20 + "else {",
    I24 + "this.chatContainer.addChild(new Spacer(1));",
    I24 + 'this.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));',
    I20 + "}",
    I16 + "}",
    I12 + 'case "auto_retry_end": {',
    I16 + "if (!event.success) {",
    I20 + 'this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);',
    I16 + "}",
    I16 + "this.ui.requestRender();",
    I12 + 'case "summarization_retry_scheduled": {',
    I16 + "this.showError(event.errorMessage);",
    I16 + "this.showStatusIndicator(new RetryStatusIndicator(this.ui, event.attempt, event.maxAttempts, event.delayMs));",
  ].join("\n");
  const patched = patchPiInteractiveRateLimitDisplay(vulnerable);
  assert.match(patched, /AXUM_PI_429_DISPLAY_SOFTENING/);
  assert.match(patched, /AXUM_RATE_LIMIT_429_NOTICE/);
  assert.match(patched, /isAxumRateLimit429Message\(event\.errorMessage\)/);
  assert.match(patched, /isAxumRateLimit429Message\(event\.finalError\)/);
  assert.equal(patchPiInteractiveRateLimitDisplay(patched), patched);
});

test("patches bundled pi-ai retryability to treat strict 422/520 gateway transients as retryable", () => {
  const vulnerable = [
    "export function isRetryableAssistantError(message) {",
    '    if (message.stopReason !== "error" || !message.errorMessage)',
    "        return false;",
    "    const errorMessage = message.errorMessage;",
    "    return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);",
    "}",
  ].join("\n");
  const patched = patchPiAiRetryable422(vulnerable);
  assert.match(patched, /AXUM_PI_422_RETRYABLE/);
  assert.match(patched, /STRICT_TRANSIENT_STATUS_PATTERN/);
  assert.match(patched, /if \(STRICT_TRANSIENT_STATUS_PATTERN\.test\(errorMessage\)\)/);
  assert.equal(patchPiAiRetryable422(patched), patched);
  assert.throws(() => patchPiAiRetryable422("nothing here"), /isRetryableAssistantError anchor not found/);
});

test("patches bundled pi-ai retryability to keep relay deadline aborts retryable", () => {
  const vulnerable = [
    "export function isRetryableAssistantError(message) {",
    '    if (message.stopReason !== "error" || !message.errorMessage)',
    "        return false;",
    "    const errorMessage = message.errorMessage;",
    "    return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);",
    "}",
  ].join("\n");
  const patched = patchPiAiDeadlineRetryable(vulnerable);
  assert.match(patched, /AXUM_PI_DEADLINE_RETRYABLE/);
  assert.match(patched, /if \(\/context\.\?deadline\.\?exceeded\/i\.test\(errorMessage\)\)/);
  assert.equal(patchPiAiDeadlineRetryable(patched), patched);
  assert.throws(() => patchPiAiDeadlineRetryable("nothing here"), /deadline retry: retryable return anchor not found/);

  const currentEra = [
    "// AXUM_PI_422_RETRYABLE: gateway-originated transient statuses",
    "const STRICT_TRANSIENT_STATUS_PATTERN = /^\\s*(?:Error:\\s*)?(?:422|520)[:\\s]/;",
    "export function isRetryableAssistantError(message) {",
    "    const errorMessage = message.errorMessage;",
    "    if (STRICT_TRANSIENT_STATUS_PATTERN.test(errorMessage))",
    "        return true;",
    "    return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);",
    "}",
  ].join("\n");
  const upgraded = patchPiAiRetryable422(currentEra);
  assert.match(upgraded, /AXUM_PI_DEADLINE_RETRYABLE/);
  assert.equal((upgraded.match(/AXUM_PI_422_RETRYABLE/g) || []).length, 1);
  assert.equal((upgraded.match(/RETRYABLE_PROVIDER_ERROR_PATTERN\.test\(errorMessage\)/g) || []).length, 1);
  assert.equal(patchPiAiRetryable422(upgraded), upgraded);
});

test("patches bundled Pi interactive mode to dedupe consecutive identical errors", () => {
  const vulnerable = [
    "    showError(errorMessage) {",
    "        this.chatContainer.addChild(new Spacer(1));",
    "        this.chatContainer.addChild(new Text(theme.fg(\"error\", `Error: ${errorMessage}`), this.outputPad, 0));",
    "        this.ui.requestRender();",
    "    }",
  ].join("\n");
  const patched = patchPiInteractiveErrorDedup(vulnerable);
  assert.match(patched, /AXUM_PI_ERROR_DEDUP/);
  assert.match(patched, /_axumLastShownError/);
  assert.match(patched, /if \(errorMessage === this\._axumLastShownError\)/);
  assert.equal(patchPiInteractiveErrorDedup(patched), patched);
  assert.throws(() => patchPiInteractiveErrorDedup("class X {}"), /showError anchor not found/);
});

test("upgrades an existing 422-only patch to the combined 422/520 transient pattern", () => {
  const legacy = [
    "// AXUM_PI_422_RETRYABLE: transient 422s from flaky provider gateways",
    "const STRICT_422_PATTERN = /^\\s*(?:Error:\\s*)?422[:\\s]/;",
    "export function isRetryableAssistantError(message) {",
    "    if (STRICT_422_PATTERN.test(errorMessage))",
    "        return true;",
    "    return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);",
    "}",
  ].join("\n");
  const upgraded = patchPiAiRetryable422(legacy);
  assert.match(upgraded, /STRICT_TRANSIENT_STATUS_PATTERN/);
  assert.match(upgraded, /422\|520/);
  assert.ok(!upgraded.includes("STRICT_422_PATTERN"));
  assert.equal(patchPiAiRetryable422(upgraded), upgraded);
});

test("patches bundled Pi assistant message to dedupe consecutive identical failures", () => {
  const vulnerable = [
    "export class AssistantMessageComponent extends Container {",
    "    render() {",
    "        // ...",
    '                this.contentContainer.addChild(new Spacer(1));',
    '                this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));',
    "        // ...",
    '                this.contentContainer.addChild(new Spacer(1));',
    '                this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));',
    "    }",
    "}",
  ].join("\n");
  const patched = patchPiAssistantMessageErrorDedup(vulnerable);
  assert.match(patched, /AXUM_PI_ASSISTANT_ERROR_DEDUP/);
  assert.match(patched, /axumLastBubbleFailure = undefined/);
  assert.match(patched, /if \(axumLastBubbleFailure !== `aborted:\$\{abortMessage\}`\)/);
  assert.match(patched, /if \(axumLastBubbleFailure !== `error:\$\{errorMsg\}`\)/);
  assert.equal(patchPiAssistantMessageErrorDedup(patched), patched);
  assert.throws(() => patchPiAssistantMessageErrorDedup("class X {}"), /class anchor not found/);
});

test("patches bundled Pi http dispatcher to a disabled body timeout default", () => {
  const source = [
    'import * as undici from "undici";',
    "export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;",
    "        bodyTimeout: normalizedTimeoutMs,",
    "        headersTimeout: normalizedTimeoutMs,",
    "export function configureHttpDispatcher() {}",
  ].join("\n");
  const patched = patchPiHttpIdleTimeoutDefault(source);
  assert.notEqual(patched, source, "patch should change the source");
  assert.match(patched, /AXUM_PI_HTTP_IDLE_TIMEOUT_BODY_DISABLED/);
  assert.match(patched, /DEFAULT_HTTP_IDLE_TIMEOUT_MS = 0;/);
  assert.match(patched, /HTTP_HEADERS_TIMEOUT_CAP_MS = 120_000;/);
  assert.match(patched, /bodyTimeout: normalizedTimeoutMs,/);
  assert.match(patched, /headersTimeout: normalizedTimeoutMs > 0 \? Math\.min\(normalizedTimeoutMs, HTTP_HEADERS_TIMEOUT_CAP_MS\) : HTTP_HEADERS_TIMEOUT_CAP_MS,/);
  assert.doesNotMatch(patched, /300_000/);
  // Idempotent: a second run leaves the patched output untouched.
  assert.equal(patchPiHttpIdleTimeoutDefault(patched), patched);
  // Anchor drift upstream must fail loudly instead of silently skipping.
  const drifted = source.replace("300_000", "600_000");
  assert.throws(() => patchPiHttpIdleTimeoutDefault(drifted), /idle timeout default anchor not found/);
  const driftedHeaders = source.replace("headersTimeout: normalizedTimeoutMs,", "headersTimeout: 0,");
  assert.throws(() => patchPiHttpIdleTimeoutDefault(driftedHeaders), /headers timeout anchor not found/);
});

test("upgrades the legacy 45s idle timeout patch to the disabled body default in place", () => {
  const legacyPatched = [
    'import * as undici from "undici";',
    "// AXUM_PI_HTTP_IDLE_TIMEOUT_45S: upstream-cancelled streams that never close must",
    "export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 45_000;",
    "        headersTimeout: normalizedTimeoutMs,",
  ].join("\n");
  const upgraded = patchPiHttpIdleTimeoutDefault(legacyPatched);
  assert.match(upgraded, /AXUM_PI_HTTP_IDLE_TIMEOUT_BODY_DISABLED/);
  assert.doesNotMatch(upgraded, /AXUM_PI_HTTP_IDLE_TIMEOUT_45S/);
  assert.match(upgraded, /DEFAULT_HTTP_IDLE_TIMEOUT_MS = 0;/);
  assert.doesNotMatch(upgraded, /45_000/);
  assert.match(upgraded, /HTTP_HEADERS_TIMEOUT_CAP_MS = 120_000;/);
  assert.match(upgraded, /headersTimeout: normalizedTimeoutMs > 0 \? Math\.min/);
  assert.equal(patchPiHttpIdleTimeoutDefault(upgraded), upgraded);
});

test("upgrades the legacy 120s idle timeout patch to the disabled body default in place", () => {
  const legacyPatched = [
    'import * as undici from "undici";',
    "// AXUM_PI_HTTP_IDLE_TIMEOUT_120S: keep idle streams bounded so",
    "// upstream-cancelled sockets surface as retryable body timeouts instead",
    "export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 120_000;",
    "        headersTimeout: normalizedTimeoutMs,",
  ].join("\n");
  const upgraded = patchPiHttpIdleTimeoutDefault(legacyPatched);
  assert.match(upgraded, /AXUM_PI_HTTP_IDLE_TIMEOUT_BODY_DISABLED/);
  assert.doesNotMatch(upgraded, /AXUM_PI_HTTP_IDLE_TIMEOUT_120S/);
  assert.match(upgraded, /DEFAULT_HTTP_IDLE_TIMEOUT_MS = 0;/);
  assert.doesNotMatch(upgraded, /DEFAULT_HTTP_IDLE_TIMEOUT_MS = 120_000;/);
  assert.match(upgraded, /headersTimeout: normalizedTimeoutMs > 0 \? Math\.min/);
  assert.equal(patchPiHttpIdleTimeoutDefault(upgraded), upgraded);
});

test("upgrades the legacy disabled idle timeout patch and adds the headers cap", () => {
  const disabledPatched = [
    'import * as undici from "undici";',
    "// AXUM_PI_HTTP_IDLE_TIMEOUT_DISABLED: never abort streams client-side",
    "export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 0;",
    "        headersTimeout: normalizedTimeoutMs,",
  ].join("\n");
  const upgraded = patchPiHttpIdleTimeoutDefault(disabledPatched);
  assert.match(upgraded, /AXUM_PI_HTTP_IDLE_TIMEOUT_BODY_DISABLED/);
  assert.doesNotMatch(upgraded, /AXUM_PI_HTTP_IDLE_TIMEOUT_DISABLED/);
  assert.match(upgraded, /DEFAULT_HTTP_IDLE_TIMEOUT_MS = 0;/);
  assert.match(upgraded, /HTTP_HEADERS_TIMEOUT_CAP_MS = 120_000;/);
  assert.match(upgraded, /headersTimeout: normalizedTimeoutMs > 0 \? Math\.min/);
  assert.equal(patchPiHttpIdleTimeoutDefault(upgraded), upgraded);
});

