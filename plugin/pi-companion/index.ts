import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, unlinkSync } from "node:fs";
import { resolve, dirname, join, extname } from "node:path";
import { homedir } from "node:os";

// ── Templates ──────────────────────────────────────────────────────────────

// Pre-built plan prompt skeleton — only the requirement varies at runtime
const PLAN_PROMPT_PREFIX = `[Requirement] `;
const PLAN_PROMPT_MIDDLE = `

[Expectation] Use plain English style to describe the expected outcome of the current requirement. **Output language**: Choose the output language based on the language information available in the current conversation (such as the language of the user's most recent message). If no usable language information is available, fall back to the system timezone: use Chinese for UTC+8, Japanese for UTC+9, and English otherwise — this timezone rule is a fallback only. In any case, the output must not repeat this instruction or the original requirement text.`;
const PLAN_PROMPT_SUFFIX = `

[Instructions] Research the requirement quickly and re-confirm the plan. Let's discuss the approach first — do not generate any code until I ask you to.`;

// Session-first-plan flag & perf marks
let firstPlanSent = false;
const PERF_MARK_PREFIX = `pi-companion:plan`;

// Pre-built implement prompt skeleton — sibling of /plan, encodes the parallel subagent-dispatch workflow
const IMPLEMENT_PROMPT_PREFIX = `[Requirement] `;
const IMPLEMENT_PROMPT_SUFFIX = `

[Instructions] For this requirement, every part that can be parallelized must be split into subtasks and dispatched concurrently to subagents. Each subtask must have a clearly bounded scope and an explicit output format. Any subtask that writes files must be marked as such, so no two agents modify the same file. Finally, you integrate all the results and check them for consistency.`;

// Session-first-implement flag (mirrors firstPlanSent)
let firstImplementSent = false;

const RALPH_COMMIT_PATTERN = /\bcommit\b|提交/i;

function buildRalphLoopPrompt(prompt: string, loop: number, maxLoops: number, commitRequested: boolean): string {
	const lines = [
		`[Ralph Loop ${loop}/${maxLoops}]`,
		`[Goal] ${prompt}`,
		"",
		"[Process]",
		"1. Maintain a fix_plan.md in the repository root: a bullet list of remaining work sorted by priority. If it does not exist, create it from the goal before doing anything else.",
		"2. Repeatedly pick the most important unfinished item from fix_plan.md and work through items continuously within this single run: complete one item fully, then immediately move on to the next unfinished item without waiting for user input.",
		"3. Before making changes, search the codebase first (do not assume something is not implemented).",
		"4. Implement fully: no placeholders, no stubs, no minimal mock implementations.",
		"5. After implementing an item, run the tests for that unit of code and make them pass before moving to the next item.",
		"6. Update fix_plan.md after each finished item: mark it as done and append any newly discovered work.",
		"7. Stop only when fix_plan.md has no unfinished items left, every remaining item is blocked (record why in fix_plan.md), or you are about to hit this run's context/time limits. Finish with a short summary of what was completed.",
	];
	if (commitRequested) {
		lines.push("8. When tests pass, stage everything with \"git add -A\" and create a git commit with a descriptive English message.");
	} else {
		lines.push("8. Do not run any git commands (no add, commit, push, or tag).");
	}
	return lines.join("\n");
}

// ── Auto-Compact ────────────────────────────────────────────────────────────

