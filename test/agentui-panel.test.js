// agentui-panel.test.js — end-to-end behavior of the /agentui web panel
// (command registration, HTTP server, save round-trip, session rebinding, XSS escaping).
process.env.PI_COMPANION_ZEN_SYNC_DISABLE = "1";
process.env.AXUM_AGENTUI_NO_OPEN = "1";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { closeAgentUiPanel, registerAgentUi } from "../plugin/pi-companion/agentui.ts";
import { AGENTUI_PREFS_GLOBAL_KEY } from "../plugin/pi-agent/agentui-prefs.ts";

const XSS_MODEL_ID = `x<ss>"model`;
const MANIFEST = {
	providers: {
		testprov: { models: [{ id: XSS_MODEL_ID }, { id: "plain-model", default: true }] },
	},
};

const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentui-panel-"));
fs.mkdirSync(path.join(fixtureHome, ".pi", "agent"), { recursive: true });
fs.writeFileSync(path.join(fixtureHome, ".pi", "agent", "models.json"), JSON.stringify(MANIFEST));
process.env.HOME = fixtureHome;

function makePi() {
	const commands = new Map();
	return { commands, registerCommand(name, def) { commands.set(name, def); } };
}

function makeCtx(sessionId, notifications) {
	return {
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		hasUI: true,
		model: { id: "plain-model", name: "plain-model", provider: "testprov" },
		sessionManager: { getSessionId: () => sessionId },
		ui: { notify: (message, level) => notifications.push({ message, level }) },
	};
}

async function openPanel(pi, sessionId) {
	const notifications = [];
	await pi.commands.get("agentui").handler("", makeCtx(sessionId, notifications));
	const url = notifications[0].message.match(/http:\/\/[^\s)]+/)?.[0];
	assert.ok(url, `panel URL missing from notify: ${JSON.stringify(notifications)}`);
	return { notifications, url, token: new URL(url).searchParams.get("token") };
}

