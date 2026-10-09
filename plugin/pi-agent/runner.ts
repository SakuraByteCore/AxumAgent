import * as os from "node:os";
import * as path from "node:path";
import { readdir } from "node:fs/promises";
import {
	type AgentSessionEvent,
	type AgentSessionServices,
	type Args,
	buildSessionContext,
	estimateTokens,
	createAgentSessionFromServices,
	createAgentSessionServices,
	getAgentDir,
	type ModelRuntime,
	parseArgs,
	resolveCliModel,
	sessionEntryToContextMessages,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { resolveAgentUiModelOverride } from "./agentui-prefs.js";
import { type AgentValueValidator, parseAgentCommand, scanAgentArguments } from "./command-line.js";
import {
	assistantText,
	AgentStopError,
	EmptyAgentTextError,
	NoAssistantMessageError,
	getFinalAssistantText,
	NO_TEXT_RESPONSE_NUDGE,
} from "./final-response.js";
import { buildPlanPrompt } from "./plan-prompt.js";
import { conversationFingerprint, mainContextFingerprint } from "./rebase.js";
import { AGENT_PRESETS, buildPresetArgs } from "./presets.js";
import type {
	AgentCommandName,
	AgentEntryData,
	AgentMessage,
	AgentResultMessage,
	AgentSession,
	ChildCompactionMessage,
	CompletedAgent,
	ExtensionAPI,
	ExtensionCommandContext,
	FailedAgentTarget,
	Model,
	ParsedAgentCommand,
	RebaseDelivery,
	RebasedEntryData,
	RunningAgent,
	ThinkingLevel,
} from "./shared.js";
import {
	agentArgsFromInvocation,
	errorMessage,
	formatModel,
	formatModelLabel,
	logSteering,
	MESSAGE_TYPE,
	planFailedAgentResume,
	REBASED_ENTRY_TYPE,
	selectResumeTargets,
} from "./shared.js";
import {
	buildAgentResultMessage,
	formatCommandErrorMessage,
	formatStartNotification,
	reportCommandError,
} from "./transcript.js";
import {
	completedPlanCandidate,
	composeRelayInstruction,
	resolvePlanRelay,
	runningPlanCandidate,
} from "./plan-relay.js";
import type { UserAgentWidget } from "./widget.js";

export { parseAgentCommand };

export async function handleAgentCommand(
	pi: ExtensionAPI,
	runningAgents: Set<RunningAgent>,
	widget: UserAgentWidget,
	disabledCommands: Set<string>,
	isShuttingDown: () => boolean,
	nextAgentNumber: () => number,
	command: AgentCommandName,
	args: string,
	invocation: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	try {
		// `/agent resume` subcommand: restart every failed background agent. Strict full match —
		// anything after `resume` is a usage error, so a task whose first word is literally
		// "resume" can still be dispatched by quoting that word (quotes flip the parser to prose).
		const trimmed = args.trim();
		const firstToken = trimmed.split(/\s+/)[0] ?? "";
		if (command === "agent" && firstToken === "resume") {
			if (trimmed !== "resume")
				throw new Error(
					'/agent resume takes no arguments. To dispatch a task whose first word is "resume", quote that word: /agent "resume …"',
			);
			await resumeFailedAgents(pi, runningAgents, widget, disabledCommands, isShuttingDown, ctx);
			return;
		}
		await startUserAgent(
			pi,
			runningAgents,
			widget,
			disabledCommands,
			isShuttingDown,
			nextAgentNumber,
			command,
			args,
			invocation,
			ctx,
		);
	} catch (error) {
		reportCommandError(pi, command, args, ctx, errorMessage(error));
	}
}

/** Inputs resolved once per dispatch and reused by /agent resume: services, options, model, thinking. */
type ChildDispatchServices = {
	services: AgentSessionServices;
	forwarded: ForwardedOptions;
	model: Model;
	thinkingLevel: ThinkingLevel;
};

async function resolveChildDispatchServices(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	forwardedArgs: string[],
	invocation: string,
): Promise<ChildDispatchServices> {
	const parsedForwardedArgs = parseForwardedArgs(forwardedArgs);
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(ctx.cwd, agentDir, {
		projectTrusted: ctx.isProjectTrusted(),
	});
	const services = await createAgentSessionServices({
		cwd: ctx.cwd,
		agentDir,
		settingsManager,
		modelRuntime: (ctx.modelRegistry as unknown as { runtime: ModelRuntime }).runtime,
		resourceLoaderOptions: buildChildResourceLoaderOptions(parsedForwardedArgs, ctx.cwd),
	});
	const forwarded = resolveForwardedOptions(parsedForwardedArgs, services.modelRuntime);
	// /agentui session-scoped override: /spawn and /blueprint presets only. A stale or
	// unavailable choice warns and falls back to the inherited current-session model.
	let selectedModel = forwarded.model ?? ctx.model;
	const agentUiOverride = resolveAgentUiModelOverride(invocation, ctx.sessionManager.getSessionId());
	if (agentUiOverride) {
		const resolvedOverride = services.modelRuntime.getModel(agentUiOverride.provider, agentUiOverride.id);
		if (resolvedOverride) {
			selectedModel = resolvedOverride;
		} else if (ctx.hasUI) {
			ctx.ui.notify(
				`/agentui model ${agentUiOverride.provider}/${agentUiOverride.id} is no longer available; falling back to the current session model.`,
				"warning",
			);
		}
	}
	if (!selectedModel) throw new Error("No current model is selected; pass -m MODELNAME");
	const model =
		services.modelRuntime.getModel(selectedModel.provider, selectedModel.id) ?? selectedModel;
	const thinkingLevel = forwarded.thinkingLevel ?? pi.getThinkingLevel();
	return { services, forwarded, model, thinkingLevel };
}

/** The tail every dispatch and resume share: register the agent, notify, and run its lifecycle. */
function launchRunningAgent(
	pi: ExtensionAPI,
	runningAgents: Set<RunningAgent>,
	widget: UserAgentWidget,
	disabledCommands: Set<string>,
	isShuttingDown: () => boolean,
	command: AgentCommandName,
	dispatch: ChildDispatchServices,
	warnings: string[],
	task: string,
	inheritedMessages: AgentMessage[],
	childSessionManager: SessionManager,
	runningAgent: RunningAgent,
	ctx: ExtensionCommandContext,
): void {
	runningAgents.add(runningAgent);
	logSteering(runningAgent.id, "agent-created", { command, taskLength: task.length });
	if (ctx.hasUI) {
		widget.setUI(ctx.ui);
		for (const warning of warnings) ctx.ui.notify(warning, "warning");
		ctx.ui.notify(formatStartNotification(runningAgent), "info");
		widget.ensureTimer();
		widget.update();
	}

	runningAgent.finished = runAgentLifecycle(
		pi,
		isShuttingDown,
		task,
		dispatch.model,
		dispatch.thinkingLevel,
		dispatch.forwarded,
		inheritedMessages,
		dispatch.services,
		childSessionManager,
		runningAgent,
		widget,
	).finally(() => {
		logSteering(runningAgent.id, "agent-disposed", { status: runningAgent.status });
		runningAgent.session?.dispose();
		runningAgents.delete(runningAgent);

		// Check if this command should be auto-disabled
		if (command !== "agent" && runningAgent.status === "delivered") {
			const { getCommandRetentionSettings } = require("../../src/provider-config.js");
			const settings = getCommandRetentionSettings();
			if (!settings.retainTemporaryCommands) {
				disabledCommands.add(command);
				pi.ui?.notify(
					`✓ /${command} completed and auto-removed. Enable retention in Settings to keep it.`,
					"info",
				);
			}
		}

		widget.update();
	});
}

// ── /agent resume: restart every failed background agent ──────────────────────

// A continued agent forked from an older main context that cannot be reconstructed here, so its
// rebase base deliberately never matches the live main session (rebase stays blocked; squash
// still works). Real fingerprints are JSON arrays, so a bare quoted word cannot collide.
const RESUME_REBASE_BASE_FINGERPRINT = '"pi-user-agents-resumed"';

async function resumeFailedAgents(
	pi: ExtensionAPI,
	runningAgents: Set<RunningAgent>,
	widget: UserAgentWidget,
	disabledCommands: Set<string>,
	isShuttingDown: () => boolean,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const selection = selectResumeTargets({
		isShuttingDown: isShuttingDown(),
		entries: (ctx.sessionManager as unknown as SessionManager).getBranch(),
		widgetTargets: widget.failedCompletedAgents().map(failedTargetFromCard),
		runningAgentIds: [...runningAgents].map((agent) => agent.id),
	});
	if (selection.blocked) throw new Error(selection.blocked);
	for (const skip of selection.skipped)
		reportResumeNotice(pi, ctx, `${skip.agentId}: ${skip.reason}`, "warning");
	if (selection.targets.length === 0) {
		reportResumeNotice(pi, ctx, "No failed background agents to resume.", "info");
		return;
	}
	if (ctx.hasUI)
		ctx.ui.notify(
			`Resuming ${selection.targets.length} failed agent${selection.targets.length === 1 ? "" : "s"}…`,
			"info",
		);
	for (const target of selection.targets) {
		try {
			await resumeOneFailedAgent(
				pi,
				runningAgents,
				widget,
				disabledCommands,
				isShuttingDown,
				target,
				ctx,
			);
		} catch (error) {
			reportResumeNotice(
				pi,
				ctx,
				`Could not resume ${target.agentId}: ${errorMessage(error)}`,
				"error",
			);
		}
	}
}

function failedTargetFromCard(card: CompletedAgent): FailedAgentTarget {
	return {
		agentId: card.id,
		sessionId: card.sessionId,
		command: card.command,
		task: card.task,
		invocation: card.invocation,
		error: card.error,
	};
}

/** Surface a /agent resume outcome: transient notice with a UI, transcript entry without one. */
function reportResumeNotice(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	message: string,
	level: "info" | "warning" | "error",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
		return;
	}
	pi.appendEntry<AgentEntryData>(MESSAGE_TYPE, {
		content: formatCommandErrorMessage("agent", "resume", message),
		details: {
			command: "agent",
			inheritedContext: false,
			model: "",
			modelLabel: "",
			task: "resume",
			ok: level !== "error",
			responseText: level === "error" ? undefined : message,
			error: level === "error" ? message : undefined,
		},
	});
}

