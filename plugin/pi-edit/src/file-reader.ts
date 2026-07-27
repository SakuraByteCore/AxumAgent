import { constants } from "fs";
import { stat } from "fs/promises";
import { lineHashes } from "./hashline/index.js";
import { loadFileKindAndText, type LFile } from "./file-kind.js";
import { resolveTarget } from "./fs-write.js";
import { toCwd } from "./paths.js";
import { toLF, stripBOM, detectEnding } from "./replace-diff.js";
import { abortIf } from "./utils.js";
import { valKind, valAccess } from "./validation.js";
import { visLines } from "./utils.js";
import type { HashStore } from "./hash-store.js";

export interface NormFile {
  absolutePath: string;
  normalized: string;
  bom: string;
  originalEnding: "\r\n" | "\n";
  fileHashes: string[];
  hadUtf8DecodeErrors: boolean;
}

export type SnapInfo = { snapshotId: string; mtimeMs: number; size: number };

function fmtSnapId(canonicalPath: string, info: { mtimeMs: number; size: number }): string {
  return `v1|${canonicalPath}|${info.mtimeMs}|${info.size}`;
}

export async function fileSnap(absolutePath: string): Promise<SnapInfo> {
  const canonicalPath = await resolveTarget(absolutePath);
  const stats = await stat(canonicalPath);
  return { snapshotId: fmtSnapId(canonicalPath, stats), mtimeMs: stats.mtimeMs, size: stats.size };
}

export async function readNormFile(
  path: string,
  cwd: string,
  signal: AbortSignal | undefined,
  accessMode: number = constants.R_OK,
  preloadedFile?: LFile,
  maxLines?: number,
  store?: HashStore,
): Promise<NormFile> {
  const absolutePath = toCwd(path, cwd);
  const resolvedPath = await resolveTarget(absolutePath);
  abortIf(signal);
  await valAccess(resolvedPath, path, accessMode);
  abortIf(signal);
  const file = preloadedFile ?? (await loadFileKindAndText(resolvedPath));
  valKind(file, path);
  abortIf(signal);
  const { bom, text: rawContent } = stripBOM(file.text);
  const originalEnding = detectEnding(rawContent);
  const normalized = toLF(rawContent);
  if (maxLines !== undefined) {
    const lineCount = visLines(normalized).length;
    if (lineCount > maxLines) {
      throw new Error(
        `[E_FILE_TOO_LARGE] ${path} has ${lineCount} lines, exceeding the ${maxLines}-line edit limit.`
      );
    }
  }
  const fileHashes = await lineHashes(normalized, resolvedPath, undefined, store);
  return {
    absolutePath: resolvedPath,
    normalized,
    bom,
    originalEnding,
    fileHashes,
    hadUtf8DecodeErrors: file.hadUtf8DecodeErrors === true,
  };
}
