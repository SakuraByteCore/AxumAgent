#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import { ensureBundledPi } from "../src/ensure-bundled-pi.js";
import { resolvePiCli, resolveBundledExtensions } from "../src/resolve-bundled-pi.js";
import { getDefaultProviderSelection } from "../src/provider-config.js";
import { startProviderWeb } from "../src/provider-web.js";

function usage() {
  return `Axum Agent

Usage:
  axum
  axum code [pi args...]
  axum provider web [--port <port>]
  axum doctor

Commands:
  code          Start bundled Pi coding agent with Axum defaults
  provider web  Open the local OpenAI-compatible provider setup page
  doctor        Check bundled Pi and extension files

Axum delegates code sessions to Pi and preloads bundled extensions:
  - pi-subagents
  - @cortexkit/pi-magic-context

Run \`axum code --help\` for Pi options.
`;
}

function providerUsage() {
  return `Axum provider commands

Usage:
  axum provider web [--port <port>]

Options:
  --port <port>  Port for provider web setup; defaults to a random local port
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

function requireFlag(flags, name) {
  if (!flags[name]) throw new Error(`missing --${name}`);
  return flags[name];
}

function runProviderCommand(argv) {
  const subcommand = argv[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    process.stdout.write(providerUsage());
    return 0;
  }
  if (subcommand === "web") {
    const flags = parseFlags(argv.slice(1));
    startProviderWeb({ port: flags.port ? Number(flags.port) : 0 }).catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
    return undefined;
  }
  throw new Error(`unknown provider command: ${subcommand}`);
}
function resolveArgs(argv) {
  if (argv.length === 0) return { mode: "help" };
  if (argv[0] === "provider") return { mode: "provider", argv: argv.slice(1) };
  if (argv[0] === "code") return { mode: "run", passthrough: argv.slice(1) };
  if (argv[0] === "doctor") return { mode: "doctor" };
  if (argv.includes("--help") || argv.includes("-h")) return { mode: "help" };
  return { mode: "help" };
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

function hasArg(args, name) {
  return args.includes(name) || args.some((arg) => arg.startsWith(`${name}=`));
}

function runPi(passthrough) {
  ensureBundledPi();
  const piCli = resolvePiCli();
  const extensionArgs = resolveBundledExtensions().flatMap((file) => ["-e", file]);
  const defaults = getDefaultProviderSelection();
  const defaultArgs = defaults && !hasArg(passthrough, "--provider") && !hasArg(passthrough, "--model")
    ? ["--provider", defaults.provider, "--model", defaults.model]
    : [];
  const args = [piCli, ...extensionArgs, ...defaultArgs, ...passthrough];
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
if (action.mode === "provider") {
  try {
    const code = runProviderCommand(action.argv ?? []);
    if (code !== undefined) process.exit(code);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
} else {
  runPi(action.passthrough ?? []);
}
