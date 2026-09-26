import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureBundledPi } from "../src/ensure-bundled-pi.js";
import { compileBundledExtensions } from "../src/compile-bundled-extensions.js";
import { getBundledPiCacheRoot } from "../src/bundled-pi-cache.js";
import { existingBundledExtensions, resolveBundledExtensions } from "../src/resolve-bundled-pi.js";
import {
  discoverExtensionPath,
  getUserPackagesPath,
  loadUserPackages,
  parsePackageSpec,
  saveUserPackages,
  userPackageExtensionEntries,
  userPackageNames,
} from "../src/user-packages.js";

function writePackage(root, name, files = {}, manifest = {}) {
  const dir = path.join(root, ...name.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", ...manifest }));
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

test("getUserPackagesPath honors AXUM_USER_PACKAGES_FILE and HOME", () => {
  assert.equal(getUserPackagesPath({ env: { AXUM_USER_PACKAGES_FILE: "/tmp/custom.json" } }), "/tmp/custom.json");
  assert.equal(getUserPackagesPath({ env: { HOME: "/home/tester" } }), path.join("/home/tester", ".axum", "packages.json"));
});

test("parsePackageSpec parses plain, versioned, and scoped npm specs", () => {
  assert.deepEqual(parsePackageSpec("pi-foo"), { name: "pi-foo", packageName: "pi-foo" });
  assert.deepEqual(parsePackageSpec("pi-foo@1.2.3"), { name: "pi-foo@1.2.3", packageName: "pi-foo" });
  assert.deepEqual(parsePackageSpec("npm:pi-foo@1.2.3"), { name: "pi-foo@1.2.3", packageName: "pi-foo" });
  assert.deepEqual(parsePackageSpec("@scope/pi-foo"), { name: "@scope/pi-foo", packageName: "@scope/pi-foo" });
  assert.deepEqual(parsePackageSpec("npm:@scope/pi-foo@2.0.0-beta.1"), {
    name: "@scope/pi-foo@2.0.0-beta.1",
    packageName: "@scope/pi-foo",
  });
  assert.throws(() => parsePackageSpec(""), /non-empty/);
  assert.throws(() => parsePackageSpec("npm:"), /invalid package spec/);
  assert.throws(() => parsePackageSpec("@"), /invalid package spec/);
});

test("loadUserPackages returns an empty list when the manifest is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-user-packages-"));
  assert.deepEqual(loadUserPackages({ env: { AXUM_USER_PACKAGES_FILE: path.join(dir, "absent.json") } }), []);
});

test("loadUserPackages reads a packages array or a top-level array", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-user-packages-"));
  const wrapped = path.join(dir, "wrapped.json");
  const plain = path.join(dir, "plain.json");
  fs.writeFileSync(wrapped, JSON.stringify({ packages: [{ name: "pi-foo@1.0.0", packageName: "pi-foo" }] }));
  fs.writeFileSync(plain, JSON.stringify([{ name: "pi-foo@1.0.0", packageName: "pi-foo" }]));
  assert.deepEqual(loadUserPackages({ env: { AXUM_USER_PACKAGES_FILE: wrapped } }), [{ name: "pi-foo@1.0.0", packageName: "pi-foo" }]);
  assert.deepEqual(loadUserPackages({ env: { AXUM_USER_PACKAGES_FILE: plain } }), [{ name: "pi-foo@1.0.0", packageName: "pi-foo" }]);
});

test("loadUserPackages rejects invalid JSON and malformed shapes with clear errors", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-user-packages-"));
  const invalidJson = path.join(dir, "broken.json");
  const invalidShape = path.join(dir, "shape.json");
  const invalidEntry = path.join(dir, "entry.json");
  fs.writeFileSync(invalidJson, "{ not json");
  fs.writeFileSync(invalidShape, JSON.stringify({ packages: "nope" }));
  fs.writeFileSync(invalidEntry, JSON.stringify({ packages: [{ packageName: "pi-foo" }] }));
  assert.throws(() => loadUserPackages({ env: { AXUM_USER_PACKAGES_FILE: invalidJson } }), /invalid JSON in user packages manifest/);
  assert.throws(() => loadUserPackages({ env: { AXUM_USER_PACKAGES_FILE: invalidShape } }), /must contain a "packages" array/);
  assert.throws(() => loadUserPackages({ env: { AXUM_USER_PACKAGES_FILE: invalidEntry } }), /entry 0 must include string "name" and "packageName"/);
});

test("saveUserPackages and loadUserPackages round-trip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-user-packages-"));
  const file = path.join(dir, "packages.json");
  const options = { env: { AXUM_USER_PACKAGES_FILE: file } };
  saveUserPackages([{ name: "pi-foo@1.0.0", packageName: "pi-foo", extensionPath: "index.ts" }], options);
  assert.deepEqual(loadUserPackages(options), [{ name: "pi-foo@1.0.0", packageName: "pi-foo", extensionPath: "index.ts" }]);
  assert.deepEqual(userPackageNames(options), ["pi-foo@1.0.0"]);
  assert.deepEqual(userPackageExtensionEntries(options), [{ name: "pi-foo@1.0.0", packageName: "pi-foo", extensionPath: "index.ts" }]);
});

