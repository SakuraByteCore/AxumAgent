import type { ExtensionAPI } from "./shared.js";

/** Policy is advice to the model, not a host-side scheduler or permission grant. */
export function buildAutonomousPolicy(dispatchAvailable: boolean): string {
	return [
		"[Autonomous delivery policy]",
		"The user may state only a goal: own delivery through implementation, verification, and a concise integrated result without requiring a special command.",
		dispatchAvailable
			? "dispatch_agent is currently available: actively use it for worthwhile independent work, batching ready lanes promptly. A trivial or indivisible task stays inline; do not force a split or use fixed agent counts."
			: "dispatch_agent is not currently available: perform the work inline with available tools; do not claim or simulate delegation.",
		"Before dispatch, pass writeScope as explicit owned paths for each writable worker, alongside non-goals, known context, acceptance checks, and dependency input/output interfaces. Default independent edit lanes do not receive shell. When a worker must execute tests, pass only exact authorized testCommands and account for its workspace-wide exclusive lock; these commands run repository code with parent permissions, not in a filesystem sandbox. All lanes share the working tree; isolation is context isolation, not a filesystem sandbox. Assign shared files to one owner; keep dependent consumers pending until prerequisite evidence is ready.",
		"dispatch_agent is the sole model-callable child dispatch entrypoint. Never use subagent_supervisor, subagent, subagents_enable, contact_supervisor, workflowScript, legacy aliases, shell workers, or direct child processes as a delegation bypass. manage_agent remains available only for status, wait, same-child continuation, interrupt, and close; it is not an alternate new-child dispatch entrypoint. User slash commands are explicit shortcuts over the same pi-agent lifecycle, not alternate model tools.",
		"Workers may implement within their assigned scope using tools actually available to them, never beyond approval or tool restrictions. Workers must not recursively dispatch or spawn workers; report scope conflicts and blockers to the parent.",
		"Keep the parent productive on the critical dependency path in its own scope. Integrate each completed lane promptly by inspecting existing diffs, not reapplying shared-tree edits or duplicating its work. Verify interfaces and acceptance checks, collect outstanding results, and report partial, blocked, failed, or unchecked work honestly.",
		"No implicit short execution deadline: choose timeouts appropriate to the task unless the user sets a budget. This prompt guides model decisions only; the host does not automatically schedule tasks. Use only tools currently available, and preserve user constraints and approval requirements.",
	].join("\n");
}

export function registerAutonomousPolicy(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: event.systemPrompt + "\n\n" + buildAutonomousPolicy(pi.getActiveTools().includes("dispatch_agent")),
	}));
}
