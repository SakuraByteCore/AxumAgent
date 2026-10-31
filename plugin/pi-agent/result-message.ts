/** Directive appended to a plan-mode result so the main agent relays the finished plan verbatim instead of summarizing it. */
export const PLAN_RESULT_DIRECTIVE =
	"This sub-agent ran in plan mode. Treat its final assistant response as the finished plan: present it to the user verbatim — do not summarize, shorten, or rewrite it unless the user asks.";

/** The extra result-message lines to insert for plan-mode agents (empty for ordinary agents). */
export function planResultDirectiveLines(planMode: boolean): string[] {
	return planMode ? [PLAN_RESULT_DIRECTIVE] : [];
}

/** Delivery is not acceptance: every result needs an explicit parent-side conclusion. */
export function parentResultDirectiveLines(planMode: boolean, ok: boolean): string[] {
	return [
		"[Parent result handoff] This result has reached the main conversation; it has not yet been reviewed or delivered to the user.",
		"Address this task explicitly in your next user-visible response, even when it arrives during unrelated work. Do not silently discard it or treat a completed child as an accepted result.",
		"Check the evidence against the original goal. If essential evidence is missing, obtain it with available parent tools, or state the exact unresolved gap; never present an incomplete investigation as a completed comparison.",
		...(ok ? planResultDirectiveLines(planMode) : ["Report failure or partial completion explicitly; preserve available evidence and distinguish it from verified success."]),
		"Integrate existing changes; for new requirements dispatch a new incremental task. Check existing effects first; no automatic side-effect retry.",
	];
}
