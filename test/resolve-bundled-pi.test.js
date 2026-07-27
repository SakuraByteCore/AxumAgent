import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getBundledPiCacheRoot } from "../src/bundled-pi-cache.js";
import { ensureBundledPi, npmInstallEnv, resolveNpmInstallCommand } from "../src/ensure-bundled-pi.js";
import { patchPiTuiStdinBuffer } from "../src/bundled-pi-patches.js";
import { resolvePiCli, resolveBundledExtensions, existingBundledExtensions } from "../src/resolve-bundled-pi.js";

function writePackage(root, name, files = {}) {
  const dir = path.join(root, "node_modules", ...name.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0" }));
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
  writePackage(cache, "pi-subagents", { "index.ts": "" });
  writePackage(cache, "pi-hermes-memory", { "src/index.ts": "" });
  writePackage(cache, "pi-rtk-optimizer", { "index.ts": "" });
  writePackage(cache, "@narumitw/pi-statusline", { "src/index.ts": "" });
  writePackage(cache, "@juicesharp/rpiv-todo", { "index.ts": "" });

  const piCli = resolvePiCli(options);
  const extensions = resolveBundledExtensions(options);
  assert.equal(piCli, path.join(cache, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"));
  assert.equal(fs.existsSync(piCli), true);
  assert.equal(extensions.length, 5);
  assert.equal(existingBundledExtensions(options).length, 5);
});

test("Android loads hermes-memory and rtk-optimizer alongside subagents", () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "axum-bundled-android-cache-"));
  const options = { platform: "android", env: { AXUM_BUNDLED_PI_DIR: cache } };
  writePackage(cache, "@earendil-works/pi-coding-agent", { "dist/cli.js": "" });
  writePackage(cache, "pi-subagents", { "index.ts": "" });
  writePackage(cache, "pi-hermes-memory", { "src/index.ts": "" });
  writePackage(cache, "pi-rtk-optimizer", { "index.ts": "" });
  writePackage(cache, "@narumitw/pi-statusline", { "src/index.ts": "" });
  writePackage(cache, "@juicesharp/rpiv-todo", { "index.ts": "" });

  const extensions = resolveBundledExtensions(options);
  assert.equal(extensions.length, 5);
  assert.equal(extensions[0], path.join(cache, "node_modules", "pi-subagents", "index.ts"));
  assert.equal(extensions[1], path.join(cache, "node_modules", "pi-hermes-memory", "src", "index.ts"));
  assert.equal(extensions[2], path.join(cache, "node_modules", "pi-rtk-optimizer", "index.ts"));
  assert.equal(extensions[3], path.join(cache, "node_modules", "@narumitw", "pi-statusline", "src", "index.ts"));
  assert.equal(extensions[4], path.join(cache, "node_modules", "@juicesharp", "rpiv-todo", "index.ts"));
  assert.equal(existingBundledExtensions(options).length, 5);
});

test("Windows skips rtk-optimizer and pi-fff extension resolution", () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "axum-bundled-win-cache-"));
  const options = { platform: "win32", env: { AXUM_BUNDLED_PI_DIR: cache } };
  writePackage(cache, "@earendil-works/pi-coding-agent", { "dist/cli.js": "" });
  writePackage(cache, "pi-subagents", { "index.ts": "" });
  writePackage(cache, "pi-hermes-memory", { "src/index.ts": "" });
  writePackage(cache, "@narumitw/pi-statusline", { "src/index.ts": "" });
  writePackage(cache, "@juicesharp/rpiv-todo", { "index.ts": "" });

  const extensions = resolveBundledExtensions(options);
  assert.equal(extensions.length, 4);
  assert.equal(extensions[0], path.join(cache, "node_modules", "pi-subagents", "index.ts"));
  assert.equal(extensions[1], path.join(cache, "node_modules", "pi-hermes-memory", "src", "index.ts"));
  assert.equal(extensions[2], path.join(cache, "node_modules", "@narumitw", "pi-statusline", "src", "index.ts"));
  assert.equal(extensions[3], path.join(cache, "node_modules", "@juicesharp", "rpiv-todo", "index.ts"));
  assert.equal(existingBundledExtensions(options).length, 4);
});

test("cache root is stable and short outside npm package install directory", () => {
  const env = { XDG_CACHE_HOME: "/tmp/axum-cache-home" };
  const root = getBundledPiCacheRoot({ env, platform: "linux", arch: "x64" });
  assert.match(root, /^\/tmp\/axum-cache-home\/axum-agent\/bundled-pi\/v3\/linux-x64\/pi-[a-f0-9]{12}$/);
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
  assert.match(root.replaceAll("\\", "/"), /\/axum-agent\/bundled-pi\/v3\/win32-x64\/pi-[a-f0-9]{12}$/);
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

test("keeps explicit non-cmd npm command shell-free", () => {
  assert.deepEqual(resolveNpmInstallCommand({ platform: "win32", npmCommand: "C:\\tools\\npm-cli.js" }), {
    command: "C:\\tools\\npm-cli.js",
    argsPrefix: [],
    shell: false,
  });
});

test("ensure installs missing bundled Pi into cache root once and patches Pi TUI", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-fake-npm-"));
  const cache = path.join(dir, "cache");
  const calls = path.join(dir, "calls.log");
  const fakeNpm = path.join(dir, "fake-npm.js");
  fs.writeFileSync(fakeNpm, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
fs.appendFileSync(${JSON.stringify(calls)}, process.argv.join(' ') + '\\n');
function pkg(name, files) { const root = path.join(prefix, 'node_modules', ...name.split('/')); fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version: '0.0.0' })); for (const [file, content] of Object.entries(files)) { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); } }
pkg('@earendil-works/pi-coding-agent', { 'dist/cli.js': '' });
pkg('@earendil-works/pi-tui', { 'dist/stdin-buffer.js': ${JSON.stringify(`const ESC = "\\x1b";
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
pkg('pi-subagents', { 'index.ts': '' });
pkg('pi-hermes-memory', { 'src/index.ts': '' });
pkg('pi-rtk-optimizer', { 'index.ts': '' });
pkg('@narumitw/pi-statusline', { 'src/index.ts': '' });
pkg('@juicesharp/rpiv-todo', { 'index.ts': '' });
`);
  fs.chmodSync(fakeNpm, 0o755);
  const options = { platform: "linux", env: { AXUM_BUNDLED_PI_DIR: cache }, npmCommand: fakeNpm };
  ensureBundledPi(options);
  ensureBundledPi(options);
  assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 1);
  assert.equal(fs.existsSync(resolvePiCli(options)), true);
  assert.equal(existingBundledExtensions(options).length, 5);
  const pluginCopy = path.join(cache, "plugin", "pi-hermes-memory", "package.json");
  assert.equal(fs.existsSync(pluginCopy), true);
  assert.equal(fs.lstatSync(path.dirname(pluginCopy)).isSymbolicLink(), false);
  const patchedStdinBuffer = fs.readFileSync(path.join(cache, "node_modules", "@earendil-works", "pi-tui", "dist", "stdin-buffer.js"), "utf8");
  assert.match(patchedStdinBuffer, /looksLikeUnbracketedPaste/);
});
