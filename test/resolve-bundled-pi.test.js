import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolvePiCli, resolveBundledExtensions, existingBundledExtensions } from "../src/resolve-bundled-pi.js";

test("resolves bundled Pi CLI and extensions", () => {
  const piCli = resolvePiCli();
  const extensions = resolveBundledExtensions();
  assert.equal(fs.existsSync(piCli), true, piCli);
  assert.equal(extensions.length, 2);
  assert.equal(existingBundledExtensions().length, 2);
  assert(extensions.some((file) => file.includes("pi-subagents")));
  assert(extensions.some((file) => file.includes("pi-magic-context")));
});
