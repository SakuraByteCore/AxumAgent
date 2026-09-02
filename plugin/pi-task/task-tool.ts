import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type ModelRegistry,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, TruncatedText } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { TASK_PROMPT_GUIDELINES, TASK_PROMPT_SNIPPET } from "./prompts.js";
import { getAgentProfiles } from "./profiles.js";
import type {
	AgentProfile,
	TaskItem,
	TaskItemResult,
	TaskProgressNode,
	TaskToolDetails,
	TaskUsage,
} from "./types.js";

export const DEFAULT_MAX_WIDTH = 8;
export const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_AGENT = "general-purpose";
const MAX_LABEL_CHARS = 80;
const MAX_WIDTH_ERROR = "Maximum subagent width reached";
const MAX_ACTIVITY_LINES = 2;
const ACTIVITY_DISPLAY_PREVIEW_CHARS = 120;
const PROGRESS_UPDATE_INTERVAL_MS = 250;
const PROGRESS_HEARTBEAT_INTERVAL_MS = 1000;

const labelParam = Type.Optional(
	Type.String({ description: "A short 3-5 word label for the task, used for UI display and routing context." }),
);
const agentParam = Type.Optional(
	Type.String({
		description: `The subagent profile to run. Defaults to ${DEFAULT_AGENT}. Custom profiles load from ~/.pi/agent/subagents/<agent>.md; ~/.omp/agent/agents/ and .pi/agents/ are also scanned.`,
	}),
);

const taskItemParameters = Type.Object({
	name: labelParam,
	agent: agentParam,
	task: Type.String({ description: "The self-contained task briefing to send to the subagent." }),
});

const taskToolParameters = Type.Object({
	name: labelParam,
	agent: agentParam,
	task: Type.Optional(
		Type.String({ description: "The self-contained briefing for a single subagent. Omit when using tasks." }),
	),
	tasks: Type.Optional(
		Type.Array(taskItemParameters, {
			description:
				"Independent tasks to run concurrently as separate subagents in one batch. Prefer this whenever several independent subagent tasks exist; the batch executes them concurrently and returns every result together.",
		}),
	),
});

type TaskToolParams = Static<typeof taskToolParameters>;
type TaskToolResult = ReturnType<typeof textResult>;

export interface DelegationState {
	maxWidth: number;
	maxConcurrency: number;
	childCount: number;
	progressEnabled: boolean;
}

export interface TaskUsageStatusState {
	calls: Map<string, TaskUsage>;
	latestCacheHitRate?: number;
}

export interface CreateTaskToolOptions {
	getThinkingLevel: () => ReturnType<ExtensionAPI["getThinkingLevel"]>;
	updateStatus: (ctx: ExtensionContext, toolCallId: string, usage: TaskUsage) => void;
}

interface PreparedTask {
	id: string;
	index: number;
	item: TaskItem;
	label: string;
	agent: string;
	profile: AgentProfile;
	model: NonNullable<ExtensionContext["model"]>;
	node?: TaskProgressNode;
}

interface ProgressEmitter {
	emitNow(): void;
	emitSoon(): void;
	startHeartbeat(): void;
	stop(): void;
}

