/**
 * Build the NODE_OPTIONS value used to preload the Axum Fast loader.
 *
 * The loader rewrites the Pi SDK provider callback in memory. Preloading it
 * twice (for example when an inherited NODE_OPTIONS already carries the same
 * preload) makes the second pass see an already patched SDK and abort the
 * child process, so the inherited copy is dropped before ours is appended.
 */
export function buildFastLoaderNodeOptions(existingOptions, loaderUrl) {
  const inherited = String(existingOptions ?? "")
    .split(/\s+/)
    .filter((token) => token && !token.includes("pi-web-fast-loader.js"));
  return [...inherited, `--import=${JSON.stringify(loaderUrl)}`].join(" ");
}
