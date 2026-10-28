import type { ExtensionAPI } from "./shared.js";

/** Policy is advice to the model, not a host-side scheduler or permission grant. */
export function buildAutonomousPolicy(dispatchAvailable: boolean): string {
	return [
		"[Autonomous delivery policy]",
		"The user may state only a goal: own delivery through implementation, verification, and a concise integrated result without requiring a special command.",
		dispatchAvailable
			? "dispatch_agent is currently available: actively use it for worthwhile independent work, batching ready lanes promptly. When there are 2+ independent files, modules, or verification branches worth parallelizing, dispatch early; simple or tightly coupled work stays inline. A trivial or indivisible task stays inline; do not force a split or use fixed agent counts."
			: "dispatch_agent is not currently available: perform the work inline with available tools; do not claim or simulate delegation.",
		"Children have independent contexts: package the complete goal, relevant source/context, non-goals, input/output interfaces, and acceptance checks. Before dispatch, pass writeScope as explicit owned paths for each writable worker, alongside non-goals, known context, acceptance checks, and dependency input/output interfaces. Default workers use controlled-pi with the existing main model and authentication: no Docker, external CLI, or new API key is required. Scoped writes use the live parent executeTool approval bridge; authorize exact testCommands for required checks. Without the bridge, command contexts are read-only. This is not an OS sandbox. Omit scope for read-only. Assign shared files to one owner; keep dependent consumers pending until prerequisite evidence is ready.",
		"dispatch_agent is the sole model-callable child dispatch entrypoint. Never use subagent_supervisor, subagent, subagents_enable, contact_supervisor, workflowScript, legacy aliases, shell workers, or direct child processes as a delegation bypass. manage_agent remains available only for status, wait, interrupt, and close (one-shot: no send/resume/rebase; inspect results and dispatch a new incremental task for new requirements; never automatically repeat side effects); it is not an alternate new-child dispatch entrypoint. User slash commands are explicit shortcuts over the same pi-agent lifecycle, not alternate model tools.",
		"Workers may implement within their assigned scope using tools actually available to them, never beyond approval or tool restrictions. Workers must not recursively dispatch or spawn workers; report scope conflicts and blockers to the parent.",
		"Keep the parent productive on the critical dependency path in its own scope. Integrate each completed lane promptly by inspecting existing diffs, not duplicating child edits. Verify interfaces and acceptance checks, collect outstanding results, remediate failed or incomplete lanes within authorized scope, run unified verification, and report partial, blocked, failed, or unchecked work honestly.",
		"No implicit short execution deadline: choose timeouts appropriate to the task unless the user sets a budget. This prompt guides model decisions only; the host does not automatically schedule tasks. Use only tools currently available, and preserve user constraints and approval requirements.",
	].join("\n");
}

export function registerAutonomousPolicy(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: event.systemPrompt + "\n\n" + buildAutonomousPolicy(pi.getActiveTools().includes("dispatch_agent")),
	}));
}
