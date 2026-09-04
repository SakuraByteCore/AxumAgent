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
  { name: "@earendil-works/pi-coding-agent@0.84.4", packageName: "@earendil-works/pi-coding-agent", extensionPath: null, android: true },
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
  // pi-companion: bundled companion extension (merged from pi-shortcuts + pi-guard).
  // Slash shortcuts (/plan /clear /ralph /rules /plugin-create-mode), response
  // guard auto-continue, and the read-only advisory watcher. Single-file, zero native deps.
  { name: "pi-companion@file:plugin/pi-companion", packageName: "pi-companion", extensionPath: "index.ts", android: true },
  // pi-web-access: web search, extraction, and curation tools. Provides /websearch,
  // /curator, /google-account, /search slash commands. Pure TS, zero native deps.
  // Windows cannot runtime-strip TS sources under node_modules, so keep it off
  // there until the package ships precompiled JS.
  { name: "pi-web-access@0.24.2", packageName: "pi-web-access", extensionPath: "index.ts", android: true, unsupportedPlatforms: ["win32"] },
  // pi-fff: FFF-powered file search (ffgrep/fffind) with frecency ranking.
  // Depends on @ff-labs/fff-node which uses ffi-rs (Rust native via libfff_c.so).
  // Native binary crashes on Android/Termux (LMDB segfault) — excluded from Android.
  // Windows runtime compile also breaks on TS parameter properties / extensionless
  // relative imports in the published source, so keep it off win32 until upstream
  // ships a loadable JS bundle.
  { name: "@ff-labs/pi-fff@0.10.5", packageName: "@ff-labs/pi-fff", extensionPath: "src/index.ts", android: false, unsupportedPlatforms: ["win32"] },
  // pi-hashline-edit-pro: hash-anchored read/replace/insert/grep tools. Stable 3-char
  // per-line hashes reject stale/ambiguous anchors. Pure TS, zero native deps.
  { name: "pi-hashline-edit-pro@2.7.0", packageName: "pi-hashline-edit-pro", extensionPath: "index.ts", android: true },
  // @tintinweb/pi-subagents: Claude Code-style sub-agents and workflow
  // orchestration (parallel agents, live fleet view, custom agent types,
  // mid-run steering, dynamic workflows). Pure TS with pure-JS deps,
  // Android-safe. Six published sources use TS parameter properties that
  // the Windows runtime strip path cannot compile, so keep it off win32.
  { name: "@tintinweb/pi-subagents@0.19.0", packageName: "@tintinweb/pi-subagents", extensionPath: "src/index.ts", android: true, unsupportedPlatforms: ["win32"] },
  // pi-agent: user-triggered background Pi agents (/agent) with a live progress widget,
  // vendored from @giladbarnea/pi-user-agents@0.0.5. Parameter-property constructors were
  // rewritten to explicit field assignments so the Windows compile path can strip its TS.
  { name: "pi-agent@file:plugin/pi-agent", packageName: "pi-agent", extensionPath: "index.ts", android: true },
];