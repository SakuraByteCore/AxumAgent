import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, join, extname } from "node:path";
import { homedir } from "node:os";

// ── Templates ──────────────────────────────────────────────────────────────

const PLAN_FIRST_TEMPLATE = `Research the requirement quickly and re-confirm the plan. Let's discuss the approach first — do not generate any code until I ask you to.`;
function readSubagentsEnabled(): boolean {
  try {
    let settingsPath: string;
    const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    settingsPath = join(dir, "settings.json");
    const raw = readFileSync(settingsPath, "utf-8");
    const config = JSON.parse(raw);
    return config.subagentsEnabled === true;
  } catch {
    return false;
  }
}

const SUBAGENT_RPC_TIMEOUT_MS = 3000;

type EventBus = {
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
};

type SpawnReply =
	| { success: true; data?: { id?: string } }
	| { success: false; error?: string };


function subagentDescription(prompt: string): string {
	const words = prompt.trim().split(/\s+/).filter(Boolean);
	const text = words.length > 1 ? words.slice(0, 5).join(" ") : prompt.trim();
	return text.slice(0, 48);
}

function spawnSubagent(pi: ExtensionAPI, prompt: string): Promise<string> {
	const events = (pi as unknown as { events?: EventBus }).events;
	if (!events) throw new Error("event bus is unavailable");
	const requestId = randomUUID();
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout>;
		let unsubscribe = () => {};
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			fn();
		};
		unsubscribe = events.on(`subagents:rpc:spawn:reply:${requestId}`, (raw) => {
			const reply = raw as SpawnReply;
			finish(() => {
				if (!reply || typeof reply !== "object") {
					reject(new Error("invalid subagent reply"));
					return;
				}
				if (!reply.success) {
					reject(new Error(reply.error || "subagent spawn failed"));
					return;
				}
				resolve(reply.data?.id || requestId);
			});
		});
		timer = setTimeout(() => {
			finish(() => reject(new Error("subagents extension is not ready")));
		}, SUBAGENT_RPC_TIMEOUT_MS);
		const model = pi.getModel();
		const provider = model ? ({
		  provider: model.provider,
		  modelId: model.id,
		  api: model.api,
		  baseUrl: model.baseUrl,
		} as const) : undefined;

		const payload: Record<string, unknown> = {
		  requestId,
		  type: "",
		  prompt,
		  options: {
		    description: subagentDescription(prompt),
		    isBackground: true,
		  },
		};
		if (provider) payload.provider = provider;
		events.emit("subagents:rpc:spawn", payload);
	});
}

// ── Auto-Compact ────────────────────────────────────────────────────────────

const COMPACT_THRESHOLD = 80;
const COMPACT_COOLDOWN_MS = 30_000;
const COMPACT_CONTINUE_DELAY_MS = 2000;
let lastCompactAt = 0;
let pendingCompact: Promise<void> | null = null;
let compactDeferred = false;
let compactRequested = false;

async function maybeCompact(pi: ExtensionAPI, _event: unknown, ctx: ExtensionContext): Promise<void> {
	const u = ctx.getContextUsage();
	if (!u || u.tokens == null || u.contextWindow == null) {
		return;
	}
	const pct = Math.round((u.tokens / u.contextWindow) * 100);
	if (pct < COMPACT_THRESHOLD) {
		compactDeferred = false;
		return;
	}
	const now = Date.now();
	if (now - lastCompactAt < COMPACT_COOLDOWN_MS) return;
	if (pendingCompact) return;
	if (compactDeferred) compactDeferred = false;

	lastCompactAt = now;
	const task = (async () => {
		try {
			compactRequested = true;
			await pi.sendUserMessage("/compact", { streamingBehavior: "steer" });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`Auto-compact failed: ${message}`, "warning");
			compactRequested = false;
		}
	})();
	pendingCompact = task;
	try {
		await task;
	} finally {
		pendingCompact = null;
	}
}


async function sendCompactContinue(pi: ExtensionAPI, _ctx: ExtensionContext): Promise<void> {
	if (!compactRequested) return;
	try {
		await new Promise((r) => setTimeout(r, COMPACT_CONTINUE_DELAY_MS));
		await pi.sendUserMessage("继续", { streamingBehavior: "steer" });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		_ctx.ui.notify(`Auto-compact continue failed: ${message}`, "warning");
	} finally {
		compactRequested = false;
	}
}
async function tryDeferredCompact(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!compactDeferred) return;
	const u = ctx.getContextUsage();
	if (!u || u.tokens == null || u.contextWindow == null) return;
	const pct = Math.round((u.tokens / u.contextWindow) * 100);
	if (pct < COMPACT_THRESHOLD) {
		compactDeferred = false;
		return;
	}
	await maybeCompact(pi, "agent_settled", ctx);
	await sendCompactContinue(pi, ctx);
}

/**
 * pi-response-guard — guard-logic.ts
 *
 * Pure detection logic for retryable model responses.
 * No pi dependencies — all functions are testable in isolation.
 */

// ── Config ──────────────────────────────────────────────────────────

