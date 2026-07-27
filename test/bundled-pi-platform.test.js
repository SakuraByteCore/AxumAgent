import assert from "node:assert/strict";
import test from "node:test";
import { expectedBundledExtensionCount, isAndroidLike, supportedBundledPiPackages } from "../src/bundled-pi-platform.js";

test("detects Termux/Android environments", () => {
  assert.equal(isAndroidLike({ platform: "android", env: {} }), true);
  assert.equal(isAndroidLike({ platform: "linux", env: { TERMUX_VERSION: "0.118.3" } }), true);
  assert.equal(isAndroidLike({ platform: "linux", env: { PREFIX: "/data/data/com.termux/files/usr" } }), true);
  assert.equal(isAndroidLike({ platform: "linux", env: {} }), false);
});

test("loads hermes-memory and rtk-optimizer on Android alongside pi-subagents", () => {
  const packages = supportedBundledPiPackages({ platform: "android", env: {} });
  assert.deepEqual(packages, [
    "@earendil-works/pi-coding-agent@0.80.10",
    "pi-subagents@0.35.1",
    "pi-hermes-memory@file:plugin/pi-hermes-memory",
    "pi-rtk-optimizer@0.9.0",
    "@narumitw/pi-statusline@0.31.0",
  ]);
  assert.equal(expectedBundledExtensionCount({ platform: "android", env: {} }), 4);
});

test("keeps same bundled Pi extensions on Linux desktop platforms (no pi-fff)", () => {
  const packages = supportedBundledPiPackages({ platform: "linux", env: {} });
  assert.deepEqual(packages, [
    "@earendil-works/pi-coding-agent@0.80.10",
    "pi-subagents@0.35.1",
    "pi-hermes-memory@file:plugin/pi-hermes-memory",
    "pi-rtk-optimizer@0.9.0",
    "@narumitw/pi-statusline@0.31.0",
  ]);
  assert.equal(expectedBundledExtensionCount({ platform: "linux", env: {} }), 4);
});

test("skips rtk optimizer on Windows because bundled Axum does not ship rtk", () => {
  const packages = supportedBundledPiPackages({ platform: "win32", env: {} });
  assert.deepEqual(packages, [
    "@earendil-works/pi-coding-agent@0.80.10",
    "pi-subagents@0.35.1",
    "pi-hermes-memory@file:plugin/pi-hermes-memory",
    "@narumitw/pi-statusline@0.31.0",
  ]);
  assert.equal(expectedBundledExtensionCount({ platform: "win32", env: {} }), 3);
});
