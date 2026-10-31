import { AGENT_ROLES, roleInstruction, type AgentRole } from "./roles.ts";
import { randomUUID } from "node:crypto";
import { compileOutputSchema, type OutputSchema } from "./structured-output.ts";
import type { ChildPermissions, ParentToolBridge } from "./permissions.js";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, RunningAgent } from "./shared.js";


type DispatchAgentParams = {
	task: string;
 role?: AgentRole;
 outputSchema?: OutputSchema;
 fullTools?: boolean;
 agentArgs?: string;
 backend?: "controlled-pi";
 batchId?: string;
 writeScope?: string[];
 testCommands?: string[];
	isolate?: boolean;
	squash?: boolean;
	model?: string;
	thinking?: string;
};

const DISPATCH_AGENT_PARAMETERS = Type.Object({
 role:Type.Optional(Type.Union(Object.keys(AGENT_ROLES).map(role=>Type.Literal(role)),{description:"Optional focus preset: explorer (code lookup), librarian (external research), oracle (architecture/debugging), designer (UI), fixer (bounded implementation). Model/effort and permissions still follow explicit dispatch settings."})),
 outputSchema: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Boolean()], {description:"Portable JSON Schema subset for the final result (types, properties, required, items, enum, combinators, bounds; no $ref or format). Validated before dispatch and on completion; invalid output fails without replaying actions."})),
 agentArgs: Type.Optional(Type.String({description:"Exact /agent arguments supplied by a user command; preserves model, plan and tool flags. Omit for normal dispatch."})),
 fullTools: Type.Optional(Type.Boolean({description:"Inherit all active parent tools through the live approval bridge, except recursive delegation. Explicit full-tool mode; commands are not limited to testCommands. Uses an exclusive workspace lane."})),
 backend: Type.Optional(Type.Literal("controlled-pi",{description:"Built-in default; inherits current model/provider authentication and available read/search tools. No extra login or deployment."})),
 testCommands: Type.Optional(Type.Array(Type.String({minLength:1}),{description:"Exact parent-authorized shell commands; requires explicit writeScope and live parent approval bridge. Not sandboxed."})),
 writeScope: Type.Optional(Type.Array(Type.String({minLength:1}),{description:"Owned writable paths. Overlaps reject. Writes use the live parent permission bridge; omit for read-only."})),
 batchId: Type.Optional(Type.String({description:"Shared label for a batch ledger; use manage_agent to inspect all members."})),
	task: Type.String({
		description:
			"Complete task description for the background agent. The child has an independent context. Include the complete goal, necessary context, owned files, non-goals, interfaces, and acceptance checks.",
	}),
	isolate: Type.Optional(
		Type.Boolean({
			description: "Start with a blank context instead of inheriting this session's conversation. All new tasks are independent; retained for compatibility.",
		}),
	),
	squash: Type.Optional(
		Type.Boolean({
			description: "Deliver the finished result back into this conversation when the agent completes. Defaults to true.",
		}),
	),
	model: Type.Optional(
		Type.String({ description: "Model override for the background agent. Defaults to current parent model/provider authentication." }),
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
	if(params.agentArgs !== undefined) return params.agentArgs;
	const flags: string[] = [];
	flags.push("-i"); // Independent context for every newly dispatched one-shot task.
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
		"[Dispatch Instructions] Break the request above into independent, well-scoped work units. Use one dispatch_agent call with a tasks array for ready independent units, choosing optional concise role presets. All entries start concurrently. Keep dependent units pending until their inputs are ready. Every task has an independent context: include all required context, owned files, interfaces, and checks; keep squash enabled so every result returns here automatically. Do not perform the dispatched work yourself in this session. After every dispatched agent has reported back, synthesize their results into one consolidated summary for the user.",
	].join("\n");
}

export type DispatchDeps = {
	isShuttingDown: () => boolean;
	startAgent: (args: string, invocation: string, ctx: ExtensionCommandContext, deadline?: { timeoutMs: number; deadlineAt: number }, batchId?: string, permissions?: ChildPermissions) => Promise<RunningAgent>;
};

