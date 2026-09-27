import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type {
	AgentSession,
	buildSessionContext,
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

export type { AgentSession, ExtensionAPI, ExtensionCommandContext };

export type AgentMessage = ReturnType<typeof buildSessionContext>["messages"][number];
export type Model = NonNullable<ExtensionCommandContext["model"]>;
export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
export type Theme = ExtensionCommandContext["ui"]["theme"];
export type UIContext = ExtensionCommandContext["ui"];

export type AgentCommandName = "agent";
export type MainContextState = "separate" | "will-squash" | "squashed" | "rebased";
export type AgentStatus =
	| "starting"
	| "running"
	| "done-waiting-to-post"
	| "idle"
	| "posted"
	| "error";

export type ParsedAgentCommand = {
	isolate: boolean;
	squash: boolean;
	/** Wrap the task in the plan prompt template before dispatching (extension-owned -P/--plan). */
	plan: boolean;
	/** -p/--plan-relay reference: "latest" or an agent id; absent when -p was not passed. */
	planRef?: string;
	/** Leading pi CLI tokens (minus the extension's own options) to forward to the child, e.g. ["--thinking", "high"]. */
	forwardedArgs: string[];
	task: string;
	/** Advisory messages surfaced to the user (e.g. a recognized option was typed inside the prose body). */
	warnings: string[];
};

export type AgentEntryData = {
	content: string;
	details: AgentCommandDetails;
};

export type DetachedEntryData = {
	sessionId: string;
};

export type RebaseStats = {
	messageCount: number;
	tokenEstimate: number;
	compactionCount: number;
};

export type RebasedEntryData = {
	sessionId: string;
	/** Absent on entries persisted before stats existed. */
	stats?: RebaseStats;
};

/**
 * A child compaction captured from its compaction_end event. keptTailCount records how many
 * messages the compaction kept verbatim, so a rebase replay can restore the exact boundary.
 */
export type ChildCompactionMessage = Extract<AgentMessage, { role: "compactionSummary" }> & {
	keptTailCount?: number;
};

export type AgentResultMessage = {
	customType: string;
	content: string;
	display: boolean;
	details: AgentCommandDetails;
};

export type AgentCommandDetails = {
	agentId?: string;
	/** The child's own session id — lets /agent resume locate the failed agent's session file. */
	sessionId?: string;
	command: AgentCommandName;
	mainContextState?: MainContextState;
	inheritedContext: boolean;
	model: string;
	modelLabel: string;
	task: string;
	ok: boolean;
	durationMs?: number;
	toolUses?: number;
	turnCount?: number;
	responseText?: string;
	/** Retained for completed entries written before responseText was persisted. */
	responsePreview?: string;
	error?: string;
	/** Whether compression was applied to the squashed message. */
	compressionApplied?: boolean;
	/** Reference to full content (sessionId) when compression is applied. */
	fullContentReference?: string;
	/** Blueprint session whose plan this agent relayed via -p, when applicable. */
	planSourceSessionId?: string;
};

export type RunningAgent = {
	id: string;
	/** The child's own Pi session, resumable with `/resume <sessionId>` after the agent is detached. */
	sessionId: string;
	command: AgentCommandName;
	inheritedContext: boolean;
	model: string;
	modelLabel: string;
	task: string;
	/** The slash command line as the user typed it, e.g. `/agent -s fix the bug`. */
	invocation: string;
	/** -s/--squash: post invocation+result to the main agent and trigger its turn, instead of waiting quietly for the next user prompt. */
	notifyMainAgent: boolean;
	/** Whether this agent was dispatched in plan mode (-P/--plan). */
	planMode: boolean;
	/** Blueprint session the -p relay consumed; carried into result details for traceability. */
	planSourceSessionId?: string;
	/** Fingerprint of the main context the child was dispatched from ("[]" for -i); the rebase fast-forward base. */
	dispatchBaseFingerprint: string;
	mainContextState: MainContextState;
	status: AgentStatus;
	startedAt: number;
	/** Start of the current turn — equals startedAt until the user resumes an idle agent. */
	turnStartedAt: number;
	completedAt?: number;
	activeTools: Map<string, string>;
	toolUses: number;
	turnCount: number;
	responseText: string;
	/** Append-only child conversation, independent from model context compaction. */
	conversationMessages: AgentMessage[];
	latestFinalizedMessage?: AgentMessage;
	error?: string;
	session?: AgentSession;
	/** Latest completed turn's result message, deliverable to the main agent via the overlay's squash action. */
	pendingSquashMessage?: AgentResultMessage;
	/** Starts another turn on an idle agent; assigned while the lifecycle loop awaits the next instruction. */
	resume?: (instruction: string) => void;
	/** Ends an idle agent's lifecycle without another turn; assigned alongside resume. */
	retire?: () => void;
	finished: Promise<void>;
	/** Set when the user closes an in-flight agent from the widget — suppresses the error entry and transcript post. */
	aborted?: boolean;
	/** Set when the user interrupts only the active turn, leaving the child session alive. */
	interruptRequested?: boolean;
	/** Retry count for the current turn (reset on success). */
	retryCount?: number;
};

export type CompletedAgent = {
	id: string;
	sessionId: string;
	command: AgentCommandName;
	modelLabel: string;
	task: string;
	/** The slash command line as the user typed it, e.g. `/spawn fix the bug`. */
	invocation: string;
	/** Whether this agent ran in plan mode (-P/--plan), i.e. a relayable blueprint. */
	planMode: boolean;
	dispatchBaseFingerprint: string;
	mainContextState: MainContextState;
	pendingSquashMessage?: AgentResultMessage;
	ok: boolean;
	responseText: string;
	messages: AgentMessage[];
	error?: string;
	startedAt: number;
	durationMs: number;
	toolUses: number;
	turnCount: number;
	contextPercent?: number;
};

/** The mechanism that fast-forwards a child conversation onto the main session, injected into the widget. */
export type RebaseDelivery = {
	/** Whether the main session's live context still equals this agent's dispatch base. */
	canDeliver(agent: RunningAgent | CompletedAgent): boolean;
	/** Append the processed child conversation onto the main session. */
	deliver(agent: RunningAgent | CompletedAgent, messages: AgentMessage[]): void;
};

/** How long a confirmation stays armed, and how long a transient footer notice shows. */
export const CONFIRMATION_WINDOW_MS = 4000;

/**
 * A two-press confirmation with a timeout: the first press arms it, a repeat press on the
 * same target within the window confirms. A press on another target re-arms, cancel or
 * expiry disarms. One instance serves every confirmable action on a surface.
 */
export class TimedConfirmation<Target> {
	private armedOn: Target | undefined;
	private expiry: ReturnType<typeof setTimeout> | undefined;

	private readonly onExpire: () => void;
	private readonly windowMs: number;

	constructor(
		onExpire: () => void,
		windowMs: number = CONFIRMATION_WINDOW_MS,
	) {
		this.onExpire = onExpire;
		this.windowMs = windowMs;
	}

	/** One press of the action key: true means confirmed, false means armed and waiting. */
	press(target: Target): boolean {
		if (this.armedOn === target) {
			this.cancel();
			return true;
		}
		this.armedOn = target;
		if (this.expiry) clearTimeout(this.expiry);
		this.expiry = setTimeout(() => {
			this.armedOn = undefined;
			this.expiry = undefined;
			this.onExpire();
		}, this.windowMs);
		return false;
	}

	cancel(): void {
		this.armedOn = undefined;
		if (this.expiry) clearTimeout(this.expiry);
		this.expiry = undefined;
	}

	isArmedOn(target: Target): boolean {
		return this.armedOn !== undefined && this.armedOn === target;
	}
}

export const MESSAGE_TYPE = "pi-user-agents";
export const DETACHED_ENTRY_TYPE = "pi-user-agents-detached";
export const REBASED_ENTRY_TYPE = "pi-user-agents-rebased";
export const WIDGET_KEY = "pi-user-agents";
export const STEERING_LOG_PATH = `${tmpdir()}/pi-user-agents-steer.log`;

export function logSteering(
	agentId: string,
	event: string,
	details: Record<string, unknown> = {},
): void {
	void appendFile(
		STEERING_LOG_PATH,
		`${new Date().toISOString()} ${JSON.stringify({ agentId, event, ...details })}\n`,
	).catch(() => undefined);
}
export const MAX_WIDGET_LINES = 9;
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const TOOL_DISPLAY: Record<string, string> = {
	read: "reading",
	bash: "running command",
	edit: "editing",
	write: "writing",
	grep: "searching",
	find: "finding files",
	ls: "listing",
};

export function formatModel(model: Model): string {
	return `${model.provider}/${model.id}${model.name && model.name !== model.id ? ` (${model.name})` : ""}`;
}

export function formatModelLabel(model: Model): string {
	return model.name && model.name !== model.id ? model.name : model.id;
}

export function contextLabel(inheritedContext: boolean): string {
	return inheritedContext ? "inherited context" : "isolated";
}

export function mainContextLabel(state: MainContextState | undefined): string | undefined {
	if (state === "will-squash") return "will squash into context";
	if (state === "squashed") return "squashed messages into context";
	if (state === "rebased") return "rebased into context";
	return undefined;
}

export function formatTurns(turnCount: number): string {
	return `↻${turnCount}`;
}

export function formatToolUses(toolUses: number): string {
	return `${toolUses} tool use${toolUses === 1 ? "" : "s"}`;
}

export function formatMs(ms: number): string {
	if (!Number.isFinite(ms)) return "0.0s";
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}m ${seconds}s`;
}

export function truncatePlain(text: string, length: number): string {
	const line =
		text
			.split("\n")
			.find((part) => part.trim())
			?.trim() ?? "";
	if (line.length <= length) return line;
	return `${line.slice(0, Math.max(0, length - 1))}…`;
}

export function extractTag(
	content: string,
	tag: "task" | "response" | "error" | "duration_ms" | "user_invocation",
): string | undefined {
	const match = content.match(new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`));
	return match?.[1]?.trim();
}