/** Re-apply a preset's baked-in flags (/spawn → -s, …) — presets encode them outside the invocation text. */
function presetPrefixFromInvocation(invocation: string): string {
	const name = /^\/(\S+)/.exec(invocation)?.[1];
	const preset = AGENT_PRESETS.find((candidate) => candidate.name === name);
	return preset ? buildPresetArgs(preset, "") : "";
}

/** Recover the original dispatch options from the persisted invocation; task comes from the entry. */
function parseResumeCommand(target: FailedAgentTarget, invocation: string): ParsedAgentCommand {
	const args = `${presetPrefixFromInvocation(invocation)} ${agentArgsFromInvocation(invocation)}`.trim();
	const scan = scanAgentArguments(args, target.command);
	return {
		isolate: scan.isolate,
		squash: scan.squash,
		plan: scan.plan,
		planRef: scan.planRef,
		forwardedArgs: scan.forwardedArgs,
		task: target.task,
		warnings: [],
	};
}

function continuationInstruction(target: FailedAgentTarget): string {
	const error = target.error?.trim() || "an internal error";
	return [
		"Your previous attempt at this task ended in failure:",
		`<previous_error>\n${error}\n</previous_error>`,
		"The task is NOT complete. Pick up where the previous attempt left off — its earlier turns, tool results, and file edits are already part of your context — and finish the original task.",
		`<original_task>\n${target.task}\n</original_task>`,
	].join("\n\n");
}

