import assert from "node:assert/strict";
import test from "node:test";
import { expectedBundledExtensionCount, isAndroidLike, supportedBundledPiPackages } from "../src/bundled-pi-platform.js";

test("detects Termux/Android environments", () => {
  assert.equal(isAndroidLike({ platform: "android", env: {} }), true);
  assert.equal(isAndroidLike({ platform: "linux", env: { TERMUX_VERSION: "0.118.3" } }), true);
  assert.equal(isAndroidLike({ platform: "linux", env: { PREFIX: "/data/data/com.termux/files/usr" } }), true);
  assert.equal(isAndroidLike({ platform: "linux", env: {} }), false);
});

test("loads pi-edit and pi-powerbar on Android alongside pi-subagents", () => {
  const packages = supportedBundledPiPackages({ platform: "android", env: {} });
  assert.deepEqual(packages, [
    "@earendil-works/pi-coding-agent@0.80.10",
    "pi-subagents@0.35.1",
    "@juanibiapina/pi-powerbar@0.13.0",
    "pi-edit@file:plugin/pi-edit",
    "@narumitw/pi-goal@0.31.0",
  ]);
  assert.equal(expectedBundledExtensionCount({ platform: "android", env: {} }), 11);
});

test("keeps same bundled Pi extensions on Linux desktop platforms (no rtk optimizer)", () => {
  const packages = supportedBundledPiPackages({ platform: "linux", env: {} });
  assert.deepEqual(packages, [
    "@earendil-works/pi-coding-agent@0.80.10",
    "pi-subagents@0.35.1",
    "@juanibiapina/pi-powerbar@0.13.0",
    "pi-edit@file:plugin/pi-edit",
    "@narumitw/pi-goal@0.31.0",
  ]);
  assert.equal(expectedBundledExtensionCount({ platform: "linux", env: {} }), 11);
});

test("Windows now loads the same extension set as other platforms (no rtk optimizer)", () => {
  const packages = supportedBundledPiPackages({ platform: "win32", env: {} });
  assert.deepEqual(packages, [
    "@earendil-works/pi-coding-agent@0.80.10",
    "pi-subagents@0.35.1",
    "@juanibiapina/pi-powerbar@0.13.0",
    "pi-edit@file:plugin/pi-edit",
    "@narumitw/pi-goal@0.31.0",
  ]);
  assert.equal(expectedBundledExtensionCount({ platform: "win32", env: {} }), 11);
});
