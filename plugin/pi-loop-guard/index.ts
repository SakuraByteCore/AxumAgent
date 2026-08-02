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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectDegradation, extractAssistantText } from "./src/detect.js";
import { DEGRADATION_GUARD_PROMPT } from "./src/prompt.js";

const MAX_CONSECUTIVE_INJECTIONS = 2;
const INJECTION_MESSAGE =
  "检测到你的上一条回复进入重复退化（输出循环/发癫）。停止重复该模式。基于当前系统提示词的指引，用可验证的工具调用继续推进当前任务，输出结构化、无重复的内容。";

export default function (pi: ExtensionAPI): void {
  let suppressUntilNextTurn = false;
  let consecutiveDegradedTurns = 0;

  pi.on("turn_start", () => {
    // A new turn resets the suppression latch; if this turn also degrades, a
    // fresh corrective user message is warranted.
    suppressUntilNextTurn = false;
  });

  pi.on("turn_end", (event, _ctx) => {
    const text = extractAssistantText(event.message);
    if (!text) return;
    const hit = detectDegradation(text);

    if (!hit) {
      consecutiveDegradedTurns = 0;
      return;
    }

    if (suppressUntilNextTurn) return;
    if (consecutiveDegradedTurns >= MAX_CONSECUTIVE_INJECTIONS) {
      // Stop nagging after the hard cap: the model has been told twice and
      // keeps looping. Let the host agent_end settle so the user can intervene.
      return;
    }

    consecutiveDegradedTurns += 1;
    suppressUntilNextTurn = true;
    pi.sendUserMessage(INJECTION_MESSAGE, { deliverAs: "steer" });
  });

  pi.on("agent_start", () => {
    consecutiveDegradedTurns = 0;
    suppressUntilNextTurn = false;
  });

  pi.on("before_agent_start", (event) => {
    return {
      systemPrompt: `${event.systemPrompt}\n\n${DEGRADATION_GUARD_PROMPT}`,
    };
  });
}
