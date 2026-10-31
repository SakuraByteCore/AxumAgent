import { spawn, type ChildProcess } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "./shared.ts";

const REQUEST_TIMEOUT = 5000;
const INITIAL_PAUSE_WAIT = 750;
const OUTPUT_LIMIT = 32768;
const TERMINATE_GRACE = 500;
const EXIT_SETTLE_WAIT = 100;
const ACTIONS = ["launch", "status", "set_breakpoint", "remove_breakpoint", "continue", "step_over", "step_into", "step_out", "pause", "stack", "scopes", "evaluate", "stop"] as const;
const PARAMETERS = Type.Object({
	action: Type.Union(ACTIONS.map((action) => Type.Literal(action))),
	sessionId: Type.Optional(Type.String({ description: "launch 可指定新会话 ID；其他操作必填，不会自动启动脚本。" })),
	path: Type.Optional(Type.String({ description: "工作区内 Node 脚本；launch、set_breakpoint 必填。" })),
	args: Type.Optional(Type.Array(Type.String(), { description: "传给脚本的参数，不是 Node 运行时参数。" })),
	line: Type.Optional(Type.Integer({ minimum: 1, description: "断点行号，从 1 开始。" })),
	column: Type.Optional(Type.Integer({ minimum: 1, description: "断点列号，从 1 开始，默认 1。" })),
	breakpointId: Type.Optional(Type.String()),
	callFrameId: Type.Optional(Type.String({ description: "当前暂停栈帧 ID；scopes 默认顶帧，evaluate 不传时在全局执行。" })),
	expression: Type.Optional(Type.String({ description: "真正执行的 JavaScript 表达式，可产生副作用。" })),
});

async function workspaceFile(root: string, path: string | undefined): Promise<string> {
	if (!path) throw new Error("必须提供 path");
	const file = await realpath(resolve(root, path));
	const part = relative(root, file);
	if (isAbsolute(part) || part === ".." || part.startsWith(`..${sep}`) || !(await stat(file)).isFile()) throw new Error("目标必须是工作区内的真实文件");
	return file;
}

class InspectorSession {
	id: string;
	root: string;
	path: string;
	child: ChildProcess;
	ws?: WebSocket;
	socketEnded?: Promise<void>;
	connectionClosedTimer?: ReturnType<typeof setTimeout>;
	state = "initializing";
 entering = true;
	error?: string;
	stdout = "";
	stderr = "";
	outputTruncated = { stdout: false, stderr: false };
	exitCode: number | null = null;
	exitSignal: string | null = null;
	frames: any[] = [];
	reason?: string;
	scripts = new Map<string, string>();
	pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	sequence = 0;
	endpoint: Promise<string>;
	resolveEndpoint!: (url: string) => void;
	rejectEndpoint!: (error: Error) => void;
	ended: Promise<void>;
	resolveEnded!: () => void;
	done = false;
	detaching = false;
	stopping?: Promise<void>;
	pauseListeners = new Set<() => void>();

