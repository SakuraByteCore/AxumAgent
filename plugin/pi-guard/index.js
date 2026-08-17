/**
 * pi-guard
 *
 * Read-only advisory watcher that posts inline guidance notes during primary
 * sessions. Filters noise, dedupes repeats, and rate-limits advice delivery.
 * Pure JS, zero native deps. No association with any upstream project.
 *
 * Contract (mirrors pi-bar event surface):
 *   - pi.events.on("pi-guard:advice", (note, severity) => { ... })
 *     -> primary agent delivers to user as <advisory> in transcript.
 *   - pi.on("tool_call"/"tool_result") -> inspect primary activity, decide.
 *   - pi.on("turn_start"/"turn_end") -> gate per-update budget.
 */

const ESC = "\x1b[0m";

// ---------------------------------------------------------------------------
// Emission guard (ported from advisor emission-guard pattern, plain JS)
// ---------------------------------------------------------------------------

function normalizeAdvisorNote(note) {
  if (typeof note !== "string") return "";
  return note
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const SUPPRESSED_NORMALIZED_PHRASES = new Set([
  "stop",
  "stop here",
  "stop now",
  "halt",
  "abort",
  "done",
  "task done",
  "task complete",
  "complete",
  "finished",
  "ok",
  "okay",
  "ok done",
  "no issue",
  "no issues",
  "no issue continue",
  "no concerns",
  "no concern",
  "nothing to add",
  "nothing to flag",
  "nothing to report",
  "no notes",
  "no further input",
  "no further input needed",
  "no further input required",
  "no further watcher input",
  "no further watcher input needed",
  "no further advice",
  "no further advice needed",
  "lgtm",
  "looks good",
  "all good",
  "agent is on track",
  "agent on track",
  "on track",
  "continue",
  "carry on",
]);

const DEFAULT_HISTORY_CAPACITY = 4096;

class EmissionGuard {
  constructor(opts = {}) {
    this.capacity = opts.capacity ?? DEFAULT_HISTORY_CAPACITY;
    this.seen = new Set();
    this.seenOrder = [];
    this.consumedThisUpdate = false;
  }

  reset() {
    this.seen.clear();
    this.seenOrder.length = 0;
    this.consumedThisUpdate = false;
  }

  beginUpdate() {
    this.consumedThisUpdate = false;
  }

  accept(note) {
    const key = normalizeAdvisorNote(note);
    if (!key) return false;
    if (SUPPRESSED_NORMALIZED_PHRASES.has(key)) return false;
    if (this.seen.has(key)) return false;
    if (this.consumedThisUpdate) return false;
    this.consumedThisUpdate = true;
    this.seen.add(key);
    this.seenOrder.push(key);
    if (this.seenOrder.length > this.capacity) {
      const stale = this.seenOrder.shift();
      if (stale !== undefined) this.seen.delete(stale);
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Watcher heuristic: lightweight read-only analysis
// ---------------------------------------------------------------------------

function inspectToolCall(event) {
  const input = event.input || {};
  const command = typeof input === "string" ? input : input.command;
  if (typeof command !== "string") return null;

  // Flag rm -rf / on obvious destructive patterns (nit-level, since user
  // might genuinely want nuclear cleanup).
  if (/\brm\s+-rf\s+\//.test(command)) {
    return {
      note: "`rm -rf /...` looks dangerous. Double-check the path.",
      severity: "concern",
    };
  }

  // Flag chmod -R 777 as a code-smell.
  if (/\bchmod\s+-R\s+777\b/.test(command)) {
    return {
      note: "Consider narrower permissions than 777.",
      severity: "nit",
    };
  }

  // Suggest dry-run for unknown mass-mutation commands.
  if (
    /\b(fuser|kill)\s+-9\b/.test(command) ||
    /\bdd\b/.test(command) ||
    /\bmkfs\b/.test(command)
  ) {
    return {
      note: "Mass-mutation command detected. Dry-run first if possible.",
      severity: "concern",
    };
  }

  // Warn on push --force without refspec.
  if (/\bgit\s+push\s+--force\b/.test(command) && !/--force-with-lease/.test(command)) {
    return {
      note: "Prefer `git push --force-with-lease` over `--force`.",
      severity: "nit",
    };
  }

  return null;
}

function inspectToolResult(event) {
  if (!event.isError) return null;
  const details = event.details;
  if (details && typeof details === "object" && details.signal === "SIGKILL") {
    return {
      note: "Process killed (SIGKILL). Check OOM or infinite loop.",
      severity: "blocker",
    };
  }
  if (details && typeof details === "object" && details.code === "ENOSPC") {
    return {
      note: "Disk full (ENOSPC). Free space before retrying.",
      severity: "blocker",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi) {
  const guard = new EmissionGuard();

  // Per-update budget cleared at turn boundaries.
  pi.on("turn_start", async () => {
    guard.beginUpdate();
  });

  pi.on("turn_end", async () => {
    guard.beginUpdate();
  });

  // Inspect tool_call for dangerous command patterns.
  pi.on("tool_call", async (event) => {
    const advice = inspectToolCall(event);
    if (!advice) return;
    if (!guard.accept(advice.note)) return;
    pi.events.emit("pi-guard:advice", advice.note, advice.severity);
  });

  // Inspect tool_result for fatal errors.
  pi.on("tool_result", async (event) => {
    const advice = inspectToolResult(event);
    if (!advice) return;
    if (!guard.accept(advice.note)) return;
    pi.events.emit("pi-guard:advice", advice.note, advice.severity);
  });

  // On session reset, clear dedupe state so a fresh run can re-raise old
  // concerns without tripping the history filter.
  pi.on("session_shutdown", async () => {
    guard.reset();
  });
}