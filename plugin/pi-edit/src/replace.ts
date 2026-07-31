import { constants } from "fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { genDiff, restoreEndings } from "./replace-diff.js";
import { readNormFile, fileSnap } from "./file-reader.js";
import { normReq } from "./replace-normalize.js";
import { isRec, has, rejectUnknownFields, abortIf, visLines } from "./utils.js";
import { MAX_HASH_LINES, MAX_REPLACE_ADDED_LINES, MAX_RESULT_HASH_LINES, MAX_DIFF_LINES } from "./constants.js";
import { writeAtomic } from "./fs-write.js";
import { applyEdits, lineHashes, resEdits, type HTEdit } from "./hashline/index.js";
import { toCwd } from "./paths.js";
import { loadHashStore, type HashStore } from "./hash-store.js";
import { Text, Container, Spacer } from "@earendil-works/pi-tui";
import { readArgPath, formatPath, buildCallHeader, buildShellBox } from "./render.js";

const contentLinesSchema = {
  type: "array",
  items: { type: "string" },
  description: "literal replacement file content, one string per line. Must not include the HASH\u2502 prefix from read output.",
};

const hashRangeInclSchema = {
  type: "array",
  items: { type: "string", description: "anchor (3-char HASH)" },
  description: "inclusive hash range to replace [start_hash, end_hash].",
  minItems: 2,
  maxItems: 2,
};

const changeItemSchema = {
  type: "object",
  properties: { content_lines: contentLinesSchema, hash_range_inclusive: hashRangeInclSchema },
  required: ["content_lines", "hash_range_inclusive"],
  additionalProperties: false,
};

export const editToolSchema = {
  type: "object",
  properties: {
    changes: { type: "array", items: changeItemSchema, description: "changes over path" },
    path: { type: "string", description: "path" },
  },
  required: ["path", "changes"],
  additionalProperties: false,
} as const;

const ROOT_KS = new Set(["path", "changes", "content_lines", "hash_range_inclusive"]);

export function assertReq(request: unknown, flat?: boolean): asserts request is { path: string; changes: HTEdit[] } {
  if (!isRec(request)) throw new Error("[E_BAD_SHAPE] Edit request must be an object.");
  for (const legacyKey of ["oldText", "newText", "old_text", "new_text", "old_range", "start", "end", "lines"]) {
    if (has(request, legacyKey)) {
      throw new Error(`[E_LEGACY_SHAPE] "${legacyKey}" is not supported. Use {content_lines: [...], hash_range_inclusive: ["<START>", "<END>"]}.`);
    }
  }
  rejectUnknownFields(request, ROOT_KS, "Edit request");
  if (typeof request.path !== "string" || request.path.length === 0) {
    throw new Error('[E_BAD_SHAPE] Edit request requires a non-empty "path" string.');
  }
  if (!Array.isArray(request.changes)) {
    if (flat) throw new Error('[E_BAD_SHAPE] Edit request requires both "content_lines" and "hash_range_inclusive" at the top level.');
    throw new Error('[E_BAD_SHAPE] Edit request requires a "changes" array.');
  }
}

interface PipelineResult {
  path: string;
  originalNormalized: string;
  result: string;
  bom: string;
  originalEnding: "\r\n" | "\n";
  hadUtf8DecodeErrors: boolean;
  warnings: string[];
  firstChangedLine?: number;
  lastChangedLine?: number;
  originalHashes: string[];
  resultHashes: string[];
  noopEdits?: { editIndex: number; loc: string; currentContent: string }[];
  totalAddedLines: number;
  totalRemovedLines: number;
  // True when result line count exceeds MAX_RESULT_HASH_LINES. In that case hashes
  // were computed in memory only (not persisted) and callers should skip the full
  // inline diff.
  hashOverflow: boolean;
}

