/**
 * pi-response-guard — index.ts
 *
 * Pi extension that auto-recovers from empty, errored, or interrupted
 * model responses. Sends a configurable retry message when the
 * assistant stops in a retryable way.
 *
 * Based on pi-hodor approach with additional detection for:
 * - Empty responses with 0 output tokens (rate limit / proxy failures)
 * - Rate limit and usage limit error patterns
 */

import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	extractUserText,
	getAutoContinueReason,
	normalizeConfig,
	shouldTerminalAutoContinue,
	type AutoContinueConfig,
} from "./guard-logic.js";

// ── Constants ───────────────────────────────────────────────────────

const EXTENSION_NAME = "pi-response-guard";
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLED_CONFIG_PATH = join(MODULE_DIR, "config.json");
const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "extensions", EXTENSION_NAME, "config.json");
const PROJECT_CONFIG_CANDIDATES = [".pi-response-guard.json", join(".pi", "pi-response-guard.json")] as const;

type NotifyLevel = "info" | "success" | "warning" | "error";

interface QueueAwareContext {
	hasUI: boolean;
	ui: { notify(message: string, level: NotifyLevel): void };
	cwd: string;
	isIdle(): boolean;
	hasPendingMessages(): boolean;
}

interface AgentEndEvent {
	type: "agent_end";
	messages: unknown[];
	willRetry?: boolean;
}

// ── Config helpers ──────────────────────────────────────────────────

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function ensureBundledConfigFile(): Promise<void> {
	try {
		await access(BUNDLED_CONFIG_PATH);
	} catch {
		// Write defaults inline if bundled config is missing
		const defaults: AutoContinueConfig = {
			enabled: true,
			retryMessage: "continue",
			maxConsecutiveAutoRetries: 10,
			notifyOnAutoContinue: true,
			autoContinueOnLength: true,
			autoContinueOnThinkingOnlyStop: true,
			autoContinueOnSilentStopAfterTool: true,
			autoContinueOnEmptyResponse: true,
			errorPatterns: [
				"rate limit", "usage limit", "rate_limit", "too many requests",
				"429", "429 too many", "insufficient_quota", "rate limit exceeded",
				"400", "401", "403", "404", "500", "502", "503", "504",
				"service unavailable", "server error", "internal error",
				"bad request", "api_error", "invalid_api_key", "authentication",
				"unauthorized", "access_denied", "permission denied",
				"model not found", "not found",
				"fetch failed", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN",
				"socket hang up", "connection error", "connection reset",
				"connection refused", "connection aborted", "connection lost",
				"connect econnrefused", "premature close", "stream closed",
				"stream interrupted", "unexpected end", "upstream connect",
				"upstream request timeout", "request timed out", "timed out",
				"timeout", "read timeout", "retry delay", "terminated",
			],
		};
		await writeFile(BUNDLED_CONFIG_PATH, `${JSON.stringify(defaults, null, 2)}\n`, "utf8");
	}
}

async function resolveConfigPath(cwd: string): Promise<string> {
	for (const relativePath of PROJECT_CONFIG_CANDIDATES) {
		const candidatePath = join(cwd, relativePath);
		if (await pathExists(candidatePath)) return candidatePath;
	}
	if (await pathExists(GLOBAL_CONFIG_PATH)) return GLOBAL_CONFIG_PATH;
	return BUNDLED_CONFIG_PATH;
}

function safeNotify(ctx: QueueAwareContext, message: string, level: NotifyLevel): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, level);
}

async function loadConfig(ctx: QueueAwareContext, lastConfigError: { value?: string }): Promise<AutoContinueConfig> {
	await ensureBundledConfigFile();
	const configPath = await resolveConfigPath(ctx.cwd);
	try {
		const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
		lastConfigError.value = undefined;
		return config;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const errorKey = `${configPath}:${message}`;
		if (lastConfigError.value !== errorKey) {
			lastConfigError.value = errorKey;
			safeNotify(ctx, `[${EXTENSION_NAME}] Failed to read config from ${configPath}. Falling back to defaults: ${message}`, "warning");
		}
		return normalizeConfig({});
	}
}

