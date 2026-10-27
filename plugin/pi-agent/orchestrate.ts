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
export function parseOrchestrationArgs(
	args: string,
	defaultBudgetMs: number = DEFAULT_ORCHESTRATION_BUDGET_MS,
): OrchestrationRequest | undefined {
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
	const resolved = budgetMs === undefined ? defaultBudgetMs : Math.round(budgetMs);
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
		"1. Fan out first: derive independent, non-overlapping lanes from the task and issue all ready dispatch_agent calls in your first tool turn. Prefer parallel implementation over serial exploration; do not emit a long plan first. Choose lane count from actual independent work, not fixed roles or duplicate races.",
		"2. Keep squash=true so results return automatically. Set isolate=true only with a self-contained task; isolate means blank conversation, NOT a filesystem sandbox. Assign exclusive file ownership; never let concurrent lanes edit the same file. Run dependent work only after its prerequisites arrive.",
		`3. Every dispatch_agent call must pass timeoutMs as the positive remaining milliseconds until ${deadlineAt}, reserving roughly the last 20% of the budget for verification and synthesis. Initial total budget: ${request.budgetMs}ms. Recalculate remaining time before later dispatches; never restart the original budget or dispatch after the deadline. The host cancels that lane on expiry; there is no global watchdog.`,
		"4. The main agent arbitrates, integrates, and verifies results rather than duplicating dispatched work. For indivisible tasks dispatch one implementation lane; add verification only when its input is available. Token cost is secondary to fast, verified delivery.",
		"5. Each lane returns a structured envelope: status (done|partial|blocked|failed), changes/findings, evidence, remainingRisks. On its allotted deadline a lane may return partial output; never treat a timeout as success.",
		"6. Wait for dispatched results before final synthesis. Verify actual diffs and core acceptance checks; report incomplete lanes and conflicts explicitly. Do not commit or push other lanes' unfinished changes. Return one consolidated result, not raw agent transcripts.",
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

/** /quick ships a tight default budget: split-and-parallelize within minutes. */
export const DEFAULT_QUICK_BUDGET_MS = 5 * 60 * 1000;
const QUICK_VERIFICATION_BUDGET_RATIO = 0.2;

/** Build the split-first quick-delivery prompt injected into the main agent. */
export function buildQuickSplitPrompt(request: OrchestrationRequest, now: number = Date.now()): string {
	const budgetSeconds = request.budgetMs / 1000;
	const deadlineAt = new Date(now + request.budgetMs).toISOString();
	const verificationMs = Math.floor(request.budgetMs * QUICK_VERIFICATION_BUDGET_RATIO);
	const implementationDeadlineMs = now + request.budgetMs - verificationMs;
	const implementationDeadlineAt = new Date(implementationDeadlineMs).toISOString();
	return [
		"[Quick Split Request]",
		request.task,
		"",
		"[Quick Split Protocol]",
		`Split first, ship fast. Wall-clock budget: ${budgetSeconds}s; absolute deadline: ${deadlineAt}. Token cost is irrelevant; wall-clock latency is the only metric.`,
		"1. A trivial or indivisible task stays inline. Otherwise, partition the requirement into 1-4 independent, non-overlapping implementation lanes by exclusive file/scope ownership, including the main agent's scope. In your first tool turn issue all ready dispatch_agent calls at once; if ownership is unknown, do only the targeted lookup needed to establish it. Skip a separate planning pass and duplicate races.",
		"2. Use dispatch_agent with a complete task, squash=true, and isolate=true only for self-contained scopes. Each task must state owned files, acceptance checks, and both absolute deadlines. Isolation means blank context, NOT a filesystem sandbox; all lanes share the working tree.",
		`3. Implementation deadline: ${implementationDeadlineAt} (epoch ms: ${implementationDeadlineMs}); reserve ${verificationMs}ms of the initial ${request.budgetMs}ms budget for verification and synthesis.`,
		`4. Immediately before each dispatch, obtain the current epoch milliseconds and calculate timeoutMs = Math.floor(${implementationDeadlineMs} - currentTimeMs). Pass that positive integer; if it is <= 0, do not dispatch. Never reset the budget. Host timeouts start after agent startup, not at command entry; there is no global watchdog, so lanes must also honor the absolute implementation deadline.`,
		"5. While lanes run, work only on your own independent scope or verification prep. Do not edit their files or consume unfinished dependent work. Results return automatically: no sleep, polling loop, or artificial wait.",
		"6. Integrate results as they arrive by inspecting the shared working-tree diff, not reapplying edits already present. Run dependent checks only once their inputs are ready; do not duplicate a lane's implementation or checks without a changed input or failure.",
		"7. Each lane reports status (done|partial|blocked|failed), changed paths, checks with results, and remaining risks. Stop implementation at its deadline; partial output and timeouts are not success.",
		"8. Verify actual diffs and core acceptance checks before synthesis. Do not claim completion while lanes are outstanding; at the final deadline report them as incomplete, along with unchecked changes and failures. Deliver early if finished; do not spend the remaining budget merely to fill it.",
		"9. Deliver one consolidated result with minimal prose; no process narration, no questions mid-run, and no new work or retries past the deadline.",
		"",
	].join("\n");
}

export function registerQuick(pi: ExtensionAPI): void {
	pi.registerCommand("quick", {
		description:
			"Split-and-ship: /quick [duration] <requirement> — the main agent splits the requirement into parallel lanes and implements it fast (duration like 90s, 10m; default 5m)",
		getArgumentCompletions: () => null,
		async handler(args: string, ctx) {
			const request = parseOrchestrationArgs(args, DEFAULT_QUICK_BUDGET_MS);
			if (!request || request.budgetMs <= 0) {
				ctx.ui.notify("Please provide a requirement: /quick [duration] <requirement> (duration like 90s, 10m; default 5m)", "warning");
				return;
			}
			ctx.ui.notify(`Quick split request sent with a ${request.budgetMs / 1000}s wall-clock budget.`, "info");
			await pi.sendUserMessage(buildQuickSplitPrompt(request), { streamingBehavior: "steer" });
		},
	});
}
