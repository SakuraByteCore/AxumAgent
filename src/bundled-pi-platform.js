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

export const bundledPiPackages = [
  { name: "@earendil-works/pi-coding-agent@0.80.10", packageName: "@earendil-works/pi-coding-agent", extensionPath: null, android: true },
  { name: "pi-subagents@0.35.1", packageName: "pi-subagents", extensionPath: "index.ts", android: true },
  { name: "pi-hermes-memory@file:plugin/pi-hermes-memory", packageName: "pi-hermes-memory", extensionPath: "src/index.ts", android: true },
  // pi-rtk-optimizer depends on an external `rtk` executable. Windows users can
  // run Axum without this optional optimization; loading it by default there
  // produces noisy startup warnings and can make first-run failures look fatal.
  { name: "pi-rtk-optimizer@0.9.0", packageName: "pi-rtk-optimizer", extensionPath: "index.ts", android: true, unsupportedPlatforms: ["win32"] },
  { name: "@ff-labs/pi-fff@0.10.1", packageName: "@ff-labs/pi-fff", extensionPath: "src/index.ts", android: true },
];

export function supportedBundledPiPackageEntries(options) {
  return bundledPiPackages.filter((pkg) => supportsPackage(pkg, options));
}

export function supportedBundledPiPackages(options) {
  return supportedBundledPiPackageEntries(options).map((pkg) => pkg.name);
}

export function supportedBundledPiExtensions(options) {
  return supportedBundledPiPackageEntries(options)
    .filter((pkg) => pkg.extensionPath)
    .map((pkg) => ({ packageName: pkg.packageName, extensionPath: pkg.extensionPath }));
}

export function expectedBundledExtensionCount(options) {
  return supportedBundledPiExtensions(options).length;
}
