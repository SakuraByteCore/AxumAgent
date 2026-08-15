/**
 * pi-response-guard — guard-logic.ts
 *
 * Pure detection logic for retryable model responses.
 * No pi dependencies — all functions are testable in isolation.
 */

// ── Config ──────────────────────────────────────────────────────────

export interface AutoContinueConfig {
	enabled: boolean;
	retryMessage: string;
	maxConsecutiveAutoRetries: number;
	notifyOnAutoContinue: boolean;
	autoContinueOnLength: boolean;
	autoContinueOnThinkingOnlyStop: boolean;
	autoContinueOnSilentStopAfterTool: boolean;
	autoContinueOnEmptyResponse: boolean;
	errorPatterns: string[];
}

export const DEFAULT_CONFIG: AutoContinueConfig = {
	enabled: true,
	retryMessage: "continue",
	maxConsecutiveAutoRetries: 10,
	notifyOnAutoContinue: true,
	autoContinueOnLength: true,
	autoContinueOnThinkingOnlyStop: true,
	autoContinueOnSilentStopAfterTool: true,
	autoContinueOnEmptyResponse: true,
	errorPatterns: [
		"rate limit",
		"usage limit",
		"rate_limit",
		"too many requests",
		"429",
		"500",
		"502",
		"503",
		"504",
		"service unavailable",
		"server error",
		"internal error",
		"fetch failed",
		"ECONNRESET",
		"ETIMEDOUT",
		"socket hang up",
		"connection reset",
		"connection refused",
		"connection lost",
		"premature close",
		"stream closed",
		"stream interrupted",
		"unexpected end",
		"upstream connect",
		"retry delay",
		"timeout",
		"terminated",
	],
};

// ── Type helpers ────────────────────────────────────────────────────

export interface GuardMessage {
	stopReason?: string;
	content?: unknown;
	errorMessage?: string;
	usage?: { input?: number; output?: number };
}

export interface GuardContext {
	previousMessageRole?: string;
	previousMessageWasAutoRetry?: boolean;
}

export interface AutoContinueReason {
	kind: string;
	notification: string;
}

// ── Internal helpers ────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function extractTextBlocks(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) => {
			if (!isRecord(block)) return [];
			if (block.type !== "text") return [];
			return typeof block.text === "string" ? [block.text] : [];
		})
		.join("\n")
		.trim();
}

export function extractUserText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	return extractTextBlocks(content);
}

export function matchesConfiguredError(errorText: string, patterns: string[]): boolean {
	const normalized = errorText.toLowerCase();
	return patterns.some((p) => normalized.includes(p.toLowerCase()));
}

function hasContentBlockType(content: unknown, type: string): boolean {
	return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === type);
}

export function hasVisibleAssistantOutput(content: unknown): boolean {
	return extractTextBlocks(content).length > 0 || hasContentBlockType(content, "toolCall");
}

export function isThinkingOnlyStop(content: unknown): boolean {
	return hasContentBlockType(content, "thinking") && !hasVisibleAssistantOutput(content);
}

/** Detect 0-output-token empty response (rate limit / proxy failure) */
export function isEmptyZeroTokenResponse(message: GuardMessage): boolean {
	if (message.stopReason !== "stop") return false;
	const usage = message.usage;
	if (!usage || typeof usage.output !== "number") return false;
	return usage.output === 0 && !hasVisibleAssistantOutput(message.content);
}

// ── Config normalization ────────────────────────────────────────────

