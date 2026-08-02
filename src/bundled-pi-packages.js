// Bundled Pi package registry.
//
// This is the single source of truth for which Pi packages and extensions Axum
// bundles. Edit this list to add, remove, or version-pin bundled plugins; the
// rest of the platform code reads it from here so plugin changes stay in one
// small, focused file.
//
// Entry fields:
//   name            npm package spec used by `npm install` (may be a versioned
//                   spec or a file: path relative to the axum package root).
//   packageName     the resolved package name inside node_modules (used to
//                   locate the installed package on disk).
//   extensionPath   relative path(s) to the Pi extension entry file inside the
//                   installed package. Use null for the core CLI package, a
//                   string for a single extension, or an array for packages
//                   that expose multiple Pi extensions.
//   android         when true the package is supported on Android/Termux.
//                   Omit (or set false) to exclude from Android installs.
//   unsupportedPlatforms  array of platform ids (e.g. "win32") to exclude on.

export const bundledPiPackages = [
  { name: "@earendil-works/pi-coding-agent@0.80.10", packageName: "@earendil-works/pi-coding-agent", extensionPath: null, android: true },
  // pi-edit: AxumAgent bundled fork. The upstream npm package
  // depends on better-sqlite3 (native C++) which fails on Android/Termux. This
  // local file: copy replaces all native deps with node:crypto + pure-JS file backend.
  { name: "pi-edit@file:plugin/pi-edit", packageName: "pi-edit", extensionPath: "index.ts", android: true },
  { name: "pi-bar@file:plugin/pi-bar", packageName: "pi-bar", extensionPath: "index.ts", android: true },
  // pi-header: sakura cyberdeck startup header. Pixel-faithful port of the header
  // extension from the pi-sakura-cyberdeck visual pack (single-file, zero native deps).
  { name: "pi-header@file:plugin/pi-header", packageName: "pi-header", extensionPath: "index.ts", android: true },
  // pi-loop-guard: detects assistant output degeneration (repetitive loop
  // / self-reference stacking) at turn_end and re-injects a corrective user
  // message plus a continuous system-prompt guard block. Pure TS, no native deps.
  { name: "pi-loop-guard@file:plugin/pi-loop-guard", packageName: "pi-loop-guard", extensionPath: "index.ts", android: true },
  // pi-goal: pure TS extension for autonomous /goal completion. No native deps.
  { name: "@narumitw/pi-goal@0.31.0", packageName: "@narumitw/pi-goal", extensionPath: "src/index.ts", android: true },
  // pi-fff depends on a Rust native library (libfff_c.so) via ffi-rs. The
  // native binary crashes on Android/Termux (LMDB segfault) and ffi-rs itself
  // fails to load (__clear_cache symbol missing). Rather than maintain a
  // platform-specific fallback, drop pi-fff entirely so behavior is consistent
  // across all platforms. Pi has built-in find/grep tools that cover the gap.
];
