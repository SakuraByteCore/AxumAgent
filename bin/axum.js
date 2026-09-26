#!/usr/bin/env node
import path from "node:path";
import { supportedBundledPiExtensions } from "../src/bundled-pi-platform.js";

function usage() {
  return `Axum Agent

Usage:
  axum
  axum code [--safe] [pi args...]
  axum resume [--safe] [pi args...]
  axum web [--port <port>]
  axum chat [pi-web args...]
  axum doctor
  axum versions
  axum update [version]
  axum install [pkg...]
  axum mcp [install|add|list|remove] [args...]

Commands:
  code          Start bundled Pi coding agent with Axum defaults
                Use --safe to skip all bundled extensions
  resume        Resume a previous session via Pi's session picker
                (equivalent to \`axum code --resume\`)
  web           Open the local OpenAI-compatible provider setup page
  chat          Start the browser chat UI (bundled @agegr/pi-web)
                Shares providers and sessions with \`axum code\` via ~/.pi
  doctor        Check bundled Pi and extension files
  versions      List published Axum versions and the currently installed one
  update        Reinstall Axum; without a version argument it pulls the main
                branch tarball, with a version it pulls that git tag instead
  install       Without arguments: force reinstall bundled Pi and all
                bundled extensions (full npm install + TypeScript compilation)
  install <pkg> Install user extension packages from npm into the shared Pi
                cache, e.g. axum install npm:pi-cc-extensions
                (persisted in ~/.axum/packages.json, loaded on every start)
  mcp          Manage MCP servers for the pi-mcp-adapter extension
  mcp install  Install the pi-mcp-adapter extension (official MCP support)
  mcp add      Interactively add an MCP server entry (stdio or http(s))
  mcp list     List configured MCP servers
  mcp remove   Remove an MCP server entry

Axum delegates code sessions to Pi and preloads bundled extensions:
${supportedBundledPiExtensions().map((ext) => `  - ${ext.packageName}`).join("\n")}

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
  if (argv[0] === "chat") return { mode: "chat", argv: argv.slice(1) };
  if (argv[0] === "code") return { mode: "run", passthrough: argv.slice(1) };
  if (argv[0] === "resume") return { mode: "run", passthrough: ["--resume", ...argv.slice(1)] };
  if (argv[0] === "doctor") return { mode: "doctor" };
  if (argv[0] === "versions") return { mode: "versions" };
  if (argv[0] === "update") return { mode: "update", version: argv[1] };
  if (argv[0] === "install") return { mode: "install", argv: argv.slice(1) };
  if (argv[0] === "mcp") return { mode: "mcp", argv: argv.slice(1) };
  if (argv.includes("--help") || argv.includes("-h")) return { mode: "help" };
  return { mode: "help" };
}

function mcpUsage() {
  return `Usage:
  axum mcp install            Install the pi-mcp-adapter extension (official MCP support)
  axum mcp add [name]         Interactively add an MCP server entry (stdio or http(s))
  axum mcp list               List configured MCP servers
  axum mcp remove <name>      Remove an MCP server entry

Servers use the standard "mcpServers" JSON format shared with Cursor,
Claude Code, and Codex. The project .mcp.json is preferred; the global
~/.config/mcp/mcp.json is the fallback. Flags --project / --global on
'axum mcp add' force one file explicitly. For stdio servers the command
line may include arguments; the first token becomes the command and the
rest are stored as args.
`;
}

async function runMcpCommand(argv) {
  const [sub, ...rest] = argv;
  const options = { env: process.env, cwd: process.cwd() };
  if (sub === "install") {
    const { MCP_ADAPTER_SPEC } = await import("../src/mcp-config.js");
    return runInstallPackages([MCP_ADAPTER_SPEC]);
  }
  if (sub === "add") return runMcpAdd(rest, options);
  if (sub === "list") return runMcpList(options);
  if (sub === "remove") return runMcpRemove(rest, options);
  process.stdout.write(mcpUsage());
  return sub === undefined ? 0 : 1;
}

function splitMcpFlags(args) {
  const flags = { positional: [] };
  for (const arg of args) {
    if (arg === "--project" || arg === "--global") flags[arg.slice(2)] = true;
    else flags.positional.push(arg);
  }
  return flags;
}

// Sequential interactive prompts. node:readline/promises question() hangs on
// piped stdin in Node 24 once the interface emits close, so drive the event
// readline manually with a line queue that works for both TTY and pipes.
function createPrompter(readlineModule, input = process.stdin, output = process.stdout) {
  const rl = readlineModule.createInterface({ input, output });
  const queued = [];
  let waiter = null;
  let closed = false;
  rl.on("line", (line) => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(line);
    } else {
      queued.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(undefined);
    }
  });
  return {
    prompt(question) {
      output.write(question);
      if (queued.length > 0) return Promise.resolve(queued.shift());
      if (closed) return Promise.resolve(undefined);
      return new Promise((resolve) => { waiter = resolve; });
    },
    close() {
      rl.close();
    },
  };
}

async function runMcpAdd(args, options) {
  const [readlineModule, mcpConfig] = await Promise.all([
    import("node:readline"),
    import("../src/mcp-config.js"),
  ]);
  const flags = splitMcpFlags(args);
  const prompter = createPrompter(readlineModule);
  try {
    const name = flags.positional[0] || (await prompter.prompt("MCP server name: ")).trim();
    if (!name) throw new Error("server name is required");
    const commandOrUrl = (await prompter.prompt("stdio command (arguments allowed) or http(s) url: ")).trim();
    const argsString = (await prompter.prompt("arguments, space-separated (empty to skip): ")).trim();
    const envString = (await prompter.prompt("environment variables, KEY=VALUE comma-separated (empty to skip): ")).trim();
    if (commandOrUrl.length === 0) throw new Error("a stdio command or http(s) url is required");
    const entry = mcpConfig.buildServerEntry(
      commandOrUrl,
      mcpConfig.parseArgsString(argsString),
      mcpConfig.parseEnvString(envString),
    );
    const file = mcpConfig.addMcpServer(name, entry, { ...options, project: flags.project, global: flags.global });
    console.log(`added ${name} -> ${file}`);
    console.log(`  ${entry.url ? "http" : "stdio"}: ${entry.url || [entry.command, ...(entry.args || [])].join(" ")}`);
    return 0;
  } finally {
    prompter.close();
  }
}

async function runMcpList(options) {
  const mcpConfig = await import("../src/mcp-config.js");
  const files = mcpConfig.existingMcpConfigFiles(options);
  if (files.length === 0) {
    console.log("no MCP server config found (project .mcp.json or global ~/.config/mcp/mcp.json)");
    return 0;
  }
  for (const file of files) {
    const servers = mcpConfig.loadMcpConfig(file);
    const names = Object.keys(servers);
    console.log(`${file}${names.length === 0 ? " (no servers)" : ""}`);
    for (const [name, entry] of Object.entries(servers)) {
      const kind = entry.url ? "http" : "stdio";
      const target = entry.url || [entry.command, ...(entry.args || [])].join(" ");
      console.log(`  ${name} (${kind}): ${target}`);
    }
  }
  return 0;
}

async function runMcpRemove(args, options) {
  const mcpConfig = await import("../src/mcp-config.js");
  const name = splitMcpFlags(args).positional[0];
  if (!name) throw new Error("usage: axum mcp remove <name>");
  const file = mcpConfig.removeMcpServer(name, options);
  console.log(`removed ${name} from ${file}`);
  return 0;
}

async function runWebCommand(argv) {
  const flags = parseFlags(argv);
  let port = 0;
  if (flags.port !== undefined) {
    const parsed = Number(flags.port);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      throw new Error("Invalid port: " + flags.port + ". Expected an integer between 0 and 65535 (0 picks a random free port).");
    }
    port = parsed;
  }
  const { startProviderWeb } = await import("../src/provider-web.js");
  await startProviderWeb({ port });
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
  const failed = await reportUserExtensionHealth(options, missing);
  if (missing.length) {
    console.error("missing bundled files:");
    for (const file of missing) console.error(`- ${file}`);
    return 1;
  }
  if (failed) return 1;
  console.log("ok");
  return 0;
}

async function reportUserExtensionHealth(options, missing) {
  const [{ loadUserPackages }, { getBundledPiNodeModules, packageDirName }, mcpConfig, { existsSync }] = await Promise.all([
    import("../src/user-packages.js"),
    import("../src/bundled-pi-cache.js"),
    import("../src/mcp-config.js"),
    import("node:fs"),
  ]);
  let userPackages = [];
  try {
    userPackages = loadUserPackages(options);
  } catch (err) {
    console.log(`user packages manifest: invalid (${err.message})`);
    return true;
  }
  if (userPackages.length === 0) {
    console.log("user extensions: none");
    return false;
  }
  let failed = false;
  for (const entry of userPackages) {
    const pkgRoot = path.join(getBundledPiNodeModules(options), packageDirName(entry.packageName));
    if (!entry.extensionPath) {
      console.log(`user extension: ${entry.name} (no extension entry point recorded)`);
      failed = true;
      continue;
    }
    const extFile = path.join(pkgRoot, entry.extensionPath);
    if (existsSync(extFile)) {
      console.log(`user extension: ${entry.name} (ok)`);
    } else {
      console.log(`user extension: ${entry.name} (missing entry: ${extFile})`);
      failed = true;
    }
  }
  if (userPackages.some((entry) => entry.packageName === mcpConfig.MCP_ADAPTER_PACKAGE)) {
    reportMcpConfigHealth(options, mcpConfig);
  }
  return failed;
}

function reportMcpConfigHealth(options, mcpConfig) {
  const files = mcpConfig.existingMcpConfigFiles(options);
  if (files.length === 0) {
    console.log(`mcp config: none found — run 'axum mcp add' or the /mcp setup wizard in a session`);
    return;
  }
  for (const file of files) {
    try {
      const servers = mcpConfig.loadMcpConfig(file);
      console.log(`mcp config: ${file} (valid, ${Object.keys(servers).length} server(s))`);
    } catch (err) {
      console.log(`mcp config: ${file} (invalid: ${err.message})`);
    }
  }
}

async function runInstall() {
  const [{ ensureBundledPi, pruneStaleCompileCaches }, { getBundledPiCacheRoot }, { resolvePiCli, resolveBundledExtensions }, { existsSync, rmSync }] = await Promise.all([
    import("../src/ensure-bundled-pi.js"),
    import("../src/bundled-pi-cache.js"),
    import("../src/resolve-bundled-pi.js"),
    import("node:fs"),
  ]);

  const options = { env: process.env };
  const cacheRoot = getBundledPiCacheRoot(options);

  console.log("Axum: forcing bundled Pi install + compilation...");
  // Force clean reinstall by removing node_modules
  rmSync(path.join(cacheRoot, "node_modules"), { recursive: true, force: true });
  // Also prune stale compile caches
  pruneStaleCompileCaches(cacheRoot);

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

async function runInstallPackages(specs) {
  const [{ ensureBundledPi }, { compileBundledExtensions }, { getBundledPiCacheRoot, getBundledPiNodeModules, packageDirName }, { loadUserPackages, saveUserPackages, parsePackageSpec, discoverExtensionPath, getUserPackagesPath }, { bundledPiPackages }, { default: path }] = await Promise.all([
    import("../src/ensure-bundled-pi.js"),
    import("../src/compile-bundled-extensions.js"),
    import("../src/bundled-pi-cache.js"),
    import("../src/user-packages.js"),
    import("../src/bundled-pi-packages.js"),
    import("node:path"),
  ]);

  const options = { env: process.env };
  const existing = loadUserPackages(options);
  const previous = JSON.stringify(existing);
  const requested = [...specs
    .map((spec) => parsePackageSpec(spec))
    .reduce((byName, spec) => byName.set(spec.packageName, spec), new Map())
    .values()];
  for (const { packageName } of requested) {
    if (bundledPiPackages.some((pkg) => pkg.packageName === packageName)) {
      throw new Error(`${packageName} is already part of Axum's bundled extension set; Axum manages its version`);
    }
  }
  const next = existing.filter((entry) => !requested.some((r) => r.packageName === entry.packageName));
  for (const { name, packageName } of requested) {
    next.push({ name, packageName });
  }
  saveUserPackages(next, options);
  try {
    console.log("Axum: installing user extension packages...");
    ensureBundledPi(options);
    const nodeModules = getBundledPiNodeModules(options);
    for (const entry of next) {
      const pkgRoot = path.join(nodeModules, packageDirName(entry.packageName));
      const extensionPath = discoverExtensionPath(pkgRoot);
      if (!extensionPath) {
        throw new Error(`${entry.name} installed successfully but declares no "pi".extensions entry point in its package.json; not a Pi extension package`);
      }
      entry.extensionPath = extensionPath;
      console.log(`installed ${entry.name} -> ${entry.packageName}/${extensionPath}`);
    }
    saveUserPackages(next, options);
    // The manifest gained extensionPath only after install, so the compile pass
    // during ensureBundledPi skipped the new entries. Compile them now so .ts
    // entry points resolve to .js on platforms without runtime TS support.
    compileBundledExtensions(options);
  } catch (error) {
    saveUserPackages(JSON.parse(previous), options);
    throw error;
  }
  console.log(`user packages manifest: ${getUserPackagesPath(options)}`);
  console.log("Done. Restart axum code to load the installed extensions.");
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
  
  // 传递用户配置的 User-Agent 给 Pi
  try {
    const { getUserAgent } = require("../src/provider-config.js");
    const customUserAgent = getUserAgent();
    if (customUserAgent) {
      env.AXUM_USER_AGENT = customUserAgent;
    }
  } catch {
    // 忽略错误，继续启动
  }
  
  return env;
}

