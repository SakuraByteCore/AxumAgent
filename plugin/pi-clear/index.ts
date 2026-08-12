// pi-clear
//
// Clear-session slash command for pi-coding-agent.
// `/clear` deletes the current session's conversation file from disk and
// starts a fresh, empty session in one step. This mirrors the goal-style
// slash-command pattern (like pi-goal's `/goal`) so it feels native to users
// who already use Pi extensions.
//
// Design notes:
//   - The current session file path is obtained from ctx.sessionManager via
//     getSessionFile(), which returns the absolute .jsonl path (or undefined
//     for in-memory sessions). We capture it *before* calling newSession(),
//     because newSession() replaces the active session and invalidates the
//     old ctx.
//   - Per Pi's extension contract, after ctx.newSession() the old ctx is
//     stale. All post-replacement work (file deletion + user notification)
//     must run inside the withSession callback, which receives a fresh
//     ReplacedSessionContext bound to the new session.
//   - Path safety: getSessionFile() returns an absolute path under the
//     sessions directory; we additionally verify it looks like a .jsonl file
//     before unlinking, as a defense-in-depth measure.
//   - In non-interactive modes (rpc/json/print) ctx.ui.confirm may not be
//     available; we skip confirmation there and proceed directly, matching
//     the behavior of other slash commands.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, unlinkSync } from "node:fs";
import { extname } from "node:path";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("clear", {
    description: "Delete the current conversation session and start a fresh one",
    getArgumentCompletions: () => null,
    async handler(_args: string, ctx) {
      const sessionFile = ctx.sessionManager.getSessionFile();

      if (!sessionFile) {
        if (ctx.hasUI) {
          await ctx.ui.confirm("Clear session", "Current session is in-memory (no file to delete). Start a new session?");
        }
        const result = await ctx.newSession({
          withSession: (newCtx) => {
            newCtx.ui.notify("Started a fresh session (in-memory, no file was deleted).", "info");
          },
        });
        if (result.cancelled) {
          ctx.ui.notify("New session cancelled.", "info");
        }
        return;
      }

      if (extname(sessionFile) !== ".jsonl") {
        ctx.ui.notify(`Refusing to delete: session file is not .jsonl (${sessionFile}).`, "error");
        return;
      }

      let confirmed = true;
      if (ctx.hasUI) {
        confirmed = await ctx.ui.confirm(
          "Clear session",
          "This will permanently delete the current conversation file and start a new session. Continue?",
        );
      }

      if (!confirmed) {
        ctx.ui.notify("Clear cancelled.", "info");
        return;
      }

      const fileToDelete = sessionFile;
      const result = await ctx.newSession({
        withSession: (newCtx) => {
          try {
            if (existsSync(fileToDelete)) {
              unlinkSync(fileToDelete);
              newCtx.ui.notify("Current session deleted. Started a fresh session.", "info");
            } else {
              newCtx.ui.notify("Fresh session started (old file already gone).", "info");
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            newCtx.ui.notify(`Started new session, but failed to delete old file: ${message}`, "warning");
          }
        },
      });

      if (result.cancelled) {
        ctx.ui.notify("New session cancelled; old session preserved.", "warning");
      }
    },
  });
}
