import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Server, request } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createThemeAsset, installPiWebTheme } from "../src/pi-web-theme-loader.js";
import { PI_WEB_THEME_CSS } from "../src/pi-web-theme.js";
import { resolvePiWebBin } from "../src/pi-web-chat.js";

const ORIGINAL_CSS = ":root{--user-bg:#eee}html.dark{--user-bg:#333}/* 原始样式 */";
const GLOBAL_FILE = "fixture-global.css";
const CSS_URL = `/_next/static/css/${GLOBAL_FILE}`;

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "axum-theme-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cssDir = path.join(root, ".next/static/css");
  mkdirSync(cssDir, { recursive: true });
  writeFileSync(path.join(cssDir, "other.css"), ".other{color:red}");
  writeFileSync(path.join(cssDir, GLOBAL_FILE), ORIGINAL_CSS);
  return { root, cssDir };
}

function send(port, options = {}, onChunk = () => {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: CSS_URL, ...options }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => { chunks.push(chunk); onChunk(chunk); });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(options.method === "POST" ? "post-body" : undefined);
  });
}

test("serves only global CSS, preserves emit and streaming, installs once across module copies", { timeout: 10000 }, async (t) => {
  const { root, cssDir } = fixture(t);
  class FixtureServer extends Server {}
  const before = FixtureServer.prototype.emit;
  const installed = installPiWebTheme({ packageRoot: root, serverType: FixtureServer });
  const patched = FixtureServer.prototype.emit;
  assert.notEqual(patched, before);
  const second = await import("../src/pi-web-theme-loader.js?second-copy");
  assert.equal(second.installPiWebTheme({ packageRoot: root, serverType: FixtureServer }), installed);
  assert.equal(FixtureServer.prototype.emit, patched);
  assert.throws(() => installPiWebTheme({ packageRoot: root + "-other", serverType: FixtureServer }), /conflicting/);
  assert.equal(createRequire(import.meta.url)("http").Server, Server);
  const delegated = [];
  let finishStream;
  const streamGate = new Promise((resolve) => { finishStream = resolve; });
  const server = new FixtureServer((req, res) => {
    delegated.push([req.method, req.url]);
    if (req.url === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: first\n\n");
      streamGate.then(() => res.end("data: second\n\n"));
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { res.statusCode = 418; res.end(`delegated:${body}`); });
  });
  t.after(() => { finishStream(); server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const custom = {};
  let observed;
  server.on("axum-test", (value) => { observed = value; });
  assert.equal(server.emit("axum-test", custom), true);
  assert.equal(observed, custom);
  assert.equal(server.emit("no-listener"), false);

  const get = await send(port, { path: CSS_URL + "?v=1" });
  assert.equal(get.status, 200);
  assert.equal(get.body.toString(), `${ORIGINAL_CSS}\n${PI_WEB_THEME_CSS}\n`);
  assert.equal(get.headers["content-type"], "text/css; charset=utf-8");
  assert.equal(Number(get.headers["content-length"]), get.body.length);
  assert.equal(get.headers["cache-control"], "no-cache");
  assert.equal(get.headers.etag, installed.etag);
  const head = await send(port, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers["content-length"], get.headers["content-length"]);
  assert.equal(head.headers.etag, get.headers.etag);
  for (const validator of [get.headers.etag, `"other", W/${get.headers.etag}`, "*"]) {
    const cached = await send(port, { headers: { "If-None-Match": validator } });
    assert.equal(cached.status, 304);
    assert.equal(cached.body.length, 0);
    assert.equal(cached.headers.etag, get.headers.etag);
    assert.equal(cached.headers["cache-control"], "no-cache");
    assert.equal(cached.headers["content-length"], undefined);
  }
  assert.equal((await send(port, { headers: { "If-None-Match": '"stale"' } })).status, 200);
  assert.equal((await send(port, { method: "HEAD", headers: { "If-None-Match": get.headers.etag } })).status, 304);
  assert.equal(delegated.length, 0);
  for (const url of ["/", "/api/models", "/_next/static/css/other.css", CSS_URL + "/extra", "/_next/static/css/%66ixture-global.css", "/_next/static/css/../css/fixture-global.css", "/_next/static/css/fixture-global.css%3Fv=1"]) {
    assert.equal((await send(port, { path: url })).status, 418);
  }
  const post = await send(port, { method: "POST" });
  assert.equal(post.status, 418);
  assert.equal(post.body.toString(), "delegated:post-body");
  assert.equal((await send(port, { method: "OPTIONS" })).status, 418);
  let firstChunk;
  const streamed = await send(port, { path: "/api/events" }, (chunk) => {
    if (!firstChunk) { firstChunk = chunk.toString(); finishStream(); }
  });
  assert.equal(firstChunk, "data: first\n\n");
  assert.equal(streamed.headers["content-type"], "text/event-stream");
  assert.equal(streamed.body.toString(), "data: first\n\ndata: second\n\n");
  assert.ok(delegated.some(([method, url]) => method === "POST" && url === CSS_URL));
  assert.equal(readFileSync(path.join(cssDir, GLOBAL_FILE), "utf8"), ORIGINAL_CSS);
  writeFileSync(path.join(cssDir, GLOBAL_FILE), "changed after installation");
  assert.deepEqual((await send(port)).body, get.body);
});

test("rejects missing, ambiguous and oversized global CSS before changing emit", (t) => {
  const { root, cssDir } = fixture(t);
  class FixtureServer extends EventEmitter {}
  const original = FixtureServer.prototype.emit;
  writeFileSync(path.join(cssDir, "duplicate.css"), ORIGINAL_CSS);
  assert.throws(() => installPiWebTheme({ packageRoot: root, serverType: FixtureServer }), /multiple global/);
  assert.equal(FixtureServer.prototype.emit, original);
  rmSync(path.join(cssDir, "duplicate.css"));
  writeFileSync(path.join(cssDir, GLOBAL_FILE), "a".repeat(256 * 1024 + 1) + ORIGINAL_CSS);
  assert.throws(() => createThemeAsset(root), /global CSS not found/);
  assert.throws(() => createThemeAsset(path.join(root, "missing")), /ENOENT/);
  for (let index = 0; index < 65; index++) writeFileSync(path.join(cssDir, `extra-${index}.css`), "");
  assert.throws(() => createThemeAsset(root), /scan limit/);
});

test("locates the installed pi-web global CSS without assuming its hash", () => {
  const root = path.resolve(path.dirname(resolvePiWebBin()), "..");
  const asset = createThemeAsset(root);
  const original = readFileSync(path.join(root, ".next/static/css", path.basename(asset.pathname)), "utf8");
  assert.ok(original.includes("--user-bg:") && original.includes("html.dark"));
  assert.equal(asset.body.toString(), `${original}\n${PI_WEB_THEME_CSS}\n`);
  assert.match(PI_WEB_THEME_CSS, /html\.dark\s*\{\s*color-scheme: dark/);
});