/** Locate a failed agent's session file in the default session dir for the dispatch cwd. */
async function findChildSessionFile(
	cwd: string,
	sessionId: string | undefined,
): Promise<string | undefined> {
	if (!sessionId) return undefined;
	// Child sessions are always created with the default session dir for the dispatch cwd
	// (SessionManager.create(cwd, undefined, …)). The layout mirrors the SDK's internal
	// getDefaultSessionDirPath: <agentDir>/sessions/--<sanitized-cwd>--/, files <timestamp>_<sessionId>.jsonl.
	const safeDir = `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const dir = path.join(getAgentDir(), "sessions", safeDir);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return undefined;
	}
	const suffix = `_${sessionId}.jsonl`;
	const matches = names.filter((name) => name.endsWith(suffix)).sort();
	return matches.length > 0 ? path.join(dir, matches.at(-1)!) : undefined;
}

async function resumeOneFailedAgent(
	pi: ExtensionAPI,
	runningAgents: Set<RunningAgent>,
	widget: UserAgentWidget,
	disabledCommands: Set<string>,
	isShuttingDown: () => boolean,
	target: FailedAgentTarget,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const invocation = target.invocation ?? `/${target.command} ${target.task}`.trim();
	const parsed = parseResumeCommand(target, invocation);
	const sessionFile = await findChildSessionFile(ctx.cwd, target.sessionId);
	const plan = planFailedAgentResume(target, sessionFile, parsed.planRef !== undefined);
	if (plan.mode === "skip") {
		reportResumeNotice(pi, ctx, `${target.agentId}: ${plan.reason}`, "warning");
		return;
	}
	const dispatch = await resolveChildDispatchServices(pi, ctx, parsed.forwardedArgs, invocation);
	let childSessionManager: SessionManager;
	let inheritedMessages: AgentMessage[];
	let task: string;
	if (plan.mode === "continue") {
		childSessionManager = SessionManager.open(plan.sessionFile);
		// The session file already carries the inherited snapshot from the original dispatch.
		inheritedMessages = [];
		task = continuationInstruction(target);
		reportResumeNotice(pi, ctx, `${target.agentId}: continuing its saved session`, "info");
	} else {
		childSessionManager = SessionManager.create(dispatch.services.cwd, undefined, {
			parentSession: ctx.sessionManager.getSessionFile(),
		});
		inheritedMessages = parsed.isolate ? [] : buildInheritedMessages(ctx);
		// target.task is already the dispatched prompt: -P agents persist the plan-wrapped task
		// (buildPlanPrompt runs in startUserAgent BEFORE the entry is recorded), so no re-wrap here.
		task = target.task;
		reportResumeNotice(pi, ctx, `${target.agentId}: ${plan.reason}`, "warning");
	}
	// The id is reused on purpose: "latest entry per agentId" makes the old failure void once this
	// run succeeds, and keeps it resumable if it fails again — no extra bookkeeping entries needed.
	const runningAgent = createRunningAgent(
		target.agentId,
		childSessionManager.getSessionId(),
		target.command,
		dispatch.model,
		parsed,
		invocation,
		target.planSourceSessionId,
		plan.mode === "continue"
			? RESUME_REBASE_BASE_FINGERPRINT
			: conversationFingerprint(inheritedMessages),
	);
	widget.removeFailedCompletedById(target.agentId);
	launchRunningAgent(
		pi,
		runningAgents,
		widget,
		disabledCommands,
		isShuttingDown,
		target.command,
		dispatch,
		[],
		task,
		inheritedMessages,
		childSessionManager,
		runningAgent,
		ctx,
	);
}

/** Warn (without blocking) when a dispatch skips -p while a blueprint is still mid-turn. */
function warnLiveBlueprint(runningAgents: Set<RunningAgent>, ctx: ExtensionCommandContext): void {
	const live = [...runningAgents].find(
		(agent) => agent.planMode && (agent.status === "starting" || agent.status === "running"),
	);
	if (!live || !ctx.hasUI) return;
	ctx.ui.notify(
		`Blueprint ${live.id} is still running and its plan is not in this agent's context yet. ` +
			"Dispatch again with -p to wait for the plan and relay it verbatim.",
		"warning",
	);
}

