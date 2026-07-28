import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Faithful JS mirror of plugin/pi-edit/src/file-reader.ts (pure functions)
function fmtSnapId(canonicalPath, info) {
  return `v1|${canonicalPath}|${info.mtimeMs}|${info.size}`;
}

test("fmtSnapId formats correctly with all fields", () => {
  const result = fmtSnapId("/abs/path/to/file.ts", { mtimeMs: 1700000000.5, size: 1024 });
  assert.equal(result, "v1|/abs/path/to/file.ts|1700000000.5|1024");
});

test("fmtSnapId uses v1 prefix", () => {
  assert.ok(fmtSnapId("/x", { mtimeMs: 1, size: 1 }).startsWith("v1|"));
});

test("fmtSnapId with size 0", () => {
  const result = fmtSnapId("/empty.txt", { mtimeMs: 0, size: 0 });
  assert.equal(result, "v1|/empty.txt|0|0");
});

test("fmtSnapId with large mtimeMs", () => {
  const result = fmtSnapId("/a.ts", { mtimeMs: 9999999999999, size: 500 });
  assert.equal(result, "v1|/a.ts|9999999999999|500");
});

test("fmtSnapId with special chars in path", () => {
  const result = fmtSnapId("/path with spaces/file (1).ts", { mtimeMs: 123, size: 42 });
  assert.equal(result, "v1|/path with spaces/file (1).ts|123|42");
});

test("fmtSnapId separates with pipe consistently", () => {
  const result = fmtSnapId("/a/b.ts", { mtimeMs: 1, size: 2 });
  const parts = result.split("|");
  assert.equal(parts.length, 4);
  assert.equal(parts[0], "v1");
  assert.equal(parts[1], "/a/b.ts");
  assert.equal(parts[2], "1");
  assert.equal(parts[3], "2");
});
