import path from "node:path";
import fs from "node:fs";
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
  const hermesRoot = packageRoot("pi-hermes-memory", options);
  extensions.push(path.join(hermesRoot, "src", "index.ts"));
  const rtkRoot = packageRoot("pi-rtk-optimizer", options);
  extensions.push(path.join(rtkRoot, "index.ts"));
  const fffRoot = packageRoot("@ff-labs/pi-fff", options);
  extensions.push(path.join(fffRoot, "src", "index.ts"));
  return extensions;
}

export function existingBundledExtensions(options) {
  return resolveBundledExtensions(options).filter((file) => fs.existsSync(file));
}
