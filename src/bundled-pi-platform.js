import { bundledPiPackages } from "./bundled-pi-packages.js";

export function isAndroidLike({ platform = process.platform, env = process.env } = {}) {
  return platform === "android" || Boolean(env.TERMUX_VERSION || env.PREFIX?.includes("/com.termux/"));
}

function supportsPackage(pkg, options = {}) {
  const platform = options.platform || process.platform;
  const android = isAndroidLike(options);
  if (android) return pkg.android !== false;
  if (pkg.unsupportedPlatforms?.includes(platform)) return false;
  return true;
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
// Returns packageName strings (e.g. "pi-edit"), matching the plugin/ subdir name.
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

export function expectedBundledExtensionCount(options) {
  return supportedBundledPiExtensions(options).length;
}
