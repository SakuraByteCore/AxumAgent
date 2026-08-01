import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadFileKindAndText } from "./file-kind.js";
import { readNormFile, fileSnap } from "./file-reader.js";
import { lineHashes, fmtRegion, HASH_SEP } from "./hashline/index.js";
import { toCwd } from "./paths.js";
import { abortIf } from "./utils.js";
import { visLines } from "./utils.js";
import { valAccess } from "./validation.js";
import { resolveTarget } from "./fs-write.js";
import { MAX_HASH_LINES, COLLAPSED_PREVIEW_LINES } from "./constants.js";
import { loadP, loadGuide } from "./prompts.js";
import { Text, Container, Spacer } from "@earendil-works/pi-tui";
import { readArgPath, formatPath, buildCallHeader, buildShellBox, collapsePreview } from "./render.js";
import { rememberReadSnapshot } from "./read-snapshot.js";
import { clearAppliedPayload } from "./noop-loop-guard.js";

interface ReadParams {
  path: string;
  offset?: number;
  limit?: number;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

interface TruncationResult {
  truncated: boolean;
  truncatedBy?: "lines" | "bytes";
  content: string;
  outputLines: number;
  maxBytes?: number;
  firstLineExceedsLimit?: boolean;
}

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_LINES = 2000;
const MAX_LINE_BYTES = 64 * 1024;

function truncateHead(text: string, maxBytes = DEFAULT_MAX_BYTES, maxLines = DEFAULT_MAX_LINES): TruncationResult {
  const lines = text.split("\n");
  let result: string[] = [];
  let bytes = 0;
  let outputLines = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > MAX_LINE_BYTES) {
      return { truncated: true, truncatedBy: "bytes", content: result.join("\n"), outputLines, maxBytes, firstLineExceedsLimit: true };
    }
    if (outputLines >= maxLines) {
      return { truncated: true, truncatedBy: "lines", content: result.join("\n"), outputLines, maxBytes };
    }
    if (bytes + lineBytes + 1 > maxBytes && outputLines > 0) {
      return { truncated: true, truncatedBy: "bytes", content: result.join("\n"), outputLines, maxBytes };
    }
    result.push(line);
    bytes += lineBytes + 1;
    outputLines++;
  }
  return { truncated: false, content: text, outputLines, maxBytes };
}

