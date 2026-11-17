// agentui.ts — /agentui: session-scoped mini web panel to pick models for /spawn and /blueprint.
//
// Opens a tiny localhost page (random port + one-shot random token, mirroring
// src/provider-web.js conventions). Saving writes a single globalThis slot
// that plugin/pi-agent/runner.ts reads at dispatch time, so the choice is
// live for this session only and disappears when the process exits. "auto"
// (the default) means: inherit the current session model, i.e. no override.
import * as http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildModelOptions, parseModelManifest, type ModelEntry } from "./model-switch.ts";
import { ensureZenProviderLocal, refreshZenProviderLive } from "./opencode-zen.ts";
import { agentUiStyle } from "./agentui-style.ts";

// Mirror of AGENTUI_PREFS_GLOBAL_KEY in plugin/pi-agent/agentui-prefs.ts — keep in sync.
const AGENTUI_PREFS_GLOBAL_KEY = "axumAgentUiModelPrefs";
const AUTO = "auto";

type ModelRef = { provider: string; id: string };
type Prefs = { sessionId: string; spawn: ModelRef | null; blueprint: ModelRef | null };
type Panel = {
	server: http.Server;
	port: number;
	token: string;
	sessionId: string;
	entries: ModelEntry[];
	labels: string[];
	currentLabel: string;
	prefs: Prefs;
};

let panel: Panel | undefined;

