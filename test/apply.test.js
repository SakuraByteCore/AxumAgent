import assert from "node:assert/strict";
import test from "node:test";

// Faithful JS mirror of plugin/pi-edit/src/hashline/apply.ts (pure functions)
const HASH_SEP = "\u2502";

function buildIdx(content) {
  const fileLines = content.split("\n");
  const lineStarts = [];
  let offset = 0;
  for (let index = 0; index < fileLines.length; index++) {
    lineStarts.push(offset);
    offset += fileLines[index].length;
    if (index < fileLines.length - 1) offset += 1;
  }
  return { fileLines, lineStarts };
}

function visLines(text) {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}

function changedRange(original, result) {
  if (original === result) return null;
  if (original.length === 0) return { firstChangedLine: 1, lastChangedLine: visLines(result).length };
  if (result.startsWith(original) && original.endsWith("\n")) {
    return { firstChangedLine: visLines(original).length + 1, lastChangedLine: visLines(result).length };
  }
  let firstDiff = 0;
  const minLen = Math.min(original.length, result.length);
  while (firstDiff < minLen && original[firstDiff] === result[firstDiff]) firstDiff++;
  if (firstDiff === minLen && original.length === result.length) return null;
  let lastOrig = original.length - 1;
  let lastRes = result.length - 1;
  while (lastOrig >= firstDiff && lastRes >= firstDiff && original[lastOrig] === result[lastRes]) {
    lastOrig--;
    lastRes--;
  }
  function idxToLine(charIdx, text) {
    let line = 1;
    for (let i = 0; i < charIdx && i < text.length; i++) if (text[i] === "\n") line++;
    return line;
  }
  const firstChangedLine = idxToLine(firstDiff + 1, result);
  let lastChangedLine;
  if (lastRes < firstDiff) {
    lastChangedLine = result.length === 0 ? 1 : visLines(result).length;
  } else if (firstDiff === 0 && original.length > 0 && result.endsWith(original)) {
    lastChangedLine = firstChangedLine;
  } else {
    lastChangedLine = idxToLine(lastRes + 1, result);
  }
  return { firstChangedLine, lastChangedLine };
}

function fmtRegion(hashes, lines) {
  if (hashes.length !== lines.length) {
    throw new Error(`fmtRegion: hashes.length (${hashes.length}) must match lines.length (${lines.length}).`);
  }
  return lines.map((line, index) => `${hashes[index]}${HASH_SEP}${line}`).join("\n");
}

test("buildIdx empty string", () => {
  const idx = buildIdx("");
  assert.deepEqual(idx.fileLines, [""]);
  assert.deepEqual(idx.lineStarts, [0]);
});

test("buildIdx single line no newline", () => {
  const idx = buildIdx("hello");
  assert.deepEqual(idx.fileLines, ["hello"]);
  assert.deepEqual(idx.lineStarts, [0]);
});

test("buildIdx two lines no trailing newline", () => {
  const idx = buildIdx("line1\nline2");
  assert.deepEqual(idx.fileLines, ["line1", "line2"]);
  assert.deepEqual(idx.lineStarts, [0, 6]);
});

test("buildIdx three lines with trailing newline", () => {
  const idx = buildIdx("a\nb\nc\n");
  assert.deepEqual(idx.fileLines, ["a", "b", "c", ""]);
  assert.deepEqual(idx.lineStarts, [0, 2, 4, 6]);
});

test("buildIdx lineStarts offset account for newline separator", () => {
  const idx = buildIdx("ab\ncd\nef");
  // line 0 starts at 0, line 1 at 3 (2 chars + 1 newline), line 2 at 6
  assert.deepEqual(idx.lineStarts, [0, 3, 6]);
});

test("changedRange identical returns null", () => {
  assert.equal(changedRange("same\ncontent\n", "same\ncontent\n"), null);
});

test("changedRange empty original to content", () => {
  const range = changedRange("", "new content\n");
  assert.deepEqual(range, { firstChangedLine: 1, lastChangedLine: 1 });
});

test("changedRange append at end with newline", () => {
  const original = "line1\nline2\n";
  const result = "line1\nline2\nline3\n";
  const range = changedRange(original, result);
  assert.deepEqual(range, { firstChangedLine: 3, lastChangedLine: 3 });
});

test("changedRange prepend at start", () => {
  const original = "line2\nline3\n";
  const result = "line1\nline2\nline3\n";
  const range = changedRange(original, result);
  assert.deepEqual(range, { firstChangedLine: 1, lastChangedLine: 2 });
});


test("changedRange middle change", () => {
  const original = "line1\nline2\nline3\n";
  const result = "line1\nCHANGED\nline3\n";
  const range = changedRange(original, result);
  assert.deepEqual(range, { firstChangedLine: 2, lastChangedLine: 2 });
});

test("changedRange full replacement", () => {
  const original = "a\nb\nc\n";
  const result = "x\ny\nz\n";
  const range = changedRange(original, result);
  assert.deepEqual(range, { firstChangedLine: 1, lastChangedLine: 3 });
});

test("changedRange shrink (delete lines)", () => {
  const original = "a\nb\nc\nd\n";
  const result = "a\nd\n";
  const range = changedRange(original, result);
  // Line 2 changes from b to d
  assert.ok(range !== null);
  assert.equal(range.firstChangedLine, 2);
});

test("fmtRegion formats with hash separator", () => {
  const result = fmtRegion(["h1", "h2"], ["line1", "line2"]);
  assert.equal(result, "h1\u2502line1\nh2\u2502line2");
});

test("fmtRegion single line", () => {
  assert.equal(fmtRegion(["abc"], ["only line"]), "abc\u2502only line");
});

test("fmtRegion mismatched lengths throws", () => {
  assert.throws(() => fmtRegion(["h1", "h2"], ["only one"]), /fmtRegion/);
});

test("fmtRegion empty arrays", () => {
  assert.equal(fmtRegion([], []), "");
});
