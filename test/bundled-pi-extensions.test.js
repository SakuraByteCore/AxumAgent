import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ensureBundledPi } from "../src/ensure-bundled-pi.js";
import { expectedBundledExtensionCount } from "../src/bundled-pi-platform.js";
import { resolveBundledExtensions } from "../src/resolve-bundled-pi.js";

// End-to-end coverage for the "a bundled extension actually loads at runtime"
// gap that unit tests (registry lists, resolved paths, extension counts) do not
// exercise. Each plugin's factory must survive the real runtime loader: jiti
// type-strips the entry .ts, resolves its relative `.js` import back to a `.ts`
// sibling, aliases @mariozechner/* to the bundled runtime, and finally invokes
// the default factory so commands/events register. This is the same path
// `axum code` uses, so any future plugin that only loads on paper but not at
// runtime is caught here once instead of in manual smoke checks.
test("bundled extensions load end-to-end via the real runtime loader", { timeout: 120000 }, async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "axum-e2e-bundled-"));
  const options = { platform: "linux", env: { AXUM_BUNDLED_PI_DIR: cache } };

  // Real npm install into an isolated cache (same first-run path a new user hits).
  await ensureBundledPi(options);

  const expected = expectedBundledExtensionCount(options);
  const extPaths = resolveBundledExtensions(options);
  assert.equal(extPaths.length, expected);

  // Import the real runtime extension loader out of the freshly installed cache.
  const loaderPath = path.join(
    cache,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "core",
    "extensions",
    "loader.js",
  );
  assert.equal(fs.existsSync(loaderPath), true, "runtime loader.js missing after install");
  const { loadExtensions } = await import(pathToFileURL(loaderPath).href);

  // Run every bundled extension's factory against the default stub runtime.
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-e2e-agent-"));
  const { extensions, errors } = await loadExtensions(extPaths, agentDir);

  assert.equal(errors.length, 0, "all bundled extensions must load without errors: " + JSON.stringify(errors));
  assert.equal(extensions.length, expected);

  // Each extension's factory really ran and registered at least one surface.
  for (const ext of extensions) {
    const registered = ext.commands.size + ext.handlers.size + ext.flags.size + ext.tools.size;
    assert.ok(registered > 0, `extension factory registered nothing: ${ext.path}`);
  }

  // pi-response-guard in particular must publish its command and retry hooks.
  const rg = extensions.find((e) => e.path.includes("pi-response-guard"));
  assert.ok(rg, "pi-response-guard must be among the extensions loaded by the runtime");
  assert.equal(rg.commands.has("pi-response-guard:setup"), true);
  assert.equal(rg.handlers.has("session_start"), true);
  assert.equal(rg.handlers.has("message_end"), true);
});