export async function startUserAgent(
	pi: ExtensionAPI,
	runningAgents: Set<RunningAgent>,
	widget: UserAgentWidget,
	disabledCommands: Set<string>,
	isShuttingDown: () => boolean,
	nextAgentNumber: () => number,
	command: AgentCommandName,
	args: string,
	invocation: string,
	ctx: ExtensionCommandContext,
): Promise<RunningAgent> {
	const parsed = parseAgentCommand(args, command);
	const userSupplement = parsed.task;
	let relayInstruction: string | undefined;
	let planSourceSessionId: string | undefined;
	if (parsed.planRef) {
		const source = await resolvePlanRelay(parsed.planRef, {
			running: () => [...runningAgents].filter((agent) => agent.planMode).map(runningPlanCandidate),
			completed: () => widget.completedPlanAgents().map(completedPlanCandidate),
			notify: (message) => {
				if (ctx.hasUI) ctx.ui.notify(message, "info");
			},
		});
		if (!parsed.task) parsed.task = source.task;
		relayInstruction = composeRelayInstruction(source, userSupplement);
		planSourceSessionId = source.sessionId;
	} else if (!parsed.plan) {
		warnLiveBlueprint(runningAgents, ctx);
	}
	if (parsed.plan) {
		parsed.task = await buildPlanPrompt(parsed.task);
	}
	const dispatch = await resolveChildDispatchServices(pi, ctx, parsed.forwardedArgs, invocation);
	const inheritedMessages = parsed.isolate ? [] : buildInheritedMessages(ctx);
	// A real session file from birth: the child outlives the widget row and stays resumable.
	const childSessionManager = SessionManager.create(dispatch.services.cwd, undefined, {
		parentSession: ctx.sessionManager.getSessionFile(),
	});
	const runningAgent = createRunningAgent(
		`user-${nextAgentNumber().toString(36)}`,
		childSessionManager.getSessionId(),
		command,
		dispatch.model,
		parsed,
		invocation,
		planSourceSessionId,
		conversationFingerprint(inheritedMessages),
	);
	launchRunningAgent(
		pi,
		runningAgents,
		widget,
		disabledCommands,
		isShuttingDown,
		command,
		dispatch,
		parsed.warnings,
		relayInstruction ?? parsed.task,
		inheritedMessages,
		childSessionManager,
		runningAgent,
		ctx,
	);
	return runningAgent;
}

function createRunningAgent(
	agentId: string,
	sessionId: string,
	command: AgentCommandName,
	model: Model,
	parsed: ParsedAgentCommand,
	invocation: string,
	planSourceSessionId?: string,
	dispatchBaseFingerprint: string,
): RunningAgent {
	return {
		id: agentId,
		sessionId,
		command,
		inheritedContext: !parsed.isolate,
		model: formatModel(model),
		modelLabel: formatModelLabel(model),
		task: parsed.task,
		invocation,
		notifyMainAgent: parsed.squash,
		planMode: parsed.plan,
		planSourceSessionId,
		dispatchBaseFingerprint,
		mainContextState: parsed.squash ? "will-squash" : "separate",
		status: "starting",
		startedAt: Date.now(),
		turnStartedAt: Date.now(),
		activeTools: new Map(),
		toolUses: 0,
		turnCount: 0,
		responseText: "",
		conversationMessages: [],
		finished: Promise.resolve(),
	};
}

function postUserAgentResult(
	pi: ExtensionAPI,
	isShuttingDown: () => boolean,
	notifyMainAgent: boolean,
	message: AgentResultMessage,
): boolean {
	if (isShuttingDown()) return false;
	if (notifyMainAgent) {
		// Steers into a streaming turn, or triggers an immediate response when idle.
		pi.sendMessage(message, { triggerTurn: true });
	} else {
		// TUI-only session entry: renders in the transcript but never enters the main agent's context.
		pi.appendEntry(message.customType, { content: message.content, details: message.details });
	}
	return true;
}

/**
 * The rebase mechanism: fast-forward a child conversation onto the session that dispatched it.
 *
 * Delivery appends the messages to the main session file, drops a persisted breadcrumb naming
 * the child session, and asks the host to switch to that same file — the one path that rebuilds
 * both the live LLM context and the TUI transcript (see INTERNALS.md).
 */
