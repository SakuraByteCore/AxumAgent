import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectedBundledExtensionCount, localPluginNames, supportedBundledPiPackages, supportedBundledPiSkills } from "./bundled-pi-platform.js";
import { getBundledPiCacheRoot } from "./bundled-pi-cache.js";
import { applyBundledPiPatches } from "./bundled-pi-patches.js";
import { existingBundledExtensions, resolvePiCli } from "./resolve-bundled-pi.js";

function stubJavaScriptValue(value) {
  if (typeof value === "function") return "(" + value + ")";
  return JSON.stringify(value);
}

function exportStubJavaScriptObject(obj) {
  const lines = Object.entries(obj).map(([k, v]) => {
    return "  " + JSON.stringify(k) + ": " + stubJavaScriptValue(v);
  }).join(",\n");
  return "export default {\n" + lines + "\n};\n";
}

const ANSI_STYLES = {
  reset:         (t) => "\x1b[0m" + t,
  bold:          (t) => "\x1b[1m" + t,
  dim:           (t) => "\x1b[2m" + t,
  italic:        (t) => "\x1b[3m" + t,
  underline:     (t) => "\x1b[4m" + t,
  inverse:       (t) => "\x1b[7m" + t,
  strikethrough: (t) => "\x1b[9m" + t,
  hidden:        (t) => "\x1b[8m" + t,
  visible:       (t) => "\x1b[28m" + t,
  black:         (t) => "\x1b[30m" + t,
  red:           (t) => "\x1b[31m" + t,
  green:         (t) => "\x1b[32m" + t,
  yellow:        (t) => "\x1b[33m" + t,
  blue:          (t) => "\x1b[34m" + t,
  magenta:       (t) => "\x1b[35m" + t,
  cyan:          (t) => "\x1b[36m" + t,
  white:         (t) => "\x1b[37m" + t,
  gray:          (t) => "\x1b[90m" + t,
  bgBlack:       (t) => "\x1b[40m" + t,
  bgRed:         (t) => "\x1b[41m" + t,
  bgGreen:       (t) => "\x1b[42m" + t,
  bgYellow:      (t) => "\x1b[43m" + t,
  bgBlue:        (t) => "\x1b[44m" + t,
  bgMagenta:     (t) => "\x1b[45m" + t,
  bgCyan:        (t) => "\x1b[46m" + t,
  bgWhite:       (t) => "\x1b[47m" + t,
};

function requireStubJavaScriptObject(obj) {
  const lines = Object.entries(obj).map(([k, v]) => {
    return "  " + JSON.stringify(k) + ": " + stubJavaScriptValue(v);
  }).join(",\n");
  return "module.exports = {\n" + lines + "\n};\n";
}

function ensureBundledPiVendoredDep(options, name, versions) {
  const cacheRoot = getBundledPiCacheRoot(options);
  const candidate = path.join(cacheRoot, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", name);
  const indexJs = path.join(candidate, "index.js");
  const stub = requireStubJavaScriptObject(ANSI_STYLES);
  if (fs.existsSync(candidate) && fs.existsSync(indexJs)) {
    try {
      const pkgJson = path.join(candidate, "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
      new Function(stub);
      new Function(fs.readFileSync(indexJs, "utf8"));
      if ((pkg.type || "commonjs") === "commonjs") return;
    } catch { /* rewrite malformed older stubs */ }
  }

  fs.mkdirSync(path.dirname(indexJs), { recursive: true });

  const pkg = { name, version: versions[0], type: "commonjs", main: "index.js", module: "index.js" };
  fs.writeFileSync(path.join(candidate, "package.json"), JSON.stringify(pkg, null, 2));
  fs.writeFileSync(indexJs, stub);
}

function getPluginSourceDir(name) {
  const thisFile = fileURLToPath(import.meta.url);
  const pkgRoot = path.resolve(path.dirname(thisFile), "..");
  return path.join(pkgRoot, "plugin", name);
}

function readPluginFingerprint(root) {
  if (!fs.existsSync(root)) return "missing";
  const entries = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replaceAll(path.sep, "/");
      if (entry.isDirectory()) {
        stack.push(full);
        entries.push(`d:${rel}`);
        continue;
      }
      if (entry.isFile()) {
        const stat = fs.statSync(full);
        const content = fs.readFileSync(full);
        entries.push(`f:${rel}:${stat.size}:${crypto.createHash("sha256").update(content).digest("hex")}`);
      }
    }
  }
  entries.sort();
  return crypto.createHash("sha256").update(entries.join("\n")).digest("hex");
}

