import path from "node:path";
import fs from "node:fs";
import { getBundledPiNodeModules } from "./bundled-pi-cache.js";
import { readCompileManifest } from "./compile-bundled-extensions.js";
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

function compiledExtensionPath(extensionEntryPath, packageRoot) {
  if (!extensionEntryPath.endsWith(".ts")) return undefined;
  const jsPath = extensionEntryPath.slice(0, -3) + ".js";
  if (!fs.existsSync(jsPath)) return undefined;
  const manifest = readCompileManifest(packageRoot);
  if (!manifest) return undefined;
  const rel = path.relative(packageRoot, extensionEntryPath).replaceAll(path.sep, "/");
  return manifest.files[rel] ? jsPath : undefined;
}

export function resolveBundledExtensions(options) {
  return supportedBundledPiExtensions(options).map((extension) => {
    const pkgRoot = packageRoot(extension.packageName, options);
    const entryPath = path.join(pkgRoot, extension.extensionPath);
    try {
      const compiled = compiledExtensionPath(entryPath, pkgRoot);
      if (compiled) return compiled;
    } catch { /* fall back to the TS source */ }
    return entryPath;
  });
}

export function existingBundledExtensions(options) {
  return resolveBundledExtensions(options).filter((file) => fs.existsSync(file));
}
