import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { getBundledPiNodeModules } from "./bundled-pi-cache.js";
import { supportedBundledPiExtensions } from "./bundled-pi-platform.js";

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
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        sources.push(full);
      }
    }
  }
  return sources.sort();
}

function compiledPathFor(sourcePath) {
  return sourcePath.slice(0, -3) + ".js";
}

export function compileExtensionPackage({ packageRoot, transform, log = () => {} }) {
  const sources = listTypeScriptSources(packageRoot);
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
        : stripTypeScriptTypes(source, { mode: "strip" });
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
