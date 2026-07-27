import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectedBundledExtensionCount, supportedBundledPiPackages } from "./bundled-pi-platform.js";
import { getBundledPiCacheRoot } from "./bundled-pi-cache.js";
import { applyBundledPiPatches } from "./bundled-pi-patches.js";
import { existingBundledExtensions, resolvePiCli } from "./resolve-bundled-pi.js";

function getPluginSourceDir() {
  const thisFile = fileURLToPath(import.meta.url);
  const pkgRoot = path.resolve(path.dirname(thisFile), "..");
  return path.join(pkgRoot, "plugin", "pi-hermes-memory");
}

function ensurePluginSource(cacheRoot) {
  const pluginDir = path.join(cacheRoot, "plugin", "pi-hermes-memory");
  const source = getPluginSourceDir();
  if (!fs.existsSync(source)) return;
  if (fs.existsSync(path.join(pluginDir, "package.json"))) return;
  fs.rmSync(pluginDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(pluginDir), { recursive: true });
  // npm resolves file: dependencies through their realpath. A symlink back to the
  // global Axum install makes pi-hermes-memory resolve native deps from
  // D:\npm-global\node_modules\axum instead of the bundled cache on Windows.
  // Copy the plugin into the cache so its realpath stays beside cache/node_modules.
  fs.cpSync(source, pluginDir, { recursive: true, dereference: true });
}

export function npmInstallEnv(options) {
  const base = { ...process.env, ...(options?.env ?? {}) };
  for (const key of Object.keys(base)) {
    if (!key || key.includes("=") || key.startsWith("=")) {
      delete base[key];
      continue;
    }
    if (key === "npm_config_user_agent") continue;
    if (key.startsWith("npm_")) delete base[key];
  }
  return {
    ...base,
    npm_config_global: "false",
    npm_config_prefix: getBundledPiCacheRoot(options),
    npm_config_package_lock: "false",
  };
}

function resolveNodeBundledNpmCli(nodePath = process.execPath) {
  const candidate = path.join(path.dirname(nodePath), "node_modules", "npm", "bin", "npm-cli.js");
  return fs.existsSync(candidate) ? candidate : "";
}

function needsWindowsShell(command) {
  return /\.(?:cmd|bat)$/i.test(command);
}

export function resolveNpmInstallCommand(options = {}) {
  const platform = options.platform || process.platform;
  const explicitNpm = options.npmCommand || process.env.AXUM_BUNDLED_PI_NPM;
  if (explicitNpm) return { command: explicitNpm, argsPrefix: [], shell: platform === "win32" && needsWindowsShell(explicitNpm) };

  if (platform === "win32") {
    const npmCli = resolveNodeBundledNpmCli(options.nodePath || process.execPath);
    if (npmCli) return { command: options.nodePath || process.execPath, argsPrefix: [npmCli], shell: false };
    return { command: "npm.cmd", argsPrefix: [], shell: true };
  }

  return { command: "npm", argsPrefix: [], shell: false };
}

function bundledReady(options) {
  try {
    const piCli = resolvePiCli(options);
    const extensions = existingBundledExtensions(options);
    return fs.existsSync(piCli) && extensions.length === expectedBundledExtensionCount(options) && extensions.every((file) => fs.existsSync(file));
  } catch {
    return false;
  }
}

export function ensureBundledPi(options) {
  if (bundledReady(options)) {
    applyBundledPiPatches(options);
    return;
  }

  const cacheRoot = getBundledPiCacheRoot(options);
  fs.mkdirSync(cacheRoot, { recursive: true });
  const npm = resolveNpmInstallCommand(options);
  const args = ["install", "--prefix", cacheRoot, "--omit=dev", "--no-audit", "--no-fund", "--no-save", "--install-strategy=hoisted", ...supportedBundledPiPackages(options)];
  console.error("Axum first-run setup: installing bundled Pi and extensions...");
  ensurePluginSource(cacheRoot);
  const result = spawnSync(npm.command, [...npm.argsPrefix, ...args], {
    cwd: cacheRoot,
    stdio: "inherit",
    env: npmInstallEnv(options),
    shell: npm.shell,
  });

  if (result.error) throw new Error(`failed to install bundled Pi dependencies: ${result.error.message}`);
  if ((result.status ?? 1) !== 0) throw new Error(`failed to install bundled Pi dependencies: npm exited ${result.status}`);
  if (!bundledReady(options)) throw new Error("bundled Pi installation completed but required files are still missing");
  applyBundledPiPatches(options);
}
