// Adapted from pi-hashline-edit@0.8.3 (src/grep.ts) by RimuruW and ported to the
// local pi-edit fork: pure-JS module wiring (no @sinclair/typebox), native
// JSON-schema parameters, local anchors (`HASH│content` via fmtRegion), and the
// local helper names (toLF/stripBOM/resolveTarget/toCwd/abortIf/loadFileKindAndText).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, Container, Spacer } from "@earendil-works/pi-tui";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { toLF, stripBOM } from "./replace-diff.js";
import { resolveTarget } from "./fs-write.js";
import { loadFileKindAndText } from "./file-kind.js";
import { toCwd } from "./paths.js";
import { fmtRegion, _lineHashesPure } from "./hashline/index.js";
import { rememberReadSnapshot } from "./read-snapshot.js";
import { abortIf } from "./utils.js";
import { buildCallHeader, buildShellBox } from "./render.js";

const GREP_DESC = [
  "Search files using ripgrep. Each matched line is returned as `HASH│content` — copy the 3-char HASH verbatim into a replace call without a prior read (anchors from grep are interchangeable with anchors from read).",
  "",
  "`pattern` is a regular expression unless `literal: true` is set. Results respect `.gitignore` by default (ripgrep's default). Use `path` to scope to a file or directory; use `glob` to filter by filename pattern (e.g. `\"**/*.ts\"`).",
  "",
  "Set `context` (0–5) to include surrounding lines around each match. Set `limit` to cap matched lines (default 50, max 200). When results are too broad, narrow in this order: check the match count, then scope with `path`/`glob`, then tighten `pattern`, and only add `context` once the set is small.",
].join("\n");

const GREP_SNIPPET = "- Use grep to find lines; results carry HASH│content anchors usable directly in replace without a prior read";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const STDERR_MAX_BYTES = 64 * 1024;

// Exported so tests can inspect/stub the binary name without mocking child_process.
export const RG_BIN = "rg";

/** Detect whether ripgrep is available on PATH. Only called at registration time. */
function isRgAvailable(): boolean {
  try {
    const result = spawnSync(RG_BIN, ["--version"], { encoding: "utf-8" });
    return result.error === undefined && result.status === 0;
  } catch {
    return false;
  }
}

interface RgMatchEvent {
  type: "match";
  data: { path: { text: string }; line_number: number };
}

interface RgEvent {
  type: string;
  data: unknown;
}

interface LineRange {
  start: number;
  end: number;
}

/** Merge a new range into an existing sorted, non-overlapping list. */
function mergeRange(ranges: LineRange[], range: LineRange): void {
  let merged = range;
  const remaining: LineRange[] = [];
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

interface RgSearchResult {
  matchesByFile: Map<string, number[]>;
  matches: number;
  truncated: boolean;
}

function addMatch(matchesByFile: Map<string, number[]>, filePath: string, lineNum: number): void {
  if (!matchesByFile.has(filePath)) matchesByFile.set(filePath, []);
  matchesByFile.get(filePath)!.push(lineNum);
}

function parseMatchLine(line: string): { filePath: string; lineNum: number } | null {
  if (!line.trim()) return null;
  let event: RgEvent;
  try {
    event = JSON.parse(line) as RgEvent;
  } catch {
    return null;
  }
  if (event.type !== "match") return null;
  const matchEvent = event as RgMatchEvent;
  return { filePath: matchEvent.data.path.text, lineNum: matchEvent.data.line_number };
}

function appendLimitedStderr(current: string, chunk: string): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, "utf8") <= STDERR_MAX_BYTES) return combined;
  return Buffer.from(combined, "utf8").subarray(0, STDERR_MAX_BYTES).toString("utf8");
}

/**
 * Run rg asynchronously, returning at most `limit` match events. Honors AbortSignal
 * by killing the child process. The limit is process-level: we mark truncated
 * after seeing match number limit + 1, then kill rg and resolve with the first
 * `limit` matches.
 *
 * rg exit codes: 0 = matches found, 1 = no matches, 2 = error.
 */
