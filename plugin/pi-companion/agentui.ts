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
import { ensureZenProvider } from "./opencode-zen.ts";

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
	return `<select id="${selectId}">${rows.join("")}</select>`;
}

function pageHtml(): string {
	const autoHint = panel ? ` (current: ${esc(panel.currentLabel)})` : "";
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>/agentui — spawn & blueprint models</title>
<style>body{font-family:system-ui,sans-serif;background:#14161a;color:#e6e6e6;max-width:560px;margin:40px auto;padding:0 16px}
h1{font-size:18px}label{display:block;margin:18px 0 6px;font-size:14px;color:#aab}
select,button{width:100%;padding:9px;font-size:14px;background:#1e2128;color:#e6e6e6;border:1px solid #3a3f4a;border-radius:6px}
button{margin-top:22px;cursor:pointer;background:#2f6fed;border-color:#2f6fed}
#status{margin-top:12px;font-size:13px;min-height:18px;color:#8f8}</style></head>
<body><h1>/agentui — models for /spawn and /blueprint${autoHint}</h1>
<p style="font-size:13px;color:#889">Session-scoped: applies to this pi session only. auto = inherit the current session model.</p>
<label for="spawn">/spawn model</label>${optionsHtml("spawn", panel?.entries ?? [], panel?.labels ?? [], AUTO)}
<label for="blueprint">/blueprint model</label>${optionsHtml("blueprint", panel?.entries ?? [], panel?.labels ?? [], AUTO)}
<button id="save">Save</button><div id="status"></div>
<script>
const params = new URLSearchParams(location.search);
const token = params.get("token") || "";
const api = (path) => path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
async function load() {
  try {
    const r = await fetch(api("/api/state"));
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "failed to load state");
    for (const key of ["spawn", "blueprint"]) {
      const select = document.getElementById(key);
      select.value = j[key] && select.querySelector('option[value="' + CSS.escape(j[key]) + '"]') ? j[key] : "auto";
    }
    document.getElementById("status").textContent = "";
  } catch (e) { document.getElementById("status").textContent = e.message; }
}
document.getElementById("save").onclick = async () => {
  try {
    const body = { spawn: document.getElementById("spawn").value, blueprint: document.getElementById("blueprint").value };
    const r = await fetch(api("/api/save"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "failed to save");
    document.getElementById("status").textContent = "Saved: /spawn " + j.spawn + " · /blueprint " + j.blueprint;
  } catch (e) { document.getElementById("status").textContent = e.message; }
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
				res.end(pageHtml());
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

/** Same model manifest source as /usemodel: live opencode Zen sync + ~/.pi/agent/models.json. */
async function loadModelEntries(agentDir: string): Promise<ModelEntry[]> {
	try {
		await ensureZenProvider(agentDir); // best-effort, identical to /usemodel; failures must not block the panel
	} catch {
		// Fall through to the on-disk manifest below.
	}
	return parseModelManifest(await readJsonFile(join(agentDir, "models.json")));
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
				// Singleton reuse: rebind to the (possibly switched) session and refresh the list.
				panel.sessionId = sessionId;
				panel.entries = entries;
				panel.labels = buildModelOptions(entries);
				panel.currentLabel = current;
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
