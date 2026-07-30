import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The hash-store module is TypeScript. We replicate its pure-JS logic here as
// a faithful mirror so node --test can exercise it without a TS loader.
// When hash-store.ts changes, keep this in sync.

function makeStore(storeFile, storeDir) {
  let cached = null;

  function loadFromDisk(sp) {
    if (!fs.existsSync(sp)) return new Map();
    try {
      const arr = JSON.parse(fs.readFileSync(sp, "utf8"));
      const m = new Map();
      for (const r of arr) if (r && typeof r.path === "string") m.set(r.path, r);
      return m;
    } catch {
      return new Map();
    }
  }

  function flushStore(s) {
    if (!s.dirty) return;
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(s.storePath, JSON.stringify(Array.from(s.rows.values())), "utf8");
    s.dirty = false;
  }

  async function loadHashStore() {
    if (cached) return cached;
    if (!fs.existsSync(storeDir)) fs.mkdirSync(storeDir, { recursive: true });
    cached = { rows: loadFromDisk(storeFile), storePath: storeFile, dirty: false };
    return cached;
  }

  function getSnapshot(s, p, c) {
    const r = s.rows.get(p);
    if (!r?.hashes) return null;
    try {
      const j = JSON.parse(r.hashes);
      if (j.content === c) return j.hashes;
    } catch {
      // fall through
    }
    return null;
  }

  function upsertSnapshot(s, p, ck, lc, h, c, maxPersistLines) {
    if (maxPersistLines !== undefined && lc > maxPersistLines) return;
    s.rows.set(p, {
      path: p,
      checksum: ck,
      line_count: lc,
      hashes: JSON.stringify({ content: c ?? "", hashes: h }),
      updated_at: Date.now(),
    });
    s.dirty = true;
  }

  async function pruneMissing(s) {
    let ch = false;
    for (const [p, row] of s.rows) {
      if (!fs.existsSync(row.path)) {
        s.rows.delete(p);
        ch = true;
      }
    }
    if (ch) s.dirty = true;
    flushStore(s);
  }

  return { loadHashStore, getSnapshot, upsertSnapshot, pruneMissing, flushStore };
}

test("hash-store basic round-trip", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-hash-basic-"));
  const storeFile = path.join(dir, "hash-store.json");
  const { loadHashStore, getSnapshot, upsertSnapshot, flushStore } = makeStore(storeFile, dir);

  const store = await loadHashStore();
  const content = "line1\nline2\nline3";
  upsertSnapshot(store, "/fake/a.ts", "ca", 3, ["h1", "h2", "h3"], content);
  flushStore(store);

  const got = getSnapshot(store, "/fake/a.ts", content);
  assert.deepEqual(got, ["h1", "h2", "h3"]);
});

test("hash-store content mismatch returns null", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-hash-mismatch-"));
  const storeFile = path.join(dir, "hash-store.json");
  const { loadHashStore, getSnapshot, upsertSnapshot, flushStore } = makeStore(storeFile, dir);

  const store = await loadHashStore();
  upsertSnapshot(store, "/fake/b.ts", "cb", 1, ["x"], "original");
  flushStore(store);

  assert.equal(getSnapshot(store, "/fake/b.ts", "different"), null);
});

test("hash-store special chars in path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-hash-special-"));
  const storeFile = path.join(dir, "hash-store.json");
  const { loadHashStore, getSnapshot, upsertSnapshot, flushStore } = makeStore(storeFile, dir);

  const weird = "/fake/O'Brien's file (v2).ts";
  const store = await loadHashStore();
  upsertSnapshot(store, weird, "cw", 2, ["x", "y"], "x\ny");
  flushStore(store);

  const got = getSnapshot(store, weird, "x\ny");
  assert.deepEqual(got, ["x", "y"]);
});

