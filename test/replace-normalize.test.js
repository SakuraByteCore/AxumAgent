import assert from "node:assert/strict";
import test from "node:test";

// Faithful JS mirror of plugin/pi-edit/src/replace-normalize.ts
function isRec(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function has(record, key) {
  return Object.hasOwn(record, key);
}

function tryParseContentLines(record, key) {
  const val = record[key];
  if (typeof val !== "string") return;
  try {
    const parsed = JSON.parse(val);
    if (Array.isArray(parsed)) { record[key] = parsed; return; }
  } catch {
    // fall through to error
  }
  throw new Error(
    `[E_BAD_SHAPE] "content_lines" must be a native JSON array of strings, not a JSON string. Pass it as a proper JSON array: ["line1", "line2"].`
  );
}

function normalizeFilePath(record) {
  if (typeof record.path !== "string" && typeof record.file_path === "string") {
    record.path = record.file_path;
    delete record.file_path;
  }
}

function normalizeField(record, from, to) {
  if (!has(record, from)) return;
  const raw = record[from];
  if (Array.isArray(raw)) {
    record[to] = raw;
  } else if (isRec(raw)) {
    record[to] = [raw];
  } else if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) record[to] = parsed;
      else if (isRec(parsed)) record[to] = [parsed];
    } catch {
      // leave as-is
    }
  }
  if (from !== to) delete record[from];
}

function normReq(request) {
  if (!isRec(request)) throw new Error("[E_BAD_SHAPE] Edit request must be an object.");
  const record = { ...request };
  normalizeFilePath(record);
  if ("changes" in record && Array.isArray(record.changes)) {
    for (const change of record.changes) {
      if (isRec(change)) tryParseContentLines(change, "content_lines");
    }
  }
  if ("content_lines" in record) tryParseContentLines(record, "content_lines");
  normalizeField(record, "edits", "changes");
  return record;
}

test("normalizeFilePath converts file_path to path", () => {
  const rec = { file_path: "/test/a.ts" };
  normalizeFilePath(rec);
  assert.equal(rec.path, "/test/a.ts");
  assert.equal(rec.file_path, undefined);
});

test("normalizeFilePath does not overwrite existing path", () => {
  const rec = { path: "/existing.ts", file_path: "/ignored.ts" };
  normalizeFilePath(rec);
  assert.equal(rec.path, "/existing.ts");
  assert.equal(rec.file_path, "/ignored.ts");
});

test("normalizeFilePath no-op when neither exists", () => {
  const rec = { other: "field" };
  normalizeFilePath(rec);
  assert.equal(rec.path, undefined);
  assert.equal(rec.file_path, undefined);
});

test("tryParseContentLines parses JSON string array", () => {
  const rec = { content_lines: '["a","b"]' };
  tryParseContentLines(rec, "content_lines");
  assert.deepEqual(rec.content_lines, ["a", "b"]);
});

test("tryParseContentLines passes through native array", () => {
  const rec = { content_lines: ["x", "y"] };
  tryParseContentLines(rec, "content_lines");
  assert.deepEqual(rec.content_lines, ["x", "y"]);
});

test("tryParseContentLines throws on non-array JSON string", () => {
  const rec = { content_lines: '{"key": "val"}' };
  assert.throws(() => tryParseContentLines(rec, "content_lines"), /E_BAD_SHAPE/);
});

test("tryParseContentLines throws on non-JSON string", () => {
  const rec = { content_lines: "not json" };
  assert.throws(() => tryParseContentLines(rec, "content_lines"), /E_BAD_SHAPE/);
});

test("normReq rejects non-object input", () => {
  assert.throws(() => normReq("string"), /E_BAD_SHAPE/);
  assert.throws(() => normReq(null), /E_BAD_SHAPE/);
  assert.throws(() => normReq([]), /E_BAD_SHAPE/);
});

test("normReq normalizes file_path to path", () => {
  const req = { file_path: "/a.ts", content_lines: ["x"] };
  const result = normReq(req);
  assert.equal(result.path, "/a.ts");
});

test("normReq normalizes content_lines from JSON string in changes", () => {
  const req = { changes: [{ path: "/a.ts", content_lines: '["line1","line2"]' }] };
  const result = normReq(req);
  assert.deepEqual(result.changes[0].content_lines, ["line1", "line2"]);
});

test("normReq normalizes edits to changes", () => {
  const req = { path: "/a.ts", edits: [{ path: "/b.ts", content_lines: ["x"] }] };
  const result = normReq(req);
  assert.deepEqual(result.changes, [{ path: "/b.ts", content_lines: ["x"] }]);
  assert.equal(result.edits, undefined);
});

test("normReq normalizes edits from JSON string", () => {
  const req = { path: "/a.ts", edits: '[{"path":"/b.ts"}]' };
  const result = normReq(req);
  assert.deepEqual(result.changes, [{ path: "/b.ts" }]);
});

test("normReq passes through already-normal request", () => {
  const req = { path: "/a.ts", content_lines: ["x", "y"] };
  const result = normReq(req);
  assert.equal(result.path, "/a.ts");
  assert.deepEqual(result.content_lines, ["x", "y"]);
});

test("normalizeField moves single object to array", () => {
  const rec = { edits: { path: "/a.ts" } };
  normalizeField(rec, "edits", "changes");
  assert.deepEqual(rec.changes, [{ path: "/a.ts" }]);
  assert.equal(rec.edits, undefined);
});