function runRg(args: string[], limit: number, signal: AbortSignal | undefined): Promise<RgSearchResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const child = spawn(RG_BIN, args);
    const rl = createInterface({ input: child.stdout });
    const matchesByFile = new Map<string, number[]>();
    let totalMatched = 0;
    let truncated = false;
    let stoppedByLimit = false;
    let settled = false;
    let stderr = "";

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    const settleResolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ matchesByFile, matches: totalMatched, truncated });
    };
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rl.close();
      reject(error);
    };
    const stopForLimit = () => {
      if (stoppedByLimit) return;
      truncated = true;
      stoppedByLimit = true;
      cleanup();
      rl.close();
      child.kill();
    };

    // setEncoding lets Node's stream decoder handle multi-byte UTF-8 sequences
    // spanning chunk boundaries correctly (spawn's options.encoding is an exec
    // parameter and has no effect here, so set it on the streams directly).
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");

    rl.on("line", (line: string) => {
      if (settled || stoppedByLimit) return;
      const match = parseMatchLine(line);
      if (!match) return;
      if (totalMatched >= limit) {
        stopForLimit();
        return;
      }
      addMatch(matchesByFile, match.filePath, match.lineNum);
      totalMatched++;
    });

    child.stderr.on("data", (chunk: string) => {
      stderr = appendLimitedStderr(stderr, chunk);
    });

    const onAbort = () => {
      child.kill();
      settleReject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err: Error) => {
      if (stoppedByLimit) return;
      settleReject(new Error(`ripgrep spawn error: ${err.message}`));
    });

    child.on("close", (code: number | null) => {
      if (settled) return;
      if (stoppedByLimit) {
        settleResolve();
        return;
      }
      if (signal?.aborted) {
        settleReject(new Error("Aborted"));
        return;
      }
      if (code === null) {
        settleReject(new Error("ripgrep process terminated unexpectedly"));
        return;
      }
      if (code === 2) {
        settleReject(new Error(`ripgrep error: ${stderr.trim() || "unknown error"}`));
        return;
      }
      // code 0 (matches) and 1 (no matches) are both success from our perspective.
      settleResolve();
    });
  });
}

/** Format a contiguous line range [start, end] as `HASH│content` lines (local read format). */
function formatHashlineRegion(fileLines: string[], hashes: string[], startLine: number, endLine: number): string {
  const selected = fileLines.slice(startLine - 1, endLine);
  const selectedHashes = hashes.slice(startLine - 1, endLine);
  return fmtRegion(selectedHashes, selected);
}

