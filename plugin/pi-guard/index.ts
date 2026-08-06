// pi-guard
//
// Command-first degradation guard. The primary interface is the /guard slash
// command. The old passive turn_end listener is replaced by an opt-in CLI flag
// `--pi-guard-watch` (default off).
//
// Detection is delegated to the pure scanner in ./src/detect.ts; thresholds
// (2-4 char substring x3 / single char x5) stay testable without a running Pi
// instance.
//
// Modes:
//   /guard            — inject a corrective user message that reloads the
//                       system prompt, breaking any active degeneration loop.
//   /guard status     — report whether --pi-guard-watch is active.
//   --pi-guard-watch  — (CLI flag, default false) when true, re-enables
//         turn_end auto-scan so every completed turn is monitored.
//
// before_agent_start is always active so the model's system prompt carries
// the degradation guard block regardless of watch mode.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectDegradation, extractAssistantText } from "./src/detect.js";
import { withDegradationGuardPrompt } from "./src/prompt.js";

const FLAG_NAME = "pi-guard-watch";
const MAX_CONSECUTIVE_INJECTIONS = 2;

const INJECTION_PREFIX =
  "（系统纠正）你的上一条输出进入退化重复，违反了下述须遵守的操作准则。请即按准则原文恢复格式与动作。";

export default function (pi: ExtensionAPI): void {
  let suppressUntilNextTurn = false;
  let consecutiveDegradedTurns = 0;
  let cachedSystemPrompt = "";

  // ------- CLI flag: --pi-guard-watch (default off) -------
  pi.registerFlag(FLAG_NAME, {
    description:
      "Scan every turn_end for output degradation (off by default; use /guard for manual check)",
    type: "boolean",
    default: false,
  });

  // ------- /guard command (primary interface) -------
  pi.registerCommand("guard", {
    description: "Manually scan the last assistant response for degradation or see guard status (/guard status)",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed === "status") {
        const on = pi.getFlag(FLAG_NAME);
        pi.sendUserMessage(
          on
            ? "[pi-guard] 自动检测已开启 (--pi-guard-watch)"
            : "[pi-guard] 自动检测已关闭，仅 /guard 手动调用生效。使用 --pi-guard-watch 开启自动模式",
        );
        return;
      }

      // The command sends a reflexive corrective user message that
      // re-loads the agent's system prompt. This breaks any active
      // degeneration loop by forcing the model to re-read its rules.
      const livePrompt =
        cachedSystemPrompt || ctx?.getSystemPrompt?.() || "";
      const correctionBody = trimmed
        ? `（pi-guard 巡检，指令: ${trimmed}）若当前输出处于 2-4 字符重复 x3 或单字符 x5 以上的退化循环，立即停止，重读以下准则并恢复工作。`
        : "（pi-guard 巡检）若当前输出处于退化循环，立即停止，重读操作准则并恢复工作。";
      pi.sendUserMessage(
        `${correctionBody}\n\n${livePrompt}`,
        { deliverAs: "steer" },
      );
    },
  });

  // ------- before_agent_start: always inject guard block -------
  pi.on("before_agent_start", (event) => {
    cachedSystemPrompt = withDegradationGuardPrompt(event.systemPrompt);
    return { systemPrompt: cachedSystemPrompt };
  });

  // ------- turn_end: only active when --pi-guard-watch is on -------
  pi.on("turn_end", (event, ctx) => {
    const enabled = pi.getFlag(FLAG_NAME);
    if (!enabled) return;

    const text = extractAssistantText(event.message);
    if (!text) return;

    if (suppressUntilNextTurn) return;

    if (consecutiveDegradedTurns >= MAX_CONSECUTIVE_INJECTIONS) return;

    const hit = detectDegradation(text);
    if (!hit) {
      consecutiveDegradedTurns = 0;
      return;
    }

    consecutiveDegradedTurns += 1;
    suppressUntilNextTurn = true;

    const livePrompt = cachedSystemPrompt || ctx?.getSystemPrompt?.() || "";
    const correction = `${INJECTION_PREFIX}\n\n${livePrompt}`;
    pi.sendUserMessage(correction, { deliverAs: "steer" });
  });

  pi.on("turn_start", () => {
    suppressUntilNextTurn = false;
  });

  pi.on("agent_start", () => {
    consecutiveDegradedTurns = 0;
    suppressUntilNextTurn = false;
  });
}