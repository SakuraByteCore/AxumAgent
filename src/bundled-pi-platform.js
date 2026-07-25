export function isAndroidLike({ platform = process.platform, env = process.env } = {}) {
  return platform === "android" || Boolean(env.TERMUX_VERSION || env.PREFIX?.includes("/com.termux/"));
}

export const bundledPiPackages = [
  { name: "@earendil-works/pi-coding-agent@0.80.10", extension: false, android: true },
  { name: "pi-subagents@0.35.1", extension: true, android: true },
  { name: "pi-hermes-memory@file:plugin/pi-hermes-memory", extension: true, android: true },
  { name: "pi-rtk-optimizer@0.9.0", extension: true, android: true },
];

export function supportedBundledPiPackages(options) {
  const android = isAndroidLike(options);
  return bundledPiPackages.filter((pkg) => pkg.android || !android).map((pkg) => pkg.name);
}

export function expectedBundledExtensionCount(options) {
  const android = isAndroidLike(options);
  return bundledPiPackages.filter((pkg) => pkg.extension && (pkg.android || !android)).length;
}