interface AutoContinueConfig {
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

const DEFAULT_CONFIG: AutoContinueConfig = {
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
		"429 too many",
		"insufficient_quota",
		"rate limit exceeded",
		"400",
		"401",
		"403",
		"404",
		"500",
		"502",
		"503",
		"504",
		"service unavailable",
		"server error",
		"internal error",
		"bad request",
		"api_error",
		"invalid_api_key",
		"authentication",
		"unauthorized",
		"access_denied",
		"permission denied",
		"model not found",
		"not found",
		"fetch failed",
		"ECONNRESET",
		"ECONNREFUSED",
		"ETIMEDOUT",
		"EAI_AGAIN",
		"socket hang up",
		"connection error",
		"connection reset",
		"connection refused",
		"connection aborted",
		"connection lost",
		"connect econnrefused",
		"premature close",
		"stream closed",
		"stream interrupted",
		"unexpected end",
		"upstream connect",
		"upstream request timeout",
		"request timed out",
		"timed out",
		"timeout",
		"read timeout",
		"retry delay",
		"terminated",
	],
};

// ── Type helpers ────────────────────────────────────────────────────

interface GuardMessage {
	stopReason?: string;
	content?: unknown;
	errorMessage?: string;
	usage?: { input?: number; output?: number };
}

interface GuardContext {
	previousMessageRole?: string;
	previousMessageWasAutoRetry?: boolean;
}

interface AutoContinueReason {
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

function extractUserText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	return extractTextBlocks(content);
}

function matchesConfiguredError(errorText: string, patterns: string[]): boolean {
	const normalized = errorText.toLowerCase();
	return patterns.some((p) => normalized.includes(p.toLowerCase()));
}

function hasContentBlockType(content: unknown, type: string): boolean {
	return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === type);
}

function hasVisibleAssistantOutput(content: unknown): boolean {
	return extractTextBlocks(content).length > 0 || hasContentBlockType(content, "toolCall");
}

function isThinkingOnlyStop(content: unknown): boolean {
	return hasContentBlockType(content, "thinking") && !hasVisibleAssistantOutput(content);
}

/** Detect 0-output-token empty response (rate limit / proxy failure) */
function isEmptyZeroTokenResponse(message: GuardMessage): boolean {
	if (message.stopReason !== "stop") return false;
	const usage = message.usage;
	if (!usage || typeof usage.output !== "number") return false;
	return usage.output === 0 && !hasVisibleAssistantOutput(message.content);
}

// ── Config normalization ────────────────────────────────────────────

