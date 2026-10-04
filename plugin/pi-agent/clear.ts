import type { ExtensionAPI } from "./shared.js";

export type ClearDeps = {
	/** Detach every live agent and drop every completed card in one keystroke. */
	clearAll: () => { closedLive: number; dismissedCompleted: number };
};

/** Human-readable summary of what a clear swept away; empty string when there was nothing. */
export function describeClearCounts(counts: { closedLive: number; dismissedCompleted: number }): string {
	const parts: string[] = [];
	if (counts.closedLive > 0)
		parts.push(`detached ${counts.closedLive} running agent${counts.closedLive === 1 ? "" : "s"}`);
	if (counts.dismissedCompleted > 0)
		parts.push(
			`dismissed ${counts.dismissedCompleted} completed card${counts.dismissedCompleted === 1 ? "" : "s"}`,
		);
	return parts.join(", ");
}

export function registerClear(pi: ExtensionAPI, deps: ClearDeps): void {
	pi.registerCommand("aclear", {
		description:
			"Clear every /agent task at once: detach all running background agents and dismiss all completed cards: /aclear",
		getArgumentCompletions: () => null,
		async handler(_args: string, ctx) {
			const summary = describeClearCounts(deps.clearAll());
			if (!summary) {
				ctx.ui.notify("No /agent tasks to clear.", "info");
				return;
			}
			ctx.ui.notify(`Cleared /agent tasks: ${summary}.`, "info");
		},
	});
}