export function buildGrepToolDef(): any {
  return {
    name: "grep",
    label: "Grep",
    description: GREP_DESC,
    promptSnippet: GREP_SNIPPET,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search pattern (regex unless literal: true)" },
        path: { type: "string", description: "File or directory to search (defaults to cwd)" },
        glob: { type: "string", description: 'Filename glob filter, e.g. "**/*.ts"' },
        ignoreCase: { type: "boolean", description: "Case-insensitive matching" },
        literal: { type: "boolean", description: "Treat pattern as a literal string, not a regex" },
        context: { type: "integer", minimum: 0, maximum: 5, description: "Number of context lines to show around each match (0–5, default 0)" },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `Maximum matched lines to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    renderShell: "self",
    renderCall(args: any, theme: any, context: any) {
      const rawPath = args?.path ? String(args.path) : "";
      const suffix = rawPath ? theme.fg("warning", rawPath) : "";
      const header = buildCallHeader("grep", theme, args?.pattern ?? "", context.cwd ?? ".", suffix);
      return buildShellBox(theme, header);
    },
    renderResult(result: any, _options: any, theme: any, context: any) {
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
      const text = (result.content ?? [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text || "")
        .join("\n");
      comp.addChild(new Spacer(1));
      comp.addChild(new Text(text, 1, 0));
      return comp;
    },
    async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      abortIf(signal);

      const searchPath = params.path ? toCwd(params.path, ctx.cwd) : ctx.cwd;
      const limit = params.limit ?? DEFAULT_LIMIT;
      const contextLines = params.context ?? 0;

      // Build rg args.
      const rgArgs: string[] = ["--json"];
      if (params.ignoreCase) rgArgs.push("--ignore-case");
      if (params.literal) rgArgs.push("--fixed-strings");
      if (params.glob) rgArgs.push("--glob", params.glob);
      rgArgs.push("--", params.pattern, searchPath);

      const { matchesByFile, matches: totalMatched, truncated } = await runRg(rgArgs, limit, signal);
      abortIf(signal);

      if (totalMatched === 0) {
        return {
          content: [{ type: "text", text: `No matches found for ${params.pattern}.` }],
          details: { matches: 0, files: 0, truncated: false },
        };
      }

      abortIf(signal);

      const outputParts: string[] = [];
      let fileCount = 0;

      for (const [filePath, matchLines] of matchesByFile) {
        abortIf(signal);

        // Load file to compute context-correct hashes for the local HASH│content format.
        let fileLines: string[];
        let hashes: string[];
        try {
          const loaded = await loadFileKindAndText(filePath);
          if (loaded.kind === "binary" || loaded.kind === "image" || loaded.kind === "directory") continue;
          const normalized = toLF(stripBOM(loaded.text).text);
          fileLines = normalized.split("\n");
          // Strip the trailing empty element from a terminal newline.
          if (fileLines.length > 0 && fileLines[fileLines.length - 1] === "") {
            fileLines = fileLines.slice(0, -1);
          }
          hashes = _lineHashesPure(normalized);

          // Record a memory snapshot so replace's stale-anchor recovery and
          // duplicate-edit guard work identically whether anchors came from read
          // or grep. Uses the same canonical path convention as read.ts.
          const canonicalWritePath = await resolveTarget(filePath);
          rememberReadSnapshot(canonicalWritePath, normalized);
        } catch {
          continue;
        }

        const totalFileLines = fileLines.length;

        // Guard against a race where the file was truncated between rg reading it
        // and our loadFileKindAndText call: out-of-bounds line numbers would make
        // formatHashlineRegion slice past the end; filter them out first.
        const validMatchLines = matchLines.filter((n) => n <= totalFileLines);
        if (validMatchLines.length === 0) continue;

        // Build merged context ranges for this file.
        const ranges: LineRange[] = [];
        for (const lineNum of validMatchLines) {
          const start = Math.max(1, lineNum - contextLines);
          const end = Math.min(totalFileLines, lineNum + contextLines);
          mergeRange(ranges, { start, end });
        }

        fileCount++;

        // Relative path for display.
        const displayPath = filePath.startsWith(ctx.cwd + "/") ? filePath.slice(ctx.cwd.length + 1) : filePath;

        outputParts.push(`${displayPath}:`);

        let prevRangeEnd = -1;
        for (const range of ranges) {
          if (prevRangeEnd !== -1) outputParts.push("    ...");
          outputParts.push(formatHashlineRegion(fileLines!, hashes!, range.start, range.end));
          prevRangeEnd = range.end;
        }

        outputParts.push("---");
      }

      const summary = `${totalMatched} match${totalMatched !== 1 ? "es" : ""} in ${fileCount} file${fileCount !== 1 ? "s" : ""}.${truncated ? ` (truncated at ${limit})` : ""}`;
      outputParts.push(summary);

      return {
        content: [{ type: "text", text: outputParts.join("\n") }],
        details: { matches: totalMatched, files: fileCount, truncated },
      };
    },
  };
}

export function regGrep(pi: ExtensionAPI): void {
  if (!isRgAvailable()) return;
  pi.registerTool(buildGrepToolDef());
}
