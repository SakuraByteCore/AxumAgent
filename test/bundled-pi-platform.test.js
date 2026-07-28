import assert from "node:assert/strict";
import test from "node:test";
import { expectedBundledExtensionCount, isAndroidLike, supportedBundledPiPackages } from "../src/bundled-pi-platform.js";

test("detects Termux/Android environments", () => {
  assert.equal(isAndroidLike({ platform: "android", env: {} }), true);
  assert.equal(isAndroidLike({ platform: "linux", env: { TERMUX_VERSION: "0.118.3" } }), true);
  assert.equal(isAndroidLike({ platform: "linux", env: { PREFIX: "/data/data/com.termux/files/usr" } }), true);
  assert.equal(isAndroidLike({ platform: "linux", env: {} }), false);
});

test("loads pi-edit and pi-goal on Android", () => {
  const packages = supportedBundledPiPackages({ platform: "android", env: {} });
  assert.deepEqual(packages, [
    "@earendil-works/pi-coding-agent@0.80.10",
    "pi-edit@file:plugin/pi-edit",
    "pi-statusline@file:plugin/pi-statusline",
    "@narumitw/pi-goal@0.31.0",
  ]);
  assert.equal(expectedBundledExtensionCount({ platform: "android", env: {} }), 3);
});

test("keeps same bundled Pi extensions on Linux desktop platforms", () => {
  const packages = supportedBundledPiPackages({ platform: "linux", env: {} });
  assert.deepEqual(packages, [
    "@earendil-works/pi-coding-agent@0.80.10",
    "pi-edit@file:plugin/pi-edit",
    "pi-statusline@file:plugin/pi-statusline",
    "@narumitw/pi-goal@0.31.0",
  ]);
  assert.equal(expectedBundledExtensionCount({ platform: "linux", env: {} }), 3);
});

test("Windows loads the same extension set as other platforms", () => {
  const packages = supportedBundledPiPackages({ platform: "win32", env: {} });
  assert.deepEqual(packages, [
    "@earendil-works/pi-coding-agent@0.80.10",
    "pi-edit@file:plugin/pi-edit",
    "pi-statusline@file:plugin/pi-statusline",
    "@narumitw/pi-goal@0.31.0",
  ]);
  assert.equal(expectedBundledExtensionCount({ platform: "win32", env: {} }), 3);
});