export function createRebaseDelivery(
	pi: ExtensionAPI,
	getSessionContext: () => ExtensionCommandContext | undefined,
): RebaseDelivery {
	return {
		canDeliver: (agent) => {
			const ctx = getSessionContext();
			return (
				ctx !== undefined &&
				mainContextFingerprint(ctx.sessionManager) === agent.dispatchBaseFingerprint
			);
		},
		deliver: (agent, messages) => {
			const ctx = getSessionContext();
			if (!ctx) throw new Error("No dispatching session context to rebase onto");
			// The runtime object behind the extension's readonly facade is the writable SessionManager.
			const sessionManager = ctx.sessionManager as unknown as SessionManager;
			// A replayed compaction's kept tail may reach back into main's existing context.
			const priorContextEntryIds = sessionManager
				.buildContextEntries()
				.flatMap((entry) => sessionEntryToContextMessages(entry).map(() => entry.id));
			persistMessages(sessionManager, messages, priorContextEntryIds);
			pi.appendEntry<RebasedEntryData>(REBASED_ENTRY_TYPE, {
				sessionId: agent.sessionId,
				stats: {
					messageCount: messages.length,
					tokenEstimate: messages.reduce((total, message) => total + estimateTokens(message), 0),
					compactionCount: messages.filter((message) => message.role === "compactionSummary")
						.length,
				},
			});
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("The main session has no file to switch to");
			void ctx.switchSession(sessionFile).then(
				(result) => {
					if (result.cancelled && ctx.hasUI)
						ctx.ui.notify(
							"The rebase is saved to the session file, but the session switch was cancelled — /resume this session to see it",
							"warning",
						);
				},
				(error) => {
					if (ctx.hasUI)
						ctx.ui.notify(
							`The rebase is saved to the session file, but the session switch failed (${errorMessage(error)}) — /resume this session to see it`,
							"error",
						);
				},
			);
		},
	};
}

/** Session inputs derived from forwarded pi CLI options, ready to hand to the child session. */
type ChildResourceLoaderOptions = {
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	additionalExtensionPaths?: string[];
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	noExtensions?: boolean;
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
};

type ForwardedOptions = {
	model?: Model;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	excludeTools?: string[];
	noTools?: "all" | "builtin";
};

/** Parse forwarded pi CLI tokens once before model and session resolution. */
export function parseForwardedArgs(forwardedArgs: string[]): Args {
	const parsed = parseArgs(forwardedArgs);
	const errors = parsed.diagnostics.filter((diagnostic) => diagnostic.type === "error");
	if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
	return parsed;
}

/**
 * Build editor value validation from the same Pi parser, model resolver, and live catalogs
 * used at submission and session creation.
 */
export function createAgentValueValidator(
	modelRuntime: ModelRuntime,
	getToolNames: () => Iterable<string>,
): AgentValueValidator {
	return (option, value, scan) => {
		if (option.completionDomain === "thinking") {
			return !parseArgs(["--thinking", value]).diagnostics.some(
				(diagnostic) => diagnostic.type === "warning",
			);
		}
		if (option.completionDomain === "provider") {
			return modelRuntime
				.getModels()
				.some((model) => model.provider.toLowerCase() === value.toLowerCase());
		}
		if (option.completionDomain === "tool") {
			const parsed = parseArgs([option.names[0]!, value]);
			const requestedNames = option.semanticId === "tools" ? parsed.tools : parsed.excludeTools;
			const knownNames = new Set(getToolNames());
			return (requestedNames ?? []).every((name) => knownNames.has(name));
		}
		if (option.completionDomain !== "model") return true;
		const parsed = parseArgs(scan.forwardedArgs);
		try {
			resolveForwardedOptions({ ...parsed, model: value }, modelRuntime);
			return true;
		} catch {
			return false;
		}
	};
}

/**
 * Return whether a model value exactly names a live ID, canonical reference, or user alias.
 *
 * @example isExactCatalogModelReference([{ provider: "openai", id: "gpt-5" } as Model], "openai/gpt-5") // true
 */
function isExactCatalogModelReference(
	models: readonly Model[],
	value: string,
	provider: string | undefined,
): boolean {
	const normalizedValue = value.toLowerCase();
	const normalizedProvider = provider?.toLowerCase();
	const exactAliasMatch = models.some(
		(model) => model.name?.toLowerCase() === normalizedValue,
	);
	const exactReferenceMatch = models.some(
		(model) =>
			(normalizedProvider === undefined || model.provider.toLowerCase() === normalizedProvider) &&
			(model.id.toLowerCase() === normalizedValue ||
				`${model.provider}/${model.id}`.toLowerCase() === normalizedValue),
	);
	return exactAliasMatch || exactReferenceMatch;
}

/** Resolve forwarded runtime options against the child session's model runtime. */
export function resolveForwardedOptions(
	parsed: Args,
	modelRuntime: ModelRuntime,
): ForwardedOptions {
	const forwarded: ForwardedOptions = {};
	if (parsed.model) {
		if (!isExactCatalogModelReference(modelRuntime.getModels(), parsed.model, parsed.provider)) {
			const display = parsed.provider ? `${parsed.provider}/${parsed.model}` : parsed.model;
			throw new Error(`Model "${display}" not found in the live model catalog.`);
		}
		const nameMatch = modelRuntime
			.getModels()
			.find((m) => m.name?.toLowerCase() === parsed.model!.toLowerCase());
		if (nameMatch) {
			forwarded.model = nameMatch;
		} else {
			const resolved = resolveCliModel({
				cliProvider: parsed.provider,
				cliModel: parsed.model,
				cliThinking: parsed.thinking,
				modelRuntime,
			});
			if (resolved.error) throw new Error(resolved.error);
			forwarded.model = resolved.model;
			if (!parsed.thinking && resolved.thinkingLevel)
				forwarded.thinkingLevel = resolved.thinkingLevel;
		}
	}
	if (parsed.thinking) forwarded.thinkingLevel = parsed.thinking;

	if (parsed.noTools) forwarded.noTools = "all";
	else if (parsed.noBuiltinTools) forwarded.noTools = "builtin";
	if (parsed.tools) forwarded.tools = parsed.tools;
	if (parsed.excludeTools) forwarded.excludeTools = parsed.excludeTools;
	return forwarded;
}

