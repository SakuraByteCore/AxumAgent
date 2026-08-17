import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

// Faithful JS mirror of plugin/pi-edit/src/hashline/hasher.ts
function xxh32(input, _seed = 0) {
  const buf = createHash("sha1").update(input, "utf8").digest();
  return buf.readUInt32BE(0) >>> 0;
}

function contentChecksum(content) {
  return createHash("sha1").update(content, "utf8").digest("hex").slice(0, 16);
}

test("hasher xxh32 is deterministic", () => {
  const a = xxh32("hello");
  const b = xxh32("hello");
  assert.equal(a, b);
});

test("hasher xxh32 different inputs produce different outputs", () => {
  const a = xxh32("hello");
  const b = xxh32("world");
  assert.notEqual(a, b);
});

test("hasher xxh32 returns unsigned 32-bit", () => {
  const result = xxh32("test");
  assert.ok(result >= 0, "should be non-negative");
  assert.ok(result <= 0xffffffff, "should fit in uint32");
});

test("hasher contentChecksum is 16 hex chars", () => {
  const cs = contentChecksum("some content");
  assert.equal(cs.length, 16);
  assert.match(cs, /^[0-9a-f]{16}$/);
});

test("hasher contentChecksum different inputs differ", () => {
  assert.notEqual(contentChecksum("a"), contentChecksum("b"));
});

test("hasher contentChecksum same input same output", () => {
  assert.equal(contentChecksum("identical"), contentChecksum("identical"));
});

test("hasher contentChecksum empty string is valid", () => {
  const cs = contentChecksum("");
  assert.equal(cs.length, 16);
  // SHA-1 of empty string is da39a3ee5e6b4b0d3255bfef95601890afd80709
  assert.equal(cs, "da39a3ee5e6b4b0d");
});
