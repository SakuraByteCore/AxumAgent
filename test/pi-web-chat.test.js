import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPiWebEnvironment, resolvePiWebBin } from "../src/pi-web-chat.js";

function packageFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "axum-chat space-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "bin"));
  mkdirSync(path.join(root, ".next/static/css"), { recursive: true });
  const bin = path.join(root, "bin/pi-web.js");
  writeFileSync(bin, "");
  writeFileSync(path.join(root, ".next/static/css/random-name.css"), ":root{--user-bg:#fff}html.dark{--user-bg:#111}");
  return { root, bin };
}

test("resolves overrides and reports a missing launcher", (t) => {
  const { root, bin } = packageFixture(t);
  assert.equal(resolvePiWebBin({ env: { AXUM_PI_WEB_DIR: root } }), bin);
  assert.throws(() => resolvePiWebBin({ env: { AXUM_PI_WEB_DIR: path.join(root, "missing") } }), /bin not found/);
});

test("preserves existing options and Fast preload while deriving theme root from the selected bin", (t) => {
  const { root, bin } = packageFixture(t);
  const previous = { NODE_OPTIONS: "--trace-warnings", AXUM_PI_WEB_THEME_ROOT: "stale", EXAMPLE: "preserved" };
  const env = createPiWebEnvironment(bin, previous);
  assert.equal(env.AXUM_PI_WEB_THEME_ROOT, root);
  assert.equal(env.EXAMPLE, "preserved");
  assert.equal(previous.AXUM_PI_WEB_THEME_ROOT, "stale");
  assert.equal(previous.NODE_OPTIONS, "--trace-warnings");
  const fast = new URL("../src/pi-web-fast-loader.js", import.meta.url).href;
  const theme = new URL("../src/pi-web-theme-loader.js", import.meta.url).href;
  assert.equal(env.NODE_OPTIONS, `--trace-warnings --import=${fast} --import=${theme}`);
  assert.equal(createPiWebEnvironment(bin, {}).NODE_OPTIONS, `--import=${fast} --import=${theme}`);
});

test("loads Fast and theme in CJS processes and inherited Next-style descendants", { timeout: 10000 }, (t) => {
  const { root, bin } = packageFixture(t);
  const probe = `JSON.stringify({
    fast: !!globalThis[Symbol.for("axum.fast-service-tier.loader-hook")],
    theme: require("node:http").Server.prototype[Symbol.for("axum.pi-web.theme-loader")].packageRoot
  })`;
  const code = `
    const { spawnSync } = require("node:child_process");
    const child = spawnSync(process.execPath, ["--input-type=commonjs", "-e", ${JSON.stringify(`process.stdout.write(${probe})`)}], {encoding:"utf8", timeout:5000});
    if (child.status !== 0) throw new Error(child.stderr || String(child.error));
    process.stdout.write(JSON.stringify({parent:${probe}, child:child.stdout}));
  `;
  const env = createPiWebEnvironment(bin, { ...process.env, NODE_OPTIONS: "--trace-warnings" });
  const result = spawnSync(process.execPath, ["--input-type=commonjs", "-e", code], { env, encoding: "utf8", timeout: 8000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const loaded = JSON.parse(result.stdout);
  assert.deepEqual(JSON.parse(loaded.parent), { fast: true, theme: root });
  assert.deepEqual(JSON.parse(loaded.child), { fast: true, theme: root });
});
