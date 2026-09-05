import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

export function resolvePiWebBin(options = {}) {
  const env = options.env ?? process.env;
  const override = env.AXUM_PI_WEB_DIR;
  if (override) {
    const bin = path.join(override, "bin", "pi-web.js");
    if (existsSync(bin)) return bin;
    throw new Error(`@agegr/pi-web bin not found at AXUM_PI_WEB_DIR: ${bin}`);
  }
  const require = createRequire(import.meta.url);
  try {
    const packageJson = require.resolve("@agegr/pi-web/package.json");
    const bin = path.join(path.dirname(packageJson), "bin", "pi-web.js");
    if (existsSync(bin)) return bin;
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
  }
  throw new Error("@agegr/pi-web is not installed; reinstall Axum to restore the bundled chat UI");
}

export function runPiWebChat(argv) {
  const bin = resolvePiWebBin();
  const child = spawn(process.execPath, [bin, ...argv], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
  child.on("error", (error) => {
    console.error(`failed to start pi-web: ${error.message}`);
    process.exit(1);
  });
}