test("userPackageExtensionEntries ignores entries without an extensionPath", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-user-packages-"));
  const file = path.join(dir, "packages.json");
  const options = { env: { AXUM_USER_PACKAGES_FILE: file } };
  saveUserPackages([
    { name: "pi-foo@1.0.0", packageName: "pi-foo" },
    { name: "pi-bar@2.0.0", packageName: "pi-bar", extensionPath: "index.ts" },
  ], options);
  assert.deepEqual(userPackageNames(options), ["pi-foo@1.0.0", "pi-bar@2.0.0"]);
  assert.deepEqual(userPackageExtensionEntries(options).map((entry) => entry.packageName), ["pi-bar"]);
});

test("discoverExtensionPath normalizes the first pi.extensions entry", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-user-packages-"));
  const withPi = writePackage(dir, "pi-foo", { "extensions/index.ts": "export default {};" }, { pi: { extensions: ["./extensions/index.ts"] } });
  const withoutPi = writePackage(path.join(dir, "b"), "pi-bar", { "index.js": "" });
  const emptyPi = writePackage(path.join(dir, "c"), "pi-baz", { "index.js": "" }, { pi: { extensions: [] } });
  assert.equal(discoverExtensionPath(withPi), "extensions/index.ts");
  assert.equal(discoverExtensionPath(withoutPi), null);
  assert.equal(discoverExtensionPath(emptyPi), null);
  assert.throws(() => discoverExtensionPath(path.join(dir, "missing")), /failed to read/);
});

test("cache root hash folds user packages into the key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-user-packages-"));
  const absentManifest = path.join(dir, "absent.json");
  const populatedManifest = path.join(dir, "populated.json");
  saveUserPackages([{ name: "pi-foo@1.0.0", packageName: "pi-foo" }], { env: { AXUM_USER_PACKAGES_FILE: populatedManifest } });
  const baseEnv = { XDG_CACHE_HOME: path.join(dir, "cache"), AXUM_USER_PACKAGES_FILE: absentManifest };
  const emptyRoot = getBundledPiCacheRoot({ platform: "linux", env: baseEnv });
  const populatedRoot = getBundledPiCacheRoot({ platform: "linux", env: { ...baseEnv, AXUM_USER_PACKAGES_FILE: populatedManifest } });
  assert.notEqual(emptyRoot, populatedRoot);
  assert.match(path.basename(populatedRoot), /^pi-[a-f0-9]{12}$/);
});

test("user manifest entries install, compile, and resolve like bundled packages", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-user-pkg-e2e-"));
  const cache = path.join(dir, "cache");
  const manifest = path.join(dir, "packages.json");
  const calls = path.join(dir, "calls.log");
  const fakeNpm = path.join(dir, "fake-npm.js");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(fakeNpm, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
fs.appendFileSync(${JSON.stringify(calls)}, process.argv.join(' ') + '\\n');
function pkg(name, files, manifest) { const root = path.join(prefix, 'node_modules', ...name.split('/')); fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version: '0.0.0', ...manifest })); for (const [file, content] of Object.entries(files)) { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); } }
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
pkg('pi-bar', { 'index.ts': 'export default {};' });
pkg('@narumitw/pi-goal', { 'src/index.ts': 'export default {};' });
pkg('pi-companion', { 'index.ts': 'export default {};' });
pkg('pi-hashline-edit-pro', { 'index.ts': 'export default {};' });
pkg('@gamaraan/todos-tool', { 'src/index.ts': 'export default {};' });
pkg('pi-agent', { 'index.ts': 'export default {};' });
pkg('pi-subagents', { 'index.ts': 'export default {};' });
pkg('pi-memory', { 'index.ts': 'export default {};' });
pkg('@zzxb/pi-notify', { 'index.ts': 'export default {};' });
pkg('pi-foo', { 'index.ts': 'export default {};' }, { pi: { extensions: ['./index.ts'] } });
`);
  fs.chmodSync(fakeNpm, 0o755);
  const options = { platform: "win32", env: { AXUM_BUNDLED_PI_DIR: cache, AXUM_USER_PACKAGES_FILE: manifest }, npmCommand: fakeNpm };

  // Phase 1: pathless entry — visible to the installer, invisible to the loader.
  saveUserPackages([{ name: "pi-foo@1.0.0", packageName: "pi-foo" }], options);
  ensureBundledPi(options);
  const installLine = fs.readFileSync(calls, "utf8").trim().split("\n").at(-1);
  assert.match(installLine, /pi-foo@1\.0\.0/);
  assert.equal(existingBundledExtensions(options).length, 9);

  // Phase 2: discover the entry point, persist, compile, and resolve.
  const entries = loadUserPackages(options);
  entries[0].extensionPath = discoverExtensionPath(path.join(cache, "node_modules", "pi-foo"));
  assert.equal(entries[0].extensionPath, "index.ts");
  saveUserPackages(entries, options);
  compileBundledExtensions(options);
  assert.equal(existingBundledExtensions(options).length, 10);
  const resolved = resolveBundledExtensions(options);
  const userEntry = resolved.find((entry) => entry.replaceAll(path.sep, "/").includes("pi-foo/"));
  assert.ok(userEntry, `pi-foo entry missing from: ${resolved.join(" ")}`);
  assert.equal(userEntry.replaceAll(path.sep, "/").endsWith("pi-foo/index.js"), true);
});