	constructor(options: { id: string; root: string; path: string; args: string[] }) {
		this.id = options.id;
		this.root = options.root;
		this.path = options.path;
		this.endpoint = new Promise((resolve, reject) => { this.resolveEndpoint = resolve; this.rejectEndpoint = reject; });
		this.ended = new Promise((resolve) => { this.resolveEnded = resolve; });
		this.child = spawn(process.execPath, ["--inspect-brk=127.0.0.1:0", this.path, ...options.args], {
			cwd: this.root, shell: false, stdio: ["ignore", "pipe", "pipe"],
		});
		for (const stream of ["stdout", "stderr"] as const) {
			this.child[stream]!.setEncoding("utf8");
			this.child[stream]!.on("data", (chunk: string) => {
				const output = this[stream] + chunk;
				this.outputTruncated[stream] ||= output.length > OUTPUT_LIMIT;
				this[stream] = output.slice(-OUTPUT_LIMIT);
				if (stream !== "stderr") return;
				const address = this.stderr.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)\r?\n/);
				if (address) this.resolveEndpoint(address[1]);
				// Node 等待 Inspector 断开才退出；主动释放连接使退出码可观测。
				if (this.stderr.includes("Waiting for the debugger to disconnect...")) {
					this.detaching = true;
					this.disconnect(new Error("脚本执行结束，Inspector 已断开"));
				}
			});
		}
		this.child.on("error", (error) => { this.error = error.message; this.state = "error"; this.disconnect(error); });
		this.child.on("exit", () => {
			this.detaching = true;
			clearTimeout(this.connectionClosedTimer);
			this.disconnect(new Error("Node 进程已退出"));
		});
		this.child.on("close", (code, signal) => {
			this.done = true;
			this.exitCode = code;
			this.exitSignal = signal;
			clearTimeout(this.connectionClosedTimer);
			if (code !== null && code !== 0 && !this.stopping) this.error ??= `Node 进程退出码：${code}`;
			this.state = this.error ? "error" : this.stopping ? "stopped" : "exited";
			this.frames = [];
			this.reason = undefined;
			this.disconnect(new Error("Node 进程已退出"));
			this.resolveEnded();
		});
	}

	disconnect(error: Error): void {
		this.rejectEndpoint(error);
		for (const request of this.pending.values()) request.reject(error);
		this.pending.clear();
		for (const notify of this.pauseListeners) notify();
		if (this.ws && this.ws.readyState < WebSocket.CLOSING) this.ws.close();
	}

	async start(signal?: AbortSignal): Promise<void> {
		const abort = () => { void this.stop(); };
		signal?.addEventListener("abort", abort, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (signal?.aborted) this.rejectEndpoint(new Error("调试启动已取消"));
			timer = setTimeout(() => this.rejectEndpoint(new Error("等待 Inspector 地址超时")), REQUEST_TIMEOUT);
			const url = await this.endpoint;
			clearTimeout(timer);
			if (this.stopping || this.done) throw new Error("调试会话已结束");
			const ws = this.ws = new WebSocket(url);
			this.socketEnded = new Promise((resolve) => ws.addEventListener("close", () => resolve(), { once: true }));
			ws.addEventListener("message", (event) => this.receive(JSON.parse(String(event.data))));
			ws.addEventListener("close", () => {
				this.disconnect(new Error("Inspector 连接已断开"));
				if (this.done || this.stopping || this.detaching) return;
				// 进程退出与 socket 关闭事件来自不同句柄，等待退出事件再判定连接故障。
				this.connectionClosedTimer = setTimeout(() => {
					if (this.done || this.stopping || this.detaching) return;
					this.error = "Inspector 连接已断开";
					void this.stop();
				}, EXIT_SETTLE_WAIT);
			});
			await new Promise<void>((resolve, reject) => {
				const finish = (error?: Error) => {
					clearTimeout(timer);
					ws.removeEventListener("open", opened);
					ws.removeEventListener("error", failed);
					ws.removeEventListener("close", failed);
					error ? reject(error) : resolve();
				};
				const opened = () => finish();
				const failed = () => finish(new Error("Inspector 连接失败"));
				ws.addEventListener("open", opened);
				ws.addEventListener("error", failed);
				ws.addEventListener("close", failed);
				timer = setTimeout(() => finish(new Error("Inspector 连接超时")), REQUEST_TIMEOUT);
			});
			await this.request("Runtime.enable", {}, signal);
			await this.request("Debugger.enable", {}, signal);
			const entry = await this.request("Debugger.setBreakpointByUrl", {url:pathToFileURL(this.path).href,lineNumber:0}, signal);
			await this.request("Runtime.runIfWaitingForDebugger", {}, signal);
			if (this.state === "initializing") await new Promise<void>((resolve) => {
				const finish = () => { clearTimeout(wait); this.pauseListeners.delete(finish); resolve(); };
				const wait = setTimeout(finish, INITIAL_PAUSE_WAIT);
				this.pauseListeners.add(finish);
			});
   if(this.state === "paused"){this.entering=false;await this.request("Debugger.removeBreakpoint", {breakpointId:entry.breakpointId}, signal);}
		} catch (error) {
			if (!this.stopping) this.error ??= error instanceof Error ? error.message : String(error);
			await this.stop();
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		}
	}

	receive(message: any): void {
		if (message.id !== undefined) {
			const request = this.pending.get(message.id);
			if (!request) return;
			message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
			return;
		}
		if (this.stopping || this.done || this.detaching) return;
		const event = message.params;
		if (message.method === "Debugger.scriptParsed") this.scripts.set(event.scriptId, event.url);
		if (message.method === "Debugger.paused") {
   const top = event.callFrames[0];
   if(this.entering && (this.scripts.get(top?.location.scriptId) || top?.url) !== pathToFileURL(this.path).href){
    void this.request("Debugger.resume").catch(error=>{this.error=error.message;void this.stop();});
    return;
   }
   this.entering=false;
			this.state = "paused";
			this.frames = event.callFrames;
			this.reason = event.reason;
			for (const notify of this.pauseListeners) notify();
		}
		if (message.method === "Debugger.resumed") { this.state = this.entering ? "initializing" : "running"; this.frames = []; this.reason = undefined; }
	}

	request(method: string, params: object = {}, signal?: AbortSignal): Promise<any> {
		if (signal?.aborted) return Promise.reject(new Error("调试请求已取消"));
		if (this.ws?.readyState !== WebSocket.OPEN || this.stopping || this.done || this.detaching) return Promise.reject(new Error("Inspector 未连接或会话已结束"));
		return new Promise((resolve, reject) => {
			const id = ++this.sequence;
			const finish = (error?: Error, result?: any) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				this.pending.delete(id);
				error ? reject(error) : resolve(result);
			};
			const abort = () => finish(new Error("调试请求已取消"));
			const timer = setTimeout(() => finish(new Error(`Inspector 请求超时：${method}`)), REQUEST_TIMEOUT);
			this.pending.set(id, { resolve: (result) => finish(undefined, result), reject: (error) => finish(error) });
			signal?.addEventListener("abort", abort, { once: true });
			try { this.ws!.send(JSON.stringify({ id, method, params })); }
			catch (error) { finish(error as Error); }
		});
	}

	location(location: any): any {
		return { scriptId: location.scriptId, url: this.scripts.get(location.scriptId) ?? "", line: location.lineNumber + 1, column: location.columnNumber + 1 };
	}

	stack(): any[] {
		return this.frames.map((frame) => ({ callFrameId: frame.callFrameId, functionName: frame.functionName, location: this.location(frame.location) }));
	}

	frame(id?: string): any {
		if (this.state !== "paused") throw new Error("此操作需要暂停中的会话；请先查询 status");
		const frame = id ? this.frames.find((item) => item.callFrameId === id) : this.frames[0];
		if (!frame) throw new Error("当前暂停中不存在此 callFrameId");
		return frame;
	}

	status(): any {
		return {
			sessionId: this.id, path: this.path, pid: this.child.pid, state: this.state, reason: this.reason,
			error: this.error, exitCode: this.exitCode, exitSignal: this.exitSignal,
			stdout: this.stdout, stderr: this.stderr, outputTruncated: { ...this.outputTruncated },
			callFrames: this.stack(), scripts: [...this.scripts].map(([scriptId, url]) => ({ scriptId, url })),
		};
	}

	stop(): Promise<void> {
		if (this.stopping) return this.stopping;
		this.state = this.error ? "error" : this.done ? this.state : "stopping";
		clearTimeout(this.connectionClosedTimer);
		this.stopping = (async () => {
			this.disconnect(new Error("调试会话已停止"));
			if (!this.done) {
				this.child.kill("SIGTERM");
				const timer = setTimeout(() => this.child.kill("SIGKILL"), TERMINATE_GRACE);
				try { await this.ended; } finally { clearTimeout(timer); }
			}
			await this.socketEnded;
		})();
		return this.stopping;
	}
}

