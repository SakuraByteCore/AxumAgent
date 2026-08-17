import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Faithful JS mirrors of plugin/pi-edit/src/replace-diff.ts and the budget
// guards introduced in plugin/pi-edit/src/replace.ts + hashline/hash.ts.
// node --test exercises these without a TS loader; keep in sync when the
// source changes.

const MAX_REPLACE_ADDED_LINES = 4000;
const MAX_RESULT_HASH_LINES = 20000;
const MAX_DIFF_LINES = 6000;

// --- mirror of replace-diff.ts genDiff + diffSummary ---

export function genDiff(original, modified, context = 3, newHashes, oldHashes, maxDiffLines) {
  const oldLines = original.length === 0 ? [] : original.split("\n");
  const newLines = modified.length === 0 ? [] : modified.split("\n");
  const budget = maxDiffLines ?? Infinity;
  if (oldLines.length + newLines.length > budget) {
    return { diff: diffSummary(oldLines.length, newLines.length), truncated: true };
  }
  const hunks = computeLcsDiff(oldLines, newLines, context, oldHashes, newHashes);
  return { diff: hunks.join("\n") };
}

function diffSummary(oldLen, newLen) {
  return [
    "@@ diff truncated @@",
    `[summary] ${oldLen} original line(s) -> ${newLen} result line(s). Output exceeds diff budget; full LCS omitted.`,
    "[hint] Call read() to inspect the updated file instead of relying on the inline diff.",
  ].join("\n");
}

function computeLcsDiff(oldLines, newLines, context, oldHashes, newHashes) {
  const n = oldLines.length;
  const m = newLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: "eq", line: oldLines[i], oldIdx: i, newIdx: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", line: oldLines[i], oldIdx: i });
      i++;
    } else {
      ops.push({ type: "add", line: newLines[j], newIdx: j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "del", line: oldLines[i], oldIdx: i });
    i++;
  }
  while (j < m) {
    ops.push({ type: "add", line: newLines[j], newIdx: j });
    j++;
  }
  return ops.map((o) => `${o.type === "eq" ? " " : o.type === "del" ? "-" : "+"}${o.line}`);
}

// --- mirror of replace.ts content_lines budget guard ---

function totalAddedLines(changes) {
  let total = 0;
  for (const edit of changes) {
    total += Array.isArray(edit.content_lines) ? edit.content_lines.length : 0;
  }
  return total;
}

function assertReplaceBudget(changes) {
  const proposed = totalAddedLines(changes);
  if (proposed > MAX_REPLACE_ADDED_LINES) {
    throw new Error(
      `[E_REPLACE_TOO_LARGE] The total number of content_lines (${proposed}) exceeds the ${MAX_REPLACE_ADDED_LINES}-line replace budget. Use the \`write\` tool for large inserts and full-file rewrites.`
    );
  }
  return proposed;
}

// --- mirror of hashline/hash.ts overflow guard (persistence skip) ---

function lineCountOf(content) {
  if (content.length === 0) return 0;
  const lines = content.split("\n");
  // Mirror of utils.ts visLines: a terminal newline yields a trailing empty
  // element that does not represent a real line; drop it.
  const realLines = content.endsWith("\n") ? lines.slice(0, -1) : lines;
  return realLines.length;
}

function resultOverflows(content, cap) {
  if (cap === undefined) return false;
  return lineCountOf(content) > cap;
}

