import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, RunningAgent } from "./shared.js";

type DispatchAgentParams = {
	task: string;
	isolate?: boolean;
	squash?: boolean;
	model?: string;
	thinking?: string;
};

const DISPATCH_AGENT_PARAMETERS = Type.Object({
	task: Type.String({
		description:
			"Complete task description for the background agent. The agent inherits this session's conversation unless isolate is true.",
	}),
	isolate: Type.Optional(
		Type.Boolean({
			description: "Start with a blank context instead of inheriting this session's conversation. Defaults to false.",
		}),
	),
	squash: Type.Optional(
		Type.Boolean({
			description: "Deliver the finished result back into this conversation when the agent completes. Defaults to true.",
		}),
	),
	model: Type.Optional(
		Type.String({ description: "Model override for the background agent. Defaults to the current model." }),
	),
	thinking: Type.Optional(
		Type.String({ description: "Thinking level override (minimal, low, medium, high, xhigh, max)." }),
	),
});

function quoteDispatchValue(value: string): string {
	return /\s/.test(value) ? JSON.stringify(value) : value;
}

/** Build the /agent-style argument string for a dispatch_agent tool call. */
export function buildDispatchArgs(params: DispatchAgentParams): string {
	const flags: string[] = [];
	if (params.isolate === true) flags.push("-i");
	if (params.squash !== false) flags.push("-s");
	if (params.model !== undefined && params.model !== "") flags.push("-m", quoteDispatchValue(params.model));
	if (params.thinking !== undefined && params.thinking !== "") flags.push("--thinking", quoteDispatchValue(params.thinking));
	return [...flags, params.task].join(" ");
}

/** Prompt the main agent to fan a batch of tasks out through the dispatch_agent tool. */
export function buildDispatchPrompt(batch: string): string {
	return [
		"[Dispatch Request]",
		batch,
		"",
		"[Dispatch Instructions] Break the request above into independent, well-scoped work units. For each unit, call the dispatch_agent tool exactly once, and issue all independent dispatches in the same turn so the background agents run in parallel. Pass isolate=true only for units that do not need this conversation's context; keep squash enabled so every result returns here automatically. Do not perform the dispatched work yourself in this session. After every dispatched agent has reported back, synthesize their results into one consolidated summary for the user.",
	].join("\n");
}

export type DispatchDeps = {
	isShuttingDown: () => boolean;
	startAgent: (args: string, invocation: string, ctx: ExtensionCommandContext) => Promise<RunningAgent>;
};

export function registerDispatch(pi: ExtensionAPI, deps: DispatchDeps): void {
	pi.registerTool({
		name: "dispatch_agent",
		label: "Dispatch Agent",
		description:
			"Run a task in a background agent that works concurrently with this session and gets its own token budget. Use it to fan independent work out in parallel: issue several dispatch_agent calls in one turn and the agents run concurrently. Finished results are delivered back into this conversation unless squash is false.",
		promptSnippet: "dispatch_agent: run a task in a concurrent background agent",
		promptGuidelines: [
			"For batch requests, split the work into independent units and call dispatch_agent once per unit in the same turn; the background agents run in parallel.",
			"Keep squash enabled so finished results return automatically; pass isolate only when the task does not need this conversation's context.",
		],
		parameters: DISPATCH_AGENT_PARAMETERS,
		executionMode: "parallel",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (deps.isShuttingDown()) {
				return {
					content: [{ type: "text" as const, text: "The session is shutting down; cannot dispatch a background agent." }],
					details: { error: "shutting-down" },
				};
			}
			try {
				const agent = await deps.startAgent(
					buildDispatchArgs(params),
					`dispatch_agent: ${params.task}`,
					ctx as ExtensionCommandContext,
				);
				return {
					content: [
						{
							type: "text" as const,
							text: `Dispatched background agent ${agent.id} (model: ${agent.modelLabel}). Its result will be delivered into this conversation when it finishes.`,
						},
					],
					details: { agentId: agent.id, task: agent.task },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `Failed to dispatch background agent: ${message}` }],
					details: { error: message },
				};
			}
		},
	});

	pi.registerCommand("dispatch", {
		description:
			"Hand a batch of tasks to the agent, which intelligently fans them out to background agents: /dispatch <tasks, one per line or freely described>",
		getArgumentCompletions: () => null,
		async handler(args: string, ctx) {
			const batch = args.trim();
			if (!batch) {
				ctx.ui.notify("Please provide a task batch: /dispatch <tasks, one per line or freely described>", "warning");
				return;
			}
			ctx.ui.notify("Dispatch request sent; the agent will fan the tasks out to background agents.", "info");
			await pi.sendUserMessage(buildDispatchPrompt(batch), { streamingBehavior: "followUp" });
		},
	});
}
