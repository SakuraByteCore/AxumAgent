#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import { ensureBundledPi } from "../src/ensure-bundled-pi.js";
import { resolvePiCli, resolveBundledExtensions } from "../src/resolve-bundled-pi.js";

function usage() {
  return `Axum Agent\n\nUsage:\n  axum [pi args...]\n  axum doctor\n\nAxum delegates to Pi and preloads bundled extensions:\n  - pi-subagents\n  - @cortexkit/pi-magic-context\n\nAny argument after axum is passed through to Pi.\n`;
}

function resolveArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { mode: "help" };
  if (argv[0] === "doctor") return { mode: "doctor" };
  return { mode: "run", passthrough: argv };
}

function printDoctor() {
  ensureBundledPi();
  const piCli = resolvePiCli();
  const extensions = resolveBundledExtensions();
  const missing = [piCli, ...extensions].filter((file) => !fs.existsSync(file));
  console.log("Axum bundled Pi doctor");
  console.log(`pi cli: ${piCli}`);
  for (const extension of extensions) console.log(`extension: ${extension}`);
  if (missing.length) {
    console.error("missing bundled files:");
    for (const file of missing) console.error(`- ${file}`);
    return 1;
  }
  console.log("ok");
  return 0;
}

function runPi(passthrough) {
  ensureBundledPi();
  const piCli = resolvePiCli();
  const extensionArgs = resolveBundledExtensions().flatMap((file) => ["-e", file]);
  const args = [piCli, ...extensionArgs, ...passthrough];
  const child = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, AXUM_BUNDLED_PI: "1" } });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
  child.on("error", (error) => {
    console.error(`failed to start bundled Pi: ${error.message}`);
    process.exit(1);
  });
}

const action = resolveArgs(process.argv.slice(2));
if (action.mode === "help") {
  process.stdout.write(usage());
  process.exit(0);
}
if (action.mode === "doctor") process.exit(printDoctor());
runPi(action.passthrough ?? []);
