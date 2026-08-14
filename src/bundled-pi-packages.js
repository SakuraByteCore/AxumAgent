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
  { name: "@earendil-works/pi-coding-agent@0.81.1", packageName: "@earendil-works/pi-coding-agent", extensionPath: null, android: true },
  { name: "pi-bar@file:plugin/pi-bar", packageName: "pi-bar", extensionPath: "index.ts", android: true },
  // pi-bar now also hosts the sakura cyberdeck startup header (formerly the
  // standalone pi-header plugin), rendered via ctx.ui.setHeader() at session
  // start, plus a dashed-rule CustomEditor. Single-file, zero native deps.
  // pi-guard: detects assistant output degeneration (repetitive loop
  // / self-reference stacking) at turn_end and re-injects a corrective user
  // message plus a continuous system-prompt guard block. Pure TS, no native deps.
  { name: "pi-guard@file:plugin/pi-guard", packageName: "pi-guard", extensionPath: "index.ts", android: true },
  // pi-clear: /clear slash command — deletes the current session file and
  // starts a fresh session. Pure TS, no native deps.
  { name: "pi-clear@file:plugin/pi-clear", packageName: "pi-clear", extensionPath: "index.ts", android: true },
  // pi-goal: pure TS extension for autonomous /goal completion. No native deps.
  { name: "@narumitw/pi-goal@0.31.0", packageName: "@narumitw/pi-goal", extensionPath: "src/index.ts", android: true },
  // pi-subagents: spawn and manage sub-agents for parallel task delegation. Pure TS, no native deps.
  { name: "@gotgenes/pi-subagents@19.2.2", packageName: "@gotgenes/pi-subagents", extensionPath: "src/index.ts", android: true },
  // pi-task: /task slash command prefixes a requirement with a fixed Japanese
  // concurrency template so the main agent splits parallel work into sub-agents
  // and integrates the results. Single-file, zero native deps.
  { name: "pi-task@file:plugin/pi-task", packageName: "pi-task", extensionPath: "index.ts", android: true },
  { name: "pi-plan@file:plugin/pi-plan", packageName: "pi-plan", extensionPath: "index.ts", android: true },
  // pi-fff depends on a Rust native library (libfff_c.so) via ffi-rs. The
  // native binary crashes on Android/Termux (LMDB segfault) and ffi-rs itself
  // fails to load (__clear_cache symbol missing). Rather than maintain a
  // platform-specific fallback, drop pi-fff entirely so behavior is consistent
  // across all platforms. Pi has built-in find/grep tools that cover the gap.
];
