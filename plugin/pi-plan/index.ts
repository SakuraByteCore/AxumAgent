// pi-plan
//
// Relentless interview for pi-coding-agent: the agent sharpens a plan or design
// by questioning it with pointed follow-up questions.
//
//   /plan <subject>    Start a session: the agent switches into a relentless
//                       interviewer and sharpens the subject by questioning.
//   /plan stop          Stop the active session and clear the guard.
//   /plan status        Show whether a session is active.
//
// "Relentless" means the agent attacks the subject with pointed follow-up
// questions one at a time and never stops on its own — only the user can stop
// it with /plan stop. A before_agent_start guard block primes the model for
// this role every turn, and a turn_end probe re-injects a steer message when
// the agent drifts out of the asking posture (e.g. answers instead of asking,
// or wraps up).
//
// Hot-path design:
//  - State is a single per-session object (the active subject string); no
//    persistence, no fs, no external deps.
//  - before_agent_start is the only prompt mutation point; turn_end only
//    reads the last assistant message and may queue one steer.
//  - The probe is a single cheap regex; non-asking turns cost one match.

export default function planExtension(pi: ExtensionAPI): void {
  // The active plan subject, or undefined when idle.
  let activeSubject: string | undefined;

  // Latch: once a corrective steer is queued for this turn, suppress repeats
  // until the next turn starts so a model that keeps drifting is not spammed.
  let suppressSteerUntilNextTurn = false;

  // Cap consecutive steer injections so a model that refuses to ask questions
  // does not loop forever — after the cap, the session needs user input.
  const MAX_CONSECUTIVE_STEERS = 3;
  let consecutiveSteeredTurns = 0;

  pi.on("turn_start", () => {
    suppressSteerUntilNextTurn = false;
  });

  pi.on("before_agent_start", (event) => {
    if (!activeSubject) return event.systemPrompt;
    return {
      systemPrompt: withPlanGuard(event.systemPrompt, activeSubject),
    };
  });

  pi.on("turn_end", (event) => {
    if (!activeSubject) return;
    const text = extractAssistantText(event.message);
    if (!text) return;

    if (isAsking(text)) {
      consecutiveSteeredTurns = 0;
      return;
    }

    if (suppressSteerUntilNextTurn) return;
    if (consecutiveSteeredTurns >= MAX_CONSECUTIVE_STEERS) return;

    consecutiveSteeredTurns += 1;
    suppressSteerUntilNextTurn = true;
    pi.sendUserMessage(PLAN_STEER, { deliverAs: "steer" });
  });

  pi.registerCommand("plan", {
    description: "Relentless interview to sharpen a plan or design",
    getArgumentCompletions: (argumentPrefix) => {
      const prefix = argumentPrefix.trimStart();
      const items = [
        { value: "stop", label: "stop", description: "Stop the active plan session" },
        { value: "status", label: "status", description: "Show whether a plan session is active" },
      ];
      if (prefix === "") return items;
      if (/\s/.test(prefix)) return null;
      const matches = items.filter((item) => item.value.startsWith(prefix) || item.label.startsWith(prefix));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      if (trimmed === "stop" || trimmed === "end" || trimmed === "quit") {
        return stopPlan(ctx);
      }
      if (trimmed === "status") {
        return showStatus(ctx);
      }

      const subject = trimmed;
      if (!subject) {
        ctx.ui.notify("Usage: /plan <subject to sharpen>  |  /plan stop  |  /plan status", "warning");
        return;
      }
      if (subject.length > MAX_SUBJECT_LENGTH) {
        ctx.ui.notify(
          `Subject is too long (${subject.length}/${MAX_SUBJECT_LENGTH} characters). Reference a file for long material.`,
          "warning",
        );
        return;
      }

      startPlan(subject, ctx);
    },
  });

  function startPlan(subject: string, ctx: ExtensionCommandContext): void {
    activeSubject = subject;
    consecutiveSteeredTurns = 0;
    suppressSteerUntilNextTurn = false;
    ctx.ui.setStatus(STATUS_KEY, `plan: ${truncate(subject, 48)}`);
    const opening = buildOpening(subject);
    pi.sendUserMessage(opening, { deliverAs: "steer" });
    ctx.ui.notify(`Plan session started: ${subject}`, "info");
  }

  function stopPlan(ctx: ExtensionCommandContext): void {
    if (!activeSubject) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.notify("No active plan session.", "info");
      return;
    }
    const stopped = activeSubject;
    activeSubject = undefined;
    consecutiveSteeredTurns = 0;
    suppressSteerUntilNextTurn = false;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.notify(`Plan session stopped: ${stopped}`, "warning");
  }

  function showStatus(ctx: ExtensionCommandContext): void {
    if (!activeSubject) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.notify("No active plan session. Start one with /plan <subject>.", "info");
      return;
    }
    ctx.ui.notify(`Plan session is active: ${activeSubject}`, "info");
  }
}