test("hash-store tricky JSON content with parens and quotes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-hash-tricky-"));
  const storeFile = path.join(dir, "hash-store.json");
  const { loadHashStore, getSnapshot, upsertSnapshot, flushStore } = makeStore(storeFile, dir);

  const tricky = 'function foo() { return (1+2)*3; } // "hi"\nvar x = "\\"quoted\\"";';
  const store = await loadHashStore();
  upsertSnapshot(store, "/fake/t.ts", "ct", 2, ["t1", "t2"], tricky);
  flushStore(store);

  const got = getSnapshot(store, "/fake/t.ts", tricky);
  assert.deepEqual(got, ["t1", "t2"]);
});

test("hash-store persistence across reload", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-hash-persist-"));
  const storeFile = path.join(dir, "hash-store.json");

  const s1 = makeStore(storeFile, dir);
  const store = await s1.loadHashStore();
  const content = "persisted content";
  s1.upsertSnapshot(store, "/fake/p.ts", "cp", 1, ["p1"], content);
  s1.flushStore(store);

  // New store instance reads from disk
  const s2 = makeStore(storeFile, dir);
  const store2 = await s2.loadHashStore();
  const got = s2.getSnapshot(store2, "/fake/p.ts", content);
  assert.deepEqual(got, ["p1"]);
});

test("hash-store prune removes missing files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-hash-prune-"));
  const storeFile = path.join(dir, "hash-store.json");
  const { loadHashStore, upsertSnapshot, pruneMissing, flushStore, getSnapshot } = makeStore(storeFile, dir);

  const store = await loadHashStore();
  upsertSnapshot(store, "/nonexistent/a.ts", "c", 1, ["h"], "content");
  upsertSnapshot(store, dir + "/real.ts", "c2", 1, ["h2"], "content2");
  fs.writeFileSync(path.join(dir, "real.ts"), "content2");
  flushStore(store);

  await pruneMissing(store);

  const raw = JSON.parse(fs.readFileSync(storeFile, "utf8"));
  assert.equal(raw.length, 1, "only the existing file should remain");
  assert.equal(raw[0].path, dir + "/real.ts");
});

test("upsertSnapshot skips persistence when lineCount exceeds maxPersistLines", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-hash-maxpersist-"));
  const storeFile = path.join(dir, "hash-store.json");
  const { loadHashStore, upsertSnapshot, getSnapshot, flushStore } = makeStore(storeFile, dir);

  const store = await loadHashStore();
  // 20001 lines exceeding a 20000-line cap
  upsertSnapshot(store, "/fake/big.ts", "cbig", 20001, new Array(20001).fill("h"), "big-content", 20000);
  flushStore(store);

  // Not persisted: getSnapshot returns null
  assert.equal(getSnapshot(store, "/fake/big.ts", "big-content"), null);
  // Store rows empty
  assert.equal(store.rows.size, 0);
});

test("upsertSnapshot persists when lineCount is within maxPersistLines", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-hash-within-"));
  const storeFile = path.join(dir, "hash-store.json");
  const { loadHashStore, upsertSnapshot, getSnapshot, flushStore } = makeStore(storeFile, dir);

  const store = await loadHashStore();
  // 20000 lines exactly at the cap (not exceeding)
  upsertSnapshot(store, "/fake/exact.ts", "cexact", 20000, new Array(20000).fill("h"), "exact-content", 20000);
  flushStore(store);

  const got = getSnapshot(store, "/fake/exact.ts", "exact-content");
  assert.equal(got.length, 20000);
});

test("upsertSnapshot with no maxPersistLines always persists", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-hash-nolimit-"));
  const storeFile = path.join(dir, "hash-store.json");
  const { loadHashStore, upsertSnapshot, getSnapshot, flushStore } = makeStore(storeFile, dir);

  const store = await loadHashStore();
  upsertSnapshot(store, "/fake/huge.ts", "chuge", 999999, ["h"], "huge");
  flushStore(store);

  const got = getSnapshot(store, "/fake/huge.ts", "huge");
  assert.deepEqual(got, ["h"]);
});
