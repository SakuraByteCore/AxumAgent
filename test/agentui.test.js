process.env.PI_COMPANION_ZEN_SYNC_DISABLE = "1";
import assert from "node:assert/strict";
import test from "node:test";
import {
	AGENTUI_PREFS_GLOBAL_KEY,
	chooseDispatchModel,
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

test("presetFromInvocation handles whitespace and case strictly", () => {
	assert.equal(presetFromInvocation("  /spawn   fix it  "), "spawn");
	assert.equal(presetFromInvocation("\t/blueprint x"), "blueprint");
	// Case-sensitive: preset names are lowercase by contract.
	assert.equal(presetFromInvocation("/Spawn x"), undefined);
	assert.equal(presetFromInvocation("/BLUEPRINT x"), undefined);
	// " /spawn" with a leading space still targets the preset after trim.
	assert.equal(presetFromInvocation(" /spawn x"), "spawn");
});

test("readAgentUiPrefs rejects non-object slots and bad session ids", () => {
	cleanup();
	const slot = (globalThis)[AGENTUI_PREFS_GLOBAL_KEY];
	(globalThis)[AGENTUI_PREFS_GLOBAL_KEY] = "spawn=auto";
	assert.equal(readAgentUiPrefs(), undefined);
	(globalThis)[AGENTUI_PREFS_GLOBAL_KEY] = ["not", "an", "object"];
	assert.equal(readAgentUiPrefs(), undefined);
	(globalThis)[AGENTUI_PREFS_GLOBAL_KEY] = { sessionId: 123, spawn: null, blueprint: null };
	assert.equal(readAgentUiPrefs(), undefined);
	(globalThis)[AGENTUI_PREFS_GLOBAL_KEY] = { sessionId: "", spawn: null, blueprint: null };
	assert.equal(readAgentUiPrefs(), undefined);
	// Malformed per-preset refs degrade to null (auto) without killing the other side.
	(globalThis)[AGENTUI_PREFS_GLOBAL_KEY] = { sessionId: SESSION, spawn: { provider: "p", id: "m" }, blueprint: 42 };
	assert.deepEqual(readAgentUiPrefs(), { sessionId: SESSION, spawn: { provider: "p", id: "m" }, blueprint: null });
	cleanup();
	assert.equal(slot, undefined);
});

test("resolveAgentUiModelOverride resolves blueprint too", () => {
	cleanup();
	writePrefs({ sessionId: SESSION, spawn: null, blueprint: { provider: "openai", id: "o4-mini" } });
	assert.deepEqual(resolveAgentUiModelOverride("/blueprint design it", SESSION), { provider: "openai", id: "o4-mini" });
	assert.equal(resolveAgentUiModelOverride("/spawn x", SESSION), undefined);
	cleanup();
});

const M = (id) => ({ id, provider: "prov", name: id });

test("chooseDispatchModel: explicit -m beats the panel choice", () => {
	const explicit = M("explicit");
	const chosen = M("panel-choice");
	const warnings = [];
	const result = chooseDispatchModel({
		forwardedModel: explicit,
		currentModel: M("current"),
		override: { provider: "prov", id: "panel-choice" },
		lookup: (provider, id) => (id === "panel-choice" ? chosen : undefined),
		warn: (message) => warnings.push(message),
	});
	assert.equal(result, explicit);
	assert.equal(warnings.length, 0);
});

test("chooseDispatchModel: panel choice beats the inherited current model", () => {
	const chosen = M("panel-choice");
	const result = chooseDispatchModel({
		currentModel: M("current"),
		override: { provider: "prov", id: "panel-choice" },
		lookup: () => chosen,
		warn: () => assert.fail("warn must not fire on a resolvable choice"),
	});
	assert.equal(result, chosen);
});

test("chooseDispatchModel: unresolvable panel choice warns and falls back to inheritance", () => {
	const warnings = [];
	const result = chooseDispatchModel({
		currentModel: M("current"),
		override: { provider: "prov", id: "ghost" },
		lookup: () => undefined,
		warn: (message) => warnings.push(message),
	});
	assert.equal(result?.id, "current");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /prov\/ghost/);
	assert.match(warnings[0], /falling back/);
});

test("chooseDispatchModel: plain inheritance and the empty case", () => {
	const current = M("current");
	assert.equal(chooseDispatchModel({ currentModel: current, lookup: () => undefined }), current);
	assert.equal(chooseDispatchModel({ lookup: () => undefined }), undefined);
	assert.equal(
		chooseDispatchModel({ override: { provider: "p", id: "ghost" }, lookup: () => undefined }),
		undefined,
	);
	// warn is optional: a missing warn callback must not throw on fallback.
	assert.equal(
		chooseDispatchModel({ currentModel: current, override: { provider: "p", id: "ghost" }, lookup: () => undefined }),
		current,
	);
});