function normalizeConfig(raw: unknown): AutoContinueConfig {
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

interface TerminalContinueContext {
	/** The last assistant message recorded from message_end / agent_end. */
	lastMessage?: GuardMessage;
	/** True if the message_end fast path already handled this terminal message. */
	alreadyHandled?: boolean;
	/** True if the agent still has pending queued messages (run not settled). */
	hasPendingMessages?: boolean;
	/** Running auto-retry count (compared against maxConsecutiveAutoRetries). */
	consecutiveAutoRetries?: number;
	/** Previous message role, used for silent-stop-after-* detection. */
	previousMessageRole?: string;
}

/**
 * Terminal fallback for non-goal tasks.
 *
 * The agent's internal retry loop (agent.prompt -> _prepareRetry ->
 * agent.continue) fires an error message_end before the queue drains, so the
 * message_end fast path bails via hasPendingMessages() and never sends. When
 * retries are exhausted the run emits agent_end(willRetry=false) +
 * agent_settled — the only events fired after the queue is finally empty. This
 * decides whether to send the retry message then.
 */
function shouldTerminalAutoContinue(
	config: AutoContinueConfig,
	context: TerminalContinueContext,
): AutoContinueReason | undefined {
	if (!config.enabled) return undefined;
	const msg = context.lastMessage;
	if (!msg || context.alreadyHandled) return undefined;
	if (msg.role !== "assistant") return undefined;
	const retryableStopReasons = new Set(["error", "length", "stop"]);
	if (!retryableStopReasons.has(msg.stopReason ?? "")) return undefined;
	// Queue must be drained; otherwise the retry is redundant or the run is
	// still driving more work.
	if (context.hasPendingMessages) return undefined;
	const existing = context.consecutiveAutoRetries ?? 0;
	const max = config.maxConsecutiveAutoRetries;
	if (existing >= max) return undefined;
	const reason = getAutoContinueReason(msg, config, {
		previousMessageRole: context.previousMessageRole,
		previousMessageWasAutoRetry: false,
	});
	if (!reason) return undefined;
	return reason;
}

// ── Main detection logic ────────────────────────────────────────────

/**
 * Determine whether an assistant message should trigger an automatic
 * retry (continue) message.
 *
 * Returns an AutoContinueReason or undefined.
 */
function getAutoContinueReason(
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
	try {
		if (!ctx?.hasUI) return;
		ctx.ui.notify(message, level);
	} catch {
		// Defensive: silently drop notification if UI is unavailable or ctx is partial.
	}
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

// ── /clear ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	let consecutiveAutoRetries = 0;
	let pendingAutoRetryMessage: string | undefined;
	let previousMessageRole: string | undefined;
	let lastUserMessageWasAutoRetry = false;
	let lastAssistantMessage: { role: string; stopReason?: string; content?: unknown; errorMessage?: string; usage?: { input?: number; output?: number } } | undefined;
	let lastAssistantAlreadyHandled = false;
	const lastConfigError: { value?: string } = {};

	pi.registerCommand("clear", {
		description: "Delete the current conversation session and start a fresh one",
		getArgumentCompletions: () => null,
		async handler(_args: string, ctx) {
			const sessionFile = ctx.sessionManager.getSessionFile();

			if (!sessionFile) {
				await ctx.newSession({
					withSession: (newCtx) => {
						newCtx.ui.notify("Started a fresh session (in-memory, no file was deleted).", "info");
					},
				});
				return;
			}

			if (extname(sessionFile) !== ".jsonl") {
				ctx.ui.notify(`Refusing to delete: session file is not .jsonl (${sessionFile}).`, "error");
				return;
			}

			const fileToDelete = sessionFile;
			const result = await ctx.newSession({
				withSession: (newCtx) => {
					try {
						if (existsSync(fileToDelete)) {
							unlinkSync(fileToDelete);
							newCtx.ui.notify("Current session deleted. Started a fresh session.", "info");
						} else {
							newCtx.ui.notify("Fresh session started (old file already gone).", "info");
						}
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						newCtx.ui.notify(`Started new session, but failed to delete old file: ${message}`, "warning");
					}
				},
			});

			if (result.cancelled) {
				ctx.ui.notify("New session cancelled; old session preserved.", "warning");
			}
		},
	});

	// ── /plan ──────────────────────────────────────────────────────────────

	pi.registerCommand("plan", {
		description: "Plan first: research the requirement, re-confirm the approach, and discuss before writing code: /plan <requirement>",
		getArgumentCompletions: () => null,
		async handler(args: string, ctx) {
			const requirement = args.trim();
			if (!requirement) {
				ctx.ui.notify("Please provide a requirement: /plan <requirement>", "warning");
				return;
			}
			const prompt = [
				`[Requirement] ${requirement}`,
				"",
				`[Instructions] ${PLAN_FIRST_TEMPLATE}`,
			].join("\n");
			pi.sendUserMessage(prompt, { streamingBehavior: "followUp" });
		},
	});

	if (readSubagentsEnabled()) {
		pi.registerCommand("subagent", {
			description: "Start a background subagent: /subagent <prompt>",
			getArgumentCompletions: () => null,
			async handler(args: string, ctx) {
				const prompt = args.trim();
				if (!prompt) {
					ctx.ui.notify("Please provide a prompt: /subagent <prompt>", "warning");
					return;
				}
				try {
					const id = await spawnSubagent(pi, prompt);
					ctx.ui.notify(`Started subagent ${id}. Manage it with /agents.`, "info");
				} catch (e: any) {
					const message = e instanceof Error ? e.message : String(e);
					ctx.ui.notify(`Failed to start subagent: ${message}`, "error");
				}
			},
		});
	}



	// ── /plugin-create-mode: open the bundled pi-plugins skill guide (plugin creation mode).

	pi.registerCommand("plugin-create-mode", {
		description: "Open the bundled pi-plugins skill guide (plugin creation mode)",
		getArgumentCompletions: () => null,
		async handler(_args: string, ctx) {
			const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "pi-plugins");
			const skillFile = join(skillDir, "SKILL.md");
			try {
				const fc = await readFile(skillFile, "utf-8");
				ctx.ui.notify("=== pi-plugins Skill Guide ===", "info");
				ctx.ui.notify(fc, "info");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to load pi-plugins skill: ${message}`, "error");
			}
		},
	});

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

	// ── Auto-Compact Listeners ──────────────────────────────────────────────

	pi.on("agent_start", async (event, ctx) => {
		await maybeCompact(pi, event, ctx);
	});

	pi.on("turn_start", async (event, ctx) => {
		await maybeCompact(pi, event, ctx);
	});

	pi.on("message_update", async (event, ctx) => {
		const u = ctx.getContextUsage();
		if (!u || u.tokens == null || u.contextWindow == null) {
			if (!compactDeferred) {
				compactDeferred = true;
			}
			return;
		}
		await maybeCompact(pi, event, ctx);
	});

	pi.on("agent_settled", async (event, ctx) => {
		await tryDeferredCompact(pi, ctx);
		await sendCompactContinue(pi, ctx);
		await maybeAutoContinueTerminal(ctx);
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
			await pi.sendUserMessage("/compact", { streamingBehavior: "steer" });
		}

		await pi.sendUserMessage(config.retryMessage, { streamingBehavior: "followUp" });
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
			await pi.sendUserMessage("/compact", { streamingBehavior: "steer" });
		}

		await pi.sendUserMessage(config.retryMessage, { streamingBehavior: "followUp" });
	});
}