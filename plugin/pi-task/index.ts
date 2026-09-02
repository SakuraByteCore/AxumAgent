import { getAgentDir, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getAgentProfiles } from "./profiles.js";
import { buildCoordinatorPrompt } from "./prompts.js";
import {
	DEFAULT_MAX_CONCURRENCY,
	DEFAULT_MAX_WIDTH,
	createTaskTool,
	createUsageStatusState,
	normalizeLimit,
	updateUsageStatus,
	type DelegationState,
} from "./task-tool.js";
import type { TaskExtensionOptions } from "./types.js";

export function createTaskExtension(options: TaskExtensionOptions = {}): ExtensionFactory {
	const maxWidth = normalizeLimit(options.maxWidth, DEFAULT_MAX_WIDTH, "maxWidth");
	const maxConcurrency = normalizeLimit(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY, "maxConcurrency");

	return function taskExtension(pi: ExtensionAPI) {
		const rootState: DelegationState = { maxWidth, maxConcurrency, childCount: 0, progressEnabled: false };
		const usageStatusState = createUsageStatusState();

		pi.registerTool(
			createTaskTool(rootState, {
				getThinkingLevel: () => pi.getThinkingLevel(),
				updateStatus: (ctx, toolCallId, usage) => {
					if (!ctx.hasUI) {
						return;
					}
					updateUsageStatus(usageStatusState, ctx, toolCallId, usage);
				},
			}),
		);

		pi.on("session_start", (_event, ctx) => {
			usageStatusState.calls.clear();
			usageStatusState.latestCacheHitRate = undefined;
			if (ctx.hasUI) {
				ctx.ui.setStatus("pi-task", undefined);
			}
		});

		pi.on("before_agent_start", (event, ctx) => {
			if (!pi.getAllTools().some((tool) => tool.name === "task")) {
				return;
			}
			rootState.childCount = 0;
			const profiles = getAgentProfiles(ctx?.cwd ?? process.cwd(), getAgentDir());
			return {
				systemPrompt: `${event.systemPrompt}\n\n${buildCoordinatorPrompt(profiles)}`,
			};
		});
	};
}

export default createTaskExtension();
