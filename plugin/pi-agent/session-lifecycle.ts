import type { ExtensionAPI, ExtensionCommandContext, RunningAgent } from "./shared.js";

export interface SessionLifecycleDeps {
	runningAgents: Set<RunningAgent>;
 waitPending?: () => Promise<unknown>;
	setShuttingDown: (value: boolean) => void;
	setMainSessionContext: (ctx: ExtensionCommandContext) => void;
	disposeWidget: () => void;
}

export function registerSessionLifecycle(pi: ExtensionAPI, deps: SessionLifecycleDeps): void {
	pi.on("session_start", (_event, ctx) => {
		deps.setShuttingDown(false);
		deps.setMainSessionContext(ctx);
	});

	pi.on("session_shutdown", async () => {
		deps.setShuttingDown(true);
		deps.disposeWidget();
		const agents = [...deps.runningAgents];
		for (const agent of agents) {
			agent.aborted = true;
			agent.cancelDeadline?.();
			if(agent.session) void Promise.resolve(agent.session.abort()).catch(() => {});
			agent.retire?.();
		}
		await deps.waitPending?.();
		await Promise.allSettled(agents.map((agent) => agent.finished));
		for (const agent of agents) {
			agent.session?.dispose();
		}
		deps.runningAgents.clear();
	});
}
