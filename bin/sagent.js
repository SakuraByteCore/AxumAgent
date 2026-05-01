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

function binCandidates(repoRoot) {
  const exe = process.platform === "win32" ? ".exe" : "";
  return [
    path.join(repoRoot, "rs", "target", "release", `sagent-cli${exe}`),
    path.join(repoRoot, "rs", "target", "debug", `sagent-cli${exe}`),
  ];
}

function findBin(repoRoot) {
  for (const p of binCandidates(repoRoot)) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function ensureBuilt(repoRoot) {
  if (findBin(repoRoot)) return;
  const cwd = path.join(repoRoot, "rs");
  run("cargo", ["build", "-q", "-p", "sagent-cli", "--release"], { cwd });
  const bin = findBin(repoRoot);
  if (!bin) fail("sagent-cli build succeeded but binary not found");
}

function main() {
  const repoRoot = resolveRepoRoot();
  ensureBuilt(repoRoot);
  const bin = findBin(repoRoot);
  if (!bin) fail("sagent-cli binary not found");
  run(bin, process.argv.slice(2), { cwd: repoRoot });
}

main();

