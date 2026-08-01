// Three-way merge helper for stale-anchor recovery.
//
// Pure-JS implementation of structuredPatch + applyPatch (fuzzFactor 0), so we
// avoid pulling the `diff` npm package and keep no native/named deps. Mirrors
// the upstream pi-hashline-edit merge.ts semantics: fuzzFactor 0 means
// misaligned hunks are rejected, never slid. If the patch cannot apply exactly,
// returns null and the caller surfaces the original stale-anchor error.

// ─── Myers-style line diff to produce hunks ─────────────────────────────

interface DiffOp {
  type: "del" | "add" | "eq";
  oldIdx: number;
  newIdx: number;
  line: string;
}

function lineDiff(oldLines: readonly string[], newLines: readonly string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  // LCS DP table.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: "eq", oldIdx: i, newIdx: j, line: oldLines[i]! });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", oldIdx: i, newIdx: j, line: oldLines[i]! });
      i++;
    } else {
      ops.push({ type: "add", oldIdx: i, newIdx: j, line: newLines[j]! });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "del", oldIdx: i, newIdx: j, line: oldLines[i]! });
    i++;
  }
  while (j < m) {
    ops.push({ type: "add", oldIdx: i, newIdx: j, line: newLines[j]! });
    j++;
  }
  return ops;
}

interface Hunk {
  oldStart: number;   // 0-based start in base
  oldLines: number;   // count of base lines affected
  newStart: number;   // 0-based start in new
  newLines: number;   // count of new lines
  lines: string[];    // unified-diff-style lines with " "/"+"/"-" prefixes
}

/**
 * Build a minimal unified-diff-style hunk list from base → baseEdited, with
 * `context` lines of surrounding equality. Mirrors jsdiff's structuredPatch
 * output shape closely enough for our applyPatch to consume.
 */
export function structuredPatch(
  base: string,
  baseEdited: string,
  context = 3,
): Hunk[] {
  const baseLines = base.length === 0 ? [] : base.split("\n");
  const editedLines = baseEdited.length === 0 ? [] : baseEdited.split("\n");
  const ops = lineDiff(baseLines, editedLines);

  const hunks: Hunk[] = [];
  // For each run of consecutive del/add ops, build a hunk with context.
  let idx = 0;
  while (idx < ops.length) {
    const op = ops[idx]!;
    if (op.type === "eq") {
      idx++;
      continue;
    }
    // Found a change starting at idx. Collect this run of del/add.
    let runEnd = idx;
    while (runEnd < ops.length && ops[runEnd]!.type !== "eq") runEnd++;

    // Determine hunk bounds with context.
    // oldStart: first base line of the hunk (including leading context).
    // Walk back up to `context` eq lines from idx-1 down.
    let ctxStart = idx;
    let lead = 0;
    while (ctxStart > 0 && ops[ctxStart - 1]!.type === "eq" && lead < context) {
      ctxStart--;
      lead++;
    }
    // Walk forward up to `context` eq lines after runEnd.
    let ctxEnd = runEnd;
    let trail = 0;
    while (ctxEnd < ops.length && ops[ctxEnd]!.type === "eq" && trail < context) {
      ctxEnd++;
      trail++;
    }

    const lines: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let k = ctxStart; k < ctxEnd; k++) {
      const o = ops[k]!;
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
    const oldStart = ops[ctxStart]!.oldIdx;
    const newStart = ops[ctxStart]!.newIdx;
    hunks.push({ oldStart, oldLines: oldCount, newStart, newLines: newCount, lines });
    idx = ctxEnd;
  }
  return hunks;
}

/**
 * Apply hunks onto `current` with fuzzFactor 0: hunks must align exactly at
 * oldStart (no sliding). Returns the merged text, or false on any failure.
 */
export function applyPatch(
  current: string,
  hunks: Hunk[],
  _opts: { fuzzFactor?: number } = {},
): string | false {
  const currentLines = current.length === 0 ? [] : current.split("\n");
  const out: string[] = [];
  let cursor = 0; // 0-based index into currentLines consumed up to here.
  for (const hunk of hunks) {
    // Must have at least hunk.oldStart lines available and they must match.
    if (hunk.oldStart < cursor) {
      // Overlapping or out-of-order hunk: reject.
      return false;
    }
    if (hunk.oldStart + hunk.oldLines > currentLines.length) {
      return false;
    }
    // Copy unchanged lines from cursor up to hunk.oldStart.
    for (let k = cursor; k < hunk.oldStart; k++) {
      out.push(currentLines[k]!);
    }
    // Verify context/deletion lines match current exactly (fuzz 0).
    let cur = hunk.oldStart;
    for (const line of hunk.lines) {
      const prefix = line[0]!;
      const content = line.slice(1);
      if (prefix === " ") {
        if (currentLines[cur] !== content) return false;
        out.push(content);
        cur++;
      } else if (prefix === "-") {
        if (currentLines[cur] !== content) return false;
        cur++;
      } else {
        // "+": insertion; do not consume from current.
        out.push(content);
      }
    }
    cursor = cur;
  }
  // Copy trailing unchanged lines.
  for (let k = cursor; k < currentLines.length; k++) {
    out.push(currentLines[k]!);
  }
  return out.join("\n");
}

/**
 * Replay the changes made from `base` → `baseEdited` onto `current`.
 *
 * Returns the merged text, or null when:
 * - the patch cannot apply to `current` with fuzzFactor 0, or
 * - the merged result is identical to `current` (nothing new to write).
 *
 * Short-circuit: if `base === current`, return `baseEdited` directly.
 */
export function threeWayMerge(
  base: string,
  baseEdited: string,
  current: string,
): string | null {
  if (base === current) {
    return baseEdited;
  }

  const hunks = structuredPatch(base, baseEdited, 3);
  if (hunks.length === 0) {
    return null;
  }
  const merged = applyPatch(current, hunks, { fuzzFactor: 0 });

  if (merged === false || typeof merged !== "string") {
    return null;
  }

  if (merged === current) {
    return null;
  }

  return merged;
}
