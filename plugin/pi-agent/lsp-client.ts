import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export interface LanguageServer {
	name: string;
	command: string;
	args: string[];
	extensions: string[];
}

type RpcMessage = { id?: number | string | null; method?: string; params?: any; result?: any; error?: { code: number; message: string } };
type Pending = { resolve(value: any): void; reject(error: Error): void };
type Diagnostics = { uri: string; version?: number; diagnostics: any[] };
const REQUEST_TIMEOUT_MS = 15_000;
const STDERR_LIMIT = 8192;
const DEFAULT_SERVERS: LanguageServer[] = [
	{ name: "typescript", command: "typescript-language-server", args: ["--stdio"], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"] },
	{ name: "pyright", command: "pyright-langserver", args: ["--stdio"], extensions: [".py", ".pyi"] },
	{ name: "clangd", command: "clangd", args: [], extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"] },
	{ name: "rust-analyzer", command: "rust-analyzer", args: [], extensions: [".rs"] },
];
const LANGUAGE_IDS: Record<string, string> = {
	".ts": "typescript", ".tsx": "typescriptreact", ".mts": "typescript", ".cts": "typescript",
	".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript",
	".py": "python", ".pyi": "python", ".c": "c", ".h": "c", ".rs": "rust",
	".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp", ".hxx": "cpp",
};

function cancelled(): Error {
	const error = new Error("LSP 请求已取消");
	error.name = "AbortError";
	return error;
}

export function assertWorkspacePath(root: string, path: string): void {
	const child = relative(root, path);
	if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error(`LSP 仅允许查询当前工作区文件：${path}`);
}

export class LspClient {
	readonly process: ChildProcessWithoutNullStreams;
	readonly root: string;
	readonly server: LanguageServer;
	readonly documents = new Map<string, { text: string; version: number }>();
	private buffer = Buffer.alloc(0);
	private nextId = 0;
	private pending = new Map<number, Pending>();
	private diagnostics = new Map<string, Diagnostics>();
	private diagnosticWaiters = new Map<string, Set<Pending>>();
	private initialization?: Promise<void>;
	private disposal?: Promise<void>;
	private failure?: Error;
	private ended = false;
	private closing = false;
	private initialized = false;
	private stderr = "";
	private capabilities: any = {};

	constructor(root: string, server: LanguageServer) {
		this.root = root;
		this.server = server;
		this.process = spawn(server.command, server.args, { cwd: root, shell: false, stdio: "pipe" });
		this.process.stdout.on("data", (data: Buffer) => {
			try { this.receive(data); }
			catch (error) { this.fail(new Error(`LSP 协议错误：${(error as Error).message}`)); this.process.kill(); }
		});
		this.process.stderr.on("data", (data: Buffer) => { this.stderr = (this.stderr + data.toString("utf8")).slice(-STDERR_LIMIT); });
		this.process.stdin.on("error", (error) => { this.fail(new Error(`LSP 输入管道失败：${error.message}`)); this.process.kill(); });
		this.process.on("error", (error) => this.fail(new Error(`无法启动 LSP 服务器 ${server.command}：${error.message}；请安装服务器或配置 .pi/lsp.json`)));
		this.process.on("exit", (code, signal) => this.fail(new Error(`LSP 服务器 ${server.name} 已退出（${code ?? signal}）${this.stderr ? `：${this.stderr}` : ""}`)));
		this.process.on("close", () => { this.ended = true; this.buffer = Buffer.alloc(0); });
	}

	private send(message: RpcMessage): void {
		if (this.failure) throw this.failure;
		const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
		this.process.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
	}

	notify(method: string, params?: unknown): void {
		if (this.closing && method !== "exit" && method !== "$/cancelRequest") throw new Error("LSP 会话已关闭");
		this.send({ method, params });
	}

	request(method: string, params?: unknown, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
		if (signal?.aborted) return Promise.reject(cancelled());
		if (this.failure) return Promise.reject(this.failure);
		if (this.closing && method !== "shutdown") return Promise.reject(new Error("LSP 会话已关闭"));
		const id = ++this.nextId;
		return new Promise((resolveRequest, rejectRequest) => {
			const finish = (error?: Error, value?: unknown) => {
				clearTimeout(timer); signal?.removeEventListener("abort", abort); this.pending.delete(id);
				if (error) rejectRequest(error); else resolveRequest(value);
			};
			const cancel = (error: Error) => {
				finish(error);
				if (!this.failure) this.notify("$/cancelRequest", { id });
			};
			const abort = () => cancel(cancelled());
			const timer = setTimeout(() => cancel(new Error(`LSP 请求超时：${method}`)), Math.min(timeoutMs, REQUEST_TIMEOUT_MS));
			this.pending.set(id, { resolve: (value) => finish(undefined, value), reject: (error) => finish(error) });
			signal?.addEventListener("abort", abort, { once: true });
			try { this.send({ id, method, params }); } catch (error) { finish(error as Error); }
		});
	}

	private receive(data: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, data]);
		while (this.buffer.length) {
			const end = this.buffer.indexOf("\r\n\r\n");
			if (end < 0) return;
			const match = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i.exec(this.buffer.subarray(0, end).toString("ascii"));
			if (!match) throw new Error("缺少 Content-Length");
			const length = Number(match[1]);
			if (this.buffer.length < end + 4 + length) return;
			const message: RpcMessage = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString("utf8"));
			this.buffer = this.buffer.subarray(end + 4 + length);
			this.handle(message);
		}
	}

	private handle(message: RpcMessage): void {
		if (message.method && message.id !== undefined) {
			let result: unknown = null;
			switch (message.method) {
				case "workspace/configuration": result = (message.params?.items ?? []).map(() => null); break;
				case "workspace/workspaceFolders": result = [{ uri: pathToFileURL(this.root).href, name: basename(this.root) }]; break;
				case "workspace/applyEdit": result = { applied: false, failureReason: "LSP 工具仅提供只读查询" }; break;
				case "client/registerCapability": case "client/unregisterCapability":
				case "window/workDoneProgress/create": case "window/showMessageRequest": break;
				default: this.send({ id: message.id, error: { code: -32601, message: `不支持客户端方法：${message.method}` } }); return;
			}
			this.send({ id: message.id, result });
			return;
		}
		if (message.method === "textDocument/publishDiagnostics") {
			const report = message.params as Diagnostics;
			const document = this.documents.get(report.uri);
			if (!document || (report.version !== undefined && report.version < document.version)) return;
			this.diagnostics.set(report.uri, report);
			for (const waiter of this.diagnosticWaiters.get(report.uri) ?? []) waiter.resolve(report);
			return;
		}
		if (typeof message.id !== "number") return;
		const pending = this.pending.get(message.id);
		if (message.error) pending?.reject(new Error(`LSP 错误 ${message.error.code}：${message.error.message}`));
		else pending?.resolve(message.result);
	}

	private fail(error: Error): void {
		this.failure ??= error;
		for (const pending of this.pending.values()) pending.reject(this.failure);
		for (const waiters of this.diagnosticWaiters.values()) for (const waiter of waiters) waiter.reject(this.failure);
	}

	initialize(signal?: AbortSignal): Promise<void> {
		if (this.closing) return Promise.reject(new Error("LSP 会话已关闭"));
		this.initialization ??= (async () => {
			const result = await this.request("initialize", {
				processId: process.pid, rootUri: pathToFileURL(this.root).href,
				workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: basename(this.root) }],
				capabilities: {
					general: { positionEncodings: ["utf-16"] },
					workspace: { configuration: true, workspaceFolders: true },
					textDocument: { synchronization: { dynamicRegistration: false }, hover: { contentFormat: ["markdown", "plaintext"] }, publishDiagnostics: { versionSupport: true }, diagnostic: { dynamicRegistration: false } },
				},
			}, signal);
			this.capabilities = result.capabilities ?? {};
			if (this.capabilities.positionEncoding && this.capabilities.positionEncoding !== "utf-16") throw new Error("LSP 服务器未采用 UTF-16 位置编码");
			this.notify("initialized", {});
			this.initialized = true;
		})();
		return this.initialization;
	}

	async openDocument(path: string, signal?: AbortSignal): Promise<string> {
		const text = await readFile(path, "utf8");
		if (signal?.aborted) throw cancelled();
		if (this.closing) throw new Error("LSP 会话已关闭");
		const uri = pathToFileURL(path).href;
		const previous = this.documents.get(uri);
		if (previous?.text === text) return uri;
		const document = { text, version: (previous?.version ?? 0) + 1 };
		this.documents.set(uri, document);
		this.diagnostics.delete(uri);
		if (previous) {
			const changes = this.capabilities.textDocumentSync;
			const incremental = (typeof changes === "number" ? changes : changes?.change) === 2;
			const lines = previous.text.split("\n");
			const contentChanges = incremental
				? [{ range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1)!.length } }, text }]
				: [{ text }];
			this.notify("textDocument/didChange", { textDocument: { uri, version: document.version }, contentChanges });
		} else this.notify("textDocument/didOpen", { textDocument: { uri, languageId: LANGUAGE_IDS[extname(path)] ?? extname(path).slice(1), ...document } });
		return uri;
	}

	async getDiagnostics(uri: string, signal?: AbortSignal): Promise<unknown> {
		if (this.capabilities.diagnosticProvider) return this.request("textDocument/diagnostic", { textDocument: { uri } }, signal);
		if (signal?.aborted) throw cancelled();
		if (this.failure) throw this.failure;
		if (this.closing) throw new Error("LSP 会话已关闭");
		const cached = this.diagnostics.get(uri);
		if (cached) return cached;
		return new Promise((resolveReport, rejectReport) => {
			const waiters = this.diagnosticWaiters.get(uri) ?? new Set<Pending>();
			const finish = (error?: Error, value?: unknown) => {
				clearTimeout(timer); signal?.removeEventListener("abort", abort); waiters.delete(waiter);
				if (!waiters.size) this.diagnosticWaiters.delete(uri);
				if (error) rejectReport(error); else resolveReport(value);
			};
			const abort = () => finish(cancelled());
			const timer = setTimeout(() => finish(new Error("LSP 服务器未在 15 秒内发布诊断")), REQUEST_TIMEOUT_MS);
			const waiter = { resolve: (value: unknown) => finish(undefined, value), reject: (error: Error) => finish(error) };
			waiters.add(waiter); this.diagnosticWaiters.set(uri, waiters);
			signal?.addEventListener("abort", abort, { once: true });
		});
	}

	status() {
		return { name: this.server.name, command: this.server.command, pid: this.process.pid,
			state: this.closing ? "closed" : this.failure ? "failed" : this.initialized ? "ready" : "starting",
			pendingRequests: this.pending.size, diagnosticWaiters: [...this.diagnosticWaiters.values()].reduce((n, set) => n + set.size, 0),
			openDocuments: this.documents.size, stderr: this.stderr, error: this.failure?.message };
	}

	close(): Promise<void> {
		this.disposal ??= this.dispose();
		return this.disposal;
	}

	private async dispose(): Promise<void> {
		this.closing = true;
		const error = new Error("LSP 会话已关闭");
		for (const pending of this.pending.values()) pending.reject(error);
		for (const waiters of this.diagnosticWaiters.values()) for (const waiter of waiters) waiter.reject(error);
		this.documents.clear(); this.diagnostics.clear();
		if (this.ended) return;
		let onClose!: () => void;
		const closed = new Promise<void>((done) => { onClose = done; this.process.once("close", onClose); });
		if (this.initialized && !this.failure) {
			try { await this.request("shutdown", null, undefined, 500); } catch { /* 关闭阶段继续回收已失效的进程。 */ }
		}
		if (!this.ended) {
			if (!this.failure) this.notify("exit");
			this.process.stdin.end();
			const timer = setTimeout(() => this.process.kill("SIGKILL"), 500);
			this.process.kill("SIGTERM");
			try { await closed; } finally { clearTimeout(timer); }
		}
		this.process.removeListener("close", onClose);
		this.failure ??= error;
	}
}