function ensurePluginSource(cacheRoot, options) {
  for (const name of localPluginNames(options)) {
    const pluginDir = path.join(cacheRoot, "plugin", name);
    const source = getPluginSourceDir(name);
    if (!fs.existsSync(source)) continue;
    const signaturePath = `${pluginDir}.fingerprint`;
    const sourceFingerprint = readPluginFingerprint(source);
    const cachedFingerprint = fs.existsSync(pluginDir) ? readPluginFingerprint(pluginDir) : "";
    const cachedSourceFingerprint = fs.existsSync(signaturePath) ? fs.readFileSync(signaturePath, "utf8").trim() : "";
    if (sourceFingerprint === cachedFingerprint && sourceFingerprint === cachedSourceFingerprint) continue;

    // Keep the cache in sync when plugin sources change, but skip the copy when
    // the source tree is unchanged so warm `npm run code` starts faster.
    fs.rmSync(pluginDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(pluginDir), { recursive: true });
    // npm resolves file: dependencies through their realpath. Copy the plugin
    // into the cache so its realpath stays beside cache/node_modules and native
    // deps resolve from the cache rather than the global axum install.
    fs.cpSync(source, pluginDir, { recursive: true, dereference: true });
    fs.writeFileSync(signaturePath, `${sourceFingerprint}\n`);
  }
}

export function npmInstallEnv(options) {
  const base = { ...process.env, ...(options?.env ?? {}) };
  for (const key of Object.keys(base)) {
    if (!key || key.includes("=") || key.startsWith("=")) {
      delete base[key];
      continue;
    }
    if (key === "npm_config_user_agent") continue;
    if (key.startsWith("npm_")) delete base[key];
  }
  return {
    ...base,
    npm_config_global: "false",
    npm_config_prefix: getBundledPiCacheRoot(options),
    npm_config_package_lock: "false",
  };
}

function resolveNodeBundledNpmCli(nodePath = process.execPath) {
  const candidate = path.join(path.dirname(nodePath), "node_modules", "npm", "bin", "npm-cli.js");
  return fs.existsSync(candidate) ? candidate : "";
}

function needsWindowsShell(command) {
  return /\.(?:cmd|bat)$/i.test(command);
}

function isNodeScript(command) {
  return /\.(?:cjs|js|mjs)$/i.test(command);
}

export function resolveNpmInstallCommand(options = {}) {
  const platform = options.platform || process.platform;
  const nodePath = options.nodePath || process.execPath;
  const explicitNpm = options.npmCommand || process.env.AXUM_BUNDLED_PI_NPM;
  if (explicitNpm) {
    if (platform === "win32" && isNodeScript(explicitNpm)) {
      return { command: nodePath, argsPrefix: [explicitNpm], shell: false };
    }
    return { command: explicitNpm, argsPrefix: [], shell: platform === "win32" && needsWindowsShell(explicitNpm) };
  }

  if (platform === "win32") {
    const npmCli = resolveNodeBundledNpmCli(nodePath);
    if (npmCli) return { command: nodePath, argsPrefix: [npmCli], shell: false };
    return { command: "npm.cmd", argsPrefix: [], shell: true };
  }

  return { command: "npm", argsPrefix: [], shell: false };
}

const requiredBundledPiRuntimePackages = [
  ["@earendil-works", "pi-ai"],
  ["@earendil-works", "pi-agent-core"],
  ["@earendil-works", "pi-tui"],
];

function packageImportEntryReady(packageRoot) {
  const packageJson = path.join(packageRoot, "package.json");
  if (!fs.existsSync(packageJson)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJson, "utf8"));
    const entry = typeof pkg.exports === "string"
      ? pkg.exports
      : typeof pkg.exports?.["."]?.import === "string"
        ? pkg.exports["."].import
        : typeof pkg.main === "string"
          ? pkg.main
          : undefined;
    return entry === undefined || fs.existsSync(path.join(packageRoot, entry));
  } catch {
    return false;
  }
}