// ---------------------------------------------------------------------------
// Constants and pure helpers (kept here so the module is single-file).
// ---------------------------------------------------------------------------

const STATUS_KEY = "pi-plan";
const MAX_SUBJECT_LENGTH = 4_000;
const MAX_QUESTION_LENGTH = 2_000;

const PLAN_STEER =
  "You are not asking. The plan session requires relentless questioning — continue the interview with one pointed question that probes the weakest part of the subject. Do not answer, summarize, or wrap up.";

/**
 * System-prompt guard block appended every turn so the model stays in the
 * interviewer role across the whole session, not just the opening.
 */
// Cache the assembled guard block per subject: the block string is identical
// across every turn of a session, so join work repeats needlessly each turn.
let cachedGuardSubject: string | undefined;
let cachedGuardBlock: string | undefined;
function planGuardBlock(subject: string): string {
  if (cachedGuardSubject === subject && cachedGuardBlock !== undefined) return cachedGuardBlock;
  cachedGuardSubject = subject;
  const block: string = [
    "PLAN SESSION ACTIVE",
    `Subject under review: ${subject}`,
    "",
    "You are a relentless interviewer sharpening the subject above. Rules:",
    "- Ask exactly ONE pointed question per turn — attack the weakest, vaguest, or riskiest part of the subject.",
    "- Never answer your own question, summarize, or conclude. The session only ends when the user stops it.",
    "- If the latest user message answered your previous question, immediately follow up with the next sharper question uncovered by their answer — do not acknowledge it.",
    "- Be specific and adversarial: name files, edge cases, failure modes, costs, or alternatives that the subject glosses over.",
    "- Keep the question short and concrete; avoid preamble or praise.",
  ].join("\n");
  cachedGuardBlock = block;
  return block;
}

function withPlanGuard(baseSystemPrompt: string, subject: string): string {
  return `${baseSystemPrompt}\n\n${planGuardBlock(subject)}`;
}

/**
 * Build the opening user message that kicks off the interview. Delivered as a
 * steer so it lands before the agent's first questioned turn.
 */
function buildOpening(subject: string): string {
  return `The plan session is now active. Begin the relentless interview now by asking exactly one pointed question about the subject below. Do not answer or summarize — only ask.\n\nSubject:\n${subject}`;
}

/**
 * Heuristic: does this assistant turn look like it is asking a pointed
 * question? Relentless interview output is short and headed by a question
 * mark. Answering, summarizing, or wrapping up all count as not asking.
 */
function isAsking(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  // Truncate to a probe window so a long answer that ends with a rhetorical
  // question does not falsely pass; a real question lives up front.
  const head = truncate(trimmed, MAX_QUESTION_LENGTH);
  // A questioning turn asks; require a question mark in the opening probe
  // window. Both half-width "?" and full-width "\uFF1F" count, since CJK
  // agents often end questions with the full-width mark. Code blocks are not
  // questions (``` blocks fence answers/specs).
  if (/```/.test(head)) return false;
  return /[\?\uFF1F]/.test(head);
}

/**
 * Extract the plain text of the latest assistant message. Mirrors the pi-guard
 * extractor shape but kept local so the plugin stays single-file.
 */
function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if ((part as { type?: string }).type === "text") {
      const value = (part as { text?: unknown }).text;
      if (typeof value === "string") out += value;
    }
  }
  return out;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
