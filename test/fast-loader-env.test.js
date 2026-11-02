import assert from "node:assert/strict";
import test from "node:test";
import { buildFastLoaderNodeOptions } from "../src/fast-loader-env.js";

const LOADER = "file:///opt/axum/src/pi-web-fast-loader.js";

test("the fast loader preload is appended when no NODE_OPTIONS exist", () => {
  const options = buildFastLoaderNodeOptions(undefined, LOADER);

  assert.equal(options, `--import=${JSON.stringify(LOADER)}`);
});

test("an inherited fast loader preload is dropped instead of stacked", () => {
  const inherited = '--import="file:///home/dev/AxumAgent/src/pi-web-fast-loader.js"';

  const options = buildFastLoaderNodeOptions(inherited, LOADER);

  assert.equal(options, `--import=${JSON.stringify(LOADER)}`);
  assert.equal(options.match(/pi-web-fast-loader\.js/g).length, 1, "the loader must be preloaded exactly once");
});

test("unrelated NODE_OPTIONS survive the loader preload", () => {
  const options = buildFastLoaderNodeOptions("--max-old-space-size=4096 --no-warnings", LOADER);

  assert.match(options, /--max-old-space-size=4096/);
  assert.match(options, /--no-warnings/);
  assert.match(options, /--import=/);
});

test("applying the builder twice keeps a single fast loader preload", () => {
  const once = buildFastLoaderNodeOptions(undefined, LOADER);
  const twice = buildFastLoaderNodeOptions(once, LOADER);

  assert.equal(twice, once);
  assert.equal(twice.match(/pi-web-fast-loader\.js/g).length, 1);
});
