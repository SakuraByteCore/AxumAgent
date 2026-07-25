import assert from "node:assert/strict";
import test from "node:test";
import { expectedBundledExtensionCount, isAndroidLike, supportedBundledPiPackages } from "../src/bundled-pi-platform.js";

test("detects Termux/Android environments", () => {
  assert.equal(isAndroidLike({ platform: "android", env: {} }), true);
  assert.equal(isAndroidLike({ platform: "linux", env: { TERMUX_VERSION: "0.118.3" } }), true);
  assert.equal(isAndroidLike({ platform: "linux", env: { PREFIX: "/data/data/com.termux/files/usr" } }), true);
  assert.equal(isAndroidLike({ platform: "linux", env: {} }), false);
});

test("skips Magic Context on Android because it depends on onnxruntime-node", () => {
  const packages = supportedBundledPiPackages({ platform: "android", env: {} });
  assert.deepEqual(packages, [
    "@earendil-works/pi-coding-agent@0.80.10",
    "pi-subagents@0.35.1",
  ]);
  assert.equal(expectedBundledExtensionCount({ platform: "android", env: {} }), 1);
});

test("keeps full bundled Pi extensions on desktop platforms", () => {
  const packages = supportedBundledPiPackages({ platform: "linux", env: {} });
  assert.deepEqual(packages, [
    "@earendil-works/pi-coding-agent@0.80.10",
    "pi-subagents@0.35.1",
    "@cortexkit/pi-magic-context@0.32.4",
  ]);
  assert.equal(expectedBundledExtensionCount({ platform: "linux", env: {} }), 2);
});
