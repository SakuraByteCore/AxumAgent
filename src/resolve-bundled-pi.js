import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { isAndroidLike } from "./bundled-pi-platform.js";

const require = createRequire(import.meta.url);

function packageDirName(packageName) {
  if (packageName.startsWith("@")) {
    const [scope, name] = packageName.split("/");
    return path.join(scope, name);
  }
  return packageName;
}

function packageRoot(packageName) {
  const packageDir = packageDirName(packageName);
  const searchRoots = require.resolve.paths(packageName) ?? [];
  for (const root of searchRoots) {
    const candidate = path.join(root, packageDir);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  throw new Error(`Unable to resolve package root for ${packageName}`);
}

export function resolvePiCli() {
  return path.join(packageRoot("@earendil-works/pi-coding-agent"), "dist", "cli.js");
}

export function resolveBundledExtensions() {
  const subagentsRoot = packageRoot("pi-subagents");
  const extensions = [path.join(subagentsRoot, "index.ts")];
  if (!isAndroidLike()) {
    const magicRoot = packageRoot("@cortexkit/pi-magic-context");
    extensions.push(path.join(magicRoot, "dist", "index.js"));
  }
  return extensions;
}

export function existingBundledExtensions() {
  return resolveBundledExtensions().filter((file) => fs.existsSync(file));
}