export class LanguageWorkspace {
	readonly root: string;
	readonly servers: LanguageServer[];
	private clients = new Map<string, LspClient>();
	private closed = false;
	private constructor(root: string, servers: LanguageServer[]) { this.root = root; this.servers = servers; }

	static async create(root: string): Promise<LanguageWorkspace> {
		root = await realpath(root);
		let config: any;
		try {
			const path = await realpath(resolve(root, ".pi/lsp.json"));
			assertWorkspacePath(root, path);
			config = JSON.parse(await readFile(path, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`读取 .pi/lsp.json 失败：${(error as Error).message}`);
		}
		const servers: LanguageServer[] = [];
		if (config !== undefined) {
			if (!config || typeof config.servers !== "object" || !config.servers || Array.isArray(config.servers)) throw new Error(".pi/lsp.json 必须包含 servers 对象");
			for (const [name, entry] of Object.entries(config.servers) as [string, any][]) {
				if (!entry || typeof entry.command !== "string" || !entry.command.trim() || !Array.isArray(entry.extensions) || !entry.extensions.length || entry.extensions.some((x: unknown) => typeof x !== "string" || !x.length) || (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some((x: unknown) => typeof x !== "string")))) throw new Error(`.pi/lsp.json 服务器配置无效：${name}`);
				servers.push({ name, command: entry.command, args: entry.args ?? [], extensions: entry.extensions.map((x: string) => x.startsWith(".") ? x : `.${x}`) });
			}
		}
		return new LanguageWorkspace(root, [...servers, ...DEFAULT_SERVERS.filter((entry) => !servers.some((custom) => custom.name === entry.name))]);
	}

