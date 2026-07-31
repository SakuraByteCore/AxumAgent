import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(process.cwd(), "plugin", "pi-edit");
const read = (file) => fs.readFileSync(path.join(root, "src", file), "utf8");

test("pi-edit persists config through atomic writes and serializes toggles", () => {
  const source = read("config.ts");
  assert.match(source, /writeAtomic\(configPath\(\)/);
  assert.match(source, /let configMutation: Promise<void> = Promise\.resolve\(\)/);
  assert.match(source, /return enqueueConfigMutation/);
});

test("pi-edit serializes hash-store flushes and preserves dirty revisions", () => {
  const source = read("hash-store.ts");
  assert.match(source, /flushQueue\?: Promise<void>/);
  assert.match(source, /while \(store\.dirty\)/);
  assert.match(source, /const revision = store\.revision/);
  assert.match(source, /if \(store\.revision === revision\) store\.dirty = false/);
  assert.match(source, /writeAtomic\(store\.storePath/);
});

test("pi-edit makes replace exclusive and exposes large-file anchor limits", () => {
  const replace = read("replace.ts");
  const fsWrite = read("fs-write.ts");
  assert.match(fsWrite, /Number\(existingStats\.mode\) & 0o7777/);
  const readTool = read("read.ts");
  assert.match(replace, /concurrency: "exclusive"/);
  assert.match(readTool, /softLineLimit: MAX_HASH_LINES/);
  assert.match(readTool, /hashesAvailable: !noHashes/);
  assert.match(readTool, /do not return hash anchors/);
});
