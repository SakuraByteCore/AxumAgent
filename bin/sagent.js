#!/usr/bin/env node

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
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

function packageRoot() {
  return path.resolve(__dirname, "..");
}

function cacheRoot() {
  if (process.env.XDG_CACHE_HOME) return path.join(process.env.XDG_CACHE_HOME, "axumagent");
  if (process.env.HOME) return path.join(process.env.HOME, ".cache", "axumagent");
  return path.join(os.tmpdir(), "axumagent-cache");
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

function sourceHash(root) {
  const hash = crypto.createHash("sha256");
  for (const rel of ["go.mod", "package.json"]) {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) hash.update(rel).update(fs.readFileSync(full));
  }
  for (const dir of ["cmd", "internal"]) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    for (const file of walk(full).sort()) {
      if (!/\.(go|html)$/i.test(file)) continue;
      hash.update(path.relative(root, file)).update(fs.readFileSync(file));
    }
  }
  return hash.digest("hex").slice(0, 16);
}

function binPath(root) {
  const exe = process.platform === "win32" ? ".exe" : "";
  return path.join(cacheRoot(), sourceHash(root), `sagent${exe}`);
}

function ensureBuilt(root) {
  const bin = binPath(root);
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  run("go", ["build", "-trimpath", "-o", bin, "./cmd/sagent"], { cwd: root });
  if (!fs.existsSync(bin)) fail("sagent build succeeded but binary not found");
  return bin;
}

function main() {
  const root = packageRoot();
  const bin = ensureBuilt(root);
  run(bin, process.argv.slice(2));
}

main();
