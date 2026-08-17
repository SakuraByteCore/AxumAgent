import { readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { abortIf } from "./utils.js";
import { loadHashStore } from "./hash-store.js";
import { writeAtomic } from "./fs-write.js";
import { toCwd } from "./paths.js";

// --- Types mirroring openai/codex apply_patch format ---
export type PatchHunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; movePath?: string; chunks: PatchChunk[]; isEndOfFile: boolean };

export interface PatchChunk {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  contextLineIndices: [number, number][];
  isEndOfFile: boolean;
}

export interface ParsedPatch {
  hunks: PatchHunk[];
  patch: string;
  environmentId?: string;
}

// --- Parser ---
const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const EOF = "*** End of File";
const CHANGE_CONTEXT_PREFIX = "@@ ";
const EMPTY_CONTEXT_PREFIX = "@@";

function parsePatch(text: string): ParsedPatch {
  const rawLines = text.trim().split("\n");
  if (rawLines.length === 0 || rawLines[0]!.trim() !== BEGIN_PATCH) {
    throw new Error("[E_PATCH] The first line of the patch must be '*** Begin Patch'");
  }
  let environmentId: string | undefined;
  const hunks: PatchHunk[] = [];
  let i = 1;
  if (i < rawLines.length && rawLines[i]!.startsWith("*** Environment ID: ")) {
    const candidate = rawLines[i]!.slice("*** Environment ID: ".length).trim();
    if (!candidate) throw new Error("apply_patch environment_id cannot be empty");
    environmentId = candidate;
    i++;
  }
  while (i < rawLines.length) {
    const line = rawLines[i]!;
    if (line.trim() === END_PATCH) break;
    if (line.startsWith(ADD_FILE)) {
      const path = line.slice(ADD_FILE.length).trim();
      i++;
      const contentLines: string[] = [];
      while (i < rawLines.length && !rawLines[i]!.match(/^\*\*\*/)) {
        const cl = rawLines[i]!;
        if (cl.startsWith("+")) contentLines.push(cl.slice(1));
        else contentLines.push(cl);
        i++;
      }
      hunks.push({ type: "add", path, contents: contentLines.join("\n") + "\n" });
    } else if (line.startsWith(DELETE_FILE)) {
      const path = line.slice(DELETE_FILE.length).trim();
      i++;
      hunks.push({ type: "delete", path });
    } else if (line.startsWith(UPDATE_FILE)) {
      const path = line.slice(UPDATE_FILE.length).trim();
      i++;
      let movePath: string | undefined;
      if (i < rawLines.length && rawLines[i]!.startsWith(MOVE_TO)) {
        movePath = rawLines[i]!.slice(MOVE_TO.length).trim();
        i++;
      }
      const chunks: PatchChunk[] = [];
      let isEndOfFile = false;
      while (i < rawLines.length && !rawLines[i]!.match(/^\*\*\*/)) {
        let changeContext: string | undefined;
        if (rawLines[i]!.startsWith(CHANGE_CONTEXT_PREFIX)) {
          changeContext = rawLines[i]!.slice(CHANGE_CONTEXT_PREFIX.length).trim();
          i++;
        } else if (rawLines[i]!.startsWith(EMPTY_CONTEXT_PREFIX)) {
          changeContext = "";
          i++;
        }
        if (!changeContext && i < rawLines.length && !rawLines[i]!.match(/^[\+\- ]/)) {
          break;
        }
        const oldLines: string[] = [];
        const newLines: string[] = [];
        const contextLineIndices: [number, number][] = [];
        while (i < rawLines.length && rawLines[i]!.match(/^[\+\- ]/)) {
          const raw = rawLines[i]!;
          const prefix = raw[0]!;
          const content = raw.slice(1);
          if (prefix === " ") {
            contextLineIndices.push([oldLines.length, newLines.length]);
            oldLines.push(content);
            newLines.push(content);
          } else if (prefix === "-") {
            oldLines.push(content);
          } else if (prefix === "+") {
            newLines.push(content);
          }
          i++;
        }
        if (i < rawLines.length && rawLines[i]!.trim() === EOF) {
          isEndOfFile = true;
          i++;
        }
        chunks.push({
          changeContext,
          oldLines,
          newLines,
          contextLineIndices,
          isEndOfFile,
        });
      }
      hunks.push({ type: "update", path, movePath, chunks, isEndOfFile });
    } else {
      i++;
    }
  }
  return { hunks, patch: text.trim(), environmentId };
}

