import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Faithful JS mirror of the pure helpers in plugin/pi-edit/src/grep.ts, plus an
// end-to-end test that runs real ripgrep through the upstream registerGrepTool
// logic is not feasible from a pure mirror (it needs the pi runtime). Instead we
// exercise the pure helpers (mergeRange / parseMatchLine / appendLimitedStderr)
// and a real `rg --json` parse to confirm the anchor-format assumptions.
// node --test runs without a TS loader; keep in sync when the source changes.

const STDERR_MAX_BYTES = 64 * 1024;

function mergeRange(ranges, range) {
  let merged = range;
  const remaining = [];
  for (const r of ranges) {
    if (r.end < merged.start - 1 || r.start > merged.end + 1) {
      remaining.push(r);
    } else {
      merged = { start: Math.min(merged.start, r.start), end: Math.max(merged.end, r.end) };
    }
  }
  remaining.push(merged);
  remaining.sort((a, b) => a.start - b.start);
  ranges.splice(0, ranges.length, ...remaining);
}

function parseMatchLine(line) {
  if (!line.trim()) return null;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (event.type !== "match") return null;
  return { filePath: event.data.path.text, lineNum: event.data.line_number };
}

function appendLimitedStderr(current, chunk) {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, "utf8") <= STDERR_MAX_BYTES) return combined;
  return Buffer.from(combined, "utf8").subarray(0, STDERR_MAX_BYTES).toString("utf8");
}

test("mergeRange merges adjacent (touching) ranges", () => {
  const r = [];
  mergeRange(r, { start: 1, end: 3 });
  mergeRange(r, { start: 4, end: 6 });
  assert.deepEqual(r, [{ start: 1, end: 6 }]);
});

test("mergeRange keeps a gap as two ranges", () => {
  const r = [];
  mergeRange(r, { start: 1, end: 3 });
  mergeRange(r, { start: 8, end: 10 });
  assert.deepEqual(r, [{ start: 1, end: 3 }, { start: 8, end: 10 }]);
});

test("mergeRange overlaps fully", () => {
  const r = [];
  mergeRange(r, { start: 1, end: 10 });
  mergeRange(r, { start: 3, end: 5 });
  assert.deepEqual(r, [{ start: 1, end: 10 }]);
});

test("mergeRange extends end when new range overflows", () => {
  const r = [];
  mergeRange(r, { start: 1, end: 4 });
  mergeRange(r, { start: 3, end: 9 });
  assert.deepEqual(r, [{ start: 1, end: 9 }]);
});

test("parseMatchLine rejects non-match rg --json events", () => {
  assert.equal(parseMatchLine('{"type":"summary","data":{}}'), null);
  assert.equal(parseMatchLine("not json"), null);
  assert.equal(parseMatchLine("  "), null);
  assert.equal(parseMatchLine('{"type":"end","data":{}}'), null);
});

test("parseMatchLine extracts file path + line number from match events", () => {
  const line = '{"type":"match","data":{"path":{"text":"a/b.ts"},"line_number":42}}';
  assert.deepEqual(parseMatchLine(line), { filePath: "a/b.ts", lineNum: 42 });
});

test("appendLimitedStderr truncates beyond STDERR_MAX_BYTES", () => {
  const big = "x".repeat(STDERR_MAX_BYTES + 100);
  const out = appendLimitedStderr("", big);
  assert.equal(Buffer.byteLength(out, "utf8"), STDERR_MAX_BYTES);
  assert.equal(out, "x".repeat(STDERR_MAX_BYTES));
});

test("appendLimitedStderr keeps content under cap unchanged", () => {
  const small = "y".repeat(100);
  assert.equal(appendLimitedStderr("", small), small);
  assert.equal(appendLimitedStderr("abc", "def"), "abcdef");
});

// Real ripgrep end-to-end through rg --json, confirming the JSON shape grep.ts parses.
test("rg --json emits match events consumable by parseMatchLine", () => {
  // Skip if rg is unavailable.
  const probe = spawnSync("rg", ["--version"], { encoding: "utf-8" });
  if (probe.error || probe.status !== 0) return;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grep-e2e-"));
  fs.writeFileSync(path.join(tmp, "f.txt"), "alpha\nbeta\ngamma\nalpha2\n");
  const res = spawnSync("rg", ["--json", "--", "alpha", tmp], { encoding: "utf-8", maxBuffer: 1 << 20 });
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.equal(res.status, 0);
  const matches = res.stdout.split("\n").map(parseMatchLine).filter(Boolean);
  // alpha matches at line 1 and line 4.
  assert.equal(matches.length, 2);
  assert.equal(matches[0].lineNum, 1);
  assert.equal(matches[1].lineNum, 4);
  assert.ok(matches[0].filePath.endsWith("f.txt"));
});
