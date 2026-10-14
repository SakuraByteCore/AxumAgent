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