export function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ── /agent resume: failed-agent recovery ────────────────────────────────────

/** A failed background agent recoverable by /agent resume, from persisted entries or widget cards. */
export type FailedAgentTarget = {
	agentId: string;
	/** The child's own session id; absent on entries persisted before session tracking was added. */
	sessionId?: string;
	command: AgentCommandName;
	task: string;
	/** The slash-command line as the user originally typed it, e.g. `/agent -s fix the bug`. */
	invocation?: string;
	error?: string;
	/** Blueprint session the -p relay consumed, when applicable. */
	planSourceSessionId?: string;
};

/** Structural view of a persisted session entry, so the resume scan stays a pure, loader-free function. */
export type AgentResultEntryLike = {
	type: string;
	customType?: string;
	content?: unknown;
	details?: AgentCommandDetails;
};

function entryContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				part?.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

/**
 * Latest persisted status per agentId: a failed target, or undefined when the agent later
 * succeeded (success voids earlier failures). Ids absent from the map were never persisted.
 */
function latestStatusByAgentId(
	entries: readonly AgentResultEntryLike[],
): Map<string, FailedAgentTarget | undefined> {
	const latest = new Map<string, FailedAgentTarget | undefined>();
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== MESSAGE_TYPE) continue;
		const details = entry.details;
		if (!details?.agentId) continue;
		if (details.ok) {
			latest.set(details.agentId, undefined);
			continue;
		}
		latest.set(details.agentId, {
			agentId: details.agentId,
			sessionId: details.sessionId,
			command: details.command,
			task: details.task,
			invocation: extractTag(entryContentText(entry.content), "user_invocation"),
			error: details.error,
			planSourceSessionId: details.planSourceSessionId,
		});
	}
	return latest;
}