export async function execPipeline(
  params: { path: string; changes: HTEdit[] },
  cwd: string,
  accessMode: number,
  signal?: AbortSignal,
  store?: HashStore,
  noPersist?: boolean,
): Promise<PipelineResult> {
  const path = params.path;
  const toolEdits = Array.isArray(params.changes) ? params.changes : [];
  if (toolEdits.length === 0) throw new Error('[E_BAD_SHAPE] Edit request requires a non-empty "changes" array.');

  // Pre-flight: total content_lines across all edits must stay within budget.
  // Large inserts should go through `write` instead of inflating replace payloads.
  let proposedAddedLines = 0;
  for (const edit of toolEdits) {
    proposedAddedLines += Array.isArray((edit as { content_lines?: unknown }).content_lines) ? (edit as { content_lines: unknown[] }).content_lines.length : 0;
  }
  if (proposedAddedLines > MAX_REPLACE_ADDED_LINES) {
    throw new Error(`[E_REPLACE_TOO_LARGE] The total number of content_lines (${proposedAddedLines}) exceeds the ${MAX_REPLACE_ADDED_LINES}-line replace budget. Use the \`write\` tool for large inserts and full-file rewrites.`);
  }
  const hashStore = store ?? (await loadHashStore());

  const { normalized: originalNormalized, bom, originalEnding, fileHashes: originalHashes, hadUtf8DecodeErrors, absolutePath } = await readNormFile(
    path, cwd, signal, accessMode, undefined, MAX_HASH_LINES, hashStore,
  );

  const resolved = resEdits(toolEdits);
  const anchorResult = applyEdits(originalNormalized, resolved, signal, originalHashes, path);
  const result = anchorResult.content;

  const removedHashes = new Set<string>();
  for (const edit of resolved) {
    const startHash = edit.hash_range_inclusive[0].hash;
    const endHash = edit.hash_range_inclusive[1].hash;
    const startLine = originalHashes.indexOf(startHash);
    const endLine = originalHashes.indexOf(endHash);
    if (startLine >= 0 && endLine >= 0) {
      for (let i = startLine; i <= endLine; i++) removedHashes.add(originalHashes[i]!);
    }
  }

  const resultLineCount = visLines(result).length;
  const hashOverflow = resultLineCount > MAX_RESULT_HASH_LINES;

  // On overflow do not persist and do not reuse a stale snapshot: compute in memory.
  const resultHashes = await lineHashes(
    result, absolutePath,
    { content: originalNormalized, hashes: originalHashes, removedHashes },
    hashStore,
    noPersist !== true,
    { maxResultHashLines: MAX_RESULT_HASH_LINES },
  );
  const warnings = [...(anchorResult.warnings ?? [])];

  let totalAddedLines = 0;
  let totalRemovedLines = 0;
  const noopIndices = new Set(anchorResult.noopEdits?.map((n) => n.editIndex) ?? []);
  for (let i = 0; i < resolved.length; i++) {
    if (noopIndices.has(i)) continue;
    const edit = resolved[i]!;
    const startLine = originalHashes.indexOf(edit.hash_range_inclusive[0].hash);
    const endLine = originalHashes.indexOf(edit.hash_range_inclusive[1].hash);
    if (startLine >= 0 && endLine >= 0) totalRemovedLines += endLine - startLine + 1;
    totalAddedLines += edit.content_lines.length;
  }

  return {
    path, originalNormalized, result, bom, originalEnding, hadUtf8DecodeErrors, warnings,
    firstChangedLine: anchorResult.firstChangedLine, lastChangedLine: anchorResult.lastChangedLine,
    resultHashes, originalHashes, totalAddedLines, totalRemovedLines,
    noopEdits: anchorResult.noopEdits,
    hashOverflow,
  };
}

