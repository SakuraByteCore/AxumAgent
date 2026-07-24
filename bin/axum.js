#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import { ensureBundledPi } from "../src/ensure-bundled-pi.js";
import { resolvePiCli, resolveBundledExtensions } from "../src/resolve-bundled-pi.js";
import { getModelsPath, listProviders, upsertOpenAICompatibleProvider } from "../src/provider-config.js";

function usage() {
  return `Axum Agent\n\nUsage:\n  axum [pi args...]\n  axum doctor\n  axum provider add-openai --name <name> --base-url <url> --model <id> [--api-key-env ENV|--api-key KEY]\n  axum provider list\n  axum provider test --provider <name> --model <id> [--prompt text]\n\nAxum delegates to Pi and preloads bundled extensions:\n  - pi-subagents\n  - @cortexkit/pi-magic-context\n\nAny other argument after axum is passed through to Pi.\n`;
}

function providerUsage() {
  return `Axum provider commands\n\nUsage:\n  axum provider add-openai --name <name> --base-url <url> --model <id> [--api-key-env ENV|--api-key KEY]\n  axum provider list\n  axum provider test --provider <name> --model <id> [--prompt text]\n\nOptions:\n  --name <name>                  Provider id written to ~/.pi/agent/models.json\n  --base-url <url>               OpenAI-compatible endpoint, usually ending in /v1\n  --model <id>                   Model id exposed by the provider\n  --model-name <name>            Display name; defaults to model id\n  --api-key-env <ENV>            Store key reference like $ENV, recommended\n  --api-key <KEY>                Store literal key in models.json; not recommended for shared machines\n  --context-window <tokens>      Defaults to 128000\n  --max-tokens <tokens>          Defaults to 32000\n  --reasoning                    Mark model as reasoning-capable\n  --supports-developer-role      Do not disable developer role compatibility\n  --supports-reasoning-effort    Do not disable reasoning_effort compatibility\n`;
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
  if (subcommand === "add-openai") {
    const flags = parseFlags(argv.slice(1));
    const name = requireFlag(flags, "name");
    const baseUrl = requireFlag(flags, "base-url");
    const model = requireFlag(flags, "model");
    if (flags["api-key"] && flags["api-key-env"]) throw new Error("use only one of --api-key or --api-key-env");
    const result = upsertOpenAICompatibleProvider({
      name,
      baseUrl,
      model,
      modelName: flags["model-name"],
      apiKeyEnv: flags["api-key-env"],
      apiKey: flags["api-key"],
      contextWindow: flags["context-window"],
      maxTokens: flags["max-tokens"],
      reasoning: flags.reasoning,
      supportsDeveloperRole: flags["supports-developer-role"],
      supportsReasoningEffort: flags["supports-reasoning-effort"],
    });
    console.log(`wrote ${result.file}`);
    console.log(`provider ${name}: ${baseUrl}`);
    console.log(`model ${model}`);
    return 0;
  }
  if (subcommand === "list") {
    const providers = listProviders();
    if (!providers.length) {
      console.log(`no providers configured in ${getModelsPath()}`);
      return 0;
    }
    for (const provider of providers) {
      console.log(`${provider.id}\t${provider.api}\t${provider.baseUrl}\t${provider.models.join(",")}`);
    }
    return 0;
  }
  if (subcommand === "test") {
    const flags = parseFlags(argv.slice(1));
    const provider = requireFlag(flags, "provider");
    const model = requireFlag(flags, "model");
    const prompt = flags.prompt || "reply exactly AXUM_OK";
    runPi(["--provider", provider, "--model", model, "--print", prompt]);
    return undefined;
  }
  throw new Error(`unknown provider command: ${subcommand}`);
}

function resolveArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { mode: "help" };
  if (argv[0] === "doctor") return { mode: "doctor" };
  if (argv[0] === "provider") return { mode: "provider", argv: argv.slice(1) };
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
if (action.mode === "provider") {
  try {
    const code = runProviderCommand(action.argv ?? []);
    if (code !== undefined) process.exit(code);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
runPi(action.passthrough ?? []);
