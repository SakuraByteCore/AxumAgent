import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectedBundledExtensionCount, isAndroidLike, localPluginNames, supportedBundledPiPackages } from "../src/bundled-pi-platform.js";

test("detects Termux/Android environments", () => {
  assert.equal(isAndroidLike({ platform: "android", env: {} }), true);
  assert.equal(isAndroidLike({ platform: "linux", env: { TERMUX_VERSION: "0.118.3" } }), true);
  assert.equal(isAndroidLike({ platform: "linux", env: { PREFIX: "/data/data/com.termux/files/usr" } }), true);
  assert.equal(isAndroidLike({ platform: "linux", env: {} }), false);
});

test("loads pi-guard and pi-goal on Android", () => {
  const packages = supportedBundledPiPackages({ platform: "android", env: {} });
  assert.deepEqual(packages, [
    "@earendil-works/pi-coding-agent@0.81.1",
    "pi-bar@file:plugin/pi-bar",
    "pi-header@file:plugin/pi-header",
    "pi-guard@file:plugin/pi-guard",
    "pi-plan@file:plugin/pi-plan",
    "@narumitw/pi-goal@0.31.0",
    "pi-blackhole@0.4.3",
  ]);
  assert.equal(expectedBundledExtensionCount({ platform: "android", env: {} }), 6);
});

test("keeps same bundled Pi extensions on Linux desktop platforms", () => {
  const packages = supportedBundledPiPackages({ platform: "linux", env: {} });
  assert.deepEqual(packages, [
    "@earendil-works/pi-coding-agent@0.81.1",
    "pi-bar@file:plugin/pi-bar",
    "pi-header@file:plugin/pi-header",
    "pi-guard@file:plugin/pi-guard",
    "pi-plan@file:plugin/pi-plan",
    "@narumitw/pi-goal@0.31.0",
    "pi-blackhole@0.4.3",
  ]);
  assert.equal(expectedBundledExtensionCount({ platform: "linux", env: {} }), 6);
});

test("Windows loads the same extension set as other platforms", () => {
  const packages = supportedBundledPiPackages({ platform: "win32", env: {} });
  assert.deepEqual(packages, [
    "@earendil-works/pi-coding-agent@0.81.1",
    "pi-bar@file:plugin/pi-bar",
    "pi-header@file:plugin/pi-header",
    "pi-guard@file:plugin/pi-guard",
    "pi-plan@file:plugin/pi-plan",
    "@narumitw/pi-goal@0.31.0",
    "pi-blackhole@0.4.3",
  ]);
  assert.equal(expectedBundledExtensionCount({ platform: "win32", env: {} }), 6);
});

// Regression guard: localPlugins in ensure-bundled-pi.js used to be a separate
// hand-written list that drifted from the registry. When pi-bar was added
// to bundled-pi-packages.js but not to localPlugins, axum doctor threw
// "required files are still missing" because the plugin source was never synced.
// Lock the invariant: every file: package is a local plugin, and every local
// plugin name matches a plugin/ subdir that exists on disk.
test("localPluginNames covers exactly the file: packages from the registry", () => {
  assert.deepEqual(localPluginNames({ platform: "android", env: {} }), ["pi-bar", "pi-header", "pi-guard", "pi-plan"]);
  assert.deepEqual(localPluginNames({ platform: "linux", env: {} }), ["pi-bar", "pi-header", "pi-guard", "pi-plan"]);
  assert.deepEqual(localPluginNames({ platform: "win32", env: {} }), ["pi-bar", "pi-header", "pi-guard", "pi-plan"]);
});

test("every local plugin name has a matching plugin/ subdir", () => {
  const here = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(here), "..");
  for (const name of localPluginNames({ platform: "android", env: {} })) {
    const dir = path.join(repoRoot, "plugin", name);
    assert.equal(fs.existsSync(dir), true, `missing plugin source dir: ${name}`);
  }
});