// Minimal in-memory store mirror to assert no upsert on overflow.
function makeMemoryStore() {
  const rows = new Map();
  return {
    rows,
    dirty: false,
    upsert(p, checksum, lineCount, hashes, maxPersist) {
      if (maxPersist !== undefined && lineCount > maxPersist) return;
      rows.set(p, { path: p, checksum, line_count: lineCount, hashes: JSON.stringify(hashes), updated_at: 1 });
      this.dirty = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("replace budget: under-limit content_lines passes the pre-flight guard", () => {
  const changes = [{ content_lines: new Array(MAX_REPLACE_ADDED_LINES).fill("x") }];
  assert.doesNotThrow(() => assertReplaceBudget(changes));
  assert.equal(assertReplaceBudget(changes), MAX_REPLACE_ADDED_LINES);
});

test("replace budget: exactly at limit passes", () => {
  const changes = [{ content_lines: new Array(MAX_REPLACE_ADDED_LINES).fill("y") }];
  assert.doesNotThrow(() => assertReplaceBudget(changes));
});

test("replace budget: over-limit content_lines throws E_REPLACE_TOO_LARGE", () => {
  const over = MAX_REPLACE_ADDED_LINES + 1;
  const changes = [{ content_lines: new Array(over).fill("z") }];
  assert.throws(
    () => assertReplaceBudget(changes),
    /E_REPLACE_TOO_LARGE/
  );
});

test("replace budget: aggregates content_lines across multiple edits", () => {
  const changes = [
    { content_lines: new Array(MAX_REPLACE_ADDED_LINES).fill("a") },
    { content_lines: ["b"] },
  ];
  assert.throws(
    () => assertReplaceBudget(changes),
    /E_REPLACE_TOO_LARGE/
  );
});

test("replace budget: empty content_lines (deletes) never trip the budget", () => {
  const changes = [{ content_lines: [] }, { content_lines: [] }];
  assert.equal(assertReplaceBudget(changes), 0);
});

test("genDiff: small payload returns a full LCS diff and truncated=false", () => {
  const original = "a\nb\nc";
  const modified = "a\nB\nc";
  const res = genDiff(original, modified, 3, undefined, undefined, MAX_DIFF_LINES);
  assert.equal(res.truncated, undefined);
  assert.ok(res.diff.length > 0);
  assert.ok(res.diff.includes("B"));
});

test("genDiff: over-budget payload skips full LCS and returns truncated summary", () => {
  const big = new Array(MAX_DIFF_LINES + 10).fill("line").join("\n");
  const bigger = new Array(MAX_DIFF_LINES + 20).fill("line").join("\n");
  const res = genDiff(big, bigger, 3, undefined, undefined, MAX_DIFF_LINES);
  assert.equal(res.truncated, true);
  assert.match(res.diff, /diff truncated/);
  assert.match(res.diff, /\[summary\]/);
  assert.match(res.diff, /full LCS omitted/);
});

test("genDiff: summary has no per-line +/− entries (full diff was skipped)", () => {
  const big = new Array(MAX_DIFF_LINES + 5).fill("x").join("\n");
  const res = genDiff(big, big + "\nextra", 3, undefined, undefined, MAX_DIFF_LINES);
  assert.equal(res.truncated, true);
  // No LCS lines should be present; the summary is the whole body.
  assert.doesNotMatch(res.diff, /^-[^\]]/m);
  assert.doesNotMatch(res.diff, /^\+[^\]]/m);
});

test("genDiff: default budget (Infinity) never truncates", () => {
  const res = genDiff("x\ny", "x\nz");
  assert.equal(res.truncated, undefined);
  assert.ok(res.diff.includes("z"));
});

test("lineHashes overflow guard: result over MAX_RESULT_HASH_LINES is flagged", () => {
  const over = new Array(MAX_RESULT_HASH_LINES + 1).fill("l").join("\n");
  assert.equal(resultOverflows(over, MAX_RESULT_HASH_LINES), true);
});

test("lineHashes overflow guard: result at exactly the cap is NOT overflow", () => {
  const at = new Array(MAX_RESULT_HASH_LINES).fill("l").join("\n");
  assert.equal(resultOverflows(at, MAX_RESULT_HASH_LINES), false);
});

test("lineCountOf: terminal newline does not add a phantom line", () => {
  // visLines semantics: "a\nb\n" has 2 lines, not 3.
  assert.equal(lineCountOf("a\nb\n"), 2);
  assert.equal(lineCountOf("a\nb"), 2);
  assert.equal(lineCountOf(""), 0);
  assert.equal(lineCountOf("x"), 1);
  assert.equal(lineCountOf("x\n"), 1);
});

test("lineHashes overflow guard: at-cap content with trailing newline still NOT overflow", () => {
  // A cap-sized file ending in \n must not be miscounted as cap+1 (which would
  // wrongly flip overflow and persist when execPipeline says hashOverflow).
  const at = new Array(MAX_RESULT_HASH_LINES).fill("l").join("\n");
  assert.equal(lineCountOf(at), MAX_RESULT_HASH_LINES);
  assert.equal(resultOverflows(at, MAX_RESULT_HASH_LINES), false);
});

test("lineHashes overflow guard: undefined cap never overflows", () => {
  const huge = new Array(MAX_RESULT_HASH_LINES * 5).fill("l").join("\n");
  assert.equal(resultOverflows(huge, undefined), false);
});

test("lineHashes persistence: overflow result is not written to the store", () => {
  const store = makeMemoryStore();
  const overflowContent = new Array(MAX_RESULT_HASH_LINES + 100).fill("l").join("\n");
  const overflow = resultOverflows(overflowContent, MAX_RESULT_HASH_LINES);

  // Mirror of the hash.ts branch: only persist when wantPersist && !overflow.
  const wantPersist = true;
  if (wantPersist && !overflow) {
    store.upsert("/p", "ck", lineCountOf(overflowContent), ["h0"], MAX_RESULT_HASH_LINES);
  }

  assert.equal(overflow, true);
  assert.equal(store.rows.size, 0, "overflow result must not be persisted");
  assert.equal(store.dirty, false, "store must remain clean on overflow");
});

test("lineHashes persistence: under-cap result IS written to the store", () => {
  const store = makeMemoryStore();
  const content = new Array(10).fill("l").join("\n");
  const overflow = resultOverflows(content, MAX_RESULT_HASH_LINES);

  const wantPersist = true;
  if (wantPersist && !overflow) {
    store.upsert("/p", "ck", lineCountOf(content), ["h0"], MAX_RESULT_HASH_LINES);
  }

  assert.equal(overflow, false);
  assert.equal(store.rows.size, 1, "under-cap result must be persisted");
  assert.equal(store.dirty, true);
});

test("lineHashes persistence: explicit noPersist skips the store even when under cap", () => {
  const store = makeMemoryStore();
  const content = "a\nb\nc";
  const overflow = resultOverflows(content, MAX_RESULT_HASH_LINES);
  const wantPersist = false; // caller disabled persistence
  if (wantPersist && !overflow) {
    store.upsert("/p", "ck", lineCountOf(content), ["h0"], MAX_RESULT_HASH_LINES);
  }
  assert.equal(overflow, false);
  assert.equal(store.rows.size, 0, "noPersist must keep the store untouched");
  assert.equal(store.dirty, false);
});

test("replace tool details: hashOverflow and diffTruncated surface for an over-cap result", () => {
  // Simulate the execute() branch decisions for a huge replace result.
  const result = new Array(MAX_RESULT_HASH_LINES + 1).fill("l").join("\n");
  const hashOverflow = lineCountOf(result) > MAX_RESULT_HASH_LINES;
  const diffResult = hashOverflow
    ? genDiff(result, result + "\nx", 4, [], [], MAX_DIFF_LINES)
    : genDiff(result, result + "\nx", 4, ["h0"], ["h0"], MAX_DIFF_LINES);

  assert.equal(hashOverflow, true);
  assert.equal(diffResult.truncated, true);
  assert.match(diffResult.diff, /\[summary\]/);
});

test("replace tool details: small edit has no overflow and no truncation", () => {
  const result = "a\nb\nc\n";
  const hashOverflow = lineCountOf(result) > MAX_RESULT_HASH_LINES;
  const diffResult = hashOverflow
    ? genDiff(result, result, 4, [], [], MAX_DIFF_LINES)
    : genDiff(result, result, 4, ["h0"], ["h0"], MAX_DIFF_LINES);

  assert.equal(hashOverflow, false);
  assert.equal(diffResult.truncated, undefined);
  assert.doesNotMatch(diffResult.diff, /^-/m);
  assert.doesNotMatch(diffResult.diff, /^\+/m);
});

test("large content_lines do not trigger a full hash diff: combination scenario", () => {
  // A replace that produces an overflow result must NOT exercise a real LCS,
  // even if the caller passed hashes. The overflow path forces the truncated
  // summary and empty hash arrays.
  const hugeResult = new Array(MAX_RESULT_HASH_LINES + 50).fill("l").join("\n");
  const hashOverflow = lineCountOf(hugeResult) > MAX_RESULT_HASH_LINES;

  // Mirror the execute() diff call exactly.
  let usedFullLcs = false;
  if (!hashOverflow) {
    usedFullLcs = true;
    genDiff(hugeResult, hugeResult, 4, ["h0"], ["h0"], MAX_DIFF_LINES);
  } else {
    genDiff(hugeResult, hugeResult, 4, [], [], MAX_DIFF_LINES);
  }

  assert.equal(hashOverflow, true);
  assert.equal(usedFullLcs, false, "full LCS must not run when hashOverflow is true");
});
