process.env.PI_COMPANION_ZEN_SYNC_DISABLE = "1";
import assert from "node:assert/strict";
import test from "node:test";
import {
	AGENTUI_PREFS_GLOBAL_KEY,
	isAgentUiModelRef,
	presetFromInvocation,
	readAgentUiPrefs,
	resolveAgentUiModelOverride,
} from "../plugin/pi-agent/agentui-prefs.ts";
import { choiceToRef, readPrefs, writePrefs } from "../plugin/pi-companion/agentui.ts";
import { parseModelManifest } from "../plugin/pi-companion/model-switch.ts";

const MANIFEST = {
	providers: {
		opencode: { models: [{ id: "grok-code" }, { id: "gpt-5.2", default: true }] },
		openai: { models: [{ id: "o4-mini" }] },
	},
};
const ENTRIES = parseModelManifest(MANIFEST);
const SESSION = "sess-a";

function cleanup() {
	delete (globalThis)[AGENTUI_PREFS_GLOBAL_KEY];
}

test("presetFromInvocation only matches spawn/blueprint presets", () => {
	assert.equal(presetFromInvocation("/spawn"), "spawn");
	assert.equal(presetFromInvocation("/spawn do work"), "spawn");
	assert.equal(presetFromInvocation("/blueprint design it"), "blueprint");
	assert.equal(presetFromInvocation("/blueprint"), "blueprint");
	// Non-preset commands and lookalikes never override.
	assert.equal(presetFromInvocation("/agent run"), undefined);
	assert.equal(presetFromInvocation("/scout look"), undefined);
	assert.equal(presetFromInvocation("/dispatch /spawn x"), undefined);
	assert.equal(presetFromInvocation("/spawned thing"), undefined);
	assert.equal(presetFromInvocation(""), undefined);
});

test("isAgentUiModelRef guards the shape", () => {
	assert.equal(isAgentUiModelRef({ provider: "opencode", id: "grok-code" }), true);
	assert.equal(isAgentUiModelRef(null), false);
	assert.equal(isAgentUiModelRef("opencode/grok-code"), false);
	assert.equal(isAgentUiModelRef({ provider: "", id: "x" }), false);
	assert.equal(isAgentUiModelRef({ provider: "opencode" }), false);
	assert.equal(isAgentUiModelRef({ provider: "a", id: "b", extra: 1 }), true);
});

test("resolveAgentUiModelOverride applies session-scoped prefs", () => {
	cleanup();
	// Absent slot, non-preset invocation, missing sessionId: never override.
	assert.equal(resolveAgentUiModelOverride("/spawn x", SESSION), undefined);
	assert.equal(resolveAgentUiModelOverride("/agent x", SESSION), undefined);
	assert.equal(resolveAgentUiModelOverride("/spawn x", undefined), undefined);

	writePrefs({ sessionId: SESSION, spawn: { provider: "opencode", id: "grok-code" }, blueprint: null });
	assert.deepEqual(resolveAgentUiModelOverride("/spawn x", SESSION), { provider: "opencode", id: "grok-code" });
	// Other session: isolated, never leaks across sessions.
	assert.equal(resolveAgentUiModelOverride("/spawn x", "sess-b"), undefined);
	// auto (null) means no override.
	assert.equal(resolveAgentUiModelOverride("/blueprint x", SESSION), undefined);
	// Malformed slot is treated as absent.
	(globalThis)[AGENTUI_PREFS_GLOBAL_KEY] = { sessionId: SESSION, spawn: "opencode/grok-code" };
	assert.equal(resolveAgentUiModelOverride("/spawn x", SESSION), undefined);
	cleanup();
});

test("readAgentUiPrefs shape-guards the global slot", () => {
	cleanup();
	assert.equal(readAgentUiPrefs(), undefined);
	writePrefs({ sessionId: SESSION, spawn: { provider: "openai", id: "o4-mini" }, blueprint: null });
	const prefs = readAgentUiPrefs();
	assert.deepEqual(prefs, { sessionId: SESSION, spawn: { provider: "openai", id: "o4-mini" }, blueprint: null });
	// Writer (pi-companion) and reader (pi-agent) agree on the same slot.
	assert.deepEqual(readPrefs(), prefs);
	cleanup();
});

test("choiceToRef validates choices against the manifest", () => {
	assert.equal(choiceToRef("auto", ENTRIES), null);
	assert.deepEqual(choiceToRef("opencode/grok-code", ENTRIES), { provider: "opencode", id: "grok-code" });
	assert.deepEqual(choiceToRef("openai/o4-mini", ENTRIES), { provider: "openai", id: "o4-mini" });
	assert.equal(choiceToRef("opencode/nope", ENTRIES), undefined);
	assert.equal(choiceToRef("ghost/model", ENTRIES), undefined);
	assert.equal(choiceToRef("/grok-code", ENTRIES), undefined);
	assert.equal(choiceToRef(123, ENTRIES), undefined);
	assert.equal(choiceToRef(undefined, ENTRIES), undefined);
});
