import type { ChildPermissions, ParentToolBridge } from "./permissions.js";
import { Type } from "typebox";
import { armExecutionDeadline } from "./child-recovery.ts";
import { logSteering } from "./shared.ts";
import type { ExtensionAPI, ExtensionCommandContext, RunningAgent } from "./shared.js";

export const MAX_DISPATCH_TIMEOUT_MS = 24 * 60 * 60 * 1000;

type DispatchAgentParams = {
	task: string;
 batchId?: string;
 writeScope?: string[];
 testCommands?: string[];
	isolate?: boolean;
	squash?: boolean;
	model?: string;
	thinking?: string;
	timeoutMs?: number;
};

const DISPATCH_AGENT_PARAMETERS = Type.Object({
 testCommands: Type.Optional(Type.Array(Type.String({minLength:1}),{description:"Exact parent-authorized shell commands. NOT sandboxed; whole-workspace lock. Omit to deny bash."})),
 writeScope: Type.Optional(Type.Array(Type.String({minLength:1}),{description:"Owned writable paths. Overlaps reject. Shell/custom mutation takes a workspace-wide lock; shell is parent-policy mediated, not path sandboxed."})),
 batchId: Type.Optional(Type.String({description:"Shared label for a batch ledger; use manage_agent to inspect all members."})),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_DISPATCH_TIMEOUT_MS, description: "Host-side execution deadline in milliseconds after dispatch starts. Omit for no deadline; timeout returns partial results." })),
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
	startAgent: (args: string, invocation: string, ctx: ExtensionCommandContext, deadline?: { timeoutMs: number; deadlineAt: number }, batchId?: string, permissions?: ChildPermissions) => Promise<RunningAgent>;
};

/** Deadline belongs to this dispatched lifecycle, not to ordinary /agent sessions. */
export function armDispatchDeadline(agent: RunningAgent, timeoutMs: number, deadlineAt = Date.now() + timeoutMs): () => void {
 return armExecutionDeadline(agent, timeoutMs, deadlineAt, (event, error) =>
  logSteering(agent.id, event, { error: String(error) }));
}

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
			if (params.timeoutMs !== undefined && (!Number.isInteger(params.timeoutMs) || params.timeoutMs < 1 || params.timeoutMs > MAX_DISPATCH_TIMEOUT_MS)) {
				return { content: [{ type: "text" as const, text: `timeoutMs must be an integer between 1 and ${MAX_DISPATCH_TIMEOUT_MS}.` }], details: { error: "invalid-timeout" } };
			}
			if((params.writeScope?.length || params.testCommands?.length) && typeof (ctx as any).executeTool !== "function")throw new Error("Installed Pi SDK/context has no parent executeTool approval bridge; writable dispatch unavailable");
			const parentSessionId=ctx.sessionManager?.getSessionId();
   const deadline = params.timeoutMs === undefined ? undefined : { timeoutMs: params.timeoutMs, deadlineAt: Date.now() + params.timeoutMs };
			try {
				const agent = await deps.startAgent(
					buildDispatchArgs(params),
					`dispatch_agent: ${params.task}`,
					ctx as ExtensionCommandContext,
					deadline,
					params.batchId,
     {writeScope:params.writeScope,testCommands:params.testCommands,bridge:typeof (ctx as any).executeTool === "function" ? {
      get tools(){return pi.getAllTools();},getActiveTools:()=>pi.getActiveTools(),
      validate:()=>{if(deps.isShuttingDown() || ctx.sessionManager?.getSessionId()!==parentSessionId)throw new Error("Parent session unavailable or changed");},
      executeTool:(name,args,options)=>(ctx as any).executeTool(name,args,options),
     } : undefined},
				);
				if (params.timeoutMs !== undefined) armDispatchDeadline(agent, params.timeoutMs, deadline!.deadlineAt);
				return {
					content: [
						{
							type: "text" as const,
							text: `Dispatched background agent ${agent.id} (model: ${agent.modelLabel}). ${params.squash === false ? "Its result is user-visible only; no automatic main-agent turn." : "Its result will be delivered into this conversation when it finishes."}`,
						},
					],
					details: { agentId: agent.id, task: agent.task, ...(params.batchId ? {batchId:params.batchId}:{}), ...(agent.status ? {status:agent.status}:{}) },
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
			await pi.sendUserMessage(buildDispatchPrompt(batch), ({ streamingBehavior: "followUp", deliverAs: "followUp" } as unknown as Parameters<ExtensionAPI["sendUserMessage"]>[1]));
		},
	});
}