export function buildChildResourceLoaderOptions(
	parsed: Args,
	cwd: string,
): ChildResourceLoaderOptions | undefined {
	const options: ChildResourceLoaderOptions = {};
	if (parsed.systemPrompt !== undefined) options.systemPrompt = parsed.systemPrompt;
	if (parsed.appendSystemPrompt) options.appendSystemPrompt = parsed.appendSystemPrompt;
	if (parsed.extensions)
		options.additionalExtensionPaths = resolveResourcePaths(parsed.extensions, cwd);
	if (parsed.skills) options.additionalSkillPaths = resolveResourcePaths(parsed.skills, cwd);
	if (parsed.promptTemplates)
		options.additionalPromptTemplatePaths = resolveResourcePaths(parsed.promptTemplates, cwd);
	if (parsed.noExtensions) options.noExtensions = true;
	if (parsed.noSkills) options.noSkills = true;
	if (parsed.noPromptTemplates) options.noPromptTemplates = true;
	if (parsed.noThemes) options.noThemes = true;
	if (parsed.noContextFiles) options.noContextFiles = true;
	return Object.keys(options).length > 0 ? options : undefined;
}

/** Resolve resource paths to absolute against the session cwd, matching how the CLI hands them to the loader. */
function resolveResourcePaths(values: string[], cwd: string): string[] {
	return values.map((value) => {
		if (value === "~" || value.startsWith("~/")) return path.join(os.homedir(), value.slice(1));
		return path.isAbsolute(value) ? value : path.resolve(cwd, value);
	});
}

function buildInheritedMessages(ctx: ExtensionCommandContext): AgentMessage[] {
	return structuredClone(buildSessionContext(ctx.sessionManager.getBranch()).messages);
}

async function runAgentLifecycle(
	pi: ExtensionAPI,
	isShuttingDown: () => boolean,
	task: string,
	model: Model,
	thinkingLevel: ThinkingLevel,
	forwarded: ForwardedOptions,
	inheritedMessages: AgentMessage[],
	services: AgentSessionServices,
	childSessionManager: SessionManager,
	runningAgent: RunningAgent,
	widget: UserAgentWidget,
): Promise<void> {
	let session: AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	try {
		session = await createChildSession(
			model,
			thinkingLevel,
			forwarded,
			inheritedMessages,
			services,
			childSessionManager,
			runningAgent,
			widget,
		);
		unsubscribe = subscribeToChildSession(session, runningAgent, widget);
		await runChildTurns(pi, isShuttingDown, task, session, runningAgent, widget);
	} catch (error) {
		if (runningAgent.aborted) {
			logSteering(runningAgent.id, "agent-aborted");
			return;
		}
		const message = errorMessage(error);
		logSteering(runningAgent.id, "agent-error", { error: message });
		runningAgent.status = "error";
		runningAgent.completedAt = Date.now();
		runningAgent.error = message;
		if (runningAgent.notifyMainAgent && isShuttingDown()) {
			runningAgent.mainContextState = "separate";
			return;
		}
		const resultMessage = buildAgentResultMessage(
			runningAgent,
			{ ok: false, error: message },
			{ display: runningAgent.notifyMainAgent },
		);
		widget.addCompleted(runningAgent, resultMessage, { squashable: !runningAgent.notifyMainAgent });
		if (postUserAgentResult(pi, isShuttingDown, runningAgent.notifyMainAgent, resultMessage))
			runningAgent.status = "posted";
	} finally {
		unsubscribe?.();
		if (session) {
			logSteering(runningAgent.id, "session-shutdown", { streaming: session.isStreaming });
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}
	}
}

