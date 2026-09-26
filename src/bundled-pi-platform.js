import { bundledPiPackages } from "./bundled-pi-packages.js";
import { userPackageExtensionEntries } from "./user-packages.js";
import fs from "fs";
import path from "path";
import os from "os";

export function isAndroidLike({ platform, env = process.env } = {}) {
  return resolvedPlatform({ platform, env }) === "android" || Boolean(env.TERMUX_VERSION || env.PREFIX?.includes("/com.termux/"));
}

function resolvedPlatform(options = {}) {
  return options.platform || options.env?.AXUM_BUNDLED_PI_TEST_PLATFORM || process.platform;
}

function supportsPackage(pkg, options = {}) {
  const platform = resolvedPlatform(options);
  const android = isAndroidLike(options);
  if (android) return pkg.android !== false;
  if (pkg.unsupportedPlatforms?.includes(platform)) return false;
  return true;
}

export function currentBundledPiPlatform(options) {
  return resolvedPlatform(options);
}

// The bundled package list lives in ./bundled-pi-packages.js so plugin
// additions/removals/version bumps stay in one focused, easy-to-edit file.

export function supportedBundledPiPackageEntries(options) {
  return bundledPiPackages.filter((pkg) => supportsPackage(pkg, options));
}

export function supportedBundledPiPackages(options) {
  return supportedBundledPiPackageEntries(options).map((pkg) => pkg.name);
}

// Local file: plugins are shipped under the axum package's plugin/ directory and
// must be synced into the cache before npm installs their file: spec. Derive the
// set from the registry instead of maintaining a separate hand-written list, so
// adding a file: plugin to bundled-pi-packages.js never silently drops its
// source sync (the bug that broke axum doctor when pi-bar was added).
// Returns packageName strings (e.g. "pi-bar"), matching the plugin/ subdir name.
export function localPluginNames(options) {
  return supportedBundledPiPackageEntries(options)
    .filter((pkg) => pkg.name.includes("file:"))
    .map((pkg) => pkg.packageName);
}

export function supportedBundledPiExtensions(options) {
  return supportedBundledPiPackageEntries(options)
    .filter((pkg) => pkg.extensionPath)
    .flatMap((pkg) => {
      const paths = Array.isArray(pkg.extensionPath) ? pkg.extensionPath : [pkg.extensionPath];
      return paths.map((extensionPath) => ({ packageName: pkg.packageName, extensionPath }));
    });
}

export function supportedBundledPiSkills(options) {
  return supportedBundledPiPackageEntries(options)
    .filter((pkg) => Array.isArray(pkg.skills) ? pkg.skills.length > 0 : Boolean(pkg.skills))
    .flatMap((pkg) => {
      const list = Array.isArray(pkg.skills) ? pkg.skills : [pkg.skills];
      return list.map((skillPath) => ({ packageName: pkg.packageName, skillPath }));
    });
}

export function expectedBundledExtensionCount(options) {
  return supportedBundledPiExtensions(options).length;
}

// User plugin discovery: scan ~/.axum/plugins/ for user-defined extensions.
// Each plugin directory must contain an index.ts entry point.
// Returns plugin metadata compatible with bundled plugin format.
export function getUserPluginPaths(options = {}) {
  const homeDir = process.env.HOME || os.homedir();
  const userPluginsDir = path.join(homeDir, ".axum", "plugins");
  
  if (!fs.existsSync(userPluginsDir)) {
    return [];
  }
  
  try {
    return fs.readdirSync(userPluginsDir)
      .filter((name) => {
        const pluginDir = path.join(userPluginsDir, name);
        const stat = fs.statSync(pluginDir);
        const hasIndex = fs.existsSync(path.join(pluginDir, "index.ts")) || fs.existsSync(path.join(pluginDir, "index.js"));
        return stat.isDirectory() && hasIndex;
      })
      .map((name) => {
        const pluginDir = path.join(userPluginsDir, name);
        const indexPath = fs.existsSync(path.join(pluginDir, "index.ts")) ? "index.ts" : "index.js";
        return {
          name: `user-plugin:${name}`,
          packageName: name,
          extensionPath: path.join(pluginDir, indexPath),
          source: "user",
          userPlugin: true,
        };
      });
  } catch (err) {
    console.warn(`Warning: failed to scan user plugins at ${userPluginsDir}:`, err.message);
    return [];
  }
}

// Project plugin discovery: scan ./axum-plugins/ for project-local extensions.
// Each plugin directory must contain an index.ts entry point.
// Returns plugin metadata compatible with bundled plugin format.
export function getProjectPluginPaths(options = {}) {
  const cwd = options.cwd || process.cwd();
  const projectPluginsDir = path.join(cwd, "axum-plugins");
  
  if (!fs.existsSync(projectPluginsDir)) {
    return [];
  }
  
  try {
    return fs.readdirSync(projectPluginsDir)
      .filter((name) => {
        const pluginDir = path.join(projectPluginsDir, name);
        const stat = fs.statSync(pluginDir);
        const hasIndex = fs.existsSync(path.join(pluginDir, "index.ts")) || fs.existsSync(path.join(pluginDir, "index.js"));
        return stat.isDirectory() && hasIndex;
      })
      .map((name) => {
        const pluginDir = path.join(projectPluginsDir, name);
        const indexPath = fs.existsSync(path.join(pluginDir, "index.ts")) ? "index.ts" : "index.js";
        return {
          name: `project-plugin:${name}`,
          packageName: name,
          extensionPath: path.join(pluginDir, indexPath),
          source: "project",
          userPlugin: true,
        };
      });
  } catch (err) {
    console.warn(`Warning: failed to scan project plugins at ${projectPluginsDir}:`, err.message);
    return [];
  }
}

// Unified plugin discovery: returns all plugins in priority order:
// 1. Project plugins (./axum-plugins/)
// 2. User plugins (~/.axum/plugins/)
// 3. Bundled plugins (from bundled-pi-packages.js)
export function getAllPluginExtensions(options = {}) {
  const project = getProjectPluginPaths(options);
  const user = getUserPluginPaths(options);
  const bundled = supportedBundledPiExtensions(options);
  
  return [...project, ...user, ...userPackageExtensionEntries(options), ...bundled];
}