// ── Extension entry point ───────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	let consecutiveAutoRetries = 0;
	let pendingAutoRetryMessage: string | undefined;
	let previousMessageRole: string | undefined;
	let lastUserMessageWasAutoRetry = false;
	let lastAssistantMessage: { role: string; stopReason?: string; content?: unknown; errorMessage?: string; usage?: { input?: number; output?: number } } | undefined;
	let lastAssistantAlreadyHandled = false;
	const lastConfigError: { value?: string } = {};

	pi.registerCommand(`${EXTENSION_NAME}:setup`, {
		description: `Copy the default config to ${GLOBAL_CONFIG_PATH}`,
		handler: async (_args, ctx) => {
			if (await pathExists(GLOBAL_CONFIG_PATH)) {
				ctx.ui.notify(`[${EXTENSION_NAME}] Config already exists at ${GLOBAL_CONFIG_PATH}`, "warning");
				return;
			}
			await ensureBundledConfigFile();
			await mkdir(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
			await copyFile(BUNDLED_CONFIG_PATH, GLOBAL_CONFIG_PATH);
			ctx.ui.notify(`[${EXTENSION_NAME}] Config copied to ${GLOBAL_CONFIG_PATH}`, "info");
		},
	});

	pi.on("session_start", async () => {
		await ensureBundledConfigFile();
	});

	// ── Terminal fallback ────────────────────────────────────────────
	// In non-goal auto-run tasks the agent's internal retry loop
	// (agent.prompt → _prepareRetry → agent.continue) drains an error
	// message_end before the run settles, so the message_end handler
	// bails via hasPendingMessages() and never sends. When every retry is
	// exhausted the run emits agent_end(willRetry=false) + agent_settled —
	// the only events fired after the queue is finally empty. Hook those
	// to act as the reliable terminal recovery for the last retryable
	// assistant message (instead of just dropping the run).
	async function maybeAutoContinueTerminal(ctx: unknown): Promise<void> {
		const guardCtx = ctx as QueueAwareContext;
		const config = await loadConfig(guardCtx, lastConfigError);

		const autoContinueReason = shouldTerminalAutoContinue(config, {
			lastMessage: lastAssistantMessage,
			alreadyHandled: lastAssistantAlreadyHandled,
			hasPendingMessages: guardCtx.hasPendingMessages(),
			consecutiveAutoRetries,
			previousMessageRole,
		});
		if (!autoContinueReason) return;

		consecutiveAutoRetries += 1;
		pendingAutoRetryMessage = config.retryMessage;
		lastAssistantAlreadyHandled = true;
		lastAssistantMessage = undefined;
		previousMessageRole = undefined;

		if (config.notifyOnAutoContinue) {
			safeNotify(
				guardCtx,
				`[${EXTENSION_NAME}] ${autoContinueReason.notification}. Sending "${config.retryMessage}" (${consecutiveAutoRetries}/${config.maxConsecutiveAutoRetries}).`,
				"info",
			);
		}

		if (autoContinueReason.kind === "length") {
			await pi.sendUserMessage("/compact");
		}

		if (guardCtx.isIdle()) {
			await pi.sendUserMessage(config.retryMessage);
		} else {
			await pi.sendUserMessage(config.retryMessage, { deliverAs: "followUp" });
		}
	}

	pi.on("agent_end", async (event, ctx) => {
		const agentEnd = event as AgentEndEvent;
		// Only act when the run is terminating without a pending framework retry.
		if (agentEnd.willRetry) return;
		const last = Array.isArray(agentEnd.messages)
			? agentEnd.messages[agentEnd.messages.length - 1]
			: undefined;
		if (last && typeof last === "object" && last !== null && (last as { role?: string }).role === "assistant") {
			const m = last as { role: string; stopReason?: string; content?: unknown; errorMessage?: string; usage?: { input?: number; output?: number } };
			lastAssistantMessage = m;
			lastAssistantAlreadyHandled = false;
		}
		await maybeAutoContinueTerminal(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await maybeAutoContinueTerminal(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		const messageRole = event.message.role;
		const previousRole = previousMessageRole;

		// Capture the terminal assistant message for the fallback handlers.
		if (messageRole === "assistant") {
			lastAssistantMessage = {
				role: "assistant",
				stopReason: event.message.stopReason,
				content: event.message.content,
				errorMessage: event.message.errorMessage,
				usage: event.message.usage,
			};
			lastAssistantAlreadyHandled = false;
		}
		const previousMessageWasAutoRetry = previousRole === "user" && lastUserMessageWasAutoRetry;
		previousMessageRole = messageRole;
		lastUserMessageWasAutoRetry = false;

		// ── Track user messages ──
		if (messageRole === "user") {
			const userText = extractUserText(event.message.content);
			if (pendingAutoRetryMessage && userText === pendingAutoRetryMessage) {
				lastUserMessageWasAutoRetry = true;
				pendingAutoRetryMessage = undefined;
				return;
			}
			consecutiveAutoRetries = 0;
			pendingAutoRetryMessage = undefined;
			// A fresh interactive user message supersedes any pending terminal
			// fallback for a prior run: reset the captured terminal state so a
			// stale agent_end/agent_settled can't fire a redundant retry.
			lastAssistantMessage = undefined;
			lastAssistantAlreadyHandled = false;
			return;
		}

		// ── Only handle assistant messages ──
		if (messageRole !== "assistant") return;

		// Only check retryable stop reasons
		const retryableStopReasons = new Set(["error", "length", "stop"]);
		if (!retryableStopReasons.has(event.message.stopReason)) {
			consecutiveAutoRetries = 0;
			pendingAutoRetryMessage = undefined;
			return;
		}

		// ── Load config ──
		const config = await loadConfig(ctx as QueueAwareContext, lastConfigError);
		if (!config.enabled) {
			consecutiveAutoRetries = 0;
			pendingAutoRetryMessage = undefined;
			return;
		}

		// ── Check if auto-continue is warranted ──
		const autoContinueReason = getAutoContinueReason(event.message, config, {
			previousMessageRole: previousRole,
			previousMessageWasAutoRetry,
		});
		if (!autoContinueReason) {
			consecutiveAutoRetries = 0;
			pendingAutoRetryMessage = undefined;
			return;
		}

		// ── Don't interrupt pending messages ──
		if ((ctx as QueueAwareContext).hasPendingMessages()) return;

		// ── Check retry limit ──
		if (consecutiveAutoRetries >= config.maxConsecutiveAutoRetries) {
			if (config.notifyOnAutoContinue) {
				safeNotify(
					ctx as QueueAwareContext,
					`[${EXTENSION_NAME}] Reached retry limit (${config.maxConsecutiveAutoRetries}). Skipping "${config.retryMessage}".`,
					"warning",
				);
			}
			return;
		}

		// ── Send retry ──
		consecutiveAutoRetries += 1;
		pendingAutoRetryMessage = config.retryMessage;
		lastAssistantAlreadyHandled = true;
		lastAssistantMessage = undefined;
		previousMessageRole = undefined;

		if (config.notifyOnAutoContinue) {
			safeNotify(
				ctx as QueueAwareContext,
				`[${EXTENSION_NAME}] ${autoContinueReason.notification}. Sending "${config.retryMessage}" (${consecutiveAutoRetries}/${config.maxConsecutiveAutoRetries}).`,
				"info",
			);
		}

		if (autoContinueReason.kind === "length") {
			await pi.sendUserMessage("/compact");
		}

		if ((ctx as QueueAwareContext).isIdle()) {
			await pi.sendUserMessage(config.retryMessage);
		} else {
			await pi.sendUserMessage(config.retryMessage, { deliverAs: "followUp" });
		}
	});
}