/** Run turns on an initialized child session until it posts, retires, or shuts down. */
export async function runChildTurns(
	pi: ExtensionAPI,
	isShuttingDown: () => boolean,
	task: string,
	session: AgentSession,
	runningAgent: RunningAgent,
	widget: UserAgentWidget,
): Promise<void> {
	let instruction = `You are running in an ephemeral, forked background process now, concurrently with the main session. ${task}`;
	while (true) {
		const turnMessageStart = session.agent.state.messages.length;
		if (!runningAgent.interruptRequested) {
			logSteering(runningAgent.id, "turn-prompt-started", {
				streaming: session.isStreaming,
				instructionLength: instruction.length,
			});
			await session.prompt(instruction);
		}
		if (runningAgent.interruptRequested) {
			const response = interruptedTurnResponse(session, turnMessageStart);
			runningAgent.interruptRequested = false;
			runningAgent.mainContextState = "separate";
			runningAgent.status = "done-waiting-to-post";
			runningAgent.completedAt = Date.now();
			runningAgent.responseText = response;
			const resultMessage = buildAgentResultMessage(
				runningAgent,
				{ ok: true, response },
				{ display: false },
			);
			postUserAgentResult(pi, isShuttingDown, false, resultMessage);
			runningAgent.pendingSquashMessage = runningAgent.notifyMainAgent
				? undefined
				: resultMessage;
			if (isShuttingDown()) return;
			runningAgent.status = "idle";
			logSteering(runningAgent.id, "turn-interrupted", { turnCount: runningAgent.turnCount });
			widget.update();
			const next = await waitForInstruction(runningAgent, widget);
			if (next === undefined) return;
			instruction = next;
			continue;
		}

		let response: string;
		try {
			response = getFinalAssistantText(session, turnMessageStart, runningAgent);
			// 成功获取响应后重置重试计数
			runningAgent.retryCount = 0;
		} catch (error) {
			// 初始化重试计数
			if (runningAgent.retryCount === undefined) {
				runningAgent.retryCount = 0;
			}
			
			// 最多重试 3 次
			const MAX_RETRIES = 3;
			if (runningAgent.retryCount < MAX_RETRIES) {
				runningAgent.retryCount++;
				logSteering(runningAgent.id, "agent-retry", {
					errorType: error instanceof Error ? error.name : "unknown",
					errorMessage: error instanceof Error ? error.message : String(error),
					retryCount: runningAgent.retryCount,
					maxRetries: MAX_RETRIES,
					messageCount: session.agent.state.messages.length,
				});
				instruction = NO_TEXT_RESPONSE_NUDGE;
				continue;
			}
			
			// 达到重试上限，抛出错误
			logSteering(runningAgent.id, "agent-retry-exhausted", {
				errorType: error instanceof Error ? error.name : "unknown",
				retryCount: runningAgent.retryCount,
				maxRetries: MAX_RETRIES,
			});
			throw error;
		}
		logSteering(runningAgent.id, "turn-prompt-resolved", {
			responseLength: response.length,
			messageCount: session.agent.state.messages.length,
		});
		runningAgent.status = "done-waiting-to-post";
		runningAgent.completedAt = Date.now();
		runningAgent.responseText = response;
		const resultMessage = buildAgentResultMessage(
			runningAgent,
			{ ok: true, response },
			{ display: runningAgent.notifyMainAgent },
		);
		if (runningAgent.notifyMainAgent) {
			if (isShuttingDown()) {
				runningAgent.mainContextState = "separate";
				resultMessage.details.mainContextState = "separate";
				return;
			}
			widget.addCompleted(runningAgent, resultMessage, { squashable: false });
			const posted = postUserAgentResult(pi, isShuttingDown, true, resultMessage);
			runningAgent.status = posted ? "posted" : runningAgent.status;
			return;
		}
		postUserAgentResult(pi, isShuttingDown, false, resultMessage);
		runningAgent.pendingSquashMessage = resultMessage;
		if (isShuttingDown()) return;
		runningAgent.status = "idle";
		logSteering(runningAgent.id, "agent-idle", { turnCount: runningAgent.turnCount });
		widget.update();
		const next = await waitForInstruction(runningAgent, widget);
		if (next === undefined) return;
		instruction = next;
	}
}

function interruptedTurnResponse(session: AgentSession, turnMessageStart: number): string {
	const assistantMessages = session.agent.state.messages
		.slice(turnMessageStart)
		.filter((message) => message.role === "assistant");
	const lastAssistantMessage = assistantMessages.at(-1);
	const partialResponse = lastAssistantMessage ? assistantText(lastAssistantMessage).trim() : "";
	if (!partialResponse) return "Interrupted by user.";
	return `Interrupted by user.\n\n${partialResponse}`;
}

async function createChildSession(
	model: Model,
	thinkingLevel: ThinkingLevel,
	forwarded: ForwardedOptions,
	inheritedMessages: AgentMessage[],
	services: AgentSessionServices,
	childSessionManager: SessionManager,
	runningAgent: RunningAgent,
	widget: UserAgentWidget,
): Promise<AgentSession> {
	// Built while the session is still empty: that is the only path on which pi records the
	// model and thinking level, and without those entries a resumed child falls back to defaults.
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: childSessionManager,
		model,
		thinkingLevel,
		tools: forwarded.tools,
		excludeTools: forwarded.excludeTools,
		noTools: forwarded.noTools,
	});

	runningAgent.session = session;
	runningAgent.status = "running";
	logSteering(runningAgent.id, "session-created", { streaming: session.isStreaming });
	if (runningAgent.aborted) void session.abort();
	widget.update();

	await session.bindExtensions({ mode: "print" });
	logSteering(runningAgent.id, "session-bound", { streaming: session.isStreaming });
	if (inheritedMessages.length > 0) {
		persistMessages(childSessionManager, inheritedMessages, []);
		session.agent.state.messages = inheritedMessages;
		logSteering(runningAgent.id, "context-inherited", { messageCount: inheritedMessages.length });
	}
	return session;
}