function normPosInt(value: number | undefined, name: "offset" | "limit"): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Read request field "${name}" must be a positive integer.`);
  }
  return value;
}

export function formatPaginationHint(startLine: number, endLine: number, totalLines: number, nextOffset: number, byteLimit?: number): string {
  const sizeSuffix = byteLimit !== undefined ? ` (${formatSize(byteLimit)} limit)` : "";
  return `[Showing lines ${startLine}-${endLine} of ${totalLines}${sizeSuffix}. Use offset=${nextOffset} to continue.]`;
}

export async function fmtReadPreview(
  text: string,
  options: { offset?: number; limit?: number },
  precomputedHashes?: string[],
  path?: string,
): Promise<{ text: string; truncation?: TruncationResult; nextOffset?: number }> {
  const allLines = visLines(text);
  const totalLines = allLines.length;
  const startLine = normPosInt(options.offset, "offset") ?? 1;
  if (totalLines === 0) {
    if (startLine === 1) {
      const allHashes = precomputedHashes ?? (path ? await lineHashes(text, path) : await lineHashes(text));
      const emptyLineHash = allHashes[0] ?? "";
      return { text: `${emptyLineHash}${HASH_SEP}\n[File is empty. Use replace to insert content.]` };
    }
    return { text: `Offset ${startLine} is beyond end of file (0 lines total). The file is empty. Use replace to insert content.` };
  }
  if (startLine > totalLines) {
    return { text: `Offset ${startLine} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start.` };
  }

  const limit = normPosInt(options.limit, "limit");
  const endIdx = limit ? Math.min(startLine - 1 + limit, totalLines) : totalLines;
  const selected = allLines.slice(startLine - 1, endIdx);
  const allHashes = precomputedHashes ?? (path ? await lineHashes(text, path) : await lineHashes(text));
  const selectedHashes = allHashes.slice(startLine - 1, endIdx);
  const formatted = precomputedHashes?.length === 0
    ? selected.join("\n")
    : fmtRegion(selectedHashes, selected);

  const truncation = truncateHead(formatted);
  if (truncation.firstLineExceedsLimit) {
    return { text: `[Line ${startLine} exceeds ${formatSize(truncation.maxBytes!)}. Hashline output requires full lines; cannot compute hashes for a truncated preview.]`, truncation };
  }

  let preview = truncation.content;
  let nextOffset: number | undefined;
  if (truncation.truncated) {
    const endLineDisplay = startLine + truncation.outputLines - 1;
    nextOffset = endLineDisplay + 1;
    if (truncation.truncatedBy === "lines") {
      preview += `\n\n${formatPaginationHint(startLine, endLineDisplay, totalLines, nextOffset)}`;
    } else {
      preview += `\n\n${formatPaginationHint(startLine, endLineDisplay, totalLines, nextOffset, truncation.maxBytes)}`;
    }
  } else if (endIdx < totalLines) {
    nextOffset = endIdx + 1;
    preview += `\n\n${formatPaginationHint(startLine, endIdx, totalLines, nextOffset)}`;
  }

  return { text: preview, truncation: truncation.truncated ? truncation : undefined, ...(nextOffset !== undefined ? { nextOffset } : {}) };
}

const R_DESC = `Read a text file. Each line is returned as HASH\u2502content. Use the 3-char HASH to reference lines in replace calls. Output is capped at ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}; use offset=N to continue, and use write for full-file changes on files over ${MAX_HASH_LINES} lines.`;

const R_SNIPPET = "- Use read to get HASH\u2502content lines, then use replace with the 3-char hashes.";
const R_GUIDE = [
  "Use read to get HASH\u2502content for files you need to edit.",
  "Reference lines by their 3-char HASH in replace, not by line number. Line numbers are NOT part of the output.",
  "The HASH is 3 characters from the URL-safe base64 alphabet A-Za-z0-9-_ (e.g. aB3, 4yN, -qk); the content after the \u2502 separator is the line verbatim.",
  "On stale anchor errors, call read again for fresh hashes.",
  `Large files over ${MAX_HASH_LINES} lines remain readable but do not return hash anchors; use write for full-file changes.`,
  "Images (JPEG, PNG, GIF, WebP) are returned as visual attachments; binary files and directories are rejected.",
  "Empty files are returned as a single empty-line hash (HASH\u2502); use replace on that hash to insert content.",
];

export function buildReadToolDef(): any {
  return {
    name: "read",
    label: "Read",
    description: R_DESC,
    promptSnippet: R_SNIPPET,
    promptGuidelines: R_GUIDE,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to read (relative or absolute)" },
        offset: { type: "integer", minimum: 1, description: "Line number to start reading from (1-indexed)" },
        limit: { type: "integer", minimum: 1, description: "Maximum number of lines to read" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      const rawPath = readArgPath(args);
      const suffix = args?.offset !== undefined || args?.limit !== undefined
        ? theme.fg("warning", `:${args.offset ?? 1}${args.limit !== undefined ? `-${(args.offset ?? 1) + args.limit - 1}` : ""}`)
        : "";
      const header = buildCallHeader("read", theme, rawPath, context.cwd ?? ".", suffix);
      return buildShellBox(theme, header);
    },
    renderResult(result: any, options: any, theme: any, context: any) {
      const rawPath = readArgPath(context.args);
      const comp = (context.lastComponent ?? new Container()) as Container;
      comp.clear();
      if (context.isError) {
        const errText = (result.content ?? [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text || "")
          .join("\n") || "Error";
        comp.addChild(new Spacer(1));
        comp.addChild(new Text(theme.fg("error", errText), 1, 0));
        return comp;
      }
      if (!options.expanded) {
        // 折叠态：摘要行 + 正文预览前 N 行，让用户不展开也能看到实际读取内容，
        // 对齐上游 bash/grep 折叠态展示真实输出的惯例。
        const trunc = result.details?.truncation;
        const totalLines = trunc?.totalLines ?? result.details?.metrics?.totalLines ?? null;
        const outLines = result.details?.metrics?.outputLines ?? (trunc?.outputLines ?? null);
        const showPath = formatPath(rawPath ?? "<file>", context.cwd ?? ".");
        let summary: string;
        if (totalLines != null && outLines != null) {
          summary = `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", showPath)} ${theme.fg("muted", `(${outLines}/${totalLines} lines)`)}`;
        } else {
          summary = `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", showPath)}`;
        }
        if (!result.details?.hashesAvailable) {
          summary += ` ${theme.fg("warning", "(no hash anchors)")}`;
        }
        comp.addChild(new Text(summary, 1, 0));
        const body = (result.content ?? [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text || "")
          .join("\n");
        const preview = collapsePreview(theme.fg("toolOutput", body), COLLAPSED_PREVIEW_LINES, theme);
        if (preview) {
          comp.addChild(new Spacer(1));
          comp.addChild(new Text(preview, 1, 0));
        }
        return comp;
      }
      // Expanded: render the file preview text with toolOutput color.
      const body = (result.content ?? [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text || "")
        .join("\n");
      comp.addChild(new Spacer(1));
      comp.addChild(new Text(theme.fg("toolOutput", body), 1, 0));
      const trunc = result.details?.truncation;
      if (trunc?.truncated) {
        const hint = trunc.firstLineExceedsLimit
          ? `[First line exceeds ${formatSize(trunc.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`
          : trunc.truncatedBy === "lines"
            ? `[Truncated: showing ${trunc.outputLines} of ${trunc.totalLines} lines]`
            : `[Truncated: ${trunc.outputLines} lines shown (${formatSize(trunc.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`;
        comp.addChild(new Text(theme.fg("warning", hint), 1, 0));
      }
      if (!result.details?.hashesAvailable) {
        comp.addChild(new Text(theme.fg("warning", `[No hash anchors: file over ${MAX_HASH_LINES} lines; use write for full-file changes.]`), 1, 0));
      }
      return comp;
    },
    async execute(_toolCallId: string, params: ReadParams, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const rawPath = params.path;
      const absolutePath = toCwd(rawPath, ctx.cwd);
      abortIf(signal);
      await valAccess(absolutePath, rawPath);
      abortIf(signal);
      const file = await loadFileKindAndText(absolutePath);
      if (file.kind === "image") {
        // Fallback: return image as attachment reference using built-in read mechanism.
        const readResult = {
          content: [{ type: "image", source: { path: absolutePath } }],
          details: {},
        };
        return readResult as any;
      }
      const { normalized, fileHashes, hadUtf8DecodeErrors } = await readNormFile(
        rawPath, ctx.cwd, signal, undefined, file, undefined, undefined,
        { softLineLimit: MAX_HASH_LINES },
      );
      const preview = await fmtReadPreview(normalized, { offset: params.offset, limit: params.limit }, fileHashes, absolutePath);
      const snapshot = await fileSnap(absolutePath);
      const noHashes = fileHashes.length === 0;
      const canonicalPath = await resolveTarget(absolutePath);
      // Capture an in-memory snapshot for stale-anchor recovery in replace.
      // Hashline reads mint anchors; record the canonical-path content snapshot so
      // a later replace with stale anchors can replay against this read and merge.
      rememberReadSnapshot(canonicalPath, normalized);
      // A deliberate re-read clears the duplicate-payload guard for this path: the
      // model has seen the current state, so any subsequent identical payload is
      // intentional rather than a retry loop.
      clearAppliedPayload(canonicalPath);
      const totalLines = visLines(normalized).length;
      const outputLines = preview.truncation?.outputLines ?? totalLines;
      const notices = [
        ...(hadUtf8DecodeErrors ? ["[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]"] : []),
        ...(noHashes ? [`[Hashline anchors unavailable for files over ${MAX_HASH_LINES} lines; use write for full-file changes.]`] : []),
      ];
      const previewText = notices.length > 0 ? `${preview.text}\n\n${notices.join("\n")}` : preview.text;
      return {
        content: [{ type: "text", text: previewText }],
        details: {
          truncation: preview.truncation,
          snapshotId: snapshot.snapshotId,
          hashesAvailable: !noHashes,
          ...(preview.nextOffset !== undefined ? { nextOffset: preview.nextOffset } : {}),
          metrics: {
            truncated: !!preview.truncation,
            hashesAvailable: !noHashes,
            totalLines,
            outputLines,
            ...(preview.nextOffset !== undefined ? { next_offset: preview.nextOffset } : {}),
          },
        },
      };
    },
  };
}

export function regRead(pi: ExtensionAPI): void {
  pi.registerTool(buildReadToolDef());
}
