// agentui-prefs.ts — pure helpers for the session-scoped /agentui model override.
// Zero runtime relative imports so node --test can import it directly from source.
//
// The /agentui command (plugin/pi-companion/agentui.ts) writes the user's
// /spawn and /blueprint model choices into a single globalThis slot; the
// dispatch path (runner.ts) reads them right before a preset dispatch so the
// choice is live for this session only and disappears with the process.
// The key literal is mirrored on the writer side — keep both in sync.

export const AGENTUI_PREFS_GLOBAL_KEY = "axumAgentUiModelPrefs";

/** A concrete model reference chosen on the /agentui page (auto is stored as null). */
export interface AgentUiModelRef {
	provider: string;
	id: string;
}

/** Shape written by plugin/pi-companion/agentui.ts. */
export interface AgentUiPrefs {
	sessionId: string;
	spawn: AgentUiModelRef | null;
	blueprint: AgentUiModelRef | null;
}

export function isAgentUiModelRef(value: unknown): value is AgentUiModelRef {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const ref = value as Record<string, unknown>;
	return typeof ref.provider === "string" && ref.provider !== "" && typeof ref.id === "string" && ref.id !== "";
}

/** Read the global slot with shape guarding; any malformed value is treated as absent. */
export function readAgentUiPrefs(): AgentUiPrefs | undefined {
	const raw = (globalThis as Record<string, unknown>)[AGENTUI_PREFS_GLOBAL_KEY];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const prefs = raw as Record<string, unknown>;
	if (typeof prefs.sessionId !== "string" || prefs.sessionId === "") return undefined;
	const spawn = prefs.spawn === null ? null : isAgentUiModelRef(prefs.spawn) ? prefs.spawn : null;
	const blueprint = prefs.blueprint === null ? null : isAgentUiModelRef(prefs.blueprint) ? prefs.blueprint : null;
	return { sessionId: prefs.sessionId, spawn, blueprint };
}

/** Map a slash-command invocation to the preset it targets; non-preset commands never override. */
export function presetFromInvocation(invocation: string): "spawn" | "blueprint" | undefined {
	const trimmed = invocation.trim();
	if (trimmed === "/spawn" || trimmed.startsWith("/spawn ")) return "spawn";
	if (trimmed === "/blueprint" || trimmed.startsWith("/blueprint ")) return "blueprint";
	return undefined;
}

/**
 * Resolve the /agentui override for a dispatch: only /spawn and /blueprint
 * preset invocations in the same session are eligible. "auto" (null) never
 * overrides — the caller keeps the inherited current-session model.
 */
export function resolveAgentUiModelOverride(
	invocation: string,
	sessionId: string | undefined,
): AgentUiModelRef | undefined {
	if (!sessionId) return undefined;
	const prefs = readAgentUiPrefs();
	if (!prefs || prefs.sessionId !== sessionId) return undefined;
	const preset = presetFromInvocation(invocation);
	if (!preset) return undefined;
	const ref = prefs[preset];
	return ref ?? undefined;
}