function bundledRuntimeDepsReady(cacheRoot) {
  const rootNodeModules = path.join(cacheRoot, "node_modules");
  const piCodingAgentNodeModules = path.join(rootNodeModules, "@earendil-works", "pi-coding-agent", "node_modules");
  return requiredBundledPiRuntimePackages.every((packageParts) => {
    const nestedPackageRoot = path.join(piCodingAgentNodeModules, ...packageParts);
    if (fs.existsSync(nestedPackageRoot)) return packageImportEntryReady(nestedPackageRoot);
    return packageImportEntryReady(path.join(rootNodeModules, ...packageParts));
  });
}

function bundledReady(options) {
  try {
    const cacheRoot = getBundledPiCacheRoot(options);
    const piCli = resolvePiCli(options);
    const extensions = existingBundledExtensions(options);
    return fs.existsSync(piCli)
      && bundledRuntimeDepsReady(cacheRoot)
      && extensions.length === expectedBundledExtensionCount(options)
      && extensions.every((file) => fs.existsSync(file));
  } catch {
    return false;
  }
}

export function ensureBundledPi(options) {
  const cacheRoot = getBundledPiCacheRoot(options);
  ensurePluginSource(cacheRoot, options);
  ensureBundledSkills(cacheRoot, options);
  if (bundledReady(options)) {
    applyBundledPiPatches(options);
    ensureBundledPiVendoredDep(options, "chalk", ["5.5.1"]);
    return;
  }

  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.rmSync(path.join(cacheRoot, "node_modules"), { recursive: true, force: true });
  const npm = resolveNpmInstallCommand(options);
  const args = ["install", "--prefix", cacheRoot, "--omit=dev", "--no-audit", "--no-fund", "--no-save", "--install-strategy=hoisted", ...supportedBundledPiPackages(options)];
  console.error("Axum first-run setup: installing bundled Pi and extensions...");
  const runNpm = (retry) => {
    const result = spawnSync(npm.command, [...npm.argsPrefix, ...args], {
      cwd: cacheRoot,
      stdio: "inherit",
      env: npmInstallEnv(options),
      shell: npm.shell,
    });
    if (result.error) {
      const msg = result.error.message;
      if (retry && (msg.includes("ENOTEMPTY") || msg.includes("EPERM") || msg.includes("EBUSY"))) {
        console.error("retrying bundled Pi install after cleanup...");
        try { fs.rmSync(path.join(cacheRoot, "node_modules"), { recursive: true, force: true }); } catch {}
        return runNpm(false);
      }
      throw new Error(`failed to install bundled Pi dependencies: ${msg}`);
    }
    if ((result.status ?? 1) !== 0) {
      const status = result.status;
      if (retry && (status === -1 || String(status).includes("ENOTEMPTY"))) {
        console.error("retrying bundled Pi install after cleanup...");
        try { fs.rmSync(path.join(cacheRoot, "node_modules"), { recursive: true, force: true }); } catch {}
        return runNpm(false);
      }
      throw new Error(`failed to install bundled Pi dependencies: npm exited ${status}`);
    }
    return result;
  };
  runNpm(true);
  if (!bundledReady(options)) throw new Error("bundled Pi installation completed but required files are still missing");
  applyBundledPiPatches(options);
  ensureBundledPiVendoredDep(options, "chalk", ["5.5.1"]);
}

export function ensureBundledSkills(cacheRoot, options) {
  const home = os.homedir();
  const skillsRoot = path.join(home, ".agents", "skills");
  for (const { packageName, skillPath } of supportedBundledPiSkills(options)) {
    const srcDir = path.join(cacheRoot, "node_modules", ...packageName.split("/"), skillPath);
    if (!fs.existsSync(srcDir)) continue;
    const skillName = path.basename(skillPath);
    const destDir = path.join(skillsRoot, skillName);
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
    fs.cpSync(srcDir, destDir, { recursive: true, dereference: true });
  }
}
