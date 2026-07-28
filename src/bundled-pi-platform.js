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
