import os from "node:os";
import path from "node:path";
import { supportedBundledPiPackages } from "./bundled-pi-platform.js";

const cacheVersion = "v1";

function sanitizeSegment(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function getBundledPiCacheRoot({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  if (env.AXUM_BUNDLED_PI_DIR) return env.AXUM_BUNDLED_PI_DIR;
  const base = env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  const packageKey = supportedBundledPiPackages({ platform, env }).map(sanitizeSegment).join("+");
  return path.join(base, "axum-agent", "bundled-pi", cacheVersion, `${platform}-${arch}`, packageKey);
}

export function getBundledPiNodeModules(options) {
  return path.join(getBundledPiCacheRoot(options), "node_modules");
}
