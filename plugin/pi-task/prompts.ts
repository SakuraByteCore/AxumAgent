import type { AgentProfile } from "./types.js";

export const TASK_PROMPT_SNIPPET =
	"Launch a fresh subagent when the task matches an available agent, can run independently, or would read across several files. Pass a tasks array to run several independent subagents concurrently.";

export const TASK_PROMPT_GUIDELINES = [
	"Reach for task when the work matches an available agent, when you have independent work to run in parallel, or when answering would mean reading across several files.",
	"Prefer one task call with a tasks array over several sequential task calls: the batch runs the subagents concurrently under a shared concurrency limit.",
	"Use explorer for repository reconnaissance, locating files, tracing references, and concise read-only findings.",
	"For a single-fact lookup where you already know the file, symbol, or value, search directly instead of spawning a subagent.",
	"Write self-contained briefings: fresh subagents do not inherit parent conversation, tool results, or reasoning.",
	"Subagents cannot launch task themselves; coordinate any follow-up delegation from the main conversation after a result returns.",
	"Clearly tell the subagent whether you expect read-only research or code changes.",
	"The subagent final message is returned to you as the tool result and is not shown to the user; relay what matters.",
];

function formatAvailableAgents(profiles: Map<string, AgentProfile>): string {
	return [...profiles.values()].map((profile) => `- ${profile.name}: ${profile.description}`).join("\n");
}

export function buildCoordinatorPrompt(profiles: Map<string, AgentProfile>): string {
	return `# Subagent Delegation

Delegate work to a fresh subagent with the \`task\` tool when a specialized agent matches the request, the work can run independently, or delegating keeps large search/read output out of the main context.

Available agents:
${formatAvailableAgents(profiles)}

Guidelines:
- Do not use subagents excessively; direct lookup is better when the target file, symbol, or value is already known.
- If the user asks for parallel work, launch independent subagents in one \`task\` call via its \`tasks\` array so they run concurrently.
- Subagents start fresh and do not inherit parent messages, tool results, or reasoning. Brief them with all needed context.
- Subagents cannot launch other subagents. Coordinate follow-up delegation from the main conversation after each result returns.
- The subagent final message is returned to you as the tool result. Relay what matters to the user.

Concurrent delegation is bounded by the extension. If the limit is reached, the \`task\` tool rejects the call; split the batch into smaller groups.`;
}
