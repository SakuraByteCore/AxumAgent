import type { RunningAgent, CompletedAgent } from "./shared.js";

/** Default -p reference: the most recently dispatched plan-mode agent. */
export const PLAN_REF_LATEST = "latest";

const NO_RELAY_SOURCE_LATEST =
	"No plan-mode agent to relay: run /blueprint <task> first, then dispatch again with -p.";

const RELAY_DIRECTIVE =
	"A finished plan follows below. It was produced by a plan-mode agent and the user has chosen " +
	"to have you implement it. Follow it exactly; do not re-plan, re-research, or redesign. " +
	"If a step is genuinely impossible, stop and report the obstacle instead of improvising a different plan.";

/** Marker an interrupted turn's response starts with (see interruptedTurnResponse). */
const INTERRUPTED_RESPONSE_PREFIX = "Interrupted by user.";

/** How often the relay re-checks a live blueprint while waiting for its plan. */
const WAIT_POLL_MS = 250;

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

/** A plan-mode agent seen as a relay source; `live` means its plan is not final yet. */
export type PlanRelayCandidate = {
	id: string;
	sessionId: string;
	task: string;
	startedAt: number;
	/** Set while the source agent is mid-turn (starting/running): the relay must wait. */
	live?: boolean;
	/** The finished plan text; absent while live. */
	planText?: string;
	/** Whether the source's turn ended successfully; absent while live. */
	ok?: boolean;
};

/** The resolved, validated source consumed by the dispatching runner. */
export type PlanRelaySource = {
	id: string;
	sessionId: string;
	task: string;
	planText: string;
};

/** Where resolvePlanRelay looks up live and completed plan-mode agents. */
export type PlanRelayLookup = {
	running: () => PlanRelayCandidate[];
	completed: () => PlanRelayCandidate[];
	notify?: (message: string) => void;
	/** Sleep between re-checks while waiting for a live blueprint (tests inject an instant tick). */
	sleep?: (ms: number) => Promise<void>;
};

/** Map a live RunningAgent to a relay candidate; only mid-turn agents stay live. */
export function runningPlanCandidate(agent: RunningAgent): PlanRelayCandidate {
	const base = {
		id: agent.id,
		sessionId: agent.sessionId,
		task: agent.task,
		startedAt: agent.startedAt,
	};
	const live = agent.status === "starting" || agent.status === "running";
	if (live) return { ...base, live: true };
	return {
		...base,
		planText: agent.responseText,
		ok: isUsablePlanText(agent.responseText),
	};
}

/** Map a completed plan-mode agent to a relay candidate. */
export function completedPlanCandidate(agent: CompletedAgent): PlanRelayCandidate {
	return {
		id: agent.id,
		sessionId: agent.sessionId,
		task: agent.task,
		startedAt: agent.startedAt,
		planText: agent.responseText,
		ok: agent.ok && isUsablePlanText(agent.responseText),
	};
}

/** Select the relay candidate for a -p reference: an exact id, else the newest dispatched plan agent. */
export function selectPlanCandidate(
	ref: string,
	running: PlanRelayCandidate[],
	completed: PlanRelayCandidate[],
): PlanRelayCandidate | undefined {
	if (ref !== PLAN_REF_LATEST) {
		return (
			running.find((candidate) => candidate.id === ref) ??
			completed.find((candidate) => candidate.id === ref)
		);
	}
	const pool = [...running, ...completed];
	let newest: PlanRelayCandidate | undefined;
	for (const candidate of pool) {
		if (newest === undefined || candidate.startedAt > newest.startedAt) newest = candidate;
	}
	return newest;
}

/**
 * Resolve the -p reference to a validated plan source: a live candidate is polled until its
 * turn settles — retiring into the completed pool, or parking idle with the plan as its final
 * response — and anything without usable plan text is a hard error.
 *
 * The RunningAgent `finished` promise is deliberately not awaited: it settles on retirement,
 * and an interrupted or interactive (`/agent -P`) plan agent parks idle while staying alive,
 * which would hang the relay forever. The published `status` is the only turn-settlement signal.
 */
export async function resolvePlanRelay(ref: string, lookup: PlanRelayLookup): Promise<PlanRelaySource> {
	const candidate = selectPlanCandidate(ref, lookup.running(), lookup.completed());
	if (!candidate) {
		throw new Error(
			ref === PLAN_REF_LATEST
				? NO_RELAY_SOURCE_LATEST
				: `No plan-mode agent with id ${ref} to relay.`,
		);
	}
	if (!candidate.live) return requirePlanText(candidate, candidate.id);
	lookup.notify?.(
		`Blueprint ${candidate.id} is still running — waiting for its plan before dispatching.`,
	);
	const settled = await waitUntilSettled(ref, candidate, lookup);
	return requirePlanText(settled, settled.id);
}

async function waitUntilSettled(
	ref: string,
	last: PlanRelayCandidate,
	lookup: PlanRelayLookup,
): Promise<PlanRelayCandidate> {
	const sleep = lookup.sleep ?? DEFAULT_SLEEP;
	while (true) {
		await sleep(WAIT_POLL_MS);
		const again = selectPlanCandidate(ref, lookup.running(), lookup.completed());
		// Vanished from both pools: retired without a completed entry (aborted/closed). Fall
		// through with the stale live candidate so requirePlanText reports the unusable plan.
		if (!again) return last;
		if (!again.live) return again;
		last = again;
	}
}

/** Compose the dispatched agent's first instruction: directive + verbatim plan + optional supplement. */
export function composeRelayInstruction(source: PlanRelaySource, supplement: string): string {
	const lines = [
		RELAY_DIRECTIVE,
		`The plan to implement (verbatim, from blueprint ${source.id}):`,
		source.planText,
		"End of plan.",
	];
	const trimmed = supplement.trim();
	if (trimmed) lines.push(`Additional instruction from the user: ${trimmed}`);
	return lines.join("\n");
}

function isUsablePlanText(text: string): boolean {
	return text.trim() !== "" && !text.startsWith(INTERRUPTED_RESPONSE_PREFIX);
}

function requirePlanText(
	candidate: PlanRelayCandidate | undefined,
	awaitedId: string,
): PlanRelaySource {
	if (!candidate || candidate.ok === false || !candidate.planText || !candidate.planText.trim()) {
		throw new Error(
			`The plan agent ${awaitedId} did not finish with a usable plan (it failed, was interrupted, or was closed). ` +
				"Nothing to relay — re-run /blueprint and try again.",
		);
	}
	return {
		id: candidate.id,
		sessionId: candidate.sessionId,
		task: candidate.task,
		planText: candidate.planText,
	};
}
