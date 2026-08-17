export function detectEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1 || crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function toLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function stripBOM(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function lineCountOf(content: string): number {
  if (content.length === 0) return 0;
  return content.split("\n").length;
}

// Pure-JS line diff (replacing the `diff` npm package).
// Produces a unified-diff-like text with +/- prefixes.
// When old+new line count exceeds `maxDiffLines` the full O(n*m) LCS is skipped:
// a compact summary hunk is returned instead and `truncated` is set to true.
export function genDiff(
  original: string,
  modified: string,
  context = 3,
  newHashes?: string[],
  oldHashes?: string[],
  maxDiffLines?: number,
): { diff: string; truncated?: boolean } {
  const oldLines = original.length === 0 ? [] : original.split("\n");
  const newLines = modified.length === 0 ? [] : modified.split("\n");
  const budget = maxDiffLines ?? Infinity;
  if (oldLines.length + newLines.length > budget) {
    return {
      diff: diffSummary(oldLines.length, newLines.length),
      truncated: true,
    };
  }
  const hunks = computeLcsDiff(oldLines, newLines, context, oldHashes, newHashes);
  return { diff: hunks.join("\n") };
}

function diffSummary(oldLen: number, newLen: number): string {
  return [
    "@@ diff truncated @@",
    `[summary] ${oldLen} original line(s) -> ${newLen} result line(s). Output exceeds diff budget; full LCS omitted.`,
    "[hint] Call read() to inspect the updated file instead of relying on the inline diff.",
  ].join("\n");
}

function computeLcsDiff(
  oldLines: string[],
  newLines: string[],
  context: number,
  oldHashes?: string[],
  newHashes?: string[],
): string[] {
  // LCS-based diff with hunk grouping.
  const n = oldLines.length;
  const m = newLines.length;
  // Build LCS table (DP).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Trace back to produce op list.
  type Op = { type: "del" | "add" | "eq"; line: string; oldIdx?: number; newIdx?: number };
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: "eq", line: oldLines[i], oldIdx: i, newIdx: j });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", line: oldLines[i], oldIdx: i });
      i++;
    } else {
      ops.push({ type: "add", line: newLines[j], newIdx: j });
      j++;
    }
  }
  while (i < n) { ops.push({ type: "del", line: oldLines[i], oldIdx: i }); i++; }
  while (j < m) { ops.push({ type: "add", line: newLines[j], newIdx: j }); j++; }

  // Group into hunks with context.
  const result: string[] = [];
  const SEPSYM = "\u2502";
  let hunk: string[] = [];
  let hunkOldStart = -1;
  let inHunk = false;
  let contextCount = 0;

  const flushHunk = (): void => {
    if (hunk.length > 0) {
      result.push(`@@ -${hunkOldStart + 1},${hunk.filter((l) => l.startsWith("-") || l.startsWith(" ")).length} +${hunkOldStart + 1},${hunk.filter((l) => l.startsWith("+") || l.startsWith(" ")).length} @@`);
      result.push(...hunk);
      hunk = [];
    }
  };

  for (const op of ops) {
    if (op.type === "eq") {
      if (inHunk) {
        if (contextCount < context) {
          const hash = oldHashes?.[op.oldIdx!] ?? "";
          hunk.push(` ${hash}${SEPSYM}${op.line}`);
          contextCount++;
        } else {
          flushHunk();
          inHunk = false;
        }
      }
    } else {
      if (!inHunk) {
        // Start new hunk: include preceding context.
        const startIdx = Math.max(0, (op.oldIdx ?? 0) - context);
        // Find context lines before this op.
        const eqOpsBefore = ops.filter((o) => o.type === "eq" && (o.oldIdx ?? -1) >= startIdx && (o.oldIdx ?? -1) < (op.oldIdx ?? 0));
        hunkOldStart = (eqOpsBefore[0]?.oldIdx ?? op.oldIdx ?? 0) + 1 - 1;
        for (const e of eqOpsBefore) {
          const hash = oldHashes?.[e.oldIdx!] ?? "";
          hunk.push(` ${hash}${SEPSYM}${e.line}`);
        }
        inHunk = true;
      }
      contextCount = 0;
      if (op.type === "del") {
        const hash = oldHashes?.[op.oldIdx!] ?? "";
        hunk.push(`-${hash}${SEPSYM}${op.line}`);
      } else {
        const hash = newHashes?.[op.newIdx!] ?? "";
        hunk.push(`+${hash}${SEPSYM}${op.line}`);
      }
    }
  }
  flushHunk();
  return result;
}
