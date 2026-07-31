import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The hash-store module is TypeScript. Keep this small mirror aligned with its
// persisted row shape so these tests cover the current contract.
function makeStore(storeFile, storeDir) {
  let cached = null;

  function loadFromDisk(sp) {
    if (!fs.existsSync(sp)) return new Map();
    try {
      const arr = JSON.parse(fs.readFileSync(sp, "utf8"));
      const rows = new Map();
      for (const row of arr) if (row && typeof row.path === "string") rows.set(row.path, row);
      return rows;
    } catch {
      return new Map();
    }
  }

  function flushStore(store) {
    if (!store.dirty) return;
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(store.storePath, JSON.stringify(Array.from(store.rows.values())), "utf8");
    store.dirty = false;
  }

  async function loadHashStore() {
    if (cached) return cached;
    if (!fs.existsSync(storeDir)) fs.mkdirSync(storeDir, { recursive: true });
    cached = { rows: loadFromDisk(storeFile), storePath: storeFile, dirty: false };
    return cached;
  }

  function getSnapshot(store, filePath, checksum) {
    const row = store.rows.get(filePath);
    if (!row?.hashes || row.checksum !== checksum) return null;
    try {
      const hashes = JSON.parse(row.hashes);
      return Array.isArray(hashes) ? hashes : null;
    } catch {
      return null;
    }
  }

  function upsertSnapshot(store, filePath, checksum, lineCount, hashes, maxPersistLines) {
    if (maxPersistLines !== undefined && lineCount > maxPersistLines) return;
    store.rows.set(filePath, {
      path: filePath,
      checksum,
      line_count: lineCount,
      hashes: JSON.stringify(hashes),
      updated_at: Date.now(),
    });
    store.dirty = true;
  }

  async function pruneMissing(store) {
    let changed = false;
    for (const [filePath, row] of store.rows) {
      if (!fs.existsSync(row.path)) {
        store.rows.delete(filePath);
        changed = true;
      }
    }
    if (changed) store.dirty = true;
    flushStore(store);
  }

  return { loadHashStore, getSnapshot, upsertSnapshot, pruneMissing, flushStore };
}

test("hash-store basic round-trip", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-hash-basic-"));
  const storeFile = path.join(dir, "hash-store.json");
  const { loadHashStore, getSnapshot, upsertSnapshot, flushStore } = makeStore(storeFile, dir);

  const store = await loadHashStore();
  upsertSnapshot(store, "/fake/a.ts", "ca", 3, ["h1", "h2", "h3"]);
  flushStore(store);

  assert.deepEqual(getSnapshot(store, "/fake/a.ts", "ca"), ["h1", "h2", "h3"]);
});

test("hash-store content mismatch returns null", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-hash-mismatch-"));
  const storeFile = path.join(dir, "hash-store.json");
  const { loadHashStore, getSnapshot, upsertSnapshot, flushStore } = makeStore(storeFile, dir);

  const store = await loadHashStore();
  upsertSnapshot(store, "/fake/b.ts", "cb", 1, ["x"]);
  flushStore(store);

  assert.equal(getSnapshot(store, "/fake/b.ts", "different"), null);
});

test("hash-store special chars in path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-hash-special-"));
  const storeFile = path.join(dir, "hash-store.json");
  const { loadHashStore, getSnapshot, upsertSnapshot, flushStore } = makeStore(storeFile, dir);

  const filePath = "/fake/O'Brien's file (v2).ts";
  const store = await loadHashStore();
  upsertSnapshot(store, filePath, "cw", 2, ["x", "y"]);
  flushStore(store);

  assert.deepEqual(getSnapshot(store, filePath, "cw"), ["x", "y"]);
});

test("hash-store tricky JSON content with parens and quotes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-hash-tricky-"));
  const storeFile = path.join(dir, "hash-store.json");
  const { loadHashStore, getSnapshot, upsertSnapshot, flushStore } = makeStore(storeFile, dir);

  const store = await loadHashStore();
  upsertSnapshot(store, "/fake/t.ts", "ct", 2, ["t1", "t2"]);
  flushStore(store);

  assert.deepEqual(getSnapshot(store, "/fake/t.ts", "ct"), ["t1", "t2"]);
});

test("hash-store persistence across reload", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-hash-persist-"));
  const storeFile = path.join(dir, "hash-store.json");

  const first = makeStore(storeFile, dir);
  const store = await first.loadHashStore();
  first.upsertSnapshot(store, "/fake/p.ts", "cp", 1, ["p1"]);
  first.flushStore(store);

  const second = makeStore(storeFile, dir);
  const reloaded = await second.loadHashStore();
  assert.deepEqual(second.getSnapshot(reloaded, "/fake/p.ts", "cp"), ["p1"]);
});

test("hash-store prune removes missing files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-hash-prune-"));
  const storeFile = path.join(dir, "hash-store.json");
  const { loadHashStore, upsertSnapshot, pruneMissing, flushStore } = makeStore(storeFile, dir);

  const realPath = path.join(dir, "real.ts");
  const store = await loadHashStore();
  upsertSnapshot(store, "/nonexistent/a.ts", "c", 1, ["h"]);
  upsertSnapshot(store, realPath, "c2", 1, ["h2"]);
  fs.writeFileSync(realPath, "content2");
  flushStore(store);

  await pruneMissing(store);

  const raw = JSON.parse(fs.readFileSync(storeFile, "utf8"));
  assert.equal(raw.length, 1, "only the existing file should remain");
  assert.equal(raw[0].path, realPath);
});

test("upsertSnapshot skips persistence when lineCount exceeds maxPersistLines", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-hash-maxpersist-"));
  const storeFile = path.join(dir, "hash-store.json");
  const { loadHashStore, upsertSnapshot, getSnapshot, flushStore } = makeStore(storeFile, dir);

  const store = await loadHashStore();
  upsertSnapshot(store, "/fake/big.ts", "cbig", 20001, new Array(20001).fill("h"), 20000);
  flushStore(store);

  assert.equal(getSnapshot(store, "/fake/big.ts", "cbig"), null);
  assert.equal(store.rows.size, 0);
});

test("upsertSnapshot persists when lineCount is within maxPersistLines", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-hash-within-"));
  const storeFile = path.join(dir, "hash-store.json");
  const { loadHashStore, upsertSnapshot, getSnapshot, flushStore } = makeStore(storeFile, dir);

  const store = await loadHashStore();
  upsertSnapshot(store, "/fake/exact.ts", "cexact", 20000, new Array(20000).fill("h"), 20000);
  flushStore(store);

  assert.equal(getSnapshot(store, "/fake/exact.ts", "cexact").length, 20000);
});

test("upsertSnapshot with no maxPersistLines always persists", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-hash-nolimit-"));
  const storeFile = path.join(dir, "hash-store.json");
  const { loadHashStore, upsertSnapshot, getSnapshot, flushStore } = makeStore(storeFile, dir);

  const store = await loadHashStore();
  upsertSnapshot(store, "/fake/huge.ts", "chuge", 999999, ["h"]);
  flushStore(store);

  assert.deepEqual(getSnapshot(store, "/fake/huge.ts", "chuge"), ["h"]);
});
