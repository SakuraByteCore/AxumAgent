import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Marker used to recognise a shim this module owns: a foreign `pi` binary is
// never overwritten.
const SHIM_MARKER = "AxumAgent pi shim";

function resolveOnPath(name, env) {
  const entries = (env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    const candidate = path.join(entry, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep scanning the remaining PATH entries.
    }
  }
  return undefined;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the `pi` launcher body. `pi` must behave like the Pi coding agent, so
 * it forwards to the current `axum code` (Axum defaults + bundled extensions).
 */
export function piCommandShimScript(options = {}) {
  const env = options.env ?? process.env;
  const axumPath = options.axumPath ?? resolveOnPath("axum", env) ?? "axum";
  return [
    "#!/usr/bin/env sh",
    `# ${SHIM_MARKER}: \`pi\` runs the current \`axum code\` (Axum defaults + bundled extensions).`,
    `axum_bin="$(command -v axum 2>/dev/null)"`,
    `[ -n "$axum_bin" ] || axum_bin=${shellQuote(axumPath)}`,
    "# Drop an inherited Axum Fast preload: the CLI adds its own and patching the",
    "# Pi SDK twice aborts the child process.",
    `if [ -n "$NODE_OPTIONS" ]; then`,
    `  case "$NODE_OPTIONS" in`,
    `    *pi-web-fast-loader.js*)`,
    `      NODE_OPTIONS="$(printf '%s\\n' "$NODE_OPTIONS" | tr ' ' '\\n' | grep -v 'pi-web-fast-loader.js' | tr '\\n' ' ')"`,
    `      export NODE_OPTIONS`,
    `      ;;`,
    `  esac`,
    `fi`,
    `exec "$axum_bin" code "$@"`,
    "",
  ].join("\n");
}

/**
 * Where the launcher lives: `~/.pi/agent/bin` is the first entry of the Pi
 * daemon PATH and of the login shell PATH, so every `pi` call resolves here.
 */
export function piCommandShimTarget(options = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  const agentDir = options.agentDir ?? path.join(homeDir, ".pi", "agent");
  return options.target ?? path.join(agentDir, "bin", "pi");
}

/**
 * Install (or refresh) the `pi` launcher. Foreign files are left untouched.
 */
export function ensurePiCommandShim(options = {}) {
  const target = piCommandShimTarget(options);
  const script = piCommandShimScript(options);
  try {
    if (fs.existsSync(target)) {
      const current = fs.readFileSync(target, "utf8");
      if (!current.includes(SHIM_MARKER)) {
        return { target, status: "skipped-foreign" };
      }
      if (current === script) {
        return { target, status: "unchanged" };
      }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, script, { mode: 0o755 });
    fs.chmodSync(target, 0o755);
    return { target, status: "written" };
  } catch (error) {
    return { target, status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
