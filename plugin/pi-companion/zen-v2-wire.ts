// zen-v2-wire.ts — OpenCode v2 client fingerprint for the Zen free lane.
//
// The v2 gate (2026-10-16, documented live-probe by Ebony-Vinyl/dsh-our-free-model
// docs/free-lane-wire.md, shape source 9router v0.5.104) compares the request's
// declared tools against the official OpenCode v2.0.26 CLI: `read` and `shell`
// must be declared with byte-identical descriptions and parameter schemas, and
// `tool_choice: "none"` must never be sent. A caller tool that uses the name
// `read`/`shell` with a different definition is renamed to `<name>_client[N]`
// (history + tool_choice follow), and the response side restores the caller's
// spelling so pi executes its own tool.
//
// Definitions below are verbatim from the v2.0.26 CLI — rewording, schema
// trimming, or `properties: {}` each earn a 403 FreeTierError.
//
// Zero pi imports beyond the public stream entry so the fingerprint logic can
// be unit-tested without a live session.

import { AssistantMessageEventStream, streamSimple as piStreamSimple } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { buildDisguiseHeaders, stableSessionID, ZEN_CLIENT_UA } from "./opencode-zen.ts";

export const ZEN_V2_API = "openai-completions";

/**
 * Turn the upstream Zen free-quota rejection into an actionable message. The
 * gateway answers 429 with `FreeUsageLimitError`; the quota window is owned by
 * the server, so the only ways forward are waiting it out or switching to the
 * Kilo free pool. Anything else is returned untouched.
 */
export function describeZenQuotaError(errorMessage: string): string {
	if (!/FreeUsageLimitError|free usage limit/i.test(errorMessage)) return errorMessage;
	return (
		`${errorMessage}\n\n` +
		"[OpenCode Zen 免费配额已耗尽] 上游返回 FreeUsageLimitError：免费模型的配额窗口已用尽，" +
		"需要等待服务端配额窗口恢复后才能继续调用（实测约 10 小时，实际以服务端为准）。" +
		"如果需要马上继续，请在 /usemodel 里改用 Kilo 免费通道。"
	);
}
/** Fallback conversation signal when the stream options carry no session id. */
const DEFAULT_SESSION_SIGNAL = "pi-companion:zen-v2:static-session";

const FINGERPRINT_TOOL_DEFINITIONS = {
	read: {
		description:
			"Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File or directory to read" },
				offset: { type: "integer", minimum: 0, description: "The line or directory entry to start reading from (1-based)" },
				limit: { type: "integer", minimum: 0, description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)" },
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
	shell: {
		description:
			"Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command string to execute" },
				workdir: { type: "string", description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead." },
				timeout: { type: "integer", minimum: 0, description: "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default." },
				background: { type: "boolean", description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." },
			},
			required: ["command"],
			additionalProperties: false,
		},
	},
} as const;

const FINGERPRINT_TOOLS = ["read", "shell"] as const;

type ToolRecord = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function functionOf(tool: ToolRecord): Record<string, unknown> | null {
	const fn = tool.function;
	return isRecord(fn) ? fn : null;
}

function toolNameOf(tool: unknown): string {
	if (!isRecord(tool)) return "";
	if (typeof tool.name === "string" && tool.name.trim()) return tool.name.trim();
	const fn = functionOf(tool);
	return typeof fn?.name === "string" ? fn.name.trim() : "";
}

function fingerprintKey(name: string): string {
	return (FINGERPRINT_TOOLS as readonly string[]).includes(name) ? name : "";
}

function definitionOf(tool: ToolRecord): { description: unknown; schema: unknown } | null {
	const fn = functionOf(tool);
	return fn ? { description: fn.description, schema: fn.parameters } : { description: tool.description, schema: tool.parameters };
}

function carriesFingerprintDefinition(tool: ToolRecord, name: string): boolean {
	const own = definitionOf(tool);
	if (!own) return false;
	const want = FINGERPRINT_TOOL_DEFINITIONS[name as keyof typeof FINGERPRINT_TOOL_DEFINITIONS];
	return own.description === want.description && JSON.stringify(own.schema) === JSON.stringify(want.parameters);
}

function withToolName(tool: ToolRecord, name: string): ToolRecord {
	const fn = functionOf(tool);
	return fn ? { ...tool, function: { ...fn, name } } : { ...tool, name };
}

function fingerprintTool(name: keyof typeof FINGERPRINT_TOOL_DEFINITIONS): ToolRecord {
	const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[name];
	return { type: "function", function: { name, description, parameters } };
}

