import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// User-installed npm extension packages, managed via `axum install <npm-spec>`.
// The manifest lives at ~/.axum/packages.json (override: AXUM_USER_PACKAGES_FILE)
// and feeds the same install/compile/load pipeline as the bundled registry:
//   - ensure-bundled-pi.js appends manifest specs to the npm install set
//   - bundled-pi-cache.js folds manifest specs into the cache-root hash
//   - compile-bundled-extensions.js strip-compiles .ts entries on Windows
//   - resolve-bundled-pi.js resolves entries inside the shared cache node_modules
// Manifest shape: { "packages": [{ "name": "pkg@version", "packageName": "pkg",
//                                   "extensionPath": "extensions/index.ts" }] }

function manifestEnv(options = {}) {
  return options.env || process.env;
}

export function getUserPackagesPath(options = {}) {
  const env = manifestEnv(options);
  if (env.AXUM_USER_PACKAGES_FILE) return env.AXUM_USER_PACKAGES_FILE;
  const home = env.HOME || os.homedir();
  return path.join(home, ".axum", "packages.json");
}

export function parsePackageSpec(spec) {
  if (typeof spec !== "string" || spec.length === 0) {
    throw new Error("package spec must be a non-empty string");
  }
  const bare = spec.startsWith("npm:") ? spec.slice(4) : spec;
  if (bare.length === 0) throw new Error(`invalid package spec: ${spec}`);
  let packageName;
  if (bare.startsWith("@")) {
    const idx = bare.indexOf("@", 1);
    packageName = idx === -1 ? bare : bare.slice(0, idx);
  } else {
    const idx = bare.indexOf("@");
    packageName = idx === -1 ? bare : bare.slice(0, idx);
  }
  if (!/^(?:@[^/@\s]+\/)?[^/@\s]+$/.test(packageName)) {
    throw new Error(`invalid package spec: ${spec}`);
  }
  return { name: bare, packageName };
}

export function loadUserPackages(options = {}) {
  const file = getUserPackagesPath(options);
  if (!fs.existsSync(file)) return [];
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`failed to read user packages manifest ${file}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in user packages manifest ${file}: ${err.message}`);
  }
  const packages = Array.isArray(data) ? data : data?.packages;
  if (!Array.isArray(packages)) {
    throw new Error(`user packages manifest ${file} must contain a "packages" array`);
  }
  return packages.map((entry, index) => {
    if (!entry || typeof entry.name !== "string" || typeof entry.packageName !== "string") {
      throw new Error(`user packages manifest ${file}: entry ${index} must include string "name" and "packageName"`);
    }
    return { ...entry };
  });
}

export function saveUserPackages(packages, options = {}) {
  const file = getUserPackagesPath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ packages }, null, 2) + "\n");
}

export function userPackageNames(options = {}) {
  return loadUserPackages(options).map((entry) => entry.name);
}

export function userPackageExtensionEntries(options = {}) {
  return loadUserPackages(options).filter((entry) => typeof entry.extensionPath === "string" && entry.extensionPath.length > 0);
}

// Discover the Pi extension entry point of an installed package from its
// package.json "pi".extensions manifest field. Returns null when the package
// declares no extension entry point.
export function discoverExtensionPath(packageRoot) {
  const manifestPath = path.join(packageRoot, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new Error(`failed to read ${manifestPath}: ${err.message}`);
  }
  const extensions = pkg?.pi?.extensions;
  if (!Array.isArray(extensions) || extensions.length === 0 || typeof extensions[0] !== "string") return null;
  return extensions[0].replace(/^\.\//, "").replace(/^\//, "");
}
