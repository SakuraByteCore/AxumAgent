#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function fail(msg) {
  process.stderr.write(String(msg) + "\n");
  process.exit(1);
}

function run(cmd, args, opts) {
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.error) fail(res.error.message);
  if (typeof res.status === "number" && res.status !== 0) process.exit(res.status);
  if (res.signal) fail(`terminated_by_signal:${res.signal}`);
}

function repoRoot() {
  return path.resolve(__dirname, "..");
}

function entrypoint(root) {
  return path.join(root, "dist", "cli.js");
}

function sources(root) {
  return [
    path.join(root, "src", "cli.ts"),
    path.join(root, "src", "providers", "openai-chat.ts"),
  ];
}

function isStale(target, sourceFiles) {
  if (!fs.existsSync(target)) return true;
  const targetMtime = fs.statSync(target).mtimeMs;
  return sourceFiles.some((source) => fs.existsSync(source) && fs.statSync(source).mtimeMs > targetMtime);
}

function ensureBuilt(root) {
  const entry = entrypoint(root);
  if (!isStale(entry, sources(root))) return;
  run("npx", ["tsc", "-p", "tsconfig.json"], { cwd: root });
}

async function main() {
  const root = repoRoot();
  ensureBuilt(root);
  const entry = entrypoint(root);
  if (!fs.existsSync(entry)) fail("TypeScript CLI build output not found: dist/cli.js");
  const mod = require(entry);
  if (typeof mod.runAxumCli !== "function") fail("dist/cli.js does not export runAxumCli");
  const result = await mod.runAxumCli(process.argv.slice(2));
  if (!result || !result.handled) {
    process.stderr.write("unknown command. Run `axum --help`.\n");
    process.exit(2);
  }
  process.exit(result.exitCode || 0);
}

main().catch((error) => fail(error && error.stack ? error.stack : error));