const COMPACT_THRESHOLD = 80;
const COMPACT_COOLDOWN_MS = 30_000;
const COMPACT_PROOF_TIMEOUT_MS = 300_000;
function compactCooldownMs(): number {
	const raw = Number(process.env.PI_COMPANION_COMPACT_COOLDOWN_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : COMPACT_COOLDOWN_MS;
}
const COMPACT_LEDGER_INSTRUCTIONS = [
	"Write the summary as a continuation handoff ledger for resuming this task later.",
	"Use exactly these sections:",
	"Active task: the user goal still in progress.",
	"Still true: constraints, decisions and requirements that remain in effect.",
	"Recently changed: files edited, commands run and their outcomes.",
	"Next step: the single most important unfinished action to resume with.",
	"Fresh evidence: the latest test results, logs or outputs that are current.",
	"Do not repeat: completed work that must not be redone.",
	"Be concise and factual; omit sections with nothing to report.",
].join("\n");
const COMPACT_CONTINUE_PROMPT = "Continue the active task using the continuation handoff summary above. Resume from the next step and do not repeat completed work.";
let lastCompactAt = 0;
let pendingCompact: Promise<boolean> | null = null;
let compactDeferred = false;
let compactResumePending = false;

function compactUsagePercent(ctx: ExtensionContext): number | null {
	const u = ctx.getContextUsage();
	if (!u || u.tokens == null || u.contextWindow == null) return null;
	return Math.round((u.tokens / u.contextWindow) * 100);
}

function startLedgerCompaction(pi: ExtensionAPI, ctx: ExtensionContext, resumeOnProof: boolean): Promise<boolean> {
	if (pendingCompact) return Promise.resolve(false);
	lastCompactAt = Date.now();
	compactDeferred = false;
	const task = (async () => {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("compaction proof timeout")), COMPACT_PROOF_TIMEOUT_MS);
			ctx.compact({
				customInstructions: COMPACT_LEDGER_INSTRUCTIONS,
				onComplete: (result) => {
					clearTimeout(timer);
					if (!result || typeof result.summary !== "string" || result.summary.trim().length === 0) {
						reject(new Error("compaction produced no summary"));
						return;
					}
					resolve();
				},
				onError: (err) => {
					clearTimeout(timer);
					reject(err instanceof Error ? err : new Error(String(err)));
				},
			});
		});
		if (resumeOnProof) {
			compactResumePending = true;
			await drainCompactResume(pi, ctx);
		}
		return true;
	})().catch((err) => {
		const message = err instanceof Error ? err.message : String(err);
		safeNotify(ctx as QueueAwareContext, `Auto-compact failed: ${message}`, "warning");
		return false;
	});
	pendingCompact = task;
	void task.then(() => {
		if (pendingCompact === task) pendingCompact = null;
	}, () => {
		if (pendingCompact === task) pendingCompact = null;
	});
	return task;
}

async function maybeCompact(pi: ExtensionAPI, _event: unknown, ctx: ExtensionContext): Promise<boolean> {
	const pct = compactUsagePercent(ctx);
	if (pct == null) return false;
	if (pct < COMPACT_THRESHOLD) {
		compactDeferred = false;
		return false;
	}
	if (Date.now() - lastCompactAt < compactCooldownMs()) return false;
	return startLedgerCompaction(pi, ctx, true);
}


