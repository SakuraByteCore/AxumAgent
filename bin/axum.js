#!/usr/bin/env node
import path from "node:path";

function usage() {
  return `Axum Agent

Usage:
  axum
  axum code [--safe] [pi args...]
  axum resume [--safe] [pi args...]
  axum web [--port <port>]
  axum doctor
  axum versions
  axum update [version]
  axum install

Commands:
  code          Start bundled Pi coding agent with Axum defaults
                Use --safe to skip all bundled extensions
  resume        Resume a previous session via Pi's session picker
                (equivalent to \`axum code --resume\`)
  web           Open the local OpenAI-compatible provider setup page
  doctor        Check bundled Pi and extension files
  versions      List published Axum versions and the currently installed one
  update        Reinstall Axum; without a version argument it pulls the main
                branch tarball, with a version it pulls that git tag instead
  install       Force install/reinstall bundled Pi and all extensions
                (triggers full npm install + TypeScript compilation)

Axum delegates code sessions to Pi and preloads bundled extensions:
  - pi-bar
  - pi-companion
  - @narumitw/pi-goal

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

function resolveArgs(argv) {
  if (argv.length === 0) return { mode: "help" };
  if (argv[0] === "web") return { mode: "web", argv: argv.slice(1) };
  if (argv[0] === "code") return { mode: "run", passthrough: argv.slice(1) };
  if (argv[0] === "resume") return { mode: "run", passthrough: ["--resume", ...argv.slice(1)] };
  if (argv[0] === "doctor") return { mode: "doctor" };
  if (argv[0] === "versions") return { mode: "versions" };
  if (argv[0] === "update") return { mode: "update", version: argv[1] };
  if (argv[0] === "install") return { mode: "install" };
  if (argv.includes("--help") || argv.includes("-h")) return { mode: "help" };
  return { mode: "help" };
}

async function runWebCommand(argv) {
  const flags = parseFlags(argv);
  const { startProviderWeb } = await import("../src/provider-web.js");
  await startProviderWeb({ port: flags.port ? Number(flags.port) : 0 });
}

async function printDoctor() {
  const [{ ensureBundledPi }, { getBundledPiCacheRoot }, { resolvePiCli, resolveBundledExtensions }, { existsSync }] = await Promise.all([
    import("../src/ensure-bundled-pi.js"),
    import("../src/bundled-pi-cache.js"),
    import("../src/resolve-bundled-pi.js"),
    import("node:fs"),
  ]);

  const options = { env: process.env };
  ensureBundledPi(options);
  const piCli = resolvePiCli(options);
  const extensions = resolveBundledExtensions(options);
  const missing = [piCli, ...extensions].filter((file) => !existsSync(file));
  console.log("Axum bundled Pi doctor");
  console.log(`cache: ${getBundledPiCacheRoot(options)}`);
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

async function runInstall() {
  const [{ ensureBundledPi }, { getBundledPiCacheRoot }, { resolvePiCli, resolveBundledExtensions, existingBundledExtensions }, { compileBundledExtensions }, { existsSync, rmSync, mkdirSync }] = await Promise.all([
    import("../src/ensure-bundled-pi.js"),
    import("../src/bundled-pi-cache.js"),
    import("../src/resolve-bundled-pi.js"),
    import("../src/compile-bundled-extensions.js"),
    import("node:fs"),
  ]);

  const options = { env: process.env };
  const cacheRoot = getBundledPiCacheRoot(options);

  console.log("Axum: forcing bundled Pi install + compilation...");
  // Force clean reinstall by removing node_modules
  rmSync(path.join(cacheRoot, "node_modules"), { recursive: true, force: true });
  // Also prune stale compile caches
  const prefix = "v8-compile-cache-";
  try {
    for (const entry of fs.readdirSync(cacheRoot)) {
      if (entry.startsWith(prefix)) {
        rmSync(path.join(cacheRoot, entry), { recursive: true, force: true });
      }
    }
  } catch {}

  ensureBundledPi(options);

  const piCli = resolvePiCli(options);
  const extensions = resolveBundledExtensions(options);
  const missing = [piCli, ...extensions].filter((file) => !existsSync(file));
  if (missing.length) {
    console.error("install completed but some files are missing:");
    for (const file of missing) console.error(`- ${file}`);
    return 1;
  }
  console.log("ok");
  console.log(`cache: ${cacheRoot}`);
  console.log(`pi cli: ${piCli}`);
  console.log(`extensions: ${extensions.length}`);
  return 0;
}

async function runUpdate(version) {
  const [{ spawn }, { resolveNpmInstallCommand }, { resolveTarballUrl }] = await Promise.all([
    import("node:child_process"),
    import("../src/ensure-bundled-pi.js"),
    import("../src/version-config.js"),
  ]);

  const label = version ? `version ${version}` : "main branch";
  console.log(`Updating Axum from ${label}...`);
  const npm = resolveNpmInstallCommand();
  const args = [...npm.argsPrefix, "install", "-g", resolveTarballUrl(version)];
  const child = spawn(npm.command, args, { stdio: "inherit", shell: npm.shell });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
  child.on("error", (error) => {
    console.error(`failed to run npm install: ${error.message}`);
    process.exit(1);
  });
}

async function runVersions() {
  const { getInstalledVersion, fetchAvailableTags } = await import("../src/version-config.js");
  const installed = getInstalledVersion();
  console.log(`axum ${installed} (installed)`);
  if (process.env.AXUM_NO_FETCH_TAGS === "1") {
    console.log("");
    console.log("Switch with: axum update <version>");
    return;
  }
  let tags;
  try {
    tags = await fetchAvailableTags();
  } catch (error) {
    console.error(`failed to list versions: ${error.message}`);
    process.exit(1);
  }
  if (!tags.length) {
    console.log("No published versions yet.");
    return;
  }
  const installedTag = `v${installed}`;
  for (const tag of tags) {
    const marker = tag === installedTag ? " <- current" : "";
    console.log(`  ${tag}${marker}`);
  }
  console.log("");
  console.log("Switch with: axum update <version>");
}

function hasArg(args, name) {
  return args.includes(name) || args.some((arg) => arg.startsWith(`${name}=`));
}

function splitAxumCodeArgs(passthrough) {
  const safe = passthrough.includes("--safe");
  return { safe, piArgs: passthrough.filter((arg) => arg !== "--safe") };
}

function buildPiEnv(compileCacheDir) {
  const env = { ...process.env, AXUM_BUNDLED_PI: "1" };
  if (compileCacheDir && !env.NODE_COMPILE_CACHE) env.NODE_COMPILE_CACHE = compileCacheDir;
  if (!env.JITI_TRY_NATIVE) env.JITI_TRY_NATIVE = "1";
  return env;
}

async function runPi(passthrough) {
  const [{ ensureBundledPi }, { getBundledPiCacheRoot }, { resolvePiCli, resolveBundledExtensions }, { getDefaultProviderSelection, ensureDefaultProviderReasoningSupport, DEFAULT_THINKING_LEVEL, ensureTuiModeDefault }, { supportedBundledPiPackages }, { ensureSubagentDelegationPolicy }, { spawn }] = await Promise.all([
    import("../src/ensure-bundled-pi.js"),
    import("../src/bundled-pi-cache.js"),
    import("../src/resolve-bundled-pi.js"),
    import("../src/provider-config.js"),
    import("../src/bundled-pi-platform.js"),
    import("../src/default-system-prompt.js"),
    import("node:child_process"),
  ]);

  const bundledPiOptions = { env: process.env };
  ensureBundledPi(bundledPiOptions);
  ensureTuiModeDefault();
  const piCli = resolvePiCli(bundledPiOptions);
  const { safe, piArgs } = splitAxumCodeArgs(passthrough);
  // Ship the subagent delegation policy only where the pi-subagents extension
  // providing the Agent tool actually loads (non-safe sessions, supported platform).
  if (!safe && supportedBundledPiPackages(bundledPiOptions).includes("@tintinweb/pi-subagents")) {
    ensureSubagentDelegationPolicy(bundledPiOptions);
  }
  const extensionArgs = safe ? [] : resolveBundledExtensions(bundledPiOptions).flatMap((file) => ["-e", file]);
  const defaults = getDefaultProviderSelection();
  const hasProviderArg = hasArg(piArgs, "--provider") || hasArg(piArgs, "--model");
  if (defaults && !hasProviderArg) {
    ensureDefaultProviderReasoningSupport(defaults);
  }
  const thinkingLevel = defaults?.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
  const defaultArgs = [
    ...(defaults && !hasProviderArg ? ["--provider", defaults.provider, "--model", defaults.model] : []),
    ...(!hasArg(piArgs, "--thinking") && thinkingLevel ? ["--thinking", thinkingLevel] : []),
  ];
  // Disable ambient Pi extensions from the user's global install before adding
  // Axum's bundled extension set. In safe mode, keep -ne but intentionally skip
  // every bundled -e entry so a broken extension cannot block startup.
  const args = [piCli, "-ne", ...extensionArgs, ...defaultArgs, ...piArgs];
  const compileCacheDir = path.join(getBundledPiCacheRoot(bundledPiOptions), `v8-compile-cache-${process.version}`);
  const child = spawn(process.execPath, args, { stdio: "inherit", env: buildPiEnv(compileCacheDir) });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
  child.on("error", (error) => {
    console.error(`failed to start bundled Pi: ${error.message}`);
    process.exit(1);
  });
}

async function main() {
  const action = resolveArgs(process.argv.slice(2));
  if (action.mode === "help") {
    process.stdout.write(usage());
    return 0;
  }
  if (action.mode === "doctor") return printDoctor();
  if (action.mode === "install") return runInstall();
  if (action.mode === "versions") {
    await runVersions();
    return 0;
  }
  if (action.mode === "update") {
    await runUpdate(action.version);
    return undefined;
  }
  if (action.mode === "web") {
    await runWebCommand(action.argv ?? []);
    return undefined;
  }
  await runPi(action.passthrough ?? []);
  return undefined;
}

try {
  const code = await main();
  if (typeof code === "number") process.exit(code);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}