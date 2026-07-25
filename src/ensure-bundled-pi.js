import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectedBundledExtensionCount, supportedBundledPiPackages } from "./bundled-pi-platform.js";
import { existingBundledExtensions, resolvePiCli } from "./resolve-bundled-pi.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function bundledReady() {
  try {
    const piCli = resolvePiCli();
    const extensions = existingBundledExtensions();
    return fs.existsSync(piCli) && extensions.length === expectedBundledExtensionCount() && extensions.every((file) => fs.existsSync(file));
  } catch {
    return false;
  }
}

export function ensureBundledPi() {
  if (bundledReady()) return;

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-save", "--install-strategy=hoisted", ...supportedBundledPiPackages()];
  console.error("Axum first-run setup: installing bundled Pi and extensions...");
  const result = spawnSync(npm, args, {
    cwd: packageRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_package_lock: "false",
    },
  });

  if (result.error) throw new Error(`failed to install bundled Pi dependencies: ${result.error.message}`);
  if ((result.status ?? 1) !== 0) throw new Error(`failed to install bundled Pi dependencies: npm exited ${result.status}`);
  if (!bundledReady()) throw new Error("bundled Pi installation completed but required files are still missing");
}
