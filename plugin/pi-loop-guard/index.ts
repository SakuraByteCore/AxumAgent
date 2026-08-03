// pi-loop-guard
//
// Detects assistant output degeneration ("发癫" / loop) at turn boundaries and
// re-steers the agent back to productive work by injecting a corrective user
// message. Also appends a continuous degradation-guard block to the system
// prompt at agent start so the model is primed to avoid the pattern proactively.
//
// Detection is delegated to the pure scanner in ./src/detect.ts so the
// thresholds (2-4 char substring x3 / single char x5) stay testable without a
// running Pi instance.
//
// Hot-path design:
//  - turn_end is the only message-content scan point; message_update fires
//    per-token and is intentionally not monitored (the partial stream may
//    transiently look repetitive before completion).
//  - The scan is a single pass with early exit on first hit; non-matching
//    turns cost one string iteration.
//  - A per-session flag suppresses re-injection for the same degeneration run
//    so a model that keeps degenerating does not get spammed once the
//    corrective message is queued — the next turn_end re-evaluates fresh.
//  - The corrective injection re-loads the agent's own real system prompt in
//    full so a model that has drifted off its operation rules is forcibly
//    reminded of the concrete persona/self-check/fusing rules it must obey,
//    rather than receiving an abstract "stop repeating" scold that the loop
//    can ingest as fresh repetition fuel.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectDegradation, extractAssistantText } from "./src/detect.js";
import { withDegradationGuardPrompt } from "./src/prompt.js";

const MAX_CONSECUTIVE_INJECTIONS = 2;

/**
 * Prefix framing the corrective injection. Deliberately avoids the model's
 * self-reference token and any repeated substring so the injected text itself
 * cannot become fresh fuel for the degeneration loop. The real system prompt is
 * appended after this line so the agent re-reads its own operation rules.
 */
const INJECTION_PREFIX =
  "（系统纠正）你的上一条输出进入退化重复，违反了下述须遵守的操作准则。请即按准则原文恢复格式与动作。";

export default function (pi: ExtensionAPI): void {
  let suppressUntilNextTurn = false;
  let consecutiveDegradedTurns = 0;
  // Latest fully-assembled system prompt captured at before_agent_start so the
  // turn_end corrective injection can re-load the agent's real operation rules
  // without re-discovering the prompt at injection time.
  let cachedSystemPrompt = "";

  pi.on("turn_start", () => {
    // A new turn resets the suppression latch; if this turn also degrades, a
    // fresh corrective user message is warranted.
    suppressUntilNextTurn = false;
  });

  pi.on("turn_end", (event, ctx) => {
    const text = extractAssistantText(event.message);
    if (!text) return;
    const hit = detectDegradation(text);

    if (!hit) {
      consecutiveDegradedTurns = 0;
      return;
    }

    if (suppressUntilNextTurn) return;
    if (consecutiveDegradedTurns >= MAX_CONSECUTIVE_INJECTIONS) {
      // Stop nagging after the hard cap: the model has been re-loaded twice and
      // keeps looping. Let the host agent_end settle so the user can intervene.
      return;
    }

    consecutiveDegradedTurns += 1;
    suppressUntilNextTurn = true;
    // Reload the agent's own real system prompt so a drifted model re-reads its
    // persona, self-check loop, and output fusing rules in full — the concrete
    // rules it forgot — instead of an abstract scold. Prefer the cached value
    // captured at before_agent_start; fall back to the live ctx accessor for
    // sessions where before_agent_start was not emitted first.
    const livePrompt = cachedSystemPrompt || ctx?.getSystemPrompt?.() || "";
    const correction = `${INJECTION_PREFIX}\n\n${livePrompt}`;
    pi.sendUserMessage(correction, { deliverAs: "steer" });
  });

  pi.on("agent_start", () => {
    consecutiveDegradedTurns = 0;
    suppressUntilNextTurn = false;
  });

  pi.on("before_agent_start", (event) => {
    cachedSystemPrompt = withDegradationGuardPrompt(event.systemPrompt);
    return {
      systemPrompt: cachedSystemPrompt,
    };
  });
}