// --- Applier ---
async function applyAdd(hunk: Extract<PatchHunk, { type: "add" }>, cwd: string): Promise<void> {
  const absolutePath = toCwd(hunk.path, cwd);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, hunk.contents, "utf-8");
}

async function applyDelete(hunk: Extract<PatchHunk, { type: "delete" }>, cwd: string): Promise<void> {
  const absolutePath = toCwd(hunk.path, cwd);
  await rm(absolutePath, { force: true });
}

async function applyUpdate(hunk: Extract<PatchHunk, { type: "update" }>, cwd: string): Promise<void> {
  const absolutePath = toCwd(hunk.path, cwd);
  let content = await readFile(absolutePath, "utf-8");
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.push("");

  for (const chunk of hunk.chunks) {
    const searchKeys = chunk.changeContext ? [chunk.changeContext, ...chunk.oldLines] : [...chunk.oldLines];
    const replaceWith = chunk.changeContext ? [chunk.changeContext, ...chunk.newLines] : [...chunk.newLines];

    const searchStr = searchKeys.join("\n");
    const replaceStr = replaceWith.join("\n");

    if (chunk.isEndOfFile) {
      const idx = content.lastIndexOf(searchStr);
      if (idx === -1 || idx + searchStr.length !== content.length) {
        // Not found or not at end: append
        if (content.length > 0 && !content.endsWith("\n")) content += "\n";
        content += replaceStr;
        if (!content.endsWith("\n")) content += "\n";
      } else {
        content = content.slice(0, idx) + replaceStr;
      }
    } else {
      const idx = content.indexOf(searchStr);
      if (idx === -1) {
        throw new Error(`[E_PATCH_NOT_FOUND] Could not find patch context in ${hunk.path}: "${searchKeys[0]}"`);
      }
      content = content.slice(0, idx) + replaceStr + content.slice(idx + searchStr.length);
    }
  }

  await writeAtomic(absolutePath, content.replace(/\n$/, "") + "\n");
}

// --- Tool ---
export function regApplyPatch(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "apply_patch",
    label: "ApplyPatch",
    description: `Apply a codex-style patch to files.\n\nFormat:\n\`\`\`\n*** Begin Patch\n*** Add File: <path>\n+<content>\n*** Delete File: <path>\n*** Update File: <path>\n@@ <context>\n <context_line>\n-<old_line>\n+<new_line>\n*** End Patch\n\`\`\`\n\nRules:\n- Paths are relative to \`cwd\` unless absolute.\n- \+ lines create/add content; \- lines delete; \\ lines are context.\n- @@ starts a change context.\n- \\*\\*\\* End of File appends at EOF.\n- Supports \\*\\*\\* Move to: for renames.`,
    parameters: {
      type: "object",
      properties: {
        patch: { type: "string", description: "Patch text in codex apply_patch format." },
      },
      required: ["patch"],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      abortIf(signal);
      const patchText = typeof params?.patch === "string" ? params.patch : "";
      if (!patchText.trim()) throw new Error("[E_BAD_SHAPE] apply_patch requires a non-empty 'patch' string.");
      const parsed = parsePatch(patchText);
      const cwd = ctx.cwd;
      for (const hunk of parsed.hunks) {
        abortIf(signal);
        if (hunk.type === "add") await applyAdd(hunk, cwd);
        else if (hunk.type === "delete") await applyDelete(hunk, cwd);
        else if (hunk.type === "update") await applyUpdate(hunk, cwd);
        if (hunk.type === "update" && hunk.movePath) {
          const src = toCwd(hunk.path, cwd);
          const dst = toCwd(hunk.movePath, cwd);
          await mkdir(dirname(dst), { recursive: true });
          await writeAtomic(dst, await readFile(src, "utf-8"));
          await rm(src, { force: true });
        }
      }
      return {
        content: [{ type: "text", text: `Applied ${parsed.hunks.length} hunk(s).${parsed.environmentId ? ` Environment ID: ${parsed.environmentId}` : ""}` }],
        details: { hunks: parsed.hunks },
      };
    },
  });
}