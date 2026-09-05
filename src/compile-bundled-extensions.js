import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { getBundledPiNodeModules, packageDirName } from "./bundled-pi-cache.js";
import { supportedBundledPiExtensions } from "./bundled-pi-platform.js";

/**
 * Rewrite relative TypeScript import specifiers to JavaScript.
 * Node.js's stripTypeScriptTypes only removes type annotations but keeps .ts extensions
 * in import paths, which fails for files under node_modules.
 * Also rewrites:
 *   - directory imports (e.g., './hashline') to './hashline/index.js' when the directory contains index.ts
 *   - bare relative imports (e.g., './hash', '../utils') to add .js extension
 */
function rewriteTsImports(source, fileImports = new Set(), dirImports = new Set()) {
  // First, rewrite directory imports that have index.ts -> add /index.js
  if (dirImports.size > 0) {
    const sortedDirs = [...dirImports].sort((a, b) => b.length - a.length);
    for (const dir of sortedDirs) {
      const escapedDir = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(?:from\\s+|import\\s*\\(\\s*)['\"](${escapedDir})['"]`, 'g');
      source = source.replace(regex, (match) => {
        const quote = match.slice(-1);
        // Rewrite './hashline' -> './hashline/index.js', '..' -> '../index.js'
        return match.slice(0, -1) + '/index.js' + quote;
      });
    }
  }
  // Then, rewrite file imports -> add .js
  if (fileImports.size > 0) {
    const sortedFiles = [...fileImports].sort((a, b) => b.length - a.length);
    for (const file of sortedFiles) {
      const escapedFile = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(?:from\\s+|import\\s*\\(\\s*)['\"](${escapedFile})['"]`, 'g');
      source = source.replace(regex, (match) => {
        const quote = match.slice(-1);
        // Rewrite './hash' -> './hash.js', '../utils' -> '../utils.js'
        return match.slice(0, -1) + '.js' + quote;
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

function stripAndRewrite(source, fileImports, dirImports) {
  const stripped = stripTypeScriptTypes(source, { mode: "transform" });
  return rewriteTsImports(stripped, fileImports, dirImports);
}

const COMPILE_MANIFEST_NAME = ".axum-compile.json";
const COMPILE_MANIFEST_VERSION = 1;

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

/**
 * Collect all TypeScript sources and build lookup structures for import rewriting.
 * Returns:
 *   - sources: sorted array of .ts file paths
 *   - fileImportsByDir: map from directory to set of file import specifiers (e.g., './hash', '../utils')
 *   - dirImportsByDir: map from directory to set of directory import specifiers (e.g., './hashline', '..')
 */
function collectSourcesAndImports(root) {
  const sources = [];
  // Map from directory (relative to root) to Sets of import specifiers relative to THAT directory
  const fileImportsByDir = new Map();
  const dirImportsByDir = new Map();

  // First pass: collect all .ts files and build a map of all .ts files by their relative path
  const tsFiles = [];
  const tsFilesByRelPath = new Map(); // relPath (from root) -> full path
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
        tsFiles.push(full);
        const relFile = path.relative(root, full).replaceAll(path.sep, "/");
        tsFilesByRelPath.set(relFile, full);
        if (entry.name === "index.ts") {
          hasIndexTs = true;
        }
      }
    }
  }

  // Build dirsWithTs: all directories that contain .ts files
  const dirsWithTs = new Set();
  for (const tsFile of tsFiles) {
    const relFile = path.relative(root, tsFile).replaceAll(path.sep, "/");
    const dir = path.dirname(relFile);
    dirsWithTs.add(dir === "." ? "" : dir);
  }

  // For each directory with .ts files, find all .ts files reachable via relative imports
  for (const dir of dirsWithTs) {
    const fileImports = new Set();
    const dirImports = new Set();
    
    // Walk ALL .ts files in the package and compute their relative import path from this directory
    for (const [relFile, _] of tsFilesByRelPath) {
      const fileDir = path.dirname(relFile);
      const fileBase = path.basename(relFile, ".ts");
      
      // Compute relative path from current directory (dir) to the target file
      // This IS the import specifier as it appears in source
      let importSpecifier;
      if (dir === "") {
        // Current dir is package root
        if (fileDir === "") {
          // Target is also in root
          importSpecifier = "./" + fileBase;
        } else {
          // Target is in subdirectory
          importSpecifier = "./" + fileDir + "/" + fileBase;
        }
      } else {
        // Current dir is a subdirectory, use path.relative
        const fromAbs = path.join(root, dir);
        const toAbs = path.join(root, fileDir, fileBase + ".ts");
        let rel = path.relative(fromAbs, toAbs).replaceAll(path.sep, "/");
        // Ensure it starts with ./ or ../
        if (!rel.startsWith(".")) {
          rel = "./" + rel;
        }
        // Remove .ts extension
        importSpecifier = rel.slice(0, -3);
      }
      
      // Handle index.ts -> directory import
      if (fileBase === "index") {
        // importSpecifier is like ./subdir/index or ../index
        // Convert to directory import: ./subdir or ../
        if (importSpecifier.endsWith("/index")) {
          importSpecifier = importSpecifier.slice(0, -6); // remove /index
        } else if (importSpecifier === "./index") {
          importSpecifier = ".";
        } else if (importSpecifier === "../index") {
          importSpecifier = "..";
        }
        dirImports.add(importSpecifier);
      } else {
        fileImports.add(importSpecifier);
      }
    }
    
    fileImportsByDir.set(dir, fileImports);
    dirImportsByDir.set(dir, dirImports);
  }

  return { sources: sources.sort(), fileImportsByDir, dirImportsByDir };
}

function compiledPathFor(sourcePath) {
  return sourcePath.slice(0, -3) + ".js";
}

export function compileExtensionPackage({ packageRoot, transform, log = () => {} }) {
  const { sources, fileImportsByDir, dirImportsByDir } = collectSourcesAndImports(packageRoot);
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
    // Determine the imports for this file's directory
    const fileDir = path.dirname(rel);
    const dirKey = fileDir === "." ? "" : fileDir;
    const fileImports = fileImportsByDir.get(dirKey) || new Set();
    const dirImports = dirImportsByDir.get(dirKey) || new Set();
    let output;
    try {
      output = transform
        ? transform(source)
        : stripAndRewrite(source, fileImports, dirImports);
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