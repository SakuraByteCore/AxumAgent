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

function resolveRepoRoot() {
  return path.resolve(__dirname, "..");
}

function tsEntrypoint(repoRoot) {
  return path.join(repoRoot, "dist", "cli.js");
}

function tsSources(repoRoot) {
  return [
    path.join(repoRoot, "src", "cli.ts"),
    path.join(repoRoot, "src", "providers", "openai-chat.ts"),
  ];
}

function isStale(target, sources) {
  if (!fs.existsSync(target)) return true;
  const targetMtime = fs.statSync(target).mtimeMs;
  return sources.some((source) => fs.existsSync(source) && fs.statSync(source).mtimeMs > targetMtime);
}

function ensureTsBuilt(repoRoot) {
  const entry = tsEntrypoint(repoRoot);
  if (!isStale(entry, tsSources(repoRoot))) return;
  run("npx", ["tsc", "-p", "tsconfig.json"], { cwd: repoRoot });
}

async function tryTsCli(repoRoot, args) {
  ensureTsBuilt(repoRoot);
  const entry = tsEntrypoint(repoRoot);
  if (!fs.existsSync(entry)) return false;
  const mod = require(entry);
  if (typeof mod.runAxumCli !== "function") return false;
  const result = await mod.runAxumCli(args);
  if (result && result.handled) process.exit(result.exitCode || 0);
  return false;
}

function binCandidates(repoRoot) {
  const exe = process.platform === "win32" ? ".exe" : "";
  return [
    path.join(repoRoot, "rs", "target", "release", `axum-cli${exe}`),
    path.join(repoRoot, "rs", "target", "debug", `axum-cli${exe}`),
  ];
}

function findBin(repoRoot) {
  for (const p of binCandidates(repoRoot)) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function ensureRustBuilt(repoRoot) {
  if (findBin(repoRoot)) return;
  const cwd = path.join(repoRoot, "rs");
  run("cargo", ["build", "-q", "-p", "axum-cli", "--release"], { cwd });
  const bin = findBin(repoRoot);
  if (!bin) fail("axum-cli build succeeded but binary not found");
}

async function main() {
  const repoRoot = resolveRepoRoot();
  const args = process.argv.slice(2);
  await tryTsCli(repoRoot, args);
  ensureRustBuilt(repoRoot);
  const bin = findBin(repoRoot);
  if (!bin) fail("axum-cli binary not found");
  run(bin, args, { cwd: repoRoot });
}

main().catch((error) => fail(error && error.stack ? error.stack : error));