async function drainCompactResume(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!compactResumePending) return;
	if (!ctx.isIdle()) return;
	if (ctx.hasPendingMessages()) return;
	compactResumePending = false;
	try {
		await pi.sendUserMessage(COMPACT_CONTINUE_PROMPT, { streamingBehavior: "followUp" });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		safeNotify(ctx as QueueAwareContext, `Auto-compact continue failed: ${message}`, "warning");
	}
}
async function tryDeferredCompact(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!compactDeferred) return;
	const pct = compactUsagePercent(ctx);
	if (pct == null) return;
	if (pct < COMPACT_THRESHOLD) {
		compactDeferred = false;
		return;
	}
	void maybeCompact(pi, "agent_settled", ctx);
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
	ralphMaxLoops: number;
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
	ralphMaxLoops: 10,
	errorPatterns: [
		"rate limit",
		"usage limit",
		"rate_limit",
		"too many requests",
		"429",
		"429 too many",
		"rate limit exceeded",
		"500",
		"502",
		"503",
		"504",
		"service unavailable",
		"server error",
		"internal error",
		"api_error",
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

	const ralphMaxLoops =
		typeof config.ralphMaxLoops === "number" && Number.isFinite(config.ralphMaxLoops)
			? Math.max(1, Math.floor(config.ralphMaxLoops))
			: DEFAULT_CONFIG.ralphMaxLoops;

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
		ralphMaxLoops,
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

// ── pi-companion:advisor — advisory watcher ────────────────────────────────
// Read-only watcher (merged from pi-guard). Posts inline guidance notes via
// pi.events.emit("pi-companion:advice", note, severity); filters noise,
// dedupes repeats, and rate-limits advice delivery.

const ADVISORY_EVENT = "pi-companion:advice";
const ADVISOR_HISTORY_CAPACITY = 4096;

function normalizeAdvisorNote(note: unknown): string {
	if (typeof note !== "string") return "";
	return note
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

const SUPPRESSED_NORMALIZED_PHRASES: ReadonlySet<string> = new Set([
	"stop",
	"stop here",
	"stop now",
	"halt",
	"abort",
	"done",
	"task done",
	"task complete",
	"complete",
	"finished",
	"ok",
	"okay",
	"ok done",
	"no issue",
	"no issues",
	"no issue continue",
	"no concerns",
	"no concern",
	"nothing to add",
	"nothing to flag",
	"nothing to report",
	"no notes",
	"no further input",
	"no further input needed",
	"no further input required",
	"no further watcher input",
	"no further watcher input needed",
	"no further advice",
	"no further advice needed",
	"lgtm",
	"looks good",
	"all good",
	"agent is on track",
	"agent on track",
	"on track",
	"continue",
	"carry on",
]);

class EmissionGuard {
	private readonly capacity: number;
	private readonly seen = new Set<string>();
	private seenOrder: string[] = [];
	private consumedThisUpdate = false;

	constructor(opts: { capacity?: number } = {}) {
		this.capacity = opts.capacity ?? ADVISOR_HISTORY_CAPACITY;
	}

	reset(): void {
		this.seen.clear();
		this.seenOrder = [];
		this.consumedThisUpdate = false;
	}

	beginUpdate(): void {
		this.consumedThisUpdate = false;
	}

	accept(note: string): boolean {
		const key = normalizeAdvisorNote(note);
		if (!key) return false;
		if (SUPPRESSED_NORMALIZED_PHRASES.has(key)) return false;
		if (this.seen.has(key)) return false;
		if (this.consumedThisUpdate) return false;
		this.consumedThisUpdate = true;
		this.seen.add(key);
		this.seenOrder.push(key);
		if (this.seenOrder.length > this.capacity) {
			const stale = this.seenOrder.shift();
			if (stale !== undefined) this.seen.delete(stale);
		}
		return true;
	}
}

interface AdvisorAdvice {
	note: string;
	severity: string;
}

interface AdvisorToolCallEvent {
	input?: unknown;
}

interface AdvisorToolResultEvent {
	isError?: boolean;
	details?: unknown;
}

function inspectToolCall(event: AdvisorToolCallEvent): AdvisorAdvice | undefined {
	const input = (event.input ?? {}) as string | { command?: unknown };
	const command = typeof input === "string" ? input : input.command;
	if (typeof command !== "string") return undefined;

	if (/\brm\s+-rf\s+\//.test(command)) {
		return {
			note: "`rm -rf /...` looks dangerous. Double-check the path.",
			severity: "concern",
		};
	}

	if (/\bchmod\s+-R\s+777\b/.test(command)) {
		return {
			note: "Consider narrower permissions than 777.",
			severity: "nit",
		};
	}

	if (
		/\b(fuser|kill)\s+-9\b/.test(command) ||
		/\bdd\b/.test(command) ||
		/\bmkfs\b/.test(command)
	) {
		return {
			note: "Mass-mutation command detected. Dry-run first if possible.",
			severity: "concern",
		};
	}

	if (/\bgit\s+push\s+--force\b/.test(command) && !/--force-with-lease/.test(command)) {
		return {
			note: "Prefer `git push --force-with-lease` over `--force`.",
			severity: "nit",
		};
	}

	return undefined;
}

function inspectToolResult(event: AdvisorToolResultEvent): AdvisorAdvice | undefined {
	if (!event.isError) return undefined;
	const details = event.details;
	if (details && typeof details === "object" && (details as { signal?: unknown }).signal === "SIGKILL") {
		return {
			note: "Process killed (SIGKILL). Check OOM or infinite loop.",
			severity: "blocker",
		};
	}
	if (details && typeof details === "object" && (details as { code?: unknown }).code === "ENOSPC") {
		return {
			note: "Disk full (ENOSPC). Free space before retrying.",
			severity: "blocker",
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
			ralphMaxLoops: 10,
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
	let deferredAutoContinueReason: AutoContinueReason | undefined;
	let previousMessageRole: string | undefined;
	let lastUserMessageWasAutoRetry = false;
	let lastAssistantMessage: { role: string; stopReason?: string; content?: unknown; errorMessage?: string; usage?: { input?: number; output?: number } } | undefined;
	let lastAssistantAlreadyHandled = false;
	const lastConfigError: { value?: string } = {};

	interface RalphState {
		prompt: string;
		commitRequested: boolean;
		loopsDone: number;
		maxLoops: number;
	}
	let ralphState: RalphState | undefined;

	const RALPH_CONTINUE_RETRY_MS = 1_000;
	const RALPH_CONTINUE_RETRY_MAX_ATTEMPTS = 30;
	let ralphContinueTimer: ReturnType<typeof setTimeout> | undefined;

	function clearRalphContinueRetry(): void {
		if (ralphContinueTimer !== undefined) {
			clearTimeout(ralphContinueTimer);
			ralphContinueTimer = undefined;
		}
	}

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
    const t0 = performance.now();
    const requirement = args.trim();
    if (!requirement) {
      ctx.ui.notify("Please provide a requirement: /plan <requirement>", "warning");
      return;
    }

    // Perf mark: handler entry → prompt built
    performance.mark(`${PERF_MARK_PREFIX}:handler-entry`);

    // Build prompt using pre-compiled template parts (single allocation, zero join)
    const prompt = PLAN_PROMPT_PREFIX + requirement + PLAN_PROMPT_MIDDLE + PLAN_PROMPT_SUFFIX;

    performance.mark(`${PERF_MARK_PREFIX}:prompt-built`);
    performance.measure(`${PERF_MARK_PREFIX}:build`, `${PERF_MARK_PREFIX}:handler-entry`, `${PERF_MARK_PREFIX}:prompt-built`);

    // Instant UI feedback — user sees confirmation BEFORE network/agent latency
    ctx.ui.notify("Plan sent, waiting for Agent…", "info");

    // First plan in this session: use "new" streamingBehavior to bypass followUp scheduling overhead
    const isFirst = !firstPlanSent;
    if (isFirst) firstPlanSent = true;
    const streamingBehavior = isFirst ? "new" : "followUp";

    performance.mark(`${PERF_MARK_PREFIX}:send-start`);
    await pi.sendUserMessage(prompt, { streamingBehavior });
    performance.mark(`${PERF_MARK_PREFIX}:send-end`);
    performance.measure(`${PERF_MARK_PREFIX}:send`, `${PERF_MARK_PREFIX}:send-start`, `${PERF_MARK_PREFIX}:send-end`);

    // Log timing summary (dev-only, no user noise)
    const buildMs = performance.getEntriesByName(`${PERF_MARK_PREFIX}:build`)[0]?.duration ?? 0;
    const sendMs = performance.getEntriesByName(`${PERF_MARK_PREFIX}:send`)[0]?.duration ?? 0;
    const totalMs = performance.now() - t0;
    if (process.env.NODE_ENV !== "production" || process.env.DEBUG) {
      console.debug(`[pi-companion] /plan timing: build=${buildMs.toFixed(2)}ms send=${sendMs.toFixed(2)}ms total=${totalMs.toFixed(2)}ms first=${isFirst}`);
    }
  },
});

// ── /implement ─────────────────────────────────────────────────────────

pi.registerCommand("implement", {
  description: "Implement now: split the requirement into parallel subagent tasks, or implement the plan discussed earlier in this session: /implement [requirement]",
  getArgumentCompletions: () => null,
  async handler(args: string, ctx) {
    // Bare /implement means: implement the requirement discussed and agreed earlier in this conversation
    const requirement = args.trim() || "the requirement discussed and agreed earlier in this conversation";

    const prompt = IMPLEMENT_PROMPT_PREFIX + requirement + IMPLEMENT_PROMPT_SUFFIX;
    ctx.ui.notify("Implement request sent, waiting for Agent…", "info");

    // Same first-send optimization as /plan: "new" bypasses followUp scheduling overhead
    const isFirst = !firstImplementSent;
    if (isFirst) firstImplementSent = true;
    const streamingBehavior = isFirst ? "new" : "followUp";

    await pi.sendUserMessage(prompt, { streamingBehavior });
  },
});

	// ── /ralph ──────────────────────────────────────────────────────────────

	pi.registerCommand("ralph", {
		description: "Ralph loop: run a goal in repeated autonomous loops, one task per loop: /ralph <prompt> | /ralph stop | /ralph delete",
		getArgumentCompletions: () => null,
		async handler(args: string, ctx) {
			const trimmed = args.trim();
			if (trimmed.toLowerCase() === "stop") {
				if (!ralphState) {
					ctx.ui.notify("Ralph is not running.", "warning");
					return;
				}
				const done = ralphState.loopsDone;
				const max = ralphState.maxLoops;
				const goal = ralphState.prompt;
				ralphState = undefined;
				clearRalphContinueRetry();
				ctx.ui.notify(`Ralph stopped after ${done}/${max} loops (goal: ${goal}).`, "info");
				return;
			}
			if (trimmed.toLowerCase() === "delete") {
				const planFile = join(process.cwd(), "fix_plan.md");
				if (!existsSync(planFile)) {
					ctx.ui.notify("Nothing to delete: fix_plan.md not found in the current directory.", "warning");
					return;
				}
				try {
					unlinkSync(planFile);
					ctx.ui.notify("Deleted Ralph artifact: fix_plan.md.", "info");
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`Failed to delete fix_plan.md: ${message}`, "error");
				}
				return;
			}
			if (!trimmed) {
				ctx.ui.notify("Please provide a goal: /ralph <prompt> (or /ralph stop, /ralph delete)", "warning");
				return;
			}
			if (ralphState) {
				ctx.ui.notify("Ralph is already running. Use /ralph stop first.", "warning");
				return;
			}
			const config = await loadConfig(ctx as QueueAwareContext, lastConfigError);
			const maxLoops = Math.max(1, config.ralphMaxLoops);
			const commitRequested = RALPH_COMMIT_PATTERN.test(trimmed);
			ralphState = { prompt: trimmed, commitRequested, loopsDone: 1, maxLoops };
			ctx.ui.notify(`Ralph started: loop 1/${maxLoops}${commitRequested ? ", commits enabled" : ""}.`, "info");
			pi.sendUserMessage(buildRalphLoopPrompt(trimmed, 1, maxLoops, commitRequested), { streamingBehavior: "followUp" });
		},
	});



	// ── /reload ──────────────────────────────────────────────────────────────

	pi.registerCommand("rules", {
		description: "Apply ~/.pi/agent/SYSTEM.md rules to current request",
		getArgumentCompletions: () => null,
		async handler(args: string, ctx) {
			let rulesContent = "";
			try {
				const systemPath = join(homedir(), ".pi", "agent", "SYSTEM.md");
				rulesContent = await readFile(systemPath, "utf8");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`[reload] Failed to read ~/.pi/agent/SYSTEM.md: ${message}`, "error");
				return;
			}
			const requirement = args.trim();
			const parts = [];
			if (rulesContent) {
				parts.push("[System Rules]", rulesContent, "");
			}
			parts.push(`[Requirement] ${requirement}`, "", "请严格遵照以上系统规则完成当前需求。");
			const prompt = parts.join("\n");
			pi.sendUserMessage(prompt, { streamingBehavior: "followUp" });
		},
	});

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

	pi.on("agent_start", (event, ctx) => {
		void maybeCompact(pi, event, ctx);
	});

	pi.on("turn_start", (event, ctx) => {
		void maybeCompact(pi, event, ctx);
	});

	pi.on("message_update", async (_event, ctx) => {
		const u = ctx.getContextUsage();
		if (!u || u.tokens == null || u.contextWindow == null) {
			if (!compactDeferred) {
				compactDeferred = true;
			}
		}
	});

	pi.on("agent_settled", async (event, ctx) => {
		await tryDeferredCompact(pi, ctx);
		if (!compactResumePending) void maybeCompact(pi, event, ctx);
		await drainCompactResume(pi, ctx);
		await maybeAutoContinueTerminal(ctx);
		await maybeRalphContinue(ctx);
	});

