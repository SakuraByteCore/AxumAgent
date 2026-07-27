#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import { ensureBundledPi } from "../src/ensure-bundled-pi.js";
import { getBundledPiCacheRoot } from "../src/bundled-pi-cache.js";
import { resolvePiCli, resolveBundledExtensions } from "../src/resolve-bundled-pi.js";
import { getDefaultProviderSelection } from "../src/provider-config.js";
import { startProviderWeb } from "../src/provider-web.js";

const UPDATE_TARBALL =
  "https://github.com/SakuraByteCore/AxumAgent/archive/refs/heads/main.tar.gz";

function usage() {
  return `Axum Agent

Usage:
  axum
  axum code [pi args...]
  axum web [--port <port>]
  axum doctor
  axum update

Commands:
  code          Start bundled Pi coding agent with Axum defaults
  web           Open the local OpenAI-compatible provider setup page
  doctor        Check bundled Pi and extension files
  update        Reinstall Axum from the main branch tarball

Axum delegates code sessions to Pi and preloads bundled extensions:
  - pi-subagents
  - pi-hermes-memory
  - @juanibiapina/pi-powerbar
  - pi-edit
  - @narumitw/pi-goal
  - @juicesharp/rpiv-todo

Run \`axum code --help\` for Pi options.
`;
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (["reasoning", "supports-developer-role", "supports-reasoning-effort"].includes(key)) {
      flags[key] = true;
      continue;
    }
    if (i + 1 >= argv.length) throw new Error(`missing value for ${arg}`);
    flags[key] = argv[++i];
  }
  return flags;
}

function runWebCommand(argv) {
  const flags = parseFlags(argv);
  startProviderWeb({ port: flags.port ? Number(flags.port) : 0 }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
function resolveArgs(argv) {
  if (argv.length === 0) return { mode: "help" };
  if (argv[0] === "web") return { mode: "web", argv: argv.slice(1) };
  if (argv[0] === "code") return { mode: "run", passthrough: argv.slice(1) };
  if (argv[0] === "doctor") return { mode: "doctor" };
  if (argv[0] === "update") return { mode: "update" };
  if (argv.includes("--help") || argv.includes("-h")) return { mode: "help" };
  return { mode: "help" };
}

function printDoctor() {
  ensureBundledPi();
  const piCli = resolvePiCli();
  const extensions = resolveBundledExtensions();
  const missing = [piCli, ...extensions].filter((file) => !fs.existsSync(file));
  console.log("Axum bundled Pi doctor");
  console.log(`cache: ${getBundledPiCacheRoot()}`);
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

function runUpdate() {
  console.log("Updating Axum from main branch...");
  const child = spawn("npm", ["install", "-g", UPDATE_TARBALL], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
  child.on("error", (error) => {
    console.error(`failed to run npm install: ${error.message}`);
    process.exit(1);
  });
}

function hasArg(args, name) {
  return args.includes(name) || args.some((arg) => arg.startsWith(`${name}=`));
}

function buildPiEnv() {
  return { ...process.env, AXUM_BUNDLED_PI: "1" };
}

function runPi(passthrough) {
  ensureBundledPi();
  const piCli = resolvePiCli();
  const extensionArgs = resolveBundledExtensions().flatMap((file) => ["-e", file]);
  const defaults = getDefaultProviderSelection();
  const defaultArgs = defaults && !hasArg(passthrough, "--provider") && !hasArg(passthrough, "--model")
    ? ["--provider", defaults.provider, "--model", defaults.model]
    : [];
  // Disable ambient Pi extensions from the user's global install before adding
  // Axum's bundled extension set. Otherwise globally installed copies can collide
  // with the bundled cache copy of the same extension (tools/flags duplicate).
  const args = [piCli, "-ne", ...extensionArgs, ...defaultArgs, ...passthrough];
  const child = spawn(process.execPath, args, { stdio: "inherit", env: buildPiEnv() });
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
if (action.mode === "update") { runUpdate(); }
if (action.mode === "web") {
  try {
    runWebCommand(action.argv ?? []);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
} else {
  runPi(action.passthrough ?? []);
}
