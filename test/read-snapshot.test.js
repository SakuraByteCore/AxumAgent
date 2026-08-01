import assert from "node:assert/strict";
import test from "node:test";

// Faithful JS mirror of plugin/pi-edit/src/read-snapshot.ts (pure in-memory LRU).
// node --test exercises this without a TS loader; keep in sync when the source
// changes.

const MAX_PATHS = 8;
const MAX_VERSIONS_PER_PATH = 4;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

const pathOrder = [];
const pathMap = new Map();

function totalSize() {
  let n = 0;
  for (const entry of pathMap.values()) {
    for (const v of entry.versions) n += v.length;
  }
  return n;
}

function evictOldestVersion() {
  for (let i = pathOrder.length - 1; i >= 0; i--) {
    const p = pathOrder[i];
    const entry = pathMap.get(p);
    if (entry && entry.versions.length > 0) {
      entry.versions.pop();
      if (entry.versions.length === 0) {
        pathMap.delete(p);
        pathOrder.splice(i, 1);
      }
      return;
    }
  }
}

function rememberReadSnapshot(canonicalPath, content) {
  const existing = pathMap.get(canonicalPath);
  if (existing && existing.versions.length > 0 && existing.versions[0] === content) {
    const idx = pathOrder.indexOf(canonicalPath);
    if (idx > 0) {
      pathOrder.splice(idx, 1);
      pathOrder.unshift(canonicalPath);
    }
    return;
  }
  if (existing) {
    existing.versions.unshift(content);
    while (existing.versions.length > MAX_VERSIONS_PER_PATH) existing.versions.pop();
    const idx = pathOrder.indexOf(canonicalPath);
    if (idx > 0) {
      pathOrder.splice(idx, 1);
      pathOrder.unshift(canonicalPath);
    }
  } else {
    if (pathOrder.length >= MAX_PATHS) {
      const lruPath = pathOrder[pathOrder.length - 1];
      pathMap.delete(lruPath);
      pathOrder.pop();
    }
    pathMap.set(canonicalPath, { versions: [content] });
    pathOrder.unshift(canonicalPath);
  }
  while (totalSize() > MAX_TOTAL_BYTES) {
    evictOldestVersion();
    if (pathMap.size === 0) break;
  }
}

function getReadSnapshot(canonicalPath) {
  const entry = pathMap.get(canonicalPath);
  return entry && entry.versions.length > 0 ? entry.versions[0] : null;
}

function getReadSnapshotVersions(canonicalPath) {
  const entry = pathMap.get(canonicalPath);
  return entry ? [...entry.versions] : [];
}

function reset() {
  pathOrder.length = 0;
  pathMap.clear();
}

test("getReadSnapshot returns null for unknown path", () => {
  reset();
  assert.equal(getReadSnapshot("/none"), null);
  assert.deepEqual(getReadSnapshotVersions("/none"), []);
});

test("rememberReadSnapshot stores newest-first and dedups by fusion", () => {
  reset();
  const p = "/tmp/a";
  rememberReadSnapshot(p, "v1");
  rememberReadSnapshot(p, "v2");
  assert.deepEqual(getReadSnapshotVersions(p), ["v2", "v1"]);
  // Identical newest version is fused (no new entry) but path stays MRU.
  rememberReadSnapshot(p, "v2");
  assert.deepEqual(getReadSnapshotVersions(p), ["v2", "v1"]);
});

test("rememberReadSnapshot trims to MAX_VERSIONS_PER_PATH", () => {
  reset();
  const p = "/tmp/b";
  for (let i = 0; i < 6; i++) rememberReadSnapshot(p, `c${i}`);
  const versions = getReadSnapshotVersions(p);
  assert.equal(versions.length, MAX_VERSIONS_PER_PATH);
  // newest-first: c5 is the most recent.
  assert.equal(versions[0], "c5");
  assert.equal(getReadSnapshot(p), "c5");
});

test("rememberReadSnapshot evicts the LRU path when MAX_PATHS is exceeded", () => {
  reset();
  for (let i = 0; i < MAX_PATHS + 1; i++) rememberReadSnapshot(`/tmp/p${i}`, `x${i}`);
  // The oldest path (/tmp/p0) should have been evicted.
  assert.equal(getReadSnapshot("/tmp/p0"), null);
  // The newest path /tmp/p8 (i = 8 = MAX_PATHS) is present.
  assert.equal(getReadSnapshot("/tmp/p8"), "x8");
});

test("MRU promotion keeps a recently remembered path warm", () => {
  reset();
  rememberReadSnapshot("/p1", "1");
  rememberReadSnapshot("/p2", "2");
  // Touch /p1 again — it should now be MRU, so /p2 is the LRU candidate.
  rememberReadSnapshot("/p1", "1b");
  for (let i = 3; i < MAX_PATHS + 2; i++) rememberReadSnapshot(`/p${i}`, `${i}`);
  // /p2 (untouched) should be evicted before /p1.
  assert.equal(getReadSnapshot("/p2"), null);
  assert.notEqual(getReadSnapshot("/p1"), null);
});
