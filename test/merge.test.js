import assert from "node:assert/strict";
import test from "node:test";

// Faithful JS mirror of plugin/pi-edit/src/merge.ts (pure functions):
// structuredPatch + applyPatch + threeWayMerge (fuzzFactor 0).
// node --test exercises this without a TS loader; keep in sync when the source
// changes.


function lineDiff(oldLines, newLines) {
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
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: "eq", oldIdx: i, newIdx: j, line: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", oldIdx: i, newIdx: j, line: oldLines[i] });
      i++;
    } else {
      ops.push({ type: "add", oldIdx: i, newIdx: j, line: newLines[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "del", oldIdx: i, newIdx: j, line: oldLines[i] });
    i++;
  }
  while (j < m) {
    ops.push({ type: "add", oldIdx: i, newIdx: j, line: newLines[j] });
    j++;
  }
  return ops;
}

function structuredPatch(base, baseEdited, context = 3) {
  const baseLines = base.length === 0 ? [] : base.split("\n");
  const editedLines = baseEdited.length === 0 ? [] : baseEdited.split("\n");
  const ops = lineDiff(baseLines, editedLines);
  const hunks = [];
  let idx = 0;
  while (idx < ops.length) {
    const op = ops[idx];
    if (op.type === "eq") {
      idx++;
      continue;
    }
    let runEnd = idx;
    while (runEnd < ops.length && ops[runEnd].type !== "eq") runEnd++;
    let ctxStart = idx;
    let lead = 0;
    while (ctxStart > 0 && ops[ctxStart - 1].type === "eq" && lead < context) {
      ctxStart--;
      lead++;
    }
    let ctxEnd = runEnd;
    let trail = 0;
    while (ctxEnd < ops.length && ops[ctxEnd].type === "eq" && trail < context) {
      ctxEnd++;
      trail++;
    }
    const lines = [];
    let oldCount = 0;
    let newCount = 0;
    for (let k = ctxStart; k < ctxEnd; k++) {
      const o = ops[k];
      if (o.type === "eq") {
        lines.push(` ${o.line}`);
        oldCount++;
        newCount++;
      } else if (o.type === "del") {
        lines.push(`-${o.line}`);
        oldCount++;
      } else {
        lines.push(`+${o.line}`);
        newCount++;
      }
    }
    hunks.push({ oldStart: ops[ctxStart].oldIdx, oldLines: oldCount, newStart: ops[ctxStart].newIdx, newLines: newCount, lines });
    idx = ctxEnd;
  }
  return hunks;
}

function applyPatch(current, hunks) {
  const currentLines = current.length === 0 ? [] : current.split("\n");
  const out = [];
  let cursor = 0;
  for (const hunk of hunks) {
    if (hunk.oldStart < cursor) return false;
    if (hunk.oldStart + hunk.oldLines > currentLines.length) return false;
    for (let k = cursor; k < hunk.oldStart; k++) out.push(currentLines[k]);
    let cur = hunk.oldStart;
    for (const line of hunk.lines) {
      const prefix = line[0];
      const content = line.slice(1);
      if (prefix === " ") {
        if (currentLines[cur] !== content) return false;
        out.push(content);
        cur++;
      } else if (prefix === "-") {
        if (currentLines[cur] !== content) return false;
        cur++;
      } else {
        out.push(content);
      }
    }
    cursor = cur;
  }
  for (let k = cursor; k < currentLines.length; k++) out.push(currentLines[k]);
  return out.join("\n");
}

function threeWayMerge(base, baseEdited, current) {
  if (base === current) return baseEdited;
  const hunks = structuredPatch(base, baseEdited, 3);
  if (hunks.length === 0) return null;
  const merged = applyPatch(current, hunks, { fuzzFactor: 0 });
  if (merged === false || typeof merged !== "string") return null;
  if (merged === current) return null;
  return merged;
}

test("threeWayMerge short-circuits when base === current", () => {
  assert.equal(threeWayMerge("a\nb\nc", "a\nb\nc", "a\nb\nc"), "a\nb\nc");
});

test("threeWayMerge replays a single-line change onto an unchanged current", () => {
  const base = "line1\nline2\nline3\nline4\nline5";
  const baseEdited = "line1\nLINE2\nline3\nline4\nline5";
  const current = "line1\nline2\nline3\nline4\nline5";
  assert.equal(threeWayMerge(base, baseEdited, current), "line1\nLINE2\nline3\nline4\nline5");
});

test("threeWayMerge replays a change when distant region was edited", () => {
  const base = "keep1\nkeep2\ntarget\nkeep3\nkeep4\nkeep5\nkeep6\nkeep7";
  const baseEdited = "keep1\nkeep2\nTARGET\nkeep3\nkeep4\nkeep5\nkeep6\nkeep7";
  // current has an unrelated edit far from the target (beyond context).
  const current = "keep1\nkeep2\ntarget\nkeep3\nkeep4\nkeep5\nkeep6\nEDITED";
  assert.equal(threeWayMerge(base, baseEdited, current), "keep1\nkeep2\nTARGET\nkeep3\nkeep4\nkeep5\nkeep6\nEDITED");
});

test("threeWayMerge returns null when the patch conflicts (context mismatch)", () => {
  const base = "line1\nline2\nline3";
  const baseEdited = "line1\nLINE2\nline3";
  // current changed the context line the hunk expects, with no slide (fuzz 0).
  const current = "line1\nXXX\nline3";
  assert.equal(threeWayMerge(base, baseEdited, current), null);
});

test("threeWayMerge returns null when the merged result equals current", () => {
  // baseEdited only touches a region; if current already contains that change
  // the merge result equals current → null (nothing new to write).
  const base = "a\nb\nc";
  const baseEdited = "a\nB\nc";
  const current = "a\nB\nc";
  assert.equal(threeWayMerge(base, baseEdited, current), null);
});