/**
 * Scan persisted session entries (root-to-leaf order) for failed agents: entries whose latest
 * status per agentId is ok:false. Successes void earlier failures for the same id; entries
 * without an agentId are dispatch-time errors that never created an agent and are ignored.
 *
 * @example collectFailedAgentTargets([]).length // 0
 */
export function collectFailedAgentTargets(
	entries: readonly AgentResultEntryLike[],
): FailedAgentTarget[] {
	const targets: FailedAgentTarget[] = [];
	for (const target of latestStatusByAgentId(entries).values()) if (target) targets.push(target);
	return targets;
}

export type ResumeSelection = {
	/** Set when resuming is refused outright (e.g. mid-shutdown). */
	blocked?: string;
	targets: FailedAgentTarget[];
	/** Ids seen as failed but not resumable right now. */
	skipped: { agentId: string; reason: string }[];
};

/**
 * Decide what /agent resume restarts: persisted failed entries merged with live widget failure
 * cards (persisted state wins per id — a card whose agent later succeeded is not failed), minus
 * ids already running again.
 */
export function selectResumeTargets(request: {
	isShuttingDown: boolean;
	entries: readonly AgentResultEntryLike[];
	widgetTargets: readonly FailedAgentTarget[];
	runningAgentIds: Iterable<string>;
}): ResumeSelection {
	if (request.isShuttingDown)
		return {
			blocked: "Cannot resume failed agents while the session is shutting down.",
			targets: [],
			skipped: [],
	};
	const persisted = latestStatusByAgentId(request.entries);
	const byId = new Map<string, FailedAgentTarget>();
	for (const target of persisted.values()) if (target) byId.set(target.agentId, target);
	// Widget cards cover agents whose failure never persisted (e.g. failure during shutdown).
	// Persisted state wins per id: a card whose agent later succeeded (undefined) stays out.
	for (const target of request.widgetTargets)
		if (!persisted.has(target.agentId)) byId.set(target.agentId, target);
	const running = new Set(request.runningAgentIds);
	const targets: FailedAgentTarget[] = [];
	const skipped: { agentId: string; reason: string }[] = [];
	for (const target of byId.values()) {
		if (running.has(target.agentId)) {
			skipped.push({ agentId: target.agentId, reason: "already running again" });
			continue;
		}
		targets.push(target);
	}
	return { targets, skipped };
}

