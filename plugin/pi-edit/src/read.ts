import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadFileKindAndText } from "./file-kind.js";
import { readNormFile, fileSnap } from "./file-reader.js";
import { lineHashes, fmtRegion, HASH_SEP } from "./hashline/index.js";
import { toCwd } from "./paths.js";
import { abortIf } from "./utils.js";
import { visLines } from "./utils.js";
import { valAccess } from "./validation.js";
import { loadP, loadGuide } from "./prompts.js";

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
  const formatted = fmtRegion(selectedHashes, selected);

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

const R_DESC = `Read a text file. Each line is returned as HASH\u2502content.

Key rule: line numbers are NOT part of the output. Use the 3-char HASH to reference lines in replace calls.

HASH format:
- The HASH is 3 characters from the URL-safe base64 alphabet A-Za-z0-9-_ (e.g. aB3, 4yN, -qk).
- The content after the \u2502 separator is the line verbatim.

Pagination:
- Large files return a truncated preview with a pagination hint. Call read again with offset=N to continue.
- Default cap: ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.

File kinds:
- Text files are returned as HASH\u2502content lines.
- Images (JPEG, PNG, GIF, WebP) are returned as visual attachments.
- Binary files and directories are rejected.
- Empty files are returned as a single empty-line hash (HASH\u2502). Use replace on that hash to insert content.`;

const R_SNIPPET = "- Use read to get HASH\u2502content lines, then use replace with the 3-char hashes.";
const R_GUIDE = [
  "- Use read to get HASH\u2502content for files you need to edit.",
  "- Reference lines by their 3-char HASH in replace, not by line number.",
  "- On stale anchor errors, call read again for fresh hashes.",
];

export function regRead(pi: ExtensionAPI): void {
  pi.registerTool({
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
    async execute(_toolCallId, params: ReadParams, signal, _onUpdate, ctx) {
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
      const { normalized, fileHashes, hadUtf8DecodeErrors } = await readNormFile(rawPath, ctx.cwd, signal, undefined, file);
      const preview = await fmtReadPreview(normalized, { offset: params.offset, limit: params.limit }, fileHashes, absolutePath);
      const snapshot = await fileSnap(absolutePath);
      const previewText = hadUtf8DecodeErrors
        ? `${preview.text}\n\n[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]`
        : preview.text;
      return {
        content: [{ type: "text", text: previewText }],
        details: {
          truncation: preview.truncation,
          snapshotId: snapshot.snapshotId,
          ...(preview.nextOffset !== undefined ? { nextOffset: preview.nextOffset } : {}),
          metrics: { truncated: !!preview.truncation, ...(preview.nextOffset !== undefined ? { next_offset: preview.nextOffset } : {}) },
        },
      };
    },
  });
}
