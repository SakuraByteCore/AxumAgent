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
  // pi-powerbar: pure JS powerline status bar, no native deps. Cross-platform.
  // The package declares "./src" (directory) with 7 powerbar-* sub-extensions
  // plus @juanibiapina/pi-usage. Axum lists each entry file explicitly since
  // pi's -e flag takes files, not directories.
  { name: "@juanibiapina/pi-powerbar@0.13.0", packageName: "@juanibiapina/pi-powerbar", extensionPath: [
    "src/powerbar/index.ts",
    "src/powerbar-context/index.ts",
    "src/powerbar-git/index.ts",
    "src/powerbar-model/index.ts",
    "src/powerbar-provider/index.ts",
    "src/powerbar-sub/index.ts",
    "src/powerbar-tokens/index.ts",
    "node_modules/@juanibiapina/pi-usage/index.ts",
  ], android: true },
  // pi-edit: AxumAgent bundled fork. The upstream npm package
  // depends on better-sqlite3 (native C++) which fails on Android/Termux. This
  // local file: copy replaces all native deps with node:crypto + pure-JS file backend.
  { name: "pi-edit@file:plugin/pi-edit", packageName: "pi-edit", extensionPath: "index.ts", android: true },
  // pi-goal: pure TS extension for autonomous /goal completion. No native deps.
  { name: "@narumitw/pi-goal@0.31.0", packageName: "@narumitw/pi-goal", extensionPath: "src/index.ts", android: true },
  // pi-fff depends on a Rust native library (libfff_c.so) via ffi-rs. The
  // native binary crashes on Android/Termux (LMDB segfault) and ffi-rs itself
  // fails to load (__clear_cache symbol missing). Rather than maintain a
  // platform-specific fallback, drop pi-fff entirely so behavior is consistent
  // across all platforms. Pi has built-in find/grep tools that cover the gap.
  // pi-rtk-optimizer and pi-statusline removed: the former depends on an
  // external `rtk` binary (unavailable on Android), the latter is superseded
  // by @juanibiapina/pi-powerbar which provides richer powerline status.
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
    .flatMap((pkg) => {
      const paths = Array.isArray(pkg.extensionPath) ? pkg.extensionPath : [pkg.extensionPath];
      return paths.map((extensionPath) => ({ packageName: pkg.packageName, extensionPath }));
    });
}

export function expectedBundledExtensionCount(options) {
  return supportedBundledPiExtensions(options).length;
}
