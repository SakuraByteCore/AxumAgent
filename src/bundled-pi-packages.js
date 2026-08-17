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
  // pi-edit: AxumAgent bundled fork. The upstream npm package
  // depends on better-sqlite3 (native C++) which fails on Android/Termux. This
  // local file: copy replaces all native deps with node:crypto + pure-JS file backend.
  { name: "pi-edit@file:plugin/pi-edit", packageName: "pi-edit", extensionPath: "index.ts", android: true },
  // pi-goal: pure TS extension for autonomous /goal completion. No native deps.
  { name: "@narumitw/pi-goal@0.31.0", packageName: "@narumitw/pi-goal", extensionPath: "src/index.ts", android: true },
  // pi-shortcuts: bundled slash shortcuts (merged from pi-plan + pi-clear).
  // Exposes /plan (plan-first template) and /clear (fresh session).
  // Single-file, zero native deps.
  { name: "pi-shortcuts@file:plugin/pi-shortcuts", packageName: "pi-shortcuts", extensionPath: "index.ts", android: true },
  // pi-response-guard: auto-recovers from empty, errored, or interrupted
  // model responses by retrying with a configurable message (rate-limit /
  // 429 / 5xx / timeouts / empty-output stop). Fork of the upstream npm
  // pi-response-guard package to drop its mariozechner peer dependency.
  // Pure TS, zero native deps.
  { name: "pi-response-guard@file:plugin/pi-response-guard", packageName: "pi-response-guard", extensionPath: "index.ts", android: true },
// pi-guard: read-only advisory watcher that posts inline guidance notes during
// primary sessions. Filters noise, dedupes repeats, and rate-limits advice
// delivery. Pure JS, zero native deps.
{ name: "pi-guard@file:plugin/pi-guard", packageName: "pi-guard", extensionPath: "index.js", android: true },
// pi-fff depends on a Rust native library (libfff_c.so) via ffi-rs. The
// native binary crashes on Android/Termux (LMDB segfault) and ffi-rs itself
// pi-workflow: interactive workflow guide + execution router (skills + extension).
// bundle size 39.4 MB unpacked; zero native deps.
{ name: "@agwab/pi-workflow@0.12.0", packageName: "@agwab/pi-workflow", extensionPath: "src/extension.ts", skills: ["skills/workflow-guide", "skills/execution-router"], android: true },
];