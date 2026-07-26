import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getBundledPiCacheRoot } from "../src/bundled-pi-cache.js";
import { ensureBundledPi } from "../src/ensure-bundled-pi.js";
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

  const piCli = resolvePiCli(options);
  const extensions = resolveBundledExtensions(options);
  assert.equal(piCli, path.join(cache, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"));
  assert.equal(fs.existsSync(piCli), true);
  assert.equal(extensions.length, 3);
  assert.equal(existingBundledExtensions(options).length, 3);
});

test("Android loads hermes-memory and rtk-optimizer alongside subagents", () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "axum-bundled-android-cache-"));
  const options = { platform: "android", env: { AXUM_BUNDLED_PI_DIR: cache } };
  writePackage(cache, "@earendil-works/pi-coding-agent", { "dist/cli.js": "" });
  writePackage(cache, "pi-subagents", { "index.ts": "" });
  writePackage(cache, "pi-hermes-memory", { "src/index.ts": "" });
  writePackage(cache, "pi-rtk-optimizer", { "index.ts": "" });

  const extensions = resolveBundledExtensions(options);
  assert.equal(extensions.length, 3);
  assert.equal(extensions[0], path.join(cache, "node_modules", "pi-subagents", "index.ts"));
  assert.equal(extensions[1], path.join(cache, "node_modules", "pi-hermes-memory", "src", "index.ts"));
  assert.equal(extensions[2], path.join(cache, "node_modules", "pi-rtk-optimizer", "index.ts"));
  assert.equal(existingBundledExtensions(options).length, 3);
});

test("cache root is stable outside npm package install directory", () => {
  const env = { XDG_CACHE_HOME: "/tmp/axum-cache-home" };
  const root = getBundledPiCacheRoot({ env, platform: "linux", arch: "x64" });
  assert.match(root, /^\/tmp\/axum-cache-home\/axum-agent\/bundled-pi\/v1\/linux-x64\//);
  assert.doesNotMatch(root, /node_modules\/axum-agent/);
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
pkg('@earendil-works/pi-tui', { 'dist/stdin-buffer.js': 'const ESC = "\\\\x1b";\nconst BRACKETED_PASTE_START = "\\\\x1b[200~";\nconst BRACKETED_PASTE_END = "\\\\x1b[201~";\nclass StdinBuffer { process(data) { let str; if (Buffer.isBuffer(data)) { str = data.toString(); } else { str = data; }\n        if (str.length === 0 && this.buffer.length === 0) {\n            this.emitDataSequence("");\n            return;\n        }\n } }\n' });
pkg('pi-subagents', { 'index.ts': '' });
pkg('pi-hermes-memory', { 'src/index.ts': '' });
pkg('pi-rtk-optimizer', { 'index.ts': '' });
`);
  fs.chmodSync(fakeNpm, 0o755);
  const options = { platform: "linux", env: { AXUM_BUNDLED_PI_DIR: cache }, npmCommand: fakeNpm };
  ensureBundledPi(options);
  ensureBundledPi(options);
  assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 1);
  assert.equal(fs.existsSync(resolvePiCli(options)), true);
  assert.equal(existingBundledExtensions(options).length, 3);
  const patchedStdinBuffer = fs.readFileSync(path.join(cache, "node_modules", "@earendil-works", "pi-tui", "dist", "stdin-buffer.js"), "utf8");
  assert.match(patchedStdinBuffer, /looksLikeUnbracketedPaste/);
});