export function normalizeConfig(raw: unknown): AutoContinueConfig {
	if (!isRecord(raw)) return { ...DEFAULT_CONFIG };

	const config = raw;

	const errorPatterns = Array.isArray(config.errorPatterns)
		? (config.errorPatterns as unknown[])
				.filter((p): p is string => typeof p === "string")
				.map((p) => p.trim())
				.filter(Boolean)
		: DEFAULT_CONFIG.errorPatterns;

	const retryMessage =
		typeof config.retryMessage === "string" && config.retryMessage.trim().length > 0
			? config.retryMessage.trim()
			: DEFAULT_CONFIG.retryMessage;

	const maxConsecutiveAutoRetries =
		typeof config.maxConsecutiveAutoRetries === "number" && Number.isFinite(config.maxConsecutiveAutoRetries)
			? Math.max(0, Math.floor(config.maxConsecutiveAutoRetries))
			: DEFAULT_CONFIG.maxConsecutiveAutoRetries;

	return {
		enabled: typeof config.enabled === "boolean" ? config.enabled : DEFAULT_CONFIG.enabled,
		retryMessage,
		maxConsecutiveAutoRetries,
		notifyOnAutoContinue:
			typeof config.notifyOnAutoContinue === "boolean"
				? config.notifyOnAutoContinue
				: DEFAULT_CONFIG.notifyOnAutoContinue,
		autoContinueOnLength:
			typeof config.autoContinueOnLength === "boolean"
				? config.autoContinueOnLength
				: DEFAULT_CONFIG.autoContinueOnLength,
		autoContinueOnThinkingOnlyStop:
			typeof config.autoContinueOnThinkingOnlyStop === "boolean"
				? config.autoContinueOnThinkingOnlyStop
				: DEFAULT_CONFIG.autoContinueOnThinkingOnlyStop,
		autoContinueOnSilentStopAfterTool:
			typeof config.autoContinueOnSilentStopAfterTool === "boolean"
				? config.autoContinueOnSilentStopAfterTool
				: DEFAULT_CONFIG.autoContinueOnSilentStopAfterTool,
		autoContinueOnEmptyResponse:
			typeof config.autoContinueOnEmptyResponse === "boolean"
				? config.autoContinueOnEmptyResponse
				: DEFAULT_CONFIG.autoContinueOnEmptyResponse,
		errorPatterns: errorPatterns.length > 0 ? errorPatterns : DEFAULT_CONFIG.errorPatterns,
	};
}

// ── Main detection logic ────────────────────────────────────────────

/**
 * Determine whether an assistant message should trigger an automatic
 * retry (continue) message.
 *
 * Returns an AutoContinueReason or undefined.
 */
export function getAutoContinueReason(
	message: GuardMessage,
	config: AutoContinueConfig,
	context: GuardContext,
): AutoContinueReason | undefined {
	// ── Case 1: error stopReason matching configured patterns ──
	if (message.stopReason === "error") {
		const errorText = [message.errorMessage, extractTextBlocks(message.content)]
			.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
			.join("\n");
		if (!errorText || !matchesConfiguredError(errorText, config.errorPatterns)) return undefined;
		return { kind: "error", notification: "Matched a configured error pattern" };
	}

	// ── Case 2: length stopReason (hit max output tokens) ──
	if (message.stopReason === "length" && config.autoContinueOnLength) {
		return { kind: "length", notification: 'Assistant stopped with stopReason "length"' };
	}

	// Everything below requires stopReason === "stop"
	if (message.stopReason !== "stop") return undefined;

	// ── Case 3: thinking-only stop ──
	if (config.autoContinueOnThinkingOnlyStop && isThinkingOnlyStop(message.content)) {
		return { kind: "thinkingOnlyStop", notification: "Assistant stopped after emitting only thinking content" };
	}

	// ── Case 7 (NEW): empty response with 0 output tokens ──
	// This catches rate-limit / proxy failures where the model returns
	// stop with 0 output tokens and empty content.
	if (config.autoContinueOnEmptyResponse && isEmptyZeroTokenResponse(message)) {
		return {
			kind: "emptyZeroTokenResponse",
			notification: "Assistant returned empty response with 0 output tokens (possible rate limit or provider failure)",
		};
	}

	// ── Cases 4–6: silent stop after user / tool / auto-retry ──
	if (!config.autoContinueOnSilentStopAfterTool || hasVisibleAssistantOutput(message.content)) {
		return undefined;
	}

	if (context.previousMessageRole === "toolResult") {
		return {
			kind: "silentStopAfterTool",
			notification: "Assistant stopped after a tool result without emitting visible output",
		};
	}

	if (context.previousMessageRole === "user" && context.previousMessageWasAutoRetry) {
		return {
			kind: "silentStopAfterAutoRetry",
			notification: "Assistant stopped after an automatic retry without emitting visible output",
		};
	}

	if (context.previousMessageRole === "user") {
		return {
			kind: "silentStopAfterUser",
			notification: "Assistant stopped after a user message without emitting visible output",
		};
	}

	return undefined;
}
