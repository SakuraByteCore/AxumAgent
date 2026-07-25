import path from "node:path";
import fs from "node:fs";
import { isAndroidLike } from "./bundled-pi-platform.js";
import { getBundledPiNodeModules } from "./bundled-pi-cache.js";

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
  const subagentsRoot = packageRoot("pi-subagents", options);
  const extensions = [path.join(subagentsRoot, "index.ts")];
  if (!isAndroidLike(options)) {
    const magicRoot = packageRoot("@cortexkit/pi-magic-context", options);
    extensions.push(path.join(magicRoot, "dist", "index.js"));
  }
  const rtkRoot = packageRoot("pi-rtk-optimizer", options);
  extensions.push(path.join(rtkRoot, "index.ts"));
  return extensions;
}

export function existingBundledExtensions(options) {
  return resolveBundledExtensions(options).filter((file) => fs.existsSync(file));
}