export function buildToolDef(opts: { flat?: boolean }): any {
  const E_DESC = `Replace lines in a text file using HASH anchors from read. Stack multiple regions for one file into the changes array. Total content_lines capped at ${MAX_REPLACE_ADDED_LINES} lines; use \`write\` for larger inserts or full rewrites.`;
  const E_SNIPPET = "- Replace lines using 3-char HASH anchors from read; stack multiple changes per file.";
  const E_GUIDE = [
    "Anchors must be 3-char base64 hashes from the most recent read. Stale anchors fail with [E_STALE_ANCHOR].",
    "hash_range_inclusive is inclusive: every line from start_hash through end_hash is deleted. Pass exactly [start_hash, end_hash].",
    "content_lines is literal file content, one string per line. Never include the HASH\u2502 prefix. To delete lines, use content_lines: [].",
    "Put all operations on one file in a single replace call — stack every region into the changes array.",
    `Budget: total content_lines across all edits is capped at ${MAX_REPLACE_ADDED_LINES} lines; the inline diff is summarized when the result exceeds ${MAX_RESULT_HASH_LINES} lines. Use \`write\` for larger inserts.`,
  ];

  return {
    name: "replace",
    label: "Replace",
    description: E_DESC,
    promptSnippet: E_SNIPPET,
    promptGuidelines: E_GUIDE,
    parameters: editToolSchema,
    concurrency: "exclusive",
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      const rawPath = readArgPath(args);
      const changes = Array.isArray((args as any)?.changes) ? (args as any).changes : [];
      const suffix = changes.length > 0
        ? theme.fg("muted", ` \u00b7 ${changes.length} change${changes.length === 1 ? "" : "s"}`)
        : "";
      const header = buildCallHeader("replace", theme, rawPath, context.cwd ?? ".", suffix);
      return buildShellBox(theme, header);
    },
    renderResult(result: any, options: any, theme: any, context: any) {
      const rawPath = readArgPath(context.args);
      const comp = (context.lastComponent ?? new Container()) as Container;
      comp.clear();
      const m = result?.details?.metrics ?? {};
      const showPath = formatPath(rawPath ?? "<file>", context.cwd ?? ".");
      if (context.isError) {
        const errText = (result.content ?? [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text || "")
          .join("\n") || "Error";
        comp.addChild(new Spacer(1));
        comp.addChild(new Text(theme.fg("error", errText), 1, 0));
        return comp;
      }
      // Noop summary.
      if (result?.details?.classification === "noop" || (m.addedLines === 0 && m.removedLines === 0)) {
        comp.addChild(new Text(
          `${theme.fg("toolTitle", theme.bold("replace"))} ${theme.fg("accent", showPath)} ${theme.fg("muted", "(no changes)")}`,
          1, 0,
        ));
        return comp;
      }
      // Collapsed: one-line summary with +added -removed.
      if (!options.expanded) {
        const range = m.firstChangedLine != null && m.lastChangedLine != null
          ? ` (lines ${m.firstChangedLine}-${m.lastChangedLine})`
          : "";
        comp.addChild(new Text(
          `${theme.fg("toolTitle", theme.bold("replace"))} ${theme.fg("accent", showPath)} ${theme.fg("toolDiffAdded", `+${m.addedLines ?? 0}`)} ${theme.fg("toolDiffRemoved", `-${m.removedLines ?? 0}`)}${theme.fg("muted", range)}`,
          1, 0,
        ));
        return comp;
      }
      // Expanded: render the diff and warnings with color.
      const body = (result.content ?? [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text || "")
        .join("\n");
      comp.addChild(new Spacer(1));
      comp.addChild(new Text(theme.fg("toolOutput", body), 1, 0));
      if (result?.details?.diffTruncated) {
        comp.addChild(new Text(theme.fg("warning", "[Diff truncated: result exceeds hash line cap]"), 1, 0));
      }
      if (result?.details?.hashOverflow) {
        comp.addChild(new Text(theme.fg("warning", `[Hash overflow: result over ${MAX_RESULT_HASH_LINES} lines; hashes not persisted]`), 1, 0));
      }
      return comp;
    },
    async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const canonical = normReq(params) as { path: string; changes: HTEdit[] };
      assertReq(canonical, opts.flat);
      const path = canonical.path;
      const absolutePath = toCwd(path, ctx.cwd);

      const {
        originalNormalized, originalHashes, result, bom, originalEnding, hadUtf8DecodeErrors,
        warnings, noopEdits, firstChangedLine, lastChangedLine, resultHashes, totalAddedLines, totalRemovedLines, hashOverflow,
      } = await execPipeline(canonical, ctx.cwd, constants.R_OK | constants.W_OK, signal);

      if (originalNormalized === result) {
        const noopSnapshotId = (await fileSnap(absolutePath)).snapshotId;
        return {
          content: [{ type: "text", text: `[No changes] ${path} (snapshot ${noopSnapshotId})\nEdit was a noop — content_lines matched existing content.` }],
          details: { classification: "noop", snapshotId: noopSnapshotId, metrics: { editsAttempted: canonical.changes.length, noopEditsCount: noopEdits?.length ?? 0, addedLines: 0, removedLines: 0 } },
        };
      }

      const allWarnings = [...warnings];
      if (hadUtf8DecodeErrors) allWarnings.push("Non-UTF-8 bytes were shown as U+FFFD; this edit rewrote the file as UTF-8.");
      if (hashOverflow) {
        allWarnings.push(`Result file exceeds ${MAX_RESULT_HASH_LINES} lines; hashes were computed in memory and not persisted. Full inline diff skipped.`);
      }

      abortIf(signal);
      await writeAtomic(absolutePath, bom + restoreEndings(result, originalEnding));
      const updatedSnapshotId = (await fileSnap(absolutePath)).snapshotId;

      // On hash overflow skip the full LCS diff: it would allocate an O(n*m) table
      // and emit a hunk per changed region. Pass empty hash sets so the summary
      // path in genDiff never touches the persisted store.
      const diffResult = hashOverflow
        ? genDiff(originalNormalized, result, 4, [], [], MAX_DIFF_LINES)
        : genDiff(originalNormalized, result, 4, resultHashes, originalHashes, MAX_DIFF_LINES);
      const diff = diffResult.diff;
      const summary = `Replaced ${path}: ${totalRemovedLines} line(s) removed, ${totalAddedLines} line(s) added (lines ${firstChangedLine ?? "?"}-${lastChangedLine ?? "?"}).`;

      return {
        content: [{ type: "text", text: `${summary}\nSnapshot: ${updatedSnapshotId}${allWarnings.length ? `\nWarnings: ${allWarnings.join("; ")}` : ""}\n\n${diff}` }],
        details: {
          diff,
          diffTruncated: diffResult.truncated === true,
          hashOverflow,
          firstChangedLine,
          snapshotId: updatedSnapshotId,
          metrics: {
            editsAttempted: canonical.changes.length,
            noopEditsCount: noopEdits?.length ?? 0,
            addedLines: totalAddedLines,
            removedLines: totalRemovedLines,
            ...(firstChangedLine !== undefined ? { firstChangedLine } : {}),
            ...(lastChangedLine !== undefined ? { lastChangedLine } : {}),
          },
        },
      };
    },
  };
}

export function regReplace(pi: ExtensionAPI): void {
  pi.registerTool(buildToolDef({ flat: false }) as any);
}
