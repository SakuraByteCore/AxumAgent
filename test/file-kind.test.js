import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

// Faithful JS mirror of plugin/pi-edit/src/file-kind.ts (pure functions only)
const IMG_SIGNATURES = [
  { magic: [0xff, 0xd8, 0xff], mime: "image/jpeg" },
  { magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: "image/png" },
  { magic: [0x47, 0x49, 0x46, 0x38], mime: "image/gif" },
  { magic: [0x52, 0x49, 0x46, 0x46], mime: "image/webp" },
];

function detectImageMime(buf) {
  for (const sig of IMG_SIGNATURES) {
    if (sig.mime === "image/webp") {
      if (buf.length >= 12 && buf.readUInt32BE(8) === 0x57454250) return "image/webp";
      continue;
    }
    if (buf.length >= sig.magic.length && sig.magic.every((b, i) => buf[i] === b)) {
      return sig.mime;
    }
  }
  return null;
}

function isProbablyBinary(buf) {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) return true;
  }
  let nonText = 0;
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)) {
      i++;
      continue;
    }
    let seqlen = 0;
    if (b >= 0xc0 && b <= 0xdf) seqlen = 2;
    else if (b >= 0xe0 && b <= 0xef) seqlen = 3;
    else if (b >= 0xf0 && b <= 0xf7) seqlen = 4;
    if (seqlen > 0) {
      if (i + seqlen <= buf.length) {
        let valid = true;
        for (let j = 1; j < seqlen; j++) {
          const c = buf[i + j];
          if (c < 0x80 || c > 0xbf) { valid = false; break; }
        }
        if (valid) { i += seqlen; continue; }
      }
      nonText++;
      i++;
      continue;
    }
    nonText++;
    i++;
  }
  return buf.length > 0 && nonText / buf.length > 0.3;
}

test("detectImageMime JPEG", () => {
  const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.equal(detectImageMime(buf), "image/jpeg");
});

test("detectImageMime PNG", () => {
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  assert.equal(detectImageMime(buf), "image/png");
});

test("detectImageMime GIF", () => {
  const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  assert.equal(detectImageMime(buf), "image/gif");
});

test("detectImageMime WebP with RIFF...WEBP", () => {
  const buf = Buffer.alloc(12);
  buf[0] = 0x52; // R
  buf[1] = 0x49; // I
  buf[2] = 0x46; // F
  buf[3] = 0x46; // F
  buf.writeUInt32BE(0x57454250, 8); // WEBP
  assert.equal(detectImageMime(buf), "image/webp");
});

test("detectImageMime RIFF without WEBP returns null", () => {
  const buf = Buffer.alloc(12);
  buf[0] = 0x52; // RIFF header
  buf[1] = 0x49;
  buf[2] = 0x46;
  buf[3] = 0x46;
  buf.writeUInt32BE(0x57415645, 8); // WAVE, not WEBP
  assert.equal(detectImageMime(buf), null);
});

test("detectImageMime returns null for text", () => {
  const buf = Buffer.from("hello world", "utf8");
  assert.equal(detectImageMime(buf), null);
});

test("detectImageMime returns null for empty buffer", () => {
  assert.equal(detectImageMime(Buffer.alloc(0)), null);
});

test("isProbablyBinary false for ASCII text", () => {
  const buf = Buffer.from("hello world\nfoo bar baz\n", "utf8");
  assert.equal(isProbablyBinary(buf), false);
});

test("isProbablyBinary true for null bytes", () => {
  const buf = Buffer.from([0x01, 0x00, 0x02, 0x03]);
  assert.equal(isProbablyBinary(buf), true);
});

test("isProbablyBinary false for text with newlines and tabs", () => {
  const buf = Buffer.from("line1\nline2\ttab\rcarriage", "utf8");
  assert.equal(isProbablyBinary(buf), false);
});

test("isProbablyBinary true for high non-text ratio", () => {
  // Stray continuation bytes (0x80-0xBF) without a valid UTF-8 lead.
  const buf = Buffer.from([0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89]);
  assert.equal(isProbablyBinary(buf), true);
});

test("isProbablyBinary false for empty buffer", () => {
  assert.equal(isProbablyBinary(Buffer.alloc(0)), false);
});

test("isProbablyBinary true for mixed content with null", () => {
  const buf = Buffer.from("text\0binary", "utf8");
  assert.equal(isProbablyBinary(buf), true);
});

test("isProbablyBinary false for CJK-heavy text", () => {
  const buf = Buffer.from("御坂です。日本語のテキストはテキストとして扱う\n", "utf8");
  assert.equal(isProbablyBinary(buf), false);
});

test("isProbablyBinary false for long CJK-only buffer", () => {
  const buf = Buffer.from("日本語".repeat(1000), "utf8");
  assert.equal(isProbablyBinary(buf), false);
});

test("isProbablyBinary false for emoji text", () => {
  const buf = Buffer.from("emoji: 😀\ngrinning: \u{1F600}\n", "utf8");
  assert.equal(isProbablyBinary(buf), false);
});

test("isProbablyBinary false for mixed ASCII and CJK", () => {
  const buf = Buffer.from("ascii part then 日本語 and 接着中文\n", "utf8");
  assert.equal(isProbablyBinary(buf), false);
});

test("isProbablyBinary true for truncated UTF-8 lead byte", () => {
  // 3-byte lead (0xE3) with no continuation bytes available.
  const buf = Buffer.from([0xe3]);
  assert.equal(isProbablyBinary(buf), true);
});

test("isProbablyBinary true for invalid UTF-8 continuation", () => {
  // 3-byte lead (0xE3) followed by non-continuation byte.
  const buf = Buffer.from([0xe3, 0x41, 0x42]);
  assert.equal(isProbablyBinary(buf), true);
});

