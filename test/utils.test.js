import assert from "node:assert/strict";
import test from "node:test";

// Faithful JS mirror of plugin/pi-edit/src/utils.ts
function isRec(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function has(record, key) {
  return Object.hasOwn(record, key);
}

function visLines(text) {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}

function lastNonEmptyIndex(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].length > 0) return i;
  }
  return -1;
}

function firstNonEmptyIndex(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 0) return i;
  }
  return -1;
}

function lastNonEmpty(lines) {
  const idx = lastNonEmptyIndex(lines);
  return idx >= 0 ? lines[idx] : undefined;
}

function firstNonEmpty(lines) {
  const idx = firstNonEmptyIndex(lines);
  return idx >= 0 ? lines[idx] : undefined;
}

function errCode(error) {
  if (error instanceof Error) {
    return error.code;
  }
  return undefined;
}

test("isRec true for plain objects", () => {
  assert.equal(isRec({}), true);
  assert.equal(isRec({ a: 1 }), true);
});

test("isRec false for non-objects", () => {
  assert.equal(isRec(null), false);
  assert.equal(isRec(undefined), false);
  assert.equal(isRec("string"), false);
  assert.equal(isRec(42), false);
  assert.equal(isRec(true), false);
});

test("isRec false for arrays", () => {
  assert.equal(isRec([]), false);
  assert.equal(isRec([1, 2]), false);
});

test("has checks own properties", () => {
  assert.equal(has({ a: 1 }, "a"), true);
  assert.equal(has({ a: 1 }, "b"), false);
});

test("has does not check prototype", () => {
  const obj = Object.create({ inherited: 1 });
  obj.own = 2;
  assert.equal(has(obj, "own"), true);
  assert.equal(has(obj, "inherited"), false);
});

test("visLines empty string returns empty array", () => {
  assert.deepEqual(visLines(""), []);
});

test("visLines no trailing newline", () => {
  assert.deepEqual(visLines("a\nb"), ["a", "b"]);
});

test("visLines with trailing newline strips empty last", () => {
  assert.deepEqual(visLines("a\nb\n"), ["a", "b"]);
});

test("visLines single line no newline", () => {
  assert.deepEqual(visLines("hello"), ["hello"]);
});

test("visLines single line with newline", () => {
  assert.deepEqual(visLines("hello\n"), ["hello"]);
});

test("lastNonEmptyIndex finds last non-empty", () => {
  assert.equal(lastNonEmptyIndex(["a", "", "b", ""]), 2);
});

test("lastNonEmptyIndex all empty returns -1", () => {
  assert.equal(lastNonEmptyIndex(["", "", ""]), -1);
});

test("lastNonEmptyIndex empty array returns -1", () => {
  assert.equal(lastNonEmptyIndex([]), -1);
});

test("firstNonEmptyIndex finds first non-empty", () => {
  assert.equal(firstNonEmptyIndex(["", "", "a", "b"]), 2);
});

test("firstNonEmptyIndex all empty returns -1", () => {
  assert.equal(firstNonEmptyIndex(["", ""]), -1);
});

test("lastNonEmpty returns value", () => {
  assert.equal(lastNonEmpty(["a", "", "b"]), "b");
});

test("lastNonEmpty all empty returns undefined", () => {
  assert.equal(lastNonEmpty(["", ""]), undefined);
});

test("firstNonEmpty returns value", () => {
  assert.equal(firstNonEmpty(["", "a", "b"]), "a");
});

test("firstNonEmpty all empty returns undefined", () => {
  assert.equal(firstNonEmpty(["", ""]), undefined);
});

test("errCode extracts code from Error", () => {
  const err = new Error("test");
  err.code = "ENOENT";
  assert.equal(errCode(err), "ENOENT");
});

test("errCode undefined for Error without code", () => {
  assert.equal(errCode(new Error("test")), undefined);
});

test("errCode undefined for non-Error", () => {
  assert.equal(errCode("string"), undefined);
  assert.equal(errCode(null), undefined);
  assert.equal(errCode(42), undefined);
});
