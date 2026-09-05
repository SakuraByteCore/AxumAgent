import assert from "node:assert/strict";
import test from "node:test";

import {
  PI_RATE_LIMIT_429_PATTERN_SOURCE,
  applyBundledPiPatches,
  patchPiTuiStdinBuffer,
} from "../src/bundled-pi-patches.js";

test("429 pattern matches strict provider throttle shapes only", () => {
  const re = new RegExp(PI_RATE_LIMIT_429_PATTERN_SOURCE, "i");
  assert.ok(re.test("Error: 429: {\"message\":\"Too Many Requests\"}"));
  assert.ok(re.test("429 Too Many Requests"));
  assert.ok(re.test("  Error: 429: quota"));
  assert.equal(re.test("the file is 429 bytes long"), false);
  assert.equal(re.test("status 1429"), false);
});

test("patchPiTuiStdinBuffer throws when the paste constants are absent", () => {
  assert.throws(
    () => patchPiTuiStdinBuffer("const X = 1;"),
    /paste constants not found/,
  );
});

test("patchPiTuiStdinBuffer inserts the unbracketed-paste guard and is idempotent", () => {
  const content = [
    'const BRACKETED_PASTE_START = "\\x1b[200~";',
    'const BRACKETED_PASTE_END = "\\x1b[201~";',
    'class Parser {',
    '    process(str) {',
    '        if (str.length === 0 && this.buffer.length === 0) {',
    '            this.emitDataSequence("");',
    '            return;',
    '        }',
    '    }',
    '}',
    '',
  ].join("\n");
  const once = patchPiTuiStdinBuffer(content);
  assert.ok(once.includes("looksLikeUnbracketedPaste"));
  assert.ok(once.includes('this.emit("paste", str);'));
  const twice = patchPiTuiStdinBuffer(once);
  assert.equal(twice, once);
});

test("applyBundledPiPatches throws for a cache root without installed packages", () => {
  assert.throws(
    () => applyBundledPiPatches({ env: { ...process.env, AXUM_BUNDLED_PI_DIR: "/nonexistent-axum-cache" } }),
    /stdin buffer not found/,
  );
});