const api = (base, pathName, token) => `${base}${pathName}${pathName.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;

test.after(() => {
	closeAgentUiPanel();
	process.env.HOME = os.homedir();
	fs.rmSync(fixtureHome, { recursive: true, force: true });
});

test("agentui command registers and serves a token-guarded page", async (t) => {
	const pi = makePi();
	registerAgentUi(pi);
	assert.ok(pi.commands.has("agentui"), "agentui command must register");

	const { url, token } = await openPanel(pi, "panel-session-1");
	const base = new URL(url).origin;

	// Missing and wrong tokens are rejected.
	assert.equal((await fetch(base + "/")).status, 403);
	assert.equal((await fetch(api(base, "/", "wrong-token"))).status, 403);

	// The real token serves the page with both selectors and escaped model ids.
	const page = await fetch(api(base, "/", token)).then((r) => {
		assert.equal(r.status, 200);
		assert.match(r.headers.get("content-type"), /text\/html/);
		return r.text();
	});
	assert.match(page, /id="spawn"/);
	assert.match(page, /id="blueprint"/);
	assert.ok(page.includes("inherit current session model"), "auto option missing");
	assert.ok(!page.includes(XSS_MODEL_ID), "raw XSS model id must never reach the page");
	const amp = String.fromCharCode(38);
	assert.ok(page.includes("x" + amp + "lt;ss" + amp + "gt;" + amp + "quot;model"), "XSS model id must arrive escaped");
	assert.ok(page.includes("current: plain-model"), "current-model hint missing");
	assert.ok(!page.includes("CSS.escape"), "attribute-selector matching must iterate options instead");
	assert.match(page, /<html lang="zh-CN">/);
	assert.match(page, /class="brand">Axum/);
	assert.match(page, /<h1 id="page-title">模型设置<\/h1>/);
	assert.match(page, /aria-describedby="spawn-hint"/);
	assert.match(page, /aria-describedby="blueprint-hint"/);
	assert.match(page, /role="status" aria-live="polite" aria-atomic="true"/);
	assert.match(page, /prefers-color-scheme: dark/);
	assert.match(page, /--background: oklch\(1 0 0\)/);
	assert.match(page, /--background: oklch\(\.192 0 0\)/);
	assert.match(page, /viewport-fit=cover/);
	assert.match(page, /safe-area-inset-bottom/);
	assert.match(page, /min-height: 44px/);
	assert.match(page, /overflow-wrap: anywhere/);
	assert.match(page, /text-overflow: ellipsis/);
	assert.match(page, /\(hover: hover\) and \(pointer: fine\)/);
	assert.match(page, /prefers-reduced-motion: reduce/);

	// API surface.
	assert.equal((await fetch(api(base, "/api/nope", token))).status, 404);
	assert.equal((await fetch(base + "/api/state")).status, 403);

	const state0 = await fetch(api(base, "/api/state", token)).then((r) => r.json());
	assert.deepEqual(state0, { current: "plain-model", spawn: "auto", blueprint: "auto" });
});

test("agentui save round-trip writes the session-bound global slot", async (t) => {
	const pi = makePi();
	registerAgentUi(pi);
	const { url, token } = await openPanel(pi, "panel-session-2");
	const base = new URL(url).origin;
	const save = api(base, "/api/save", token);

	// Valid choices: both a plain id and the XSS-shaped id round-trip.
	const ok = await fetch(save, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ spawn: "testprov/plain-model", blueprint: `testprov/${XSS_MODEL_ID}` }),
	}).then((r) => r.json());
	assert.equal(ok.ok, true);
	assert.match(ok.spawn, /plain-model/);
	assert.match(ok.blueprint, /x/);

	const slot = (globalThis)[AGENTUI_PREFS_GLOBAL_KEY];
	assert.deepEqual(slot, {
		sessionId: "panel-session-2",
		spawn: { provider: "testprov", id: "plain-model" },
		blueprint: { provider: "testprov", id: XSS_MODEL_ID },
	});

	// State reflects the saved choices for the same session.
	const state = await fetch(api(base, "/api/state", token)).then((r) => r.json());
	assert.equal(state.spawn, "testprov/plain-model");
	assert.equal(state.blueprint, `testprov/${XSS_MODEL_ID}`);

	// Unknown / malformed choices are rejected with 400 and do not touch the slot.
	const bad = [
		{ spawn: "testprov/missing" },
		{ spawn: 42 },
		{ spawn: "auto" }, // blueprint missing entirely → invalid
		{ spawn: "/leading-slash" },
	];
	for (const body of bad) {
		const res = await fetch(save, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
	}
	assert.equal((globalThis)[AGENTUI_PREFS_GLOBAL_KEY].spawn.id, "plain-model", "rejected saves must not mutate the slot");

	// Broken JSON and oversized bodies fail closed without crashing the server.
	const broken = await fetch(save, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{not json",
	});
	assert.equal(broken.status, 500);
	const huge = await fetch(save, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "x".repeat(9000),
	});
	assert.equal(huge.status, 500);

	// The server still answers after the malformed requests.
	const state2 = await fetch(api(base, "/api/state", token)).then((r) => r.json());
	assert.equal(state2.spawn, "testprov/plain-model");
});

test("agentui singleton reuse rebinds to a new session and isolates old saves", async (t) => {
	const pi = makePi();
	registerAgentUi(pi);
	const first = await openPanel(pi, "panel-session-3a");
	const second = await openPanel(pi, "panel-session-3b");
	// Same server and token: second invocation reuses the singleton.
	assert.equal(new URL(second.url).origin, new URL(first.url).origin);
	assert.equal(second.token, first.token);

	const base = new URL(second.url).origin;
	const save = api(base, "/api/save", second.token);

	// Old-session saves are not visible to the freshly bound session.
	const state = await fetch(api(base, "/api/state", second.token)).then((r) => r.json());
	assert.equal(state.spawn, "auto");

	// Saving from the new session rewrites the binding, not the old one.
	await fetch(save, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ spawn: "testprov/plain-model", blueprint: "auto" }),
	});
	const slot = (globalThis)[AGENTUI_PREFS_GLOBAL_KEY];
	assert.equal(slot.sessionId, "panel-session-3b");
	assert.deepEqual(slot.spawn, { provider: "testprov", id: "plain-model" });
	assert.equal(slot.blueprint, null);

	// The stale-choice fallback path is exercised end to end: an override whose
	// model left the manifest still saves fine (validation passes at save time)
	// and the runner-side chooser degrades to inheritance — covered by
	// chooseDispatchModel unit tests in agentui.test.js.
});

test("agentui handler warns when no models are configured", async (t) => {
	const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentui-empty-"));
	fs.mkdirSync(path.join(emptyHome, ".pi", "agent"), { recursive: true });
	const previousHome = process.env.HOME;
	process.env.HOME = emptyHome;
	try {
		const pi = makePi();
		registerAgentUi(pi);
		const notifications = [];
		await pi.commands.get("agentui").handler("", makeCtx("panel-session-4", notifications));
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].level, "warning");
		assert.match(notifications[0].message, /No models configured/);
	} finally {
		process.env.HOME = previousHome;
		fs.rmSync(emptyHome, { recursive: true, force: true });
	}
});

test("agentui browser script handles busy state, safe feedback, failures and retry", async () => {
	const pi = makePi();
	registerAgentUi(pi);
	const { url } = await openPanel(pi, "panel-browser");
	const page = await fetch(url).then((r) => r.text());
	const elements = Object.fromEntries(["model-settings", "spawn", "blueprint", "save", "status"].map((id) => [id, {
		value: "auto", disabled: false, textContent: "", dataset: {}, attributes: {},
		options: [{ value: "auto" }, { value: "testprov/plain-model" }],
		setAttribute(name, value) { this.attributes[name] = value; },
	}]));
	const requests = [];
	const context = vm.createContext({
		URLSearchParams, location: { search: new URL(url).search },
		document: { getElementById: (id) => elements[id] },
		fetch: (request, options) => new Promise((resolve, reject) => requests.push({ request, options, resolve, reject })),
	});
	vm.runInContext(page.match(/<script>([\s\S]*?)<\/script>/)[1], context);
	assert.equal(elements.save.disabled, true);
	assert.equal(elements["model-settings"].attributes["aria-busy"], "true");
	assert.equal(new URL(requests[0].request, url).searchParams.get("token"), new URL(url).searchParams.get("token"));
	requests.shift().resolve({ ok: true, json: async () => ({ spawn: "testprov/plain-model", blueprint: "missing" }) });
	await new Promise(setImmediate);
	assert.equal(elements.spawn.value, "testprov/plain-model");
	assert.equal(elements.blueprint.value, "auto", "stale model must fall back to auto");
	assert.equal(elements.save.disabled, false);
	const submit = () => elements["model-settings"].onsubmit({ preventDefault() {} });
	const saving = submit();
	assert.equal(elements.save.disabled, true);
	assert.equal(elements.spawn.disabled, true);
	assert.equal(elements.blueprint.disabled, true);
	assert.equal(elements.save.attributes["aria-busy"], "true");
	await submit();
	assert.equal(requests.length, 1, "duplicate submissions must not issue another request");
	const request = requests.shift();
	assert.deepEqual(JSON.parse(request.options.body), { spawn: "testprov/plain-model", blueprint: "auto" });
	request.resolve({ ok: true, json: async () => ({ spawn: XSS_MODEL_ID, blueprint: "auto" }) });
	await saving;
	assert.equal(elements.status.dataset.state, "success");
	assert.ok(elements.status.textContent.includes(XSS_MODEL_ID), "model feedback must use literal text");
	assert.equal(elements.status.attributes.role, "status");
	assert.equal(elements.status.attributes["aria-live"], "polite");
	assert.equal(elements.save.disabled, false);
	assert.equal(elements.save.attributes["aria-busy"], "false");
	for (const failure of ["http", "network"]) {
		const failed = submit();
		const pending = requests.shift();
		if (failure === "http") pending.resolve({ ok: false, json: async () => ({ error: "invalid model choice" }) });
		else pending.reject(new Error("offline"));
		await failed;
		assert.equal(elements.status.dataset.state, "error");
		assert.equal(elements.status.attributes.role, "alert");
		assert.equal(elements.status.attributes["aria-live"], "assertive");
		assert.equal(elements.save.disabled, false, "failure must allow retry");
		assert.equal(elements["model-settings"].attributes["aria-busy"], "false");
	}
	const loading = vm.runInContext("load()", context);
	requests.shift().reject(new Error("offline"));
	await loading;
	assert.match(elements.status.textContent, /读取失败/);
	assert.equal(elements.status.attributes.role, "alert");
	assert.equal(elements.save.disabled, false);
});