export type AgentResumePlan =
	| { mode: "continue"; sessionFile: string }
	| { mode: "redispatch"; reason: string }
	| { mode: "skip"; reason: string };

/**
 * How to bring one failed agent back: continue its own session file when it still exists,
 * otherwise re-dispatch from scratch. Plan-relay agents cannot be re-dispatched — the relayed
 * plan body lives only in their session, not in the persisted task.
 */
export function planFailedAgentResume(
	target: FailedAgentTarget,
	sessionFile: string | undefined,
	invocationUsesPlanRelay: boolean,
): AgentResumePlan {
	const missing = target.sessionId
		? `session file for ${target.agentId} is missing`
		: `${target.agentId} predates per-agent session tracking`;
	if (sessionFile) return { mode: "continue", sessionFile };
	if (invocationUsesPlanRelay)
		return { mode: "skip", reason: `${missing}, and a plan-relay agent cannot be re-dispatched without its session — run /agent -p again instead` };
	return { mode: "redispatch", reason: `${missing}; re-dispatching from scratch` };
}

/** Strip the leading /command token from an invocation line, yielding the args the parser expects. */
export function agentArgsFromInvocation(invocation: string | undefined): string {
	if (!invocation) return "";
	const match = /^\/\S+\s+([\s\S]*)$/.exec(invocation.trim());
	return match?.[1] ?? "";
}
