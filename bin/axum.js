#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function fail(msg) {
  process.stderr.write(String(msg) + "\n");
  process.exit(1);
}

function repoRoot() {
  return path.resolve(__dirname, "..");
}

function entrypoint(root) {
  return path.join(root, "dist", "cli.js");
}

function assertBuildOutput(root) {
  const entry = entrypoint(root);
  if (!fs.existsSync(entry)) {
    fail("Missing build output: dist/cli.js. Reinstall from a packaged release or run `npm run build` in a development checkout.");
  }
}

async function main() {
  const root = repoRoot();
  assertBuildOutput(root);
  const entry = entrypoint(root);
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
