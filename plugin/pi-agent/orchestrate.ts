import type { ExtensionAPI } from "./shared.js";

export const DEFAULT_ORCHESTRATION_BUDGET_MS = 10 * 60 * 1000;
export const MAX_ORCHESTRATION_BUDGET_MS = 24 * 60 * 60 * 1000;

export type OrchestrationRequest = {
	budgetMs: number;
	task: string;
};

const DURATION_TOKEN = /(\d+(?:\.\d+)?)(h|m|s)/g;
const UNIT_MS = { h: 3_600_000, m: 60_000, s: 1_000 } as const;

/**
 * Parse a leading wall-clock budget like "90s", "10m", "1h30m", or bare minutes
 * ("7"); without a duration the default budget is 10m. Returns undefined when no
 * task text remains. Budgets above 24h are clamped to the pi-subagents
 * timeout ceiling (86400000ms).
 */
export function parseOrchestrationArgs(args: string): OrchestrationRequest | undefined {
	const trimmed = args.trim();
	if (!trimmed) return undefined;
	const tokens = trimmed.split(/\s+/);
	const first = tokens[0];
	let budgetMs: number | undefined;
	let taskOffset = 0;
	if (/^\d+(?:\.\d+)?$/.test(first)) {
		budgetMs = Number(first) * UNIT_MS.m;
		taskOffset = 1;
	} else if (/^\d/.test(first) && /[hms]/.test(first)) {
		let total = 0;
		let consumed = 0;
		DURATION_TOKEN.lastIndex = 0;
		for (let match = DURATION_TOKEN.exec(first); match !== null; match = DURATION_TOKEN.exec(first)) {
			total += Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
			consumed += match[0].length;
		}
		if (consumed === first.length && total > 0) {
			budgetMs = total;
			taskOffset = 1;
		}
	}
	const task = tokens.slice(taskOffset).join(" ");
	if (!task) return undefined;
	const resolved = budgetMs === undefined ? DEFAULT_ORCHESTRATION_BUDGET_MS : Math.round(budgetMs);
	return { budgetMs: Math.min(resolved, MAX_ORCHESTRATION_BUDGET_MS), task };
}

/** Build the latency-first orchestration protocol prompt injected into the main agent. */
export function buildOrchestrationPrompt(request: OrchestrationRequest, now: number = Date.now()): string {
	const budgetSeconds = Math.round(request.budgetMs / 1000);
	const deadlineAt = new Date(now + request.budgetMs).toISOString();
	return [
		"[Orchestration Request]",
		request.task,
		"",
		"[Orchestration Protocol]",
		`You are the latency-first orchestrator. Wall-clock budget: ${budgetSeconds}s; absolute deadline: ${deadlineAt}. Token cost is irrelevant; wall-clock latency is the only metric.`,
		"1. Execute first: in your first action, start doing the most direct core step of the task yourself (read the relevant code, make the first real change); never open with a decomposition pass or a plan.",
		`2. Split cheaply while executing: as you work, peel off only obviously independent chunks (scouting, lookups, builds, test runs) and dispatch each as an async subagent workflowScript call with top-level timeoutMs = ${request.budgetMs}; children that omit timeoutMs inherit the host-enforced remaining budget.`,
		"3. Add workers progressively: delegate more only as execution reveals genuinely parallelizable shards or confirmed bottlenecks; never pre-launch speculative lanes for work you have not examined yourself.",
		"4. Reserve roughly the last 20% of the budget for verification and synthesis; verify lanes use acceptance checks that require verifiable evidence.",
		"5. At ~80% of the budget, steer still-running children to emit their best partial structured envelope; interrupt redundant or losing lanes once one lane passes an acceptance-checked verifier.",
		"6. Every lane returns a structured envelope: status (done|partial|blocked|failed), changes/findings, evidence, remainingRisks.",
		"7. Arbitrate only from the envelopes: prefer verified evidence over prose, report uncovered shards explicitly, and synthesize one consolidated result for the user.",
		"",
	].join("\n");
}

export function registerOrchestrate(pi: ExtensionAPI): void {
	pi.registerCommand("orchestrate", {
		description:
			"Latency-first orchestration under a wall-clock budget: /orchestrate [duration] <task> (duration like 90s, 10m, 1h30m; default 10m)",
		getArgumentCompletions: () => null,
		async handler(args: string, ctx) {
			const request = parseOrchestrationArgs(args);
			if (!request) {
				ctx.ui.notify("Please provide a task: /orchestrate [duration] <task> (duration like 90s, 10m, 1h30m; default 10m)", "warning");
				return;
			}
			ctx.ui.notify(`Orchestration request sent with a ${Math.round(request.budgetMs / 1000)}s wall-clock budget.`, "info");
			await pi.sendUserMessage(buildOrchestrationPrompt(request), { streamingBehavior: "followUp" });
		},
	});
}
