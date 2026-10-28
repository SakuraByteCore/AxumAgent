import { registerAutonomousPolicy } from "./autonomous.js";
import { registerAgentManagement } from "./manage.js";
import { registerDesktopPet } from "./desktop-pet.js";
import { registerClear } from "./clear.js";
import { registerDispatch } from "./dispatch.js";
import { registerOrchestrate, registerQuick } from "./orchestrate.js";
import { registerPresets } from "./presets.js";
import { registerSessionLifecycle } from "./session-lifecycle.js";
import type {
	MessageEndEvent,
	MessageEndEventResult,
} from "@earendil-works/pi-coding-agent";
import { registerAgentAutocomplete } from "./autocomplete.js";
import { createRebaseDelivery, handleAgentCommand, startUserAgent, registryFor } from "./runner.js";
import type {
	AgentCommandDetails,
	DetachedEntryData,
	ExtensionAPI,
	ExtensionCommandContext,
	RunningAgent,
} from "./shared.js";
import { DETACHED_ENTRY_TYPE, MESSAGE_TYPE } from "./shared.js";
import { registerUserAgentRenderer } from "./transcript.js";
import { UserAgentWidget } from "./widget.js";

export default function userAgent(pi: ExtensionAPI): void {
	registerDesktopPet(pi);
	registerAutonomousPolicy(pi);
	const runningAgents = new Set<RunningAgent>();
	registerAgentManagement(pi,registryFor(runningAgents),runningAgents);
	const disabledCommands = new Set<string>();
	// The session every agent was dispatched from; rebase fast-forwards onto it.
	let mainSessionContext: ExtensionCommandContext | undefined;
	const widget = new UserAgentWidget(
		runningAgents,
		(message) => pi.sendMessage(message, { triggerTurn: true }),
		(sessionId, sequence) => pi.appendEntry<DetachedEntryData>(DETACHED_ENTRY_TYPE, { sessionId, sequence }),
		createRebaseDelivery(pi, () => mainSessionContext),
	);
	let shuttingDown = false;
	let nextAgentNumber = 0;

	registerUserAgentRenderer(pi);
	registerAgentAutocomplete(pi);

	pi.on("message_end", (event) => confirmMainContextSquash(event, widget));

	pi.registerCommand("agent", {
		description:
			"Run one independent real OAR Codex task (mandatory isolated runtime; read-only here). Use dispatch_agent with owned writeScope for edits; Pi CLI/model flags are not native overrides.",
		handler: async (args, ctx) => {
			mainSessionContext = ctx;
			await handleAgentCommand(
				pi,
				runningAgents,
				widget,
				disabledCommands,
				() => shuttingDown,
				() => ++nextAgentNumber,
				"agent",
				args,
				`/agent ${args}`.trim(),
				ctx,
			);
		},
	});

	// ── /spawn, /scout, /blueprint: one-keystroke flag presets over /agent ────

	registerPresets(pi, {
		disabledCommands,
		run: (presetArgs, invocation, ctx) => {
			mainSessionContext = ctx;
			return handleAgentCommand(
				pi,
				runningAgents,
				widget,
				disabledCommands,
				() => shuttingDown,
				() => ++nextAgentNumber,
				"agent",
				presetArgs,
				invocation,
				ctx,
			);
		},
	});

	// ── /aclear: one-keystroke cleanup of every /agent task ───────────────

	registerClear(pi, {
		clearAll: () => widget.clearAll(),
	});

	// ── /dispatch + dispatch_agent: main-agent-driven batch fan-out ─────────────

	registerDispatch(pi, {
		isShuttingDown: () => shuttingDown,
		startAgent: (dispatchArgs, invocation, ctx, deadline, batchId, permissions) =>
			startUserAgent(
				pi,
				runningAgents,
				widget,
				disabledCommands,
				() => shuttingDown,
				() => ++nextAgentNumber,
				"agent",
				dispatchArgs,
				invocation,
				ctx,
				deadline,
				batchId,
				permissions,
			),
	});

	// ── /orchestrate: latency-first orchestration under a wall-clock budget ──

	registerOrchestrate(pi);

	// ── /quick: concise delivery with optional explicit budget ────────────────
	registerQuick(pi);

	registerSessionLifecycle(pi, {
		runningAgents,
		waitPending: () => Promise.allSettled([...registryFor(runningAgents).pendingStarts]),
		setShuttingDown: (value) => { shuttingDown = value; if(value)registryFor(runningAgents).shutdown(); },
		setMainSessionContext: (ctx) => { mainSessionContext = ctx; },
		disposeWidget: () => widget.dispose(),
	});
}

export function confirmMainContextSquash(
	event: MessageEndEvent,
	widget: UserAgentWidget,
): MessageEndEventResult | undefined {
	if (event.message.role !== "custom" || event.message.customType !== MESSAGE_TYPE) return;
	const details = event.message.details as AgentCommandDetails | undefined;
	if (!details?.agentId || details.mainContextState !== "will-squash") return;
	widget.confirmMainContextSquash(details.agentId);
	details.mainContextState = "squashed";
	return {
		message: {
			...event.message,
			details: { ...details, mainContextState: "squashed" },
		},
	};
}