pi.on("session_start", async () => {
  await ensureBundledConfigFile();
  ralphState = undefined;
  clearRalphContinueRetry();
  firstPlanSent = false; // reset per-session first-plan optimization flag
  firstImplementSent = false; // reset per-session first-implement optimization flag
});

	// ── Ralph loop continuation ──────────────────────────────────────
	function scheduleRalphContinueRetry(ctx: QueueAwareContext, attemptsLeft: number = RALPH_CONTINUE_RETRY_MAX_ATTEMPTS): void {
		clearRalphContinueRetry();
		ralphContinueTimer = setTimeout(() => {
			ralphContinueTimer = undefined;
			if (!ralphState) return;
			if (ctx.hasPendingMessages()) {
				if (attemptsLeft > 1) scheduleRalphContinueRetry(ctx, attemptsLeft - 1);
				return;
			}
			void maybeRalphContinue(ctx);
		}, RALPH_CONTINUE_RETRY_MS);
	}

	async function maybeRalphContinue(ctx: unknown): Promise<void> {
		const state = ralphState;
		if (!state) return;
		clearRalphContinueRetry();
		const guardCtx = ctx as QueueAwareContext;
		if (typeof guardCtx.hasPendingMessages === "function" && guardCtx.hasPendingMessages()) {
			scheduleRalphContinueRetry(guardCtx);
			return;
		}
		const nextLoop = state.loopsDone + 1;
		if (nextLoop > state.maxLoops) {
			ralphState = undefined;
			safeNotify(guardCtx, `Ralph finished: reached loop limit (${state.maxLoops}) for goal: ${state.prompt}`, "info");
			return;
		}
		state.loopsDone = nextLoop;
		try {
			await pi.sendUserMessage(buildRalphLoopPrompt(state.prompt, nextLoop, state.maxLoops, state.commitRequested), { streamingBehavior: "followUp" });
		} catch (err) {
			ralphState = undefined;
			const message = err instanceof Error ? err.message : String(err);
			safeNotify(guardCtx, `Ralph stopped: failed to start loop ${nextLoop}: ${message}`, "error");
		}
	}

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

		if (guardCtx.hasPendingMessages()) return;

		const autoContinueReason = deferredAutoContinueReason ?? shouldTerminalAutoContinue(config, {
			lastMessage: lastAssistantMessage,
			alreadyHandled: lastAssistantAlreadyHandled,
			hasPendingMessages: false,
			consecutiveAutoRetries,
			previousMessageRole,
		});
		if (!autoContinueReason) return;

		if (consecutiveAutoRetries >= config.maxConsecutiveAutoRetries) {
			deferredAutoContinueReason = undefined;
			lastAssistantAlreadyHandled = true;
			lastAssistantMessage = undefined;
			previousMessageRole = undefined;
			if (config.notifyOnAutoContinue) {
				safeNotify(
					guardCtx,
					`[${EXTENSION_NAME}] Reached retry limit (${config.maxConsecutiveAutoRetries}). Skipping "${config.retryMessage}".`,
					"warning",
				);
			}
			return;
		}

		consecutiveAutoRetries += 1;
		pendingAutoRetryMessage = config.retryMessage;
		deferredAutoContinueReason = undefined;
		lastAssistantAlreadyHandled = true;
		lastAssistantMessage = undefined;
		previousMessageRole = undefined;


		if (config.notifyOnAutoContinue) {
			// Extract error text for filtering specific errors from notifications
			const lastMsg = lastAssistantMessage;
			const errorText = lastMsg
				? [lastMsg.errorMessage, extractTextBlocks(lastMsg.content)]
					.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
					.join("\n")
				: "";
			const isOverloadedError = /service temporarily overloaded/i.test(errorText);
			if (!isOverloadedError) {
				safeNotify(
					guardCtx,
					`[${EXTENSION_NAME}] ${autoContinueReason.notification}. Sending "${config.retryMessage}" (${consecutiveAutoRetries}/${config.maxConsecutiveAutoRetries}).`,
					"info",
				);
			}
		}
		if (autoContinueReason.kind === "length") {
			await startLedgerCompaction(pi, guardCtx as unknown as ExtensionContext, false);
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
		// Do not send the retry from agent_end: Pi can still be processing even
		// after willRetry=false, and sendUserMessage/streamingBehavior may reject with
		// "Agent is already processing". agent_settled is the safe injection point.
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
			deferredAutoContinueReason = undefined;
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
			deferredAutoContinueReason = undefined;
			return;
		}

		// ── Load config ──
		const config = await loadConfig(ctx as QueueAwareContext, lastConfigError);
		if (!config.enabled) {
			consecutiveAutoRetries = 0;
			pendingAutoRetryMessage = undefined;
			deferredAutoContinueReason = undefined;
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
			deferredAutoContinueReason = undefined;
			return;
		}

		// ── Defer injection until agent_settled ──
		// message_end/agent_end can fire while the runtime is still processing.
		// Queueing the follow-up from agent_settled avoids racing the runtime and
		// prevents "Agent is already processing" from stopping the task.
		deferredAutoContinueReason = autoContinueReason;
		return;
	});

	// ── Advisory watcher (merged from pi-guard) ────────────────────────────
	const advisor = new EmissionGuard();

	pi.on("turn_start", async () => {
		advisor.beginUpdate();
	});

	pi.on("turn_end", async () => {
		advisor.beginUpdate();
	});

	pi.on("tool_call", async (event) => {
		const advice = inspectToolCall(event as AdvisorToolCallEvent);
		if (!advice) return;
		if (!advisor.accept(advice.note)) return;
		pi.events.emit(ADVISORY_EVENT, advice.note, advice.severity);
	});

	pi.on("tool_result", async (event) => {
		const advice = inspectToolResult(event as AdvisorToolResultEvent);
		if (!advice) return;
		if (!advisor.accept(advice.note)) return;
		pi.events.emit(ADVISORY_EVENT, advice.note, advice.severity);
	});

	pi.on("session_shutdown", async () => {
		advisor.reset();
	});
}