async function runPi(passthrough) {
  const [{ ensureBundledPi }, { getBundledPiCacheRoot }, { resolvePiCli, resolveBundledExtensions }, { getDefaultProviderSelection, ensureDefaultProviderReasoningSupport, DEFAULT_THINKING_LEVEL, ensureTuiModeDefault, ensureWebSearchWorkflowDefault }, { supportedBundledPiPackages }, { ensureTodoProgressPolicy, ensureParallelToolBatchingPolicy, ensureSubagentDelegationPolicy }, { spawn }] = await Promise.all([
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
  ensureWebSearchWorkflowDefault();
  const piCli = resolvePiCli(bundledPiOptions);
  const { safe, piArgs } = splitAxumCodeArgs(passthrough);
  const packageNames = supportedBundledPiPackages(bundledPiOptions);
  // Ship the todo progress policy only where pi-todo loads (non-safe sessions).
  if (!safe && packageNames.some((name) => name.startsWith("@gamaraan/todos-tool@"))) {
    ensureTodoProgressPolicy(bundledPiOptions);
  }
  // Parallel tool batching is core Pi behavior and applies to every session.
  ensureParallelToolBatchingPolicy(bundledPiOptions);
  // Ship the subagent delegation policy only where pi-subagents loads
  // (non-safe sessions).
  if (!safe && packageNames.some((name) => name.startsWith("pi-subagents@"))) {
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
  if (action.mode === "mcp") return runMcpCommand(action.argv);
  if (action.mode === "install") {
    return (action.argv?.length ?? 0) > 0 ? runInstallPackages(action.argv) : runInstall();
  }
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
  if (action.mode === "chat") {
    const { runPiWebChat } = await import("../src/pi-web-chat.js");
    runPiWebChat(action.argv ?? []);
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