export function registerDispatch(pi: ExtensionAPI, deps: DispatchDeps): void {
		const executeOne = async (_toolCallId: string, params: DispatchAgentParams, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) => {
   if(params.backend && params.backend!=="controlled-pi")throw new Error("Native OAR backend retired. Remove backend to use bundled controlled-pi with your current model/provider; no task started.");
			if (deps.isShuttingDown()) {
				return {
					content: [{ type: "text" as const, text: "The session is shutting down; cannot dispatch a background agent." }],
					details: { error: "shutting-down" },
				};
			}
			if((params.fullTools || params.writeScope?.length || params.testCommands?.length) && typeof (ctx as any).executeTool !== "function")throw new Error("Installed Pi SDK/context has no parent executeTool approval bridge; writable dispatch unavailable");
			const parentSessionId=ctx.sessionManager?.getSessionId();
			try {
				roleInstruction(params.role);
				if(params.outputSchema !== undefined) compileOutputSchema(params.outputSchema);
				const agent = await deps.startAgent(
					buildDispatchArgs(params),
					`dispatch_agent: ${params.task}`,
					ctx as ExtensionCommandContext,
					undefined,
					params.batchId,
     {role:params.role,outputSchema:params.outputSchema,fullTools:params.fullTools,backend:params.backend,writeScope:params.writeScope,testCommands:params.testCommands,bridge:typeof (ctx as any).executeTool === "function" ? {
      get tools(){return pi.getAllTools();},getActiveTools:()=>pi.getActiveTools(),
      validate:()=>{if(deps.isShuttingDown() || ctx.sessionManager?.getSessionId()!==parentSessionId)throw new Error("Parent session unavailable or changed");},
      executeTool:(name,args,options)=>(ctx as any).executeTool(name,args,options),
     } : undefined},
				);
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
		};

	pi.registerTool({
		name: "dispatch_agent",
		label: "Dispatch Agent",
		description:
			"Run a task in a background agent that works concurrently with this session and gets its own token budget. Use it to fan independent work out in parallel: prefer one tasks array to start independent agents concurrently with one tool round trip; separate calls remain supported. No execution timeout is imposed; use manage_agent interrupt/close to stop a task. Finished results are delivered back into this conversation unless squash is false.",
		promptSnippet: "dispatch_agent: run a task in a concurrent background agent",
		promptGuidelines: [
			"When a goal has two or more independent file/module/verification lanes worth parallelizing, dispatch ready lanes early after minimal orientation; keep the parent on the critical path. Do not wait for exhaustive investigation, use fixed counts, split tightly coupled/simple work, or assign the same writable file to multiple owners.",
			"For ready independent lanes prefer one dispatch_agent tasks array with short role presets and disjoint writeScope; batch admission never waits for child completion. Do not create an extra planner/scout round when ownership is already known.",
			"Keep squash enabled so finished results return automatically; package the full goal/context/scope/interfaces/acceptance in every task.",
			"In default scoped mode, read/search tools work without writeScope. When a task needs commands, include exact testCommands and explicit writeScope at dispatch time; task prose alone does not authorize bash. User /agent requests use fullTools:true and verbatim agentArgs, inheriting active parent tools through approval without a command allowlist. Do not ask users to install or configure child tools.",
		],
		parameters: Type.Object({...DISPATCH_AGENT_PARAMETERS.properties,
   task:Type.Optional(DISPATCH_AGENT_PARAMETERS.properties.task),
   tasks:Type.Optional(Type.Array(DISPATCH_AGENT_PARAMETERS,{minItems:1,maxItems:6,description:"Start independent scoped tasks concurrently in ONE tool call. Each item has its own task, role, owned paths and checks. Results return admission records immediately; use batchId to collect. Do not batch dependent work."})),
  }),
		executionMode: "parallel",
        async execute(id,params,signal,onUpdate,ctx){
   if(params.tasks){
    if(params.task !== undefined)throw new Error("Provide task or tasks, not both");
    if(!params.tasks.length || params.tasks.length>6)throw new Error("tasks requires 1–6 independent tasks");
    for(const task of params.tasks){
     if(!task.task?.trim())throw new Error("Every batch task requires a nonempty task");
     roleInstruction(task.role);
     if(task.outputSchema!==undefined)compileOutputSchema(task.outputSchema);
    }
    const batchId=params.batchId ?? "batch-"+randomUUID();
    const results=await Promise.all(params.tasks.map(async(task,index)=>{
     try{return await executeOne(`${id}/${index}`,{...task,batchId},signal,onUpdate,ctx);}
     catch(error){return {details:{error:String(error)}};}
    }));
    const records=results.map((result,index)=>({index,...result.details}));
    return {content:[{type:"text",text:JSON.stringify({batchId,records})}],details:{batchId,records}};
   }
   if(!params.task?.trim())throw new Error("Provide a nonempty task or tasks batch");
   return executeOne(id,params as DispatchAgentParams,signal,onUpdate,ctx);
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

/** Command contexts lack executeTool: enter the real parent tool turn for the bridge. */
export function buildAgentCommandRequest(args: string): string {
 return `[Agent command request]\nCall dispatch_agent exactly once with these arguments, preserving agentArgs verbatim. This user-requested child inherits all active parent tools through approval hooks. Do not execute the task in the parent.\n${JSON.stringify({task:args,agentArgs:args,fullTools:true})}`;
}
