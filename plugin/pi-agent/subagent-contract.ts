import type { AgentRole } from "./roles.ts";

/**
 * oh-my-pi 子代理契约对齐：执行契约、空转提醒与工具取证判定。
 *
 * 来源：oh-my-pi `packages/coding-agent/src/prompts/system/subagent-system-prompt.md`
 * 的 § Coop / § Completion 段，以及 `src/task/completion-probe.ts` 的空转提醒语义。
 * oh-my-pi 用 `yield` 工具收敛终态，AxumAgent 的子代理以最终文本收敛，
 * 因此这里用“整轮零工具调用”作为等价的未开工信号。
 */

/** 必须用工具取证的角色：只做推理的 oracle 不在其中。 */
const TOOL_EVIDENCE_ROLES: readonly AgentRole[] = ["explorer", "librarian", "designer", "fixer"];

/** 空转提醒次数上限；用尽后强制收尾，与 oh-my-pi 的 maxRetries 同构。 */
export const SUBAGENT_NUDGE_MAX_ATTEMPTS = 2;

/** 子代理执行契约（模型可见文本）。 */
export const SUBAGENT_EXECUTION_CONTRACT = [
	"[Execution contract]",
	"You are operating on one bounded piece of work assigned by the main agent.",
	"No TODO tracking and no progress updates. Execute, then report the result.",
	"While work remains you MUST continue with another tool call (inspect, edit, verify); a reply without a tool call ends your run.",
	"NEVER end on a plan, a promise of further work, or a question.",
	"NEVER give up because of uncertainty, missing information you can obtain with tools, or a design decision you can derive yourself.",
	"If you are truly blocked, state exactly what you tried and the exact blocker.",
].join("\n");

/** 该角色是否必须用工具取证。 */
export function requiresToolEvidence(role?: AgentRole): boolean {
	return role !== undefined && TOOL_EVIDENCE_ROLES.includes(role);
}

/** 空转提醒：继续用工具推进，或说明确切阻塞点。 */
export function subagentIdleReminder(attempt: number, max: number): string {
	return [
		`[Reminder ${attempt} of ${max}] Your last turn ended without a tool call, so the assignment is still open.`,
		"Continue the assignment with the tools you actually have, or reply with the exact blocker you hit and what you already tried.",
		"Do not restate the plan and stop; do not ask the parent for permission you already hold.",
	].join("\n");
}

/** 强制收尾：提醒次数用尽后只要最终报告，不再开启新工作。 */
export function subagentForcedWrapup(): string {
	return [
		"[Final wrap-up] Tool-use reminders are exhausted.",
		"Reply now with your best final report: what was done, the evidence you actually collected, and what remains unfinished.",
		"Mark every unverified claim as unverified. Do not start new work.",
	].join("\n");
}
