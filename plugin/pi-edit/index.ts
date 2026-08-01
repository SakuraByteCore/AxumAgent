import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initHasher } from "./src/hashline/index.js";
import { regReplace } from "./src/replace.js";
import { regRead } from "./src/read.js";
import { regGrep } from "./src/grep.js";
import { visLines } from "./src/utils.js";
import { AUTO_READ_MAX, AUTO_READ_HASH_MAX } from "./src/constants.js";
import { readConfig, toggleReplaceMode, toggleAutoRead } from "./src/config.js";
import { loadHashStore, pruneMissing } from "./src/hash-store.js";
import { readNormFile } from "./src/file-reader.js";
import { fmtReadPreview } from "./src/read.js";

export default function (pi: ExtensionAPI): void {
  regRead(pi);
  regGrep(pi);
  regReplace(pi);

  const debugValue = process.env.PI_HASHLINE_DEBUG;
  const autoReadValue = process.env.PI_HASHLINE_AUTO_READ;
  let autoRead = autoReadValue === "1" || autoReadValue === "true";

  pi.on("session_start", async (_event, ctx) => {
    // Disable the built-in edit tool so the hashline replace is authoritative.
    const active = pi.getActiveTools();
    pi.setActiveTools(active.filter((t) => t !== "edit"));
    await initHasher();
    try {
      const store = await loadHashStore();
      await pruneMissing(store);
    } catch (err) {
      console.error("Failed to load or prune hash store:", err);
    }
    const config = await readConfig();
    const mode = config.replaceMode;
    autoRead = config.autoRead;

    if (debugValue === "1" || debugValue === "true") {
      ctx.ui.notify(`Hashline Edit mode active (${mode} replace)`, "info");
    }
  });

  pi.registerCommand("toggle-replace-mode", {
    description: "Toggle replace tool between bulk (changes array) and flat (single edit at top level) mode",
    handler: async (_args, ctx) => {
      const mode = await toggleReplaceMode();
      ctx.ui.notify(`Replace mode switched to: ${mode}`, "info");
    },
  });

  pi.registerCommand("toggle-auto-read", {
    description: "Toggle automatic hashline anchors after write and replace operations",
    handler: async (_args, ctx) => {
      autoRead = await toggleAutoRead();
      const state = autoRead ? "enabled" : "disabled";
      ctx.ui.notify(`Auto-read after write/replace: ${state}`, "info");
    },
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!autoRead) return;
    if (event.isError) return;
    if (event.toolName !== "write" && event.toolName !== "replace") return;
    const filePath = (event.input as Record<string, unknown>)?.path;
    if (typeof filePath !== "string") return;
    try {
      const { normalized, fileHashes, absolutePath } = await readNormFile(
        filePath, ctx.cwd, undefined, undefined, undefined, undefined, undefined,
        { softLineLimit: AUTO_READ_HASH_MAX },
      );
      if (visLines(normalized).length === 0) return;
      if (fileHashes.length === 0) {
        const lineCount = visLines(normalized).length;
        return {
          content: [
            ...(event.content ?? []),
            {
              type: "text",
              text: `\n\n--- Auto-read skipped ---\nFile has ${lineCount} lines (exceeds ${AUTO_READ_HASH_MAX}-line auto-read hash limit). Write/replace succeeded; auto-read skipped to avoid full-file hashing.`,
            },
          ],
        };
      }
      const preview = await fmtReadPreview(normalized, { limit: AUTO_READ_MAX }, fileHashes, absolutePath);
      return {
        content: [
          ...(event.content ?? []),
          { type: "text", text: `\n\n--- Auto-read (hashline anchors) ---\n${preview.text}` },
        ],
      };
    } catch (error) {
      console.error("Auto-read after write/replace failed:", error);
    }
  });
}
