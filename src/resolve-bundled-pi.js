import path from "node:path";
import fs from "node:fs";
import { getBundledPiNodeModules } from "./bundled-pi-cache.js";
import { supportedBundledPiExtensions } from "./bundled-pi-platform.js";

function packageDirName(packageName) {
  if (packageName.startsWith("@")) {
    const [scope, name] = packageName.split("/");
    return path.join(scope, name);
  }
  return packageName;
}

function packageRoot(packageName, options) {
  const packageDir = packageDirName(packageName);
  const candidate = path.join(getBundledPiNodeModules(options), packageDir);
  if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
  throw new Error(`Unable to resolve package root for ${packageName}`);
}

export function resolvePiCli(options) {
  return path.join(packageRoot("@earendil-works/pi-coding-agent", options), "dist", "cli.js");
}

export function resolveBundledExtensions(options) {
  return supportedBundledPiExtensions(options).map((extension) => (
    path.join(packageRoot(extension.packageName, options), extension.extensionPath)
  ));
}

export function existingBundledExtensions(options) {
  return resolveBundledExtensions(options).filter((file) => fs.existsSync(file));
}