export function normalizeLimit(value: number | undefined, fallback: number, label: string): number {
	if (value === undefined) {
		return fallback;
	}
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${label} must be a non-negative integer`);
	}
	return value;
}

function shouldEnableProgress(ctx: ExtensionContext): boolean {
	if (!ctx.hasUI) {
		return false;
	}
	try {
		return ctx.ui.getAllThemes().length > 0;
	} catch {
		return false;
	}
}

function textResult(text: string, details: TaskToolDetails) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function normalizeAgentName(agent: string | undefined): string {
	const normalized = agent?.trim();
	return normalized ? normalized : DEFAULT_AGENT;
}

function makeTaskLabel(item: TaskItem): string {
	const name = item.name?.trim();
	if (name) {
		return name;
	}
	const normalized = item.task.replace(/\s+/g, " ").trim();
	return normalized.length > MAX_LABEL_CHARS ? `${normalized.slice(0, MAX_LABEL_CHARS)}…` : normalized;
}

function normalizeItems(params: TaskToolParams): { items?: TaskItem[]; error?: string } {
	const batch = Array.isArray(params.tasks) ? params.tasks : [];
	const singleTask = typeof params.task === "string" ? params.task : "";
	const hasSingle = singleTask.trim().length > 0;
	if (batch.length > 0 && hasSingle) {
		return { error: "Provide either task for a single subagent or tasks for a batch, not both." };
	}
	const items: TaskItem[] =
		batch.length > 0
			? batch.map((entry) => ({ name: entry.name, agent: entry.agent, task: entry.task }))
			: hasSingle
				? [{ name: params.name, agent: params.agent, task: singleTask }]
				: [];
	if (items.length === 0) {
		return { error: "Provide task for a single subagent or a non-empty tasks array for a batch." };
	}
	const empty = items.find((item) => typeof item.task !== "string" || item.task.trim().length === 0);
	if (empty) {
		return { error: "Every task entry needs a non-empty task briefing." };
	}
	return { items };
}

function formatProfileNames(profiles: Map<string, AgentProfile>): string {
	return [...profiles.keys()].join(", ");
}

function findProfileModel(
	profile: AgentProfile,
	modelRegistry: ModelRegistry,
): ExtensionContext["model"] {
	if (!profile.model) {
		return undefined;
	}
	const separator = profile.model.indexOf("/");
	if (separator <= 0) {
		return undefined;
	}
	return modelRegistry.find(profile.model.slice(0, separator), profile.model.slice(separator + 1));
}

function prepareTask(
	id: string,
	index: number,
	item: TaskItem,
	profiles: Map<string, AgentProfile>,
	ctx: ExtensionContext,
): { ok: true; task: PreparedTask } | { ok: false; result: TaskItemResult } {
	const label = makeTaskLabel(item);
	const agent = normalizeAgentName(item.agent);
	const profile = profiles.get(agent);
	if (!profile) {
		return {
			ok: false,
			result: {
				label,
				agent,
				status: "rejected",
				error: `Unknown agent "${agent}". Available agents: ${formatProfileNames(profiles)}.`,
			},
		};
	}
	const model = profile.model ? findProfileModel(profile, ctx.modelRegistry) : ctx.model;
	if (!model) {
		return {
			ok: false,
			result: {
				label,
				agent,
				status: "rejected",
				error: profile.model ? `Profile model not found: ${profile.model}` : "No model is selected",
			},
		};
	}
	return { ok: true, task: { id, index, item, label, agent, profile, model } };
}

function createProgressNode(id: string, label: string, agent: string): TaskProgressNode {
	return { id, label, agent, status: "queued", startedAt: Date.now(), activity: [], activityCount: 0 };
}

function sumUsage(results: TaskItemResult[]): TaskUsage | undefined {
	const total: TaskUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let found = false;
	for (const result of results) {
		if (!result.usage) {
			continue;
		}
		found = true;
		total.input += result.usage.input;
		total.output += result.usage.output;
		total.cacheRead += result.usage.cacheRead;
		total.cacheWrite += result.usage.cacheWrite;
		total.cost += result.usage.cost;
		if (result.usage.latestCacheHitRate !== undefined) {
			total.latestCacheHitRate = result.usage.latestCacheHitRate;
		}
	}
	return found ? total : undefined;
}
export function createUsageStatusState(): TaskUsageStatusState {
	return { calls: new Map() };
}

function getUsageTotals(state: TaskUsageStatusState): TaskUsage {
	const totals: TaskUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		latestCacheHitRate: state.latestCacheHitRate,
	};
	for (const usage of state.calls.values()) {
		totals.input += usage.input;
		totals.output += usage.output;
		totals.cacheRead += usage.cacheRead;
		totals.cacheWrite += usage.cacheWrite;
		totals.cost += usage.cost;
	}
	return totals;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	if (hours > 0) {
		return `${hours}h${minutes}m${seconds}s`;
	}
	if (minutes > 0) {
		return `${minutes}m${seconds}s`;
	}
	return `${seconds}s`;
}

function formatTokens(count: number): string {
	if (count < 1000) {
		return count.toString();
	}
	if (count < 10000) {
		return `${(count / 1000).toFixed(1)}k`;
	}
	if (count < 1000000) {
		return `${Math.round(count / 1000)}k`;
	}
	if (count < 10000000) {
		return `${(count / 1000000).toFixed(1)}M`;
	}
	return `${Math.round(count / 1000000)}M`;
}

function formatUsage(usage: TaskUsage): string {
	const parts = [`↑${formatTokens(usage.input)}`, `↓${formatTokens(usage.output)}`];
	if (usage.cacheRead) {
		parts.push(`R${formatTokens(usage.cacheRead)}`);
	}
	if (usage.cacheWrite) {
		parts.push(`W${formatTokens(usage.cacheWrite)}`);
	}
	if ((usage.cacheRead > 0 || usage.cacheWrite > 0) && usage.latestCacheHitRate !== undefined) {
		parts.push(`CH${usage.latestCacheHitRate.toFixed(1)}%`);
	}
	if (usage.cost) {
		parts.push(`$${usage.cost.toFixed(3)}`);
	}
	return parts.join(" ");
}

function formatUsageStatus(totals: TaskUsage, theme: Theme): string {
	return `${theme.fg("dim", "pi-task ")}${theme.fg("dim", formatUsage(totals))}`;
}

function publishUsageStatus(ctx: ExtensionContext, state: TaskUsageStatusState): void {
	const totals = getUsageTotals(state);
	if (totals.input === 0 && totals.output === 0 && totals.cacheRead === 0 && totals.cacheWrite === 0 && totals.cost === 0) {
		ctx.ui.setStatus("pi-task", undefined);
		return;
	}
	ctx.ui.setStatus("pi-task", formatUsageStatus(totals, ctx.ui.theme));
}

export function updateUsageStatus(
	state: TaskUsageStatusState,
	ctx: ExtensionContext,
	toolCallId: string,
	usage: TaskUsage,
): void {
	state.calls.set(toolCallId, usage);
	if (usage.latestCacheHitRate !== undefined) {
		state.latestCacheHitRate = usage.latestCacheHitRate;
	}
	publishUsageStatus(ctx, state);
}

function formatActivityLineForDisplay(line: string): string {
	if (line.length <= ACTIVITY_DISPLAY_PREVIEW_CHARS) {
		return line;
	}
	const hiddenChars = line.length - ACTIVITY_DISPLAY_PREVIEW_CHARS;
	return `${line.slice(0, ACTIVITY_DISPLAY_PREVIEW_CHARS).trimEnd()} … (+${hiddenChars} chars)`;
}

function formatStatusReason(error: string | undefined): string {
	if (!error) {
		return "";
	}
	if (error === MAX_WIDTH_ERROR) {
		return ": max width reached";
	}
	return `: ${error}`;
}

function addActivity(progress: TaskProgressNode, line: string): void {
	const normalized = line.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return;
	}
	progress.activityCount++;
	progress.activity.push(normalized);
	if (progress.activity.length > MAX_ACTIVITY_LINES) {
		progress.activity.splice(0, progress.activity.length - MAX_ACTIVITY_LINES);
	}
}

function replaceLatestActivity(progress: TaskProgressNode, line: string): void {
	const normalized = line.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return;
	}
	if (progress.activity.length === 0) {
		addActivity(progress, normalized);
		return;
	}
	progress.activity[progress.activity.length - 1] = normalized;
}

function getFirstTextLine(text: string): string {
	return text.split("\n").find((line) => line.trim()) ?? text;
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((part) => {
			const block = part as { type?: string; text?: unknown };
			return block.type === "text" && typeof block.text === "string" ? block.text : undefined;
		})
		.filter((part): part is string => part !== undefined)
		.join("\n")
		.trim();
}

function getToolArgPreview(args: unknown): string {
	if (!args || typeof args !== "object") {
		return "";
	}
	const record = args as Record<string, unknown>;
	const value =
		typeof record.name === "string" ? record.name
		: typeof record.description === "string" ? record.description
		: typeof record.path === "string" ? record.path
		: typeof record.command === "string" ? record.command
		: typeof record.pattern === "string" ? record.pattern
		: typeof record.query === "string" ? record.query
		: typeof record.url === "string" ? record.url
		: "";
	return value.replace(/\s+/g, " ").trim();
}

function updateProgressFromEvent(progress: TaskProgressNode, event: AgentSessionEvent): void {
	if (event.type === "tool_execution_start") {
		if (event.toolName === "task") {
			return;
		}
		const preview = getToolArgPreview(event.args);
		addActivity(progress, `${event.toolName}${preview ? ` ${preview}` : ""}`);
		return;
	}
	if (event.type === "message_start" && event.message.role === "assistant") {
		addActivity(progress, "Thinking...");
		return;
	}
	if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
		return;
	}
	if (event.type === "message_update") {
		const assistantEvent = event.assistantMessageEvent;
		const content =
			"partial" in assistantEvent ? assistantEvent.partial.content
			: "message" in assistantEvent ? assistantEvent.message.content
			: "error" in assistantEvent ? assistantEvent.error.content
			: undefined;
		const text = extractTextContent(content);
		if (text) {
			replaceLatestActivity(progress, getFirstTextLine(text));
		}
		return;
	}
	if (event.type === "message_end" && event.message.role === "assistant") {
		const text = extractTextContent(event.message.content);
		if (text) {
			replaceLatestActivity(progress, getFirstTextLine(text));
		}
	}
}

function extractFinalAssistantText(messages: readonly unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; content?: unknown };
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		const text = extractTextContent(message.content);
		if (text) {
			return text;
		}
	}
	return "";
}

function extractLatestCacheHitRate(messages: readonly unknown[]): number | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as {
			role?: string;
			usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
		};
		if (message.role !== "assistant" || !message.usage) {
			continue;
		}
		const input = message.usage.input ?? 0;
		const cacheRead = message.usage.cacheRead ?? 0;
		const cacheWrite = message.usage.cacheWrite ?? 0;
		const promptTokens = input + cacheRead + cacheWrite;
		return promptTokens > 0 ? (cacheRead / promptTokens) * 100 : undefined;
	}
	return undefined;
}

function getTaskUsage(session: {
	getSessionStats: () => {
		tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
		cost: number;
	};
	messages: readonly unknown[];
}): TaskUsage {
	const stats = session.getSessionStats();
	return {
		input: stats.tokens.input,
		output: stats.tokens.output,
		cacheRead: stats.tokens.cacheRead,
		cacheWrite: stats.tokens.cacheWrite,
		cost: stats.cost,
		latestCacheHitRate: extractLatestCacheHitRate(session.messages),
	};
}

function renderProgressNode(node: TaskProgressNode, theme: Theme): Container {
	const container = new Container();
	const status = node.status === "completed" ? "done" : node.status;
	const elapsed = formatDuration((node.endedAt ?? Date.now()) - node.startedAt);
	const usage = node.usage ? ` ${formatUsage(node.usage)}` : "";
	container.addChild(
		new Text(`${theme.bold(`Task(${node.agent}: ${node.label})`)} ${theme.fg("dim", `${status} ${elapsed}${usage}`)}`, 0, 0),
	);
	const skipped = node.activityCount - node.activity.length;
	if (skipped > 0) {
		container.addChild(new Text(`  ${theme.fg("muted", `... +${skipped} earlier events`)}`, 0, 0));
	}
	for (const line of node.activity) {
		container.addChild(new TruncatedText(`  ${theme.fg("muted", formatActivityLineForDisplay(line))}`, 0, 0));
	}
	if (node.error) {
		container.addChild(new Text(`  ${theme.fg("error", node.error)}`, 0, 0));
	}
	return container;
}

class Semaphore {
	private available: number;
	private readonly waiters: Array<() => void> = [];

	constructor(max: number) {
		this.available = max;
	}

	async acquire(): Promise<void> {
		if (this.available > 0) {
			this.available--;
			return;
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
	}

	release(): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter();
			return;
		}
		this.available++;
	}
}

function createProgressEmitter(enabled: boolean, emit: () => void): ProgressEmitter {
	let lastEmit = 0;
	let pending: ReturnType<typeof setTimeout> | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	const emitNow = () => {
		if (!enabled) {
			return;
		}
		if (pending) {
			clearTimeout(pending);
			pending = undefined;
		}
		lastEmit = Date.now();
		emit();
	};
	const emitSoon = () => {
		if (!enabled) {
			return;
		}
		const elapsed = Date.now() - lastEmit;
		if (elapsed >= PROGRESS_UPDATE_INTERVAL_MS) {
			emitNow();
			return;
		}
		if (!pending) {
			pending = setTimeout(() => {
				pending = undefined;
				emitNow();
			}, PROGRESS_UPDATE_INTERVAL_MS - elapsed);
		}
	};
	return {
		emitNow,
		emitSoon,
		startHeartbeat() {
			if (!enabled || heartbeat) {
				return;
			}
			heartbeat = setInterval(() => emitSoon(), PROGRESS_HEARTBEAT_INTERVAL_MS);
			heartbeat.unref?.();
		},
		stop() {
			if (pending) {
				clearTimeout(pending);
				pending = undefined;
			}
			if (heartbeat) {
				clearInterval(heartbeat);
				heartbeat = undefined;
			}
		},
	};
}

async function createSubagentSession(
	profile: AgentProfile,
	model: NonNullable<ExtensionContext["model"]>,
	options: CreateTaskToolOptions,
	ctx: ExtensionContext,
) {
	const agentDir = getAgentDir();
	const cwd = ctx.cwd;
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const appendPrompts = [profile.systemPrompt].filter((prompt): prompt is string => Boolean(prompt));
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionsOverride: (base) => ({
			...base,
			extensions: base.extensions.filter((extension) => !extension.tools.has("task")),
		}),
		appendSystemPromptOverride: (base) => [...base, ...appendPrompts],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		thinkingLevel: profile.thinking ?? options.getThinkingLevel(),
		modelRegistry: ctx.modelRegistry,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		resourceLoader,
		excludeTools: ["task"],
		...(profile.tools !== undefined ? { tools: profile.tools } : {}),
	});
	return session;
}

async function runTaskItem(
	prepared: PreparedTask,
	progressEnabled: boolean,
	options: CreateTaskToolOptions,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
	emitter: ProgressEmitter,
): Promise<TaskItemResult> {
	const progress = progressEnabled
		? (prepared.node ??= createProgressNode(prepared.id, prepared.label, prepared.agent))
		: undefined;
	if (progress) {
		progress.status = "running";
		progress.startedAt = Date.now();
		emitter.emitSoon();
	}
	let session: Awaited<ReturnType<typeof createSubagentSession>> | undefined;
	let unsubscribe: (() => void) | undefined;
	let abortHandler: (() => void) | undefined;
	try {
		session = await createSubagentSession(prepared.profile, prepared.model, options, ctx);
		if (signal) {
			abortHandler = () => {
				void session?.abort();
			};
			if (!signal.aborted) {
				signal.addEventListener("abort", abortHandler, { once: true });
			}
		}
		const activeSession = session;
		unsubscribe = activeSession.subscribe((event) => {
			if (progress) {
				updateProgressFromEvent(progress, event);
				emitter.emitSoon();
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				const usage = getTaskUsage(activeSession);
				if (progress) {
					progress.usage = usage;
				}
				options.updateStatus(ctx, prepared.id, usage);
			}
		});
		if (signal?.aborted) {
			throw new Error("Subagent aborted before prompt start");
		}
		await activeSession.bindExtensions({});
		if (signal?.aborted) {
			throw new Error("Subagent aborted before prompt start");
		}
		emitter.emitNow();
		await activeSession.prompt(prepared.item.task, { source: "extension" });
		const result = extractFinalAssistantText(activeSession.messages) || "(no final text output)";
		const usage = getTaskUsage(activeSession);
		options.updateStatus(ctx, prepared.id, usage);
		if (progress) {
			progress.status = "completed";
			progress.result = result;
			progress.usage = usage;
			progress.endedAt = Date.now();
		}
		emitter.emitSoon();
		return { label: prepared.label, agent: prepared.agent, status: "completed", result, usage };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const usage = session ? getTaskUsage(session) : undefined;
		if (usage) {
			options.updateStatus(ctx, prepared.id, usage);
		}
		if (progress) {
			progress.status = "error";
			progress.error = message;
			progress.usage = usage;
			progress.endedAt = Date.now();
		}
		emitter.emitSoon();
		return { label: prepared.label, agent: prepared.agent, status: "error", error: message, usage };
	} finally {
		unsubscribe?.();
		if (signal && abortHandler) {
			signal.removeEventListener("abort", abortHandler);
		}
		session?.dispose();
	}
}

function runningDetails(prepared: PreparedTask): TaskToolDetails {
	return {
		label: prepared.label,
		agent: prepared.agent,
		status: "running",
		items: [],
		...(prepared.node ? { progress: prepared.node, usage: prepared.node.usage } : {}),
	};
}

function singleDetails(result: TaskItemResult, node?: TaskProgressNode): TaskToolDetails {
	return {
		label: result.label,
		agent: result.agent,
		status: result.status,
		items: [result],
		usage: result.usage,
		...(node ? { progress: node } : {}),
		error: result.error,
	};
}

function batchBatchResult(batchLabel: string, results: TaskItemResult[], nodes: TaskProgressNode[]): TaskToolResult {
	const completed = results.filter((result) => result.status === "completed").length;
	const failed = results.length - completed;
	const sections = results.map((result, index) => {
		const body = result.status === "completed" ? result.result : `Error: ${result.error ?? "unknown"}`;
		return `=== Task ${index + 1} ["${result.label}"] (${result.agent}) — ${result.status} ===\n${body ?? "(no final text output)"}`;
	});
	const details: TaskToolDetails = {
		label: batchLabel,
		agent: "batch",
		status: failed > 0 ? "error" : "completed",
		items: results,
		usage: sumUsage(results),
		...(nodes.length > 0 ? { progressItems: [...nodes] } : {}),
		...(failed > 0 ? { error: `${failed} of ${results.length} tasks failed or were rejected` } : {}),
	};
	return textResult(
		`Task batch of ${results.length} finished: ${completed} completed, ${failed} failed or rejected.\n\n${sections.join("\n\n")}`,
		details,
	);
}

async function runBatchTasks(
	toolCallId: string,
	items: TaskItem[],
	profiles: Map<string, AgentProfile>,
	state: DelegationState,
	progressEnabled: boolean,
	options: CreateTaskToolOptions,
	signal: AbortSignal | undefined,
	onUpdate: ((result: TaskToolResult) => void) | undefined,
	ctx: ExtensionContext,
): Promise<TaskToolResult> {
	const batchLabel = `batch ×${items.length}`;
	const nodes: TaskProgressNode[] = [];
	const results: (TaskItemResult | undefined)[] = new Array(items.length);
	const preparedTasks: PreparedTask[] = [];
	items.forEach((item, index) => {
		const prepared = prepareTask(`${toolCallId}:${index}`, index, item, profiles, ctx);
		if (prepared.ok) {
			preparedTasks.push(prepared.task);
		} else {
			results[index] = prepared.result;
		}
	});
	if (preparedTasks.length === 0) {
		return batchBatchResult(batchLabel, results as TaskItemResult[], nodes);
	}
	const semaphore = new Semaphore(state.maxConcurrency);
	const emitter = createProgressEmitter(progressEnabled && Boolean(onUpdate), () => {
		onUpdate?.(textResult(`Task batch of ${items.length} is running.`, {
			label: batchLabel,
			agent: "batch",
			status: "running",
			items: [],
			progressItems: [...nodes],
		}));
	});
	state.childCount += preparedTasks.length;
	try {
		emitter.startHeartbeat();
		await Promise.all(
			preparedTasks.map(async (prepared) => {
				await semaphore.acquire();
				try {
					if (progressEnabled) {
						prepared.node = createProgressNode(prepared.id, prepared.label, prepared.agent);
						nodes.push(prepared.node);
					}
					results[prepared.index] = await runTaskItem(prepared, progressEnabled, options, signal, ctx, emitter);
					emitter.emitSoon();
				} finally {
					semaphore.release();
				}
			}),
		);
	} finally {
		emitter.stop();
		state.childCount = Math.max(0, state.childCount - preparedTasks.length);
	}
	return batchBatchResult(batchLabel, results as TaskItemResult[], nodes);
}

export function createTaskTool(state: DelegationState, options: CreateTaskToolOptions): ToolDefinition {
	return defineTool({
		name: "task",
		label: "Task",
		description:
			"Launch a fresh subagent, or several concurrently via a tasks array. Available agents include built-ins (general-purpose, explorer) and custom profiles from ~/.pi/agent/subagents/*.md. Briefings must be self-contained.",
		promptSnippet: TASK_PROMPT_SNIPPET,
		promptGuidelines: TASK_PROMPT_GUIDELINES,
		parameters: taskToolParameters,
		executionMode: "parallel",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const effectiveState: DelegationState = {
				...state,
				progressEnabled: state.progressEnabled || shouldEnableProgress(ctx),
			};
			const profiles = getAgentProfiles(ctx.cwd);
			const normalized = normalizeItems(params);
			if (normalized.error || !normalized.items) {
				const message = normalized.error ?? "Invalid task parameters.";
				return textResult(message, {
					label: params.name?.trim() || "task",
					agent: normalizeAgentName(params.agent),
					status: "rejected",
					items: [],
					error: message,
				});
			}
			const items = normalized.items;
			if (state.childCount + items.length > effectiveState.maxWidth) {
				const message = `Maximum subagent width reached for this agent run. maxWidth: ${effectiveState.maxWidth}, in-flight: ${state.childCount}, requested: ${items.length}.`;
				return textResult(message, {
					label: items.length === 1 ? makeTaskLabel(items[0]) : `batch ×${items.length}`,
					agent: items.length === 1 ? normalizeAgentName(items[0].agent) : "batch",
					status: "rejected",
					items: [],
					error: MAX_WIDTH_ERROR,
				});
			}
			if (items.length > 1) {
				return runBatchTasks(toolCallId, items, profiles, state, effectiveState.progressEnabled, options, signal, onUpdate, ctx);
			}
			const single = prepareTask(toolCallId, 0, items[0], profiles, ctx);
			if (!single.ok) {
				return textResult(single.result.error ?? "Task rejected.", singleDetails(single.result));
			}
			const prepared = single.task;
			const progressEnabled = effectiveState.progressEnabled;
			if (progressEnabled) {
				prepared.node = createProgressNode(prepared.id, prepared.label, prepared.agent);
			}
			const emitter = createProgressEmitter(progressEnabled && Boolean(onUpdate), () => {
				onUpdate?.(textResult(`Task "${prepared.label}" (${prepared.agent}) is running.`, runningDetails(prepared)));
			});
			state.childCount += 1;
			try {
				emitter.startHeartbeat();
				const result = await runTaskItem(prepared, progressEnabled, options, signal, ctx, emitter);
				const text =
					result.status === "completed"
						? `Task "${result.label}" (${result.agent}) completed:\n\n${result.result}`
						: `Task "${result.label}" (${result.agent}) failed: ${result.error}`;
				return textResult(text, singleDetails(result, prepared.node));
			} finally {
				emitter.stop();
				state.childCount = Math.max(0, state.childCount - 1);
			}
		},
		renderCall(args, theme, context) {
			if (context.executionStarted) {
				return new Text("", 0, 0);
			}
			const batch = Array.isArray(args.tasks) ? args.tasks : [];
			if (batch.length > 0) {
				const names = batch.map((entry) =>
					typeof entry?.name === "string" && entry.name.trim() ? entry.name.trim() : normalizeAgentName(entry?.agent),
				);
				const preview = names.slice(0, 3).join(", ");
				const suffix = names.length > 3 ? `, +${names.length - 3} more` : "";
				return new Text(`${theme.bold("Task")} ${theme.fg("muted", `batch ×${batch.length}`)} ${theme.fg("dim", `${preview}${suffix}`)}`, 0, 0);
			}
			const agent = normalizeAgentName(typeof args.agent === "string" ? args.agent : undefined);
			const label = typeof args.name === "string" ? args.name.trim() : "";
			return new Text(`${theme.bold("Task")} ${theme.fg("muted", agent)}${label ? ` ${theme.fg("dim", label)}` : ""}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as TaskToolDetails;
			if (details.progressItems && details.progressItems.length > 0) {
				const container = new Container();
				for (const node of details.progressItems) {
					container.addChild(renderProgressNode(node, theme));
				}
				return container;
			}
			if (details.progress) {
				return renderProgressNode(details.progress, theme);
			}
			if (details.items.length > 1) {
				const container = new Container();
				for (const item of details.items) {
					const usage = item.usage ? ` ${formatUsage(item.usage)}` : "";
					const reason = item.status !== "completed" ? formatStatusReason(item.error) : "";
					container.addChild(
						new Text(`${theme.bold("Task")} ${theme.fg("muted", item.agent)} ${theme.fg("dim", item.label)} ${theme.fg("dim", `${item.status}${reason}${usage}`)}`, 0, 0),
					);
				}
				return container;
			}
			const usage = details.usage ? ` ${formatUsage(details.usage)}` : "";
			const reason = details.status === "rejected" || details.status === "error" ? formatStatusReason(details.error) : "";
			return new Text(
				`${theme.bold("Task")} ${theme.fg("muted", details.agent)} ${theme.fg("dim", details.label)} ${theme.fg("dim", `${details.status}${reason}${usage}`)}`,
				0,
				0,
			);
		},
	});
}
