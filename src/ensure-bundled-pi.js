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

function ensurePluginLink(cacheRoot) {
  const pluginLink = path.join(cacheRoot, "plugin", "pi-hermes-memory");
  if (fs.existsSync(pluginLink)) return;
  const source = getPluginSourceDir();
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(pluginLink), { recursive: true });
  fs.symlinkSync(source, pluginLink, "dir");
}

function npmInstallEnv(options) {
  const base = { ...process.env, ...(options?.env ?? {}) };
  for (const key of Object.keys(base)) {
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
  const npm = options?.npmCommand || process.env.AXUM_BUNDLED_PI_NPM || (process.platform === "win32" ? "npm.cmd" : "npm");
  const args = ["install", "--prefix", cacheRoot, "--omit=dev", "--no-audit", "--no-fund", "--no-save", "--install-strategy=hoisted", ...supportedBundledPiPackages(options)];
  console.error("Axum first-run setup: installing bundled Pi and extensions...");
  ensurePluginLink(cacheRoot);
  const result = spawnSync(npm, args, {
    cwd: cacheRoot,
    stdio: "inherit",
    env: npmInstallEnv(options),
  });

  if (result.error) throw new Error(`failed to install bundled Pi dependencies: ${result.error.message}`);
  if ((result.status ?? 1) !== 0) throw new Error(`failed to install bundled Pi dependencies: npm exited ${result.status}`);
  if (!bundledReady(options)) throw new Error("bundled Pi installation completed but required files are still missing");
  applyBundledPiPatches(options);
}