export function readPrefs(): Prefs | undefined {
	const raw = (globalThis as Record<string, unknown>)[AGENTUI_PREFS_GLOBAL_KEY];
	if (!raw || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	const toRef = (value: unknown): ModelRef | null =>
		value && typeof value === "object" && typeof (value as ModelRef).provider === "string" && typeof (value as ModelRef).id === "string"
			? (value as ModelRef)
			: null;
	if (typeof record.sessionId !== "string") return undefined;
	return { sessionId: record.sessionId, spawn: toRef(record.spawn), blueprint: toRef(record.blueprint) };
}

export function writePrefs(prefs: Prefs): void {
	(globalThis as Record<string, unknown>)[AGENTUI_PREFS_GLOBAL_KEY] = {
		sessionId: prefs.sessionId,
		spawn: prefs.spawn,
		blueprint: prefs.blueprint,
	};
}

function refValue(ref: ModelRef | null): string {
	return ref ? `${ref.provider}/${ref.id}` : AUTO;
}

function commandAvailable(command: string): boolean {
	const result = spawnSync("command", ["-v", command], { shell: true, stdio: "ignore" });
	return result.status === 0;
}

// Local twin of openBrowser() in src/provider-web.js: plugins run from the
// bundled-pi cache, where ../../src is not reachable, so the opener stays self-contained.
function openUrlInBrowser(url: string): boolean {
	if (process.env.AXUM_AGENTUI_NO_OPEN === "1") return false;
	const platform = process.platform;
	const candidates: Array<[string, string[]]> = [];
	if (platform === "android" || process.env.TERMUX_VERSION || (process.env.PREFIX ?? "").includes("/com.termux/")) {
		candidates.push(["termux-open-url", [url]]);
	}
	if (platform === "darwin") candidates.push(["open", [url]]);
	else if (platform === "win32") candidates.push(["cmd", ["/c", "start", "", url]]);
	else candidates.push(["xdg-open", [url]]);
	for (const [command, args] of candidates) {
		if (platform !== "win32" && !commandAvailable(command)) continue;
		try {
			const child = spawn(command, args, { detached: true, stdio: "ignore" });
			child.on("error", () => {});
			child.unref();
			return true;
		} catch {
			// Try the next platform opener.
		}
	}
	return false;
}

function esc(value: string): string {
	// Concatenated so the entity strings survive any editor/tooling entity decoding.
	return value
		.replace(/&/g, "&" + "amp;")
		.replace(/</g, "&" + "lt;")
		.replace(/>/g, "&" + "gt;")
		.replace(/"/g, "&" + "quot;");
}

function optionsHtml(selectId: string, entries: ModelEntry[], labels: string[], selected: string): string {
	const rows = [`<option value="${AUTO}"${selected === AUTO ? " selected" : ""}>auto — inherit current session model</option>`];
	entries.forEach((entry, index) => {
		const value = `${entry.provider}/${entry.model}`;
		rows.push(`<option value="${esc(value)}"${selected === value ? " selected" : ""}>${esc(labels[index] ?? value)}</option>`);
	});
	return `<select id="${selectId}" aria-describedby="${selectId}-hint">${rows.join("")}</select>`;
}

function pageHtml(p: Panel): string {
	// Render the server-closure state even before first singleton assignment.
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><title>模型设置 · Axum</title>
<style>${agentUiStyle}</style></head>
<body><header class="workspace-header"><div class="brand">Axum<span>工作区设置</span></div></header>
<main aria-labelledby="page-title"><h1 id="page-title">模型设置</h1>
<p class="description">为 /spawn 与 /blueprint 选择模型。</p>
<p class="session">仅对当前会话生效，退出后恢复默认。<br><strong>current: ${esc(p.currentLabel)}</strong></p>
<form id="model-settings" aria-busy="true">
<div class="field"><label for="spawn">/spawn 模型</label>${optionsHtml("spawn", p.entries, p.labels, AUTO)}
<p class="hint" id="spawn-hint">用于子任务执行。auto 继承当前会话模型。</p></div>
<div class="field"><label for="blueprint">/blueprint 模型</label>${optionsHtml("blueprint", p.entries, p.labels, AUTO)}
<p class="hint" id="blueprint-hint">用于方案规划。auto 继承当前会话模型。</p></div>
<div class="actions"><button id="save" type="submit" disabled>保存设置</button>
<div id="status" role="status" aria-live="polite" aria-atomic="true">正在读取设置…</div></div>
</form></main>
<script>
const params = new URLSearchParams(location.search);
const token = params.get("token") || "";
const api = (path) => path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
const form = document.getElementById("model-settings");
const save = document.getElementById("save");
const status = document.getElementById("status");
function feedback(message, state) {
  status.dataset.state = state;
  status.setAttribute("role", state === "error" ? "alert" : "status");
  status.setAttribute("aria-live", state === "error" ? "assertive" : "polite");
  status.textContent = message;
}
function setBusy(busy) {
  form.setAttribute("aria-busy", String(busy));
  save.setAttribute("aria-busy", String(busy));
  for (const key of ["spawn", "blueprint", "save"]) document.getElementById(key).disabled = busy;
}
function setSelectValue(key, value) {
  const select = document.getElementById(key);
  for (const opt of select.options) { if (opt.value === value) { select.value = value; return; } }
  select.value = "auto";
}
async function load() {
  setBusy(true);
  try {
    const r = await fetch(api("/api/state"));
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "读取设置失败，请刷新重试。");
    for (const key of ["spawn", "blueprint"]) setSelectValue(key, j[key] || "auto");
    feedback("选择 auto 可跟随当前会话模型。", "idle");
  } catch (e) { feedback("读取失败：" + e.message, "error"); }
  finally { setBusy(false); }
}
form.onsubmit = async (event) => {
  event.preventDefault();
  if (save.disabled) return;
  setBusy(true);
  save.textContent = "正在保存…";
  feedback("正在保存当前会话设置…", "pending");
  try {
    const body = { spawn: document.getElementById("spawn").value, blueprint: document.getElementById("blueprint").value };
    const r = await fetch(api("/api/save"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "保存失败，请重试。");
    feedback("已保存：/spawn " + j.spawn + " · /blueprint " + j.blueprint + "。仅对当前会话生效。", "success");
  } catch (e) { feedback("保存失败：" + e.message, "error"); }
  finally { setBusy(false); save.textContent = "保存设置"; }
};
load();
</script></body></html>`;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk: Buffer) => {
			data += chunk.toString("utf8");
			if (data.length > 8192) reject(new Error("request body too large"));
		});
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}

/** "auto" → null; "provider/model" must exist in the manifest, else undefined. */
export function choiceToRef(choice: unknown, entries: ModelEntry[]): ModelRef | null | undefined {
	if (choice === AUTO) return null;
	if (typeof choice !== "string") return undefined;
	const slash = choice.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = choice.slice(0, slash);
	const id = choice.slice(slash + 1);
	return entries.some((entry) => entry.provider === provider && entry.model === id) ? { provider, id } : undefined;
}

function labelFor(entries: ModelEntry[], labels: string[], ref: ModelRef | null): string {
	if (!ref) return AUTO;
	const index = entries.findIndex((entry) => entry.provider === ref.provider && entry.model === ref.id);
	const value = `${ref.provider}/${ref.id}`;
	return index >= 0 ? `${labels[index] ?? value}` : value;
}

function startPanelServer(sessionId: string, entries: ModelEntry[], currentLabel: string): Promise<Panel> {
	const token = randomBytes(18).toString("base64url");
	const pending: Panel = {
		server: null as unknown as http.Server,
		port: 0,
		token,
		sessionId,
		entries,
		labels: buildModelOptions(entries),
		currentLabel,
		prefs: { sessionId, spawn: null, blueprint: null },
	};
	const server = http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url || "/", "http://127.0.0.1");
			if (url.searchParams.get("token") !== token) return json(res, 403, { error: "invalid token" });
			if (req.method === "GET" && url.pathname === "/") {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
				res.end(pageHtml(pending));
				return;
			}
			if (req.method === "GET" && url.pathname === "/api/state") {
				const saved = readPrefs();
				const mine = saved && saved.sessionId === pending.sessionId ? saved : pending.prefs;
				return json(res, 200, {
					current: currentLabel,
					spawn: refValue(mine.spawn),
					blueprint: refValue(mine.blueprint),
				});
			}
			if (req.method === "POST" && url.pathname === "/api/save") {
				const parsed = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
				const spawn = choiceToRef(parsed.spawn, pending.entries);
				const blueprint = choiceToRef(parsed.blueprint, pending.entries);
				if (spawn === undefined || blueprint === undefined) {
					return json(res, 400, { error: "invalid model choice (expected \"auto\" or a listed provider/model)" });
				}
				pending.prefs = { sessionId: pending.sessionId, spawn, blueprint };
				writePrefs(pending.prefs);
				return json(res, 200, {
					ok: true,
					spawn: labelFor(pending.entries, pending.labels, spawn),
					blueprint: labelFor(pending.entries, pending.labels, blueprint),
				});
			}
			json(res, 404, { error: "not found" });
		} catch (error) {
			json(res, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	});
	pending.server = server;
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			pending.port = typeof address === "object" && address ? address.port : 0;
			resolve(pending);
		});
	});
}

async function readJsonFile(file: string): Promise<Record<string, unknown>> {
	try {
		const text = await readFile(file, "utf8");
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Same model manifest source as /usemodel: on-disk opencode Zen catalog + ~/.pi/agent/models.json. */
async function loadModelEntries(agentDir: string): Promise<ModelEntry[]> {
	try {
		// Network-free local merge so the panel never waits on a sync; a stale
		// catalog triggers a silent background refresh for the next open.
		const local = await ensureZenProviderLocal(agentDir);
		if (local.needsLiveRefresh) void refreshZenProviderLive(agentDir).catch(() => {});
	} catch {
		// Fall through to the on-disk manifest below.
	}
	return parseModelManifest(await readJsonFile(join(agentDir, "models.json")));
}

/** Close the panel server and drop the singleton (process exit does this implicitly). */
export function closeAgentUiPanel(): void {
	if (!panel) return;
	try {
		panel.server.close();
	} catch {
		// Already closing.
	}
	panel = undefined;
}

export function registerAgentUi(pi: ExtensionAPI): void {
	pi.registerCommand("agentui", {
		description:
			"Open a small web panel to pick the models used by /spawn and /blueprint for this session only (auto = inherit the current session model)",
		getArgumentCompletions: () => null,
		async handler(_args: string, ctx) {
			const agentDir = join(homedir(), ".pi", "agent");
			const entries = await loadModelEntries(agentDir);
			if (!entries.length) {
				ctx.ui.notify(`No models configured (${join(agentDir, "models.json")}). Use /provider to add a model first.`, "warning");
				return;
			}
			const sessionId = ctx.sessionManager.getSessionId();
			const current = ctx.model ? (ctx.model.name && ctx.model.name !== ctx.model.id ? ctx.model.name : ctx.model.id) : "none";
			if (panel) {
				// Singleton reuse: rebind to the (possibly switched) session and refresh
				// the list. prefs must reset too — the old session's snapshot must never
				// leak into the freshly bound session's /api/state fallback.
				panel.sessionId = sessionId;
				panel.entries = entries;
				panel.labels = buildModelOptions(entries);
				panel.currentLabel = current;
				panel.prefs = { sessionId, spawn: null, blueprint: null };
			} else {
				try {
					panel = await startPanelServer(sessionId, entries, current);
				} catch (error) {
					ctx.ui.notify(`/agentui failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
					return;
				}
			}
			const url = `http://127.0.0.1:${panel.port}/?token=${panel.token}`;
			const opened = openUrlInBrowser(url);
			ctx.ui.notify(opened ? `/agentui panel opened in your browser (${url})` : `/agentui panel: ${url}`, "info");
		},
	});
}
