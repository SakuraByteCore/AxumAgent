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
  // pi-debug: real debugger driver (DAP over stdio) exposing attach / break /
  // continue / step / stack / variables slash commands. Speaks the Debug Adapter
  // Protocol to lldb-dap / dlv / debugpy. Pure TS, zero native deps.
  { name: "pi-debug@file:plugin/pi-debug", packageName: "pi-debug", extensionPath: "index.ts", android: true },

  // pi-goal: pure TS extension for autonomous /goal completion. No native deps.
  { name: "@narumitw/pi-goal@0.31.0", packageName: "@narumitw/pi-goal", extensionPath: "src/index.ts", android: true },
  // pi-shortcuts: bundled slash shortcuts (merged from pi-plan + pi-clear + pi-plugins).
  // Exposes /plan (plan-first template), /clear (fresh session), and /plugin-create-mode (open skill guide).
  // Single-file, zero native deps.
  { name: "pi-shortcuts@file:plugin/pi-shortcuts", packageName: "pi-shortcuts", extensionPath: "index.ts", android: true },

// pi-guard: read-only advisory watcher that posts inline guidance notes during
// primary sessions. Filters noise, dedupes repeats, and rate-limits advice
// delivery. Pure JS, zero native deps.
{ name: "pi-guard@file:plugin/pi-guard", packageName: "pi-guard", extensionPath: "index.js", android: true },
// pi-fff depends on a Rust native library (libfff_c.so) via ffi-rs. The
// native binary crashes on Android/Termux (LMDB segfault) and ffi-rs itself
];
