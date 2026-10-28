import { DispatchDeadlineError } from "./child-recovery.ts";
import type { AgentMessage, AgentSession } from "./shared.js";

/** Follow-up instruction for a child that finished a turn without any text response. */
export const NO_TEXT_RESPONSE_NUDGE =
	"Your previous turn finished without any text response. Reply now with your complete final answer as plain text, without calling any tools.";

/** Thrown when a finished turn contains no recoverable assistant text anywhere within it. */
export class EmptyAgentTextError extends Error {
	constructor(detail: { assistantMessages: number }) {
		super(
			`User agent returned no text response (${detail.assistantMessages} assistant messages this turn, none with text)`,
		);
		this.name = "EmptyAgentTextError";
	}
}

/** Thrown when a turn finishes without any assistant message at all. */
export class NoAssistantMessageError extends Error {
	constructor() {
		super("User agent finished without an assistant message");
		this.name = "NoAssistantMessageError";
	}
}

/** Thrown when the agent stops with an error or aborted status. */
export class AgentStopError extends Error {
	public readonly stopReason: "error" | "aborted";
	constructor(detail: { stopReason: "error" | "aborted"; errorMessage?: string }) {
		super(detail.errorMessage || `User agent ${detail.stopReason}`);
		this.name = "AgentStopError";
		this.stopReason = detail.stopReason;
	}
}

export function assistantText(message: Extract<AgentMessage, { role: "assistant" }>): string {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

/**
 * The text to deliver for a finished turn. The final assistant message may carry only thinking
 * or tool parts, so fall back to the last non-empty assistant text within the same turn.
 */
export function getFinalAssistantText(
	session: AgentSession,
	turnMessageStart: number,
): string {
	const assistantMessages = session.agent.state.messages
		.slice(turnMessageStart)
		.filter((message) => message.role === "assistant");
	const lastMessage = assistantMessages.at(-1);
	if (!lastMessage) throw new NoAssistantMessageError();
	if (lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted") {
		throw new AgentStopError({
			stopReason: lastMessage.stopReason,
			errorMessage: lastMessage.errorMessage,
		});
	}
	const text = assistantMessages
		.map((message) => assistantText(message).trim())
		.findLast((candidate) => candidate.length > 0);
	if (text) return text;
	throw new EmptyAgentTextError({
		assistantMessages: assistantMessages.length,
	});
}

/** A deadline is partial delivery, not a provider failure or a successful completion. */
export function dispatchTimeoutReport(agent: {
	timeoutMs?: number; responseText: string; toolUses: number; turnCount: number;
}): string {
	return [
		`超时 / 部分结果：子代理达到 ${agent.timeoutMs}ms 执行上限，已停止。`,
		`工具调用 ${agent.toolUses} 次，回合 ${agent.turnCount} 次。`,
		"已收到的输出（可能被截断，不代表已完成验收）：",
		agent.responseText || "截止前未收到助手文本；已有文件改动仍需主代理核验。",
		"剩余风险：任务可能未完成；请核对实际差异与测试后决定是否续跑。",
	].join("\n\n");
}

/** Only deadline sentinel/abort is partial; provider/tool failures always retain their error. */
export function isDispatchDeadlineFailure(agent: { stopCause?: string }, error: unknown): boolean {
 return agent.stopCause === "deadline" && (error instanceof DispatchDeadlineError ||
  (error instanceof AgentStopError && error.stopReason === "aborted"));
}

/** Recover available text without hiding a genuine provider failure behind a timeout. */
export function getPartialAssistantText(session: AgentSession, turnMessageStart: number): string {
 const messages = session.agent.state.messages.slice(turnMessageStart).filter(message => message.role === "assistant");
 const last = messages.at(-1);
 if (last?.stopReason === "error") throw new AgentStopError({ stopReason: "error", errorMessage: last.errorMessage });
 return messages.map(message => assistantText(message).trim()).findLast(text => text.length > 0) ?? "";
}
