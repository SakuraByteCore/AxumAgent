import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { supportedBundledPiPackages } from "./bundled-pi-platform.js";

const cacheVersion = "v4";

function packageSetKey(options) {
  const packageSpec = supportedBundledPiPackages(options).join("\n");
  return `pi-${crypto.createHash("sha256").update(packageSpec).digest("hex").slice(0, 12)}`;
}

export function getBundledPiCacheRoot({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  if (env.AXUM_BUNDLED_PI_DIR) return env.AXUM_BUNDLED_PI_DIR;
  const base = env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "axum-agent", "bundled-pi", cacheVersion, `${platform}-${arch}`, packageSetKey({ platform, env }));
}

export function getBundledPiNodeModules(options) {
  return path.join(getBundledPiCacheRoot(options), "node_modules");
}