/**
 * Mirror a message stream into a session file, each role through its own append method.
 * Seeds a child with its inherited snapshot (leading summary), and replays a rebase onto the
 * main session. A compaction with a keptTailCount maps its kept-tail boundary onto this file's
 * own entry ids, so the rebuilt context keeps the same messages verbatim the child kept — the
 * tail may reach back into the pre-replay context, whose per-message ids arrive as
 * priorContextEntryIds (empty when seeding a child).
 */
export function persistMessages(
	sessionManager: SessionManager,
	messages: readonly AgentMessage[],
	priorContextEntryIds: readonly string[],
): void {
	// One id per context message, prior context first; every appended entry projects to one message.
	const entryIdsPerMessage: string[] = [...priorContextEntryIds];
	for (const message of messages) {
		if (message.role === "compactionSummary") {
			const keptTailCount = (message as ChildCompactionMessage).keptTailCount ?? 0;
			const firstKeptEntryId =
				keptTailCount > 0 ? (entryIdsPerMessage[entryIdsPerMessage.length - keptTailCount] ?? "") : "";
			entryIdsPerMessage.push(
				sessionManager.appendCompaction(message.summary, firstKeptEntryId, message.tokensBefore),
			);
		} else if (message.role === "branchSummary")
			entryIdsPerMessage.push(
				sessionManager.branchWithSummary(sessionManager.getLeafId(), message.summary),
			);
		else if (message.role === "custom")
			entryIdsPerMessage.push(
				sessionManager.appendCustomMessageEntry(
					message.customType,
					message.content,
					message.display,
					message.details,
				),
			);
		else entryIdsPerMessage.push(sessionManager.appendMessage(message));
	}
}

/** Parks an idle agent until the user resumes it with another instruction (resolves with it) or retires it (resolves undefined). */
export function waitForInstruction(
	agent: RunningAgent,
	widget: { update(): void },
): Promise<string | undefined> {
	return new Promise((resolve) => {
		const settle = (instruction: string | undefined) => {
			agent.resume = undefined;
			agent.retire = undefined;
			resolve(instruction);
		};
		agent.resume = (instruction) => {
			logSteering(agent.id, "agent-resumed", { instructionLength: instruction.length });
			agent.mainContextState = agent.notifyMainAgent ? "will-squash" : "separate";
			agent.status = "running";
			agent.turnStartedAt = Date.now();
			agent.completedAt = undefined;
			settle(instruction);
			widget.update();
		};
		agent.retire = () => {
			logSteering(agent.id, "agent-retired", { status: agent.status });
			settle(undefined);
		};
	});
}

export function subscribeToChildSession(
	session: AgentSession,
	runningAgent: RunningAgent,
	widget: UserAgentWidget,
): () => void {
	return session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "compaction_end" && !event.aborted && event.result) {
			// Compaction never emits message events; capture it here or the rebase stream misses it.
			// At this instant the live context is exactly [summary, kept tail], so the tail is countable.
			const keptTailCount = Math.max(0, session.agent.state.messages.length - 1);
			const compactionMessage: ChildCompactionMessage = {
				role: "compactionSummary",
				summary: event.result.summary,
				tokensBefore: event.result.tokensBefore,
				timestamp: Date.now(),
				keptTailCount,
			};
			runningAgent.conversationMessages.push(compactionMessage);
			logSteering(runningAgent.id, "child-compacted", { keptTailCount });
		}
		if (event.type === "agent_start")
			logSteering(runningAgent.id, "child-agent-started", { streaming: session.isStreaming });
		if (event.type === "agent_end")
			logSteering(runningAgent.id, "child-agent-ended", {
				streaming: session.isStreaming,
				messageCount: event.messages.length,
			});
		if (event.type === "agent_settled")
			logSteering(runningAgent.id, "child-agent-settled", { streaming: session.isStreaming });
		if (event.type === "turn_start")
			logSteering(runningAgent.id, "turn-started", { streaming: session.isStreaming });
		if (event.type === "turn_end")
			logSteering(runningAgent.id, "turn-ended", { streaming: session.isStreaming });
		if (event.type === "message_start")
			logSteering(runningAgent.id, "message-started", {
				role: event.message.role,
				streaming: session.isStreaming,
			});
		const finalizedMessageUpdate =
			event.type === "message_update" && event.assistantMessageEvent.type.endsWith("_end");
		if (event.type === "message_end")
			runningAgent.conversationMessages.push(structuredClone(event.message));
		if (finalizedMessageUpdate || event.type === "message_end")
			runningAgent.latestFinalizedMessage = structuredClone(event.message);
		if (
			finalizedMessageUpdate &&
			event.message.role === "assistant" &&
			event.assistantMessageEvent.type === "text_end"
		) {
			runningAgent.responseText = assistantText(event.message);
		}
		if (event.type === "message_end" && event.message.role === "assistant")
			runningAgent.responseText = assistantText(event.message);
		if (event.type === "tool_execution_start") {
			runningAgent.activeTools.set(event.toolCallId, event.toolName);
		}
		if (event.type === "tool_execution_end") {
			runningAgent.activeTools.delete(event.toolCallId);
			runningAgent.toolUses += 1;
		}
		if (event.type === "turn_end") {
			runningAgent.turnCount += 1;
		}
		if (event.type === "message_update" && !finalizedMessageUpdate) return;
		widget.update();
	});
}