/**
 * The note appended when a fingerprint tool had to be injected. The v2
 * definitions are real tools the model will actually call, so the wording
 * (measured upstream) steers it away from the placeholders without making it
 * refuse the caller's own tools.
 */
function placeholderNote(names: string[]): string {
	const list = names.map((name) => `\`${name}\``).join(" or ");
	return names.length > 1
		? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
		: `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
}

/** Rename prior-turn tool calls of a renamed tool so the model reads one consistent toolset. */
function aliasHistoryToolCalls(body: Record<string, unknown>, sentToCaller: Map<string, string>): void {
	if (sentToCaller.size === 0) return;
	const callerToSent = new Map([...sentToCaller].map(([sent, caller]) => [caller, sent]));
	const rename = (name: unknown): unknown =>
		typeof name === "string" && callerToSent.has(name) ? callerToSent.get(name) : name;
	const messages = Array.isArray(body.messages) ? body.messages : [];
	body.messages = messages.map((message) => {
		if (!isRecord(message)) return message;
		if (Array.isArray(message.tool_calls)) {
			return {
				...message,
				tool_calls: message.tool_calls.map((call: unknown) => {
					if (!isRecord(call) || !isRecord(call.function)) return call;
					const name = rename(call.function.name);
					return name === call.function.name ? call : { ...call, function: { ...call.function, name } };
				}),
			};
		}
		return message;
	});
}

function retargetToolChoice(body: Record<string, unknown>, sentToCaller: Map<string, string>): void {
	if (sentToCaller.size === 0) return;
	const choice = body.tool_choice;
	if (!isRecord(choice)) return;
	const callerToSent = new Map([...sentToCaller].map(([sent, caller]) => [caller, sent]));
	const fn = isRecord(choice.function) ? choice.function : undefined;
	if (fn && typeof fn.name === "string" && callerToSent.has(fn.name.trim())) {
		body.tool_choice = { ...choice, function: { ...fn, name: callerToSent.get(fn.name.trim()) } };
	} else if (typeof choice.name === "string" && callerToSent.has(choice.name.trim())) {
		body.tool_choice = { ...choice, name: callerToSent.get(choice.name.trim()) };
	}
}

/**
 * Satisfy the v2 fingerprint gate on a chat-completions payload (mutated in
 * place). Returns sent-name -> caller-name for the response-side restore.
 *
 * 1. `read` + `shell` declared with the official definitions verbatim;
 * 2. caller tools preserved as-is (case variants included);
 * 3. caller `read`/`shell` with different definitions renamed to
 *    `<name>_client[N]`, with history + tool_choice retargeted;
 * 4. duplicate names keep the first declaration (upstream rejects dupes);
 * 5. `tool_choice: "none"` is deleted — the v2 gate 403s it on sight.
 */
export function applyFingerprintToChatPayload(body: Record<string, unknown>): Map<string, string> {
	const sentToCaller = new Map<string, string>();
	const tools = Array.isArray(body.tools) ? body.tools : [];
	const taken = new Set(tools.map(toolNameOf).filter((name) => name !== ""));
	const seen = new Set<string>();
	const present = new Set<string>();
	const out: unknown[] = [];

	for (const tool of tools) {
		const name = toolNameOf(tool);
		const key = fingerprintKey(name);
		if (key === "" || !isRecord(tool)) {
			out.push(tool);
			continue;
		}
		if (seen.has(key)) continue; // duplicate declaration: upstream rejects, keep first
		seen.add(key);
		if (carriesFingerprintDefinition(tool, key)) {
			out.push(tool);
			present.add(key);
			continue;
		}
		let alias = `${key}_client`;
		for (let i = 2; taken.has(alias); i += 1) alias = `${key}_client${i}`;
		taken.add(alias);
		sentToCaller.set(alias, name);
		out.push(withToolName(tool, alias));
	}

	const injected: string[] = [];
	for (const name of FINGERPRINT_TOOLS) {
		if (present.has(name)) continue;
		out.push(fingerprintTool(name));
		injected.push(name);
	}

	body.tools = out;
	retargetToolChoice(body, sentToCaller);
	aliasHistoryToolCalls(body, sentToCaller);
	if (injected.length > 0) {
		const note = placeholderNote(injected);
		const messages = Array.isArray(body.messages) ? body.messages : [];
		const first = messages[0];
		if (isRecord(first) && first.role === "system" && typeof first.content === "string") {
			body.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...messages.slice(1)];
		} else {
			body.messages = [{ role: "system", content: note }, ...messages];
		}
	}
	if (body.tool_choice === "none" || (isRecord(body.tool_choice) && body.tool_choice.type === "none")) {
		delete body.tool_choice;
	}
	return sentToCaller;
}

/** Restore the caller's tool spelling in a streaming tool-call event. */
export function restoreToolName(name: string, sentToCaller: Map<string, string>): string {
	return sentToCaller.get(name) ?? name;
}

function rewriteToolCallEvents(event: AssistantMessageEvent, sentToCaller: Map<string, string>): AssistantMessageEvent {
	if (sentToCaller.size === 0 || event.type !== "toolcall_end") return event;
	const toolCall = event.toolCall as { name: string };
	const callerName = restoreToolName(toolCall.name, sentToCaller);
	if (callerName === toolCall.name) return event;
	// The partial block is shared by every event of this turn: fixing it in
	// place also fixes the blocks already delivered inside earlier events.
	const content = (event.partial as { content?: Array<{ type?: string; name?: string }> } | undefined)?.content;
	const block = content?.[event.contentIndex];
	if (block && block.type === "toolCall" && block.name === toolCall.name) block.name = callerName;
	return { ...event, toolCall: { ...toolCall, name: callerName } } as AssistantMessageEvent;
}

export interface ZenStreamSimpleOptions {
	/** Test seam: overrides the conversation signal used for the session id. */
	sessionSignal?: string;
}

/**
 * Build the streamSimple handler registered for the "opencode" provider. It
 * delegates to pi-ai's openai-completions stream with the v2 disguise headers
 * (per-conversation session id) and the fingerprinted payload, then restores
 * aliased tool names on the way back so pi executes its own tools.
 */
export function createZenStreamSimple(options: ZenStreamSimpleOptions = {}): (
	model: Model<"openai-completions">,
	context: Context,
	streamOptions?: SimpleStreamOptions,
) => AsyncIterable<AssistantMessageEvent> & { result?: () => Promise<AssistantMessage> } {
	return (model, context, streamOptions) => {
		const signal = options.sessionSignal
			?? (typeof streamOptions?.sessionId === "string" && streamOptions.sessionId ? streamOptions.sessionId : DEFAULT_SESSION_SIGNAL);
		const session = stableSessionID(signal);
		const headers: Record<string, string> = { ...(streamOptions?.headers as Record<string, string> | undefined), ...buildDisguiseHeaders({ session }) };
		// v1-era keys must never reach the wire, even if a stale block still carries them.
		delete headers["x-opencode-request"];
		delete headers["X-Session-Id"];
		const callerOnPayload = streamOptions?.onPayload;
		let sentToCaller = new Map<string, string>();
		const upstreamFetch = streamOptions?.fetch ?? fetch;
		// Authoritative wire scrub: models.json legacy v1 headers reach the request
		// through model.headers (bypassing options.headers), and the v2 gate 403s
		// `x-opencode-request` on sight. The fetch layer is the last word.
		const wireFetch: typeof fetch = (url, init) => {
			const h = new Headers(init?.headers);
			h.delete("x-opencode-request");
			h.delete("X-Session-Id");
			for (const key of ["x-opencode-session", "x-opencode-session-id", "x-session-affinity", "x-session-id"]) h.set(key, session);
			h.set("user-agent", ZEN_CLIENT_UA);
			h.set("x-opencode-client", "cli");
			h.set("x-opencode-project", "global");
			return upstreamFetch(url, { ...init, headers: h });
		};
		const incoming = piStreamSimple(model, context, {
			...streamOptions,
			headers,
			fetch: wireFetch,
			onPayload: async (payload: unknown, payloadModel: unknown) => {
				let next = payload;
				if (callerOnPayload) next = (await callerOnPayload(payload, payloadModel as never)) ?? payload;
				if (isRecord(next)) sentToCaller = applyFingerprintToChatPayload(next);
				return next;
			},
		});

		const output = new AssistantMessageEventStream();
		void (async () => {
			for await (const event of incoming) {
				if (event.type === "error" && event.error.errorMessage) {
					event.error.errorMessage = describeZenQuotaError(event.error.errorMessage);
				}
				output.push(rewriteToolCallEvents(event, sentToCaller));
			}
			output.end(typeof incoming.result === "function" ? await incoming.result() : undefined);
		})().catch((error) => {
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "error",
				errorMessage: describeZenQuotaError(error instanceof Error ? error.message : String(error)),
				timestamp: Date.now(),
			};
			output.push({ type: "error", reason: "error", error: message } as AssistantMessageEvent);
			output.end(message);
		});
		return output;
	};
}