	status() {
		return { root: this.root, servers: this.servers.map((server) => ({ ...server, ...(this.clients.get(server.name)?.status() ?? { state: "not_started" }) })) };
	}

	async query(action: "diagnostics" | "definition" | "references" | "hover", path: string, position?: { line: number; character: number }, signal?: AbortSignal) {
		if (this.closed) throw new Error("LSP 会话已关闭");
		if (signal?.aborted) throw cancelled();
		const lexicalPath = resolve(this.root, path);
		assertWorkspacePath(this.root, lexicalPath);
		const absolutePath = await realpath(lexicalPath);
		assertWorkspacePath(this.root, absolutePath);
		const server = this.servers.find((entry) => entry.extensions.includes(extname(absolutePath)));
		if (!server) throw new Error(`未配置此文件类型的 LSP 服务器：${extname(absolutePath) || absolutePath}`);
		if (this.closed) throw new Error("LSP 会话已关闭");
		let client = this.clients.get(server.name);
		if (!client) { client = new LspClient(this.root, server); this.clients.set(server.name, client); }
		try { await client.initialize(signal); }
		catch (error) { if (this.clients.get(server.name) === client) this.clients.delete(server.name); await client.close(); throw error; }
		const uri = await client.openDocument(absolutePath, signal);
		const result = action === "diagnostics" ? await client.getDiagnostics(uri, signal)
			: await client.request(`textDocument/${action}`, { textDocument: { uri }, position, ...(action === "references" ? { context: { includeDeclaration: true } } : {}) }, signal);
		return { action, path: absolutePath, server: server.name, result };
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.all([...this.clients.values()].map((client) => client.close()));
		this.clients.clear();
	}
}
