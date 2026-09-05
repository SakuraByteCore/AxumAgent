import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { compileExtensionPackage, readCompileManifest } from "../src/compile-bundled-extensions.js";

function makePackage(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

const fakeTransform = (source) => `// compiled\n${source.replace(/: string/g, "")}`;

test("compileExtensionPackage transforms TS sources and records a manifest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axum-compile-basic-"));
  makePackage(root, {
    "src/index.ts": "export const name: string = \"x\";\n",
    "src/util.ts": "export const id: string = \"y\";\n",
  });

  let calls = 0;
  const result = compileExtensionPackage({
    packageRoot: root,
    transform: (source) => { calls += 1; return fakeTransform(source); },
  });

  assert.deepEqual(result.compiled.sort(), ["src/index.ts", "src/util.ts"]);
  assert.deepEqual(result.collisions, []);
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(path.join(root, "src/index.js"), "utf8"), "// compiled\nexport const name = \"x\";\n");
  const manifest = readCompileManifest(root);
  assert.equal(manifest.version, 1);
  assert.ok(manifest.files["src/index.ts"]);
  assert.ok(manifest.files["src/util.ts"]);
});

test("compileExtensionPackage skips unchanged sources on rerun", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axum-compile-warm-"));
  makePackage(root, { "index.ts": "export const a: string = \"a\";\n" });
  const options = { packageRoot: root, transform: fakeTransform };

  compileExtensionPackage(options);
  let calls = 0;
  const second = compileExtensionPackage({ ...options, transform: (s) => { calls += 1; return fakeTransform(s); } });

  assert.deepEqual(second.compiled, []);
  assert.deepEqual(second.skipped, ["index.ts"]);
  assert.equal(calls, 0);
  assert.ok(fs.existsSync(path.join(root, "index.js")));
});

test("compileExtensionPackage recompiles when a source changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axum-compile-stale-"));
  makePackage(root, { "index.ts": "export const a: string = \"a\";\n" });
  compileExtensionPackage({ packageRoot: root, transform: fakeTransform });

  fs.writeFileSync(path.join(root, "index.ts"), "export const b: string = \"b\";\n");
  const result = compileExtensionPackage({ packageRoot: root, transform: fakeTransform });

  assert.deepEqual(result.compiled, ["index.ts"]);
  assert.match(fs.readFileSync(path.join(root, "index.js"), "utf8"), /export const b/);
});

test("compileExtensionPackage never overwrites pre-existing JS files it did not build", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axum-compile-collide-"));
  makePackage(root, {
    "index.ts": "export const a: string = \"a\";\n",
    "index.js": "export const native = true;\n",
  });

  const result = compileExtensionPackage({ packageRoot: root, transform: fakeTransform });

  assert.deepEqual(result.collisions, ["index.ts"]);
  assert.deepEqual(result.compiled, []);
  assert.equal(fs.readFileSync(path.join(root, "index.js"), "utf8"), "export const native = true;\n");
  const manifest = readCompileManifest(root);
  assert.equal(manifest.files["index.ts"], undefined);
});

test("compileExtensionPackage transpiles parameter properties in imported modules", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axum-compile-parameter-property-"));
  makePackage(root, {
    "src/index.ts": "import { Greeter } from \"./engine.ts\"; export const greet = () => new Greeter(\"axum\").greet();\n",
    "src/engine.ts": "export class Greeter { constructor(private readonly name: string) {} greet(): string { return this.name; } }\n",
  });

  const result = compileExtensionPackage({ packageRoot: root });

  assert.deepEqual(result.collisions, []);
  const output = fs.readFileSync(path.join(root, "src", "engine.js"), "utf8");
  assert.match(output, /this\.name = name/);
  assert.doesNotMatch(output, /private readonly/);
  const module = await import(pathToFileURL(path.join(root, "src", "index.js")).href);
  assert.equal(module.greet(), "axum");
});

test("compileExtensionPackage rewrites root-level sibling imports to .js", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axum-compile-root-sibling-"));
  makePackage(root, {
    "index.ts": "import { value } from \"./util\"; export const read = () => value;\n",
    "util.ts": "export const value: string = \"v\";\n",
  });

  const result = compileExtensionPackage({ packageRoot: root });

  assert.deepEqual(result.collisions, []);
  const output = fs.readFileSync(path.join(root, "index.js"), "utf8");
  assert.match(output, /from \"\.\/util\.js\"/);
  const module = await import(pathToFileURL(path.join(root, "index.js")).href);
  assert.equal(module.read(), "v");
});
