import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { getBundledPiNodeModules } from "./bundled-pi-cache.js";
import { supportedBundledPiExtensions } from "./bundled-pi-platform.js";

/**
 * Rewrite relative TypeScript import specifiers to JavaScript.
 * Node.js's stripTypeScriptTypes only removes type annotations but keeps .ts extensions
 * in import paths, which fails for files under node_modules.
 * Also rewrites directory imports (e.g., './src/hashline') to './src/hashline/index.js'
 * when the directory contains an index.ts file.
 */
function rewriteTsImports(source, indexDirs = new Set()) {
  // First, rewrite directory imports that have index.ts
  if (indexDirs.size > 0) {
    // Sort by length descending to match longer paths first (e.g., './src/hashline' before './src')
    const sortedDirs = [...indexDirs].sort((a, b) => b.length - a.length);
    for (const dir of sortedDirs) {
      // Escape special regex characters in the directory path
      const escapedDir = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match import/export specifiers with the directory path (not ending in .ts)
      // Handles: import ... from './src/hashline', import type ... from './src/hashline',
      // export ... from './src/hashline', export * from './src/hashline', import('./src/hashline')
      const regex = new RegExp(`(?:from\\s+|import\\s*\\(\\s*)['\"](${escapedDir})['"]`, 'g');
      source = source.replace(regex, (match, importPath) => {
        const quote = match.slice(-1);
        // Rewrite './src/hashline' -> './src/hashline/index.js'
        return match.slice(0, -1) + '/index.js' + quote;
      });
    }
  }
  // Then, rewrite .ts imports
  const regex = /(?:from\s+|import\s*\(\s*)['"](\.\.?\/[^"']*?)\.ts['"]/g;
  return source.replace(regex, (match) => {
    const quote = match.slice(-1);
    return match.slice(0, -4) + ".js" + quote;
  });
}

function stripAndRewrite(source, indexDirs) {
  const stripped = stripTypeScriptTypes(source, { mode: "strip" });
  return rewriteTsImports(stripped, indexDirs);
}

const COMPILE_MANIFEST_NAME = ".axum-compile.json";
const COMPILE_MANIFEST_VERSION = 1;

function packageDirName(packageName) {
  if (packageName.startsWith("@")) {
    const [scope, name] = packageName.split("/");
    return path.join(scope, name);
  }
  return packageName;
}

export function compiledManifestPath(packageRoot) {
  return path.join(packageRoot, COMPILE_MANIFEST_NAME);
}

export function readCompileManifest(packageRoot) {
  try {
    const manifest = JSON.parse(fs.readFileSync(compiledManifestPath(packageRoot), "utf8"));
    if (manifest?.version !== COMPILE_MANIFEST_VERSION || typeof manifest.files !== "object") return undefined;
    return manifest;
  } catch {
    return undefined;
  }
}

function listTypeScriptSources(root) {
  const sources = [];
  const indexDirs = new Set();
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let hasIndexTs = false;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        sources.push(full);
        if (entry.name === "index.ts") {
          hasIndexTs = true;
        }
      }
    }
    if (hasIndexTs) {
      // Store the relative path from root to this directory
      const relDir = path.relative(root, dir).replaceAll(path.sep, "/");
      if (relDir !== "") {
        indexDirs.add("./" + relDir);
      } else {
        indexDirs.add(".");
      }
    }
  }
  return { sources: sources.sort(), indexDirs };
}

function compiledPathFor(sourcePath) {
  return sourcePath.slice(0, -3) + ".js";
}

export function compileExtensionPackage({ packageRoot, transform, log = () => {} }) {
  const { sources, indexDirs } = listTypeScriptSources(packageRoot);
  if (sources.length === 0) return { compiled: [], skipped: [], collisions: [] };

  const manifestPath = path.join(packageRoot, COMPILE_MANIFEST_NAME);
  let manifest = { version: COMPILE_MANIFEST_VERSION, files: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (parsed?.version === COMPILE_MANIFEST_VERSION && typeof parsed.files === "object") {
      manifest = parsed;
    }
  } catch { /* rebuild manifest from scratch */ }

  const compiled = [];
  const skipped = [];
  const collisions = [];
  let dirty = false;
  for (const sourcePath of sources) {
    const rel = path.relative(packageRoot, sourcePath).replaceAll(path.sep, "/");
    const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
    const jsPath = compiledPathFor(sourcePath);
    if (manifest.files[rel] === sourceHash && fs.existsSync(jsPath)) {
      skipped.push(rel);
      continue;
    }
    if (fs.existsSync(jsPath) && manifest.files[rel] === undefined) {
      collisions.push(rel);
      continue;
    }
    const source = fs.readFileSync(sourcePath, "utf8");
    let output;
    try {
      output = transform
        ? transform(source)
        : stripAndRewrite(source, indexDirs);
    } catch {
      collisions.push(rel);
      continue;
    }
    if (typeof output !== "string" || output.length === 0 || output.includes("exports.")) {
      collisions.push(rel);
      continue;
    }
    fs.writeFileSync(jsPath, output);
    manifest.files[rel] = sourceHash;
    compiled.push(rel);
    dirty = true;
  }

  if (dirty || (Object.keys(manifest.files).length > 0 && !fs.existsSync(manifestPath)) || !fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
  log(`compiled=${compiled.length} skipped=${skipped.length} collisions=${collisions.length}`);
  return { compiled, skipped, collisions };
}

export function compileBundledExtensions(options) {
  const results = [];
  for (const extension of supportedBundledPiExtensions(options)) {
    const packageRoot = path.join(getBundledPiNodeModules(options), packageDirName(extension.packageName));
    if (!fs.existsSync(packageRoot)) continue;
    const entryPath = path.join(packageRoot, extension.extensionPath);
    if (!fs.existsSync(entryPath) || !entryPath.endsWith(".ts")) continue;
    results.push({
      packageName: extension.packageName,
      ...compileExtensionPackage({ packageRoot }),
    });
  }
  return results;
}
