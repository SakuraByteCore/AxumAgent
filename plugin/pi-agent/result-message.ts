/** Directive appended to a plan-mode result so the main agent relays the finished plan verbatim instead of summarizing it. */
export const PLAN_RESULT_DIRECTIVE =
	"This sub-agent ran in plan mode. Treat its final assistant response as the finished plan: present it to the user verbatim — do not summarize, shorten, or rewrite it unless the user asks.";

/** The extra result-message lines to insert for plan-mode agents (empty for ordinary agents). */
export function planResultDirectiveLines(planMode: boolean): string[] {
	return planMode ? [PLAN_RESULT_DIRECTIVE] : [];
}