export function registerDebuggerTools(pi: ExtensionAPI): void {
	const sessions = new Map<string, InspectorSession>();
	let closed = false;
	pi.registerTool({
		name: "debugger",
		label: "Node 调试器",
		description: "通过 Node Inspector/CDP 调试工作区内 Node 脚本，需要 Node 24 global WebSocket。launch 真正执行脚本，evaluate 真正执行表达式，均可读写文件或产生其他副作用；使用主线程正常工具审批，不提供隔离。支持多个 sessionId；除 launch 外不会启动或重启脚本。行列从 1 开始。launch 返回首行暂停或 initializing 状态；continue/step/pause 仅发出控制请求，随后用 status 查询暂停及输出。evaluate 不传 callFrameId 时在全局执行。仅支持 Node，不是全语言 DAP。",
		parameters: PARAMETERS,
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (closed) throw new Error("调试工具会话已关闭");
			if (signal?.aborted) throw new Error("调试请求已取消");
			const root = await realpath(ctx.cwd);
			if (closed) throw new Error("调试工具会话已关闭");
			let session: InspectorSession;
			let result: any;
			if (params.action === "launch") {
				const path = await workspaceFile(root, params.path);
				if (!/\.(?:[cm]?js|[cm]?ts)$/.test(path)) throw new Error("launch 仅支持 Node JavaScript/TypeScript 脚本");
				if (typeof WebSocket === "undefined") throw new Error("需要提供 global WebSocket 的 Node 24 运行时");
				if (closed || signal?.aborted) throw new Error("调试启动已取消");
				const id = params.sessionId ?? randomUUID();
				if (sessions.has(id)) throw new Error("sessionId 已存在；请使用新的 ID");
				session = new InspectorSession({ id, root, path, args: params.args ?? [] });
				sessions.set(id, session);
				await session.start(signal);
			} else {
				if (!params.sessionId || !sessions.has(params.sessionId)) throw new Error("必须提供已存在的 sessionId；请先 launch");
				session = sessions.get(params.sessionId)!;
				if (session.root !== root) throw new Error("sessionId 不属于当前工作区");
				switch (params.action) {
					case "status": break;
					case "stop": await session.stop(); break;
					case "stack": session.frame(); result = { callFrames: session.stack() }; break;
					case "set_breakpoint": {
						const path = await workspaceFile(root, params.path);
						if (!Number.isInteger(params.line) || params.line! < 1 || (params.column !== undefined && (!Number.isInteger(params.column) || params.column < 1))) throw new Error("断点行列必须是从 1 开始的整数");
						const breakpoint = await session.request("Debugger.setBreakpointByUrl", { url: pathToFileURL(path).href, lineNumber: params.line! - 1, columnNumber: (params.column ?? 1) - 1 }, signal);
						result = { breakpointId: breakpoint.breakpointId, locations: breakpoint.locations.map((location: any) => session.location(location)) };
						break;
					}
					case "remove_breakpoint":
						if (!params.breakpointId) throw new Error("必须提供 breakpointId");
						result = await session.request("Debugger.removeBreakpoint", { breakpointId: params.breakpointId }, signal); break;
					case "continue": case "step_over": case "step_into": case "step_out": {
						session.frame();
						const methods = { continue: "Debugger.resume", step_over: "Debugger.stepOver", step_into: "Debugger.stepInto", step_out: "Debugger.stepOut" };
						session.state = "resuming"; session.frames = []; session.reason = undefined;
						try { await session.request(methods[params.action], {}, signal); }
						catch (error) { if (session.state === "resuming") session.state = "unknown"; throw error; }
						if (session.state === "resuming") session.state = "running";
						result = { resumed: true }; break;
					}
					case "pause": result = await session.request("Debugger.pause", {}, signal); break;
					case "scopes": {
						const frame = session.frame(params.callFrameId);
						const scopes = await Promise.all(frame.scopeChain.map(async (scope: any) => {
							const properties = await session.request("Runtime.getProperties", { objectId: scope.object.objectId, ownProperties: true, generatePreview: true }, signal);
							return { type: scope.type, name: scope.name, objectId: scope.object.objectId, properties: properties.result, exceptionDetails: properties.exceptionDetails };
						}));
						result = { callFrameId: frame.callFrameId, scopes }; break;
					}
					case "evaluate": {
						if (typeof params.expression !== "string") throw new Error("必须提供 expression");
						const expression = { expression: params.expression, generatePreview: true };
						result = params.callFrameId
							? await session.request("Debugger.evaluateOnCallFrame", { ...expression, callFrameId: session.frame(params.callFrameId).callFrameId }, signal)
							: await session.request("Runtime.evaluate", { ...expression, timeout: REQUEST_TIMEOUT }, signal);
						break;
					}
					default: throw new Error("未知 debugger action");
				}
			}
			const details = { action: params.action, ...session.status(), ...(result === undefined ? {} : { result }) };
			return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
		},
	});
	pi.on("session_shutdown", async () => {
		closed = true;
		await Promise.all([...sessions.values()].map((session) => session.stop()));
		sessions.clear();
	});
}
