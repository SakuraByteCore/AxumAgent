import { realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI } from "./shared.ts";
import { LanguageWorkspace } from "./lsp-client.ts";

const PARAMETERS = Type.Object({
	action: Type.Union([Type.Literal("diagnostics"), Type.Literal("definition"), Type.Literal("references"), Type.Literal("hover"), Type.Literal("status")]),
	path: Type.Optional(Type.String({ minLength: 1, description: "工作区内文件的绝对路径或相对路径；status 无需路径。" })),
	line: Type.Optional(Type.Integer({ minimum: 1, description: "从 1 开始的行号；definition、references、hover 必填。" })),
	character: Type.Optional(Type.Integer({ minimum: 1, description: "从 1 开始的 UTF-16 列号；definition、references、hover 必填。" })),
});

function locationText(location: any): string {
	const uri = location.uri ?? location.targetUri;
	const start = (location.range ?? location.targetSelectionRange ?? location.targetRange)?.start;
	const path = uri?.startsWith("file:") ? fileURLToPath(uri) : uri;
	return `${path ?? "未知位置"}${start ? `:${start.line + 1}:${start.character + 1}` : ""}`;
}

function hoverText(contents: any): string {
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents)) return contents.map(hoverText).join("\n\n");
	return contents?.value ?? "服务器未返回悬浮信息。";
}

function queryText(action: string, path: string, result: any): string {
	if (action === "hover") return hoverText(result?.contents);
	if (action === "diagnostics") {
		const diagnostics = result?.diagnostics ?? result?.items;
		if (!diagnostics) return JSON.stringify(result, null, 2);
		if (!diagnostics.length) return `${path}：服务器返回 0 条诊断。`;
		const severity: Record<number, string> = { 1: "错误", 2: "警告", 3: "信息", 4: "提示" };
		return diagnostics.map((item: any) => `${locationText({ uri: result.uri ?? pathToFileURL(path).href, range: item.range })} ${severity[item.severity] ?? "诊断"}${item.code !== undefined ? ` [${item.code}]` : ""}：${item.message}`).join("\n");
	}
	const locations = result == null ? [] : Array.isArray(result) ? result : [result];
	return locations.length ? locations.map(locationText).join("\n") : "服务器未返回匹配位置。";
}

export function registerLanguageTools(pi: ExtensionAPI): void {
	const workspaces = new Map<string, Promise<LanguageWorkspace>>();
	let closed = false;
	pi.registerTool({
		name: "lsp",
		label: "LSP",
		description: "通过真实语言服务器只读查询诊断、定义、引用和悬浮信息。line/character 从 1 开始，character 按 UTF-16 计数。按需使用工作区 .pi/lsp.json 或已安装的 typescript-language-server、pyright-langserver、clangd、rust-analyzer；不会安装服务器。status 查看配置及进程状态，不启动服务器。",
		parameters: PARAMETERS,
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (closed) throw new Error("LSP 会话已关闭");
			if (signal?.aborted) throw signal.reason ?? new Error("LSP 请求已取消");
			if (params.action !== "status" && !params.path) throw new Error("此 LSP 查询必须提供 path");
			const needsPosition = ["definition", "references", "hover"].includes(params.action);
			if (needsPosition && (!Number.isInteger(params.line) || !Number.isInteger(params.character) || params.line! < 1 || params.character! < 1)) throw new Error("line 和 character 必须是从 1 开始的整数");
			const root = await realpath(ctx.cwd);
			if (closed) throw new Error("LSP 会话已关闭");
			let workspace = workspaces.get(root);
			if (!workspace) {
				workspace = LanguageWorkspace.create(root);
				workspaces.set(root, workspace);
				workspace.catch(() => { if (workspaces.get(root) === workspace) workspaces.delete(root); });
			}
			const service = await workspace;
			if (closed) throw new Error("LSP 会话已关闭");
			if (params.action === "status") {
				const details = { action: params.action, ...service.status() };
				const text = details.servers.map((server) => `${server.name}：${server.state}；${server.command} ${server.args.join(" ")}；${server.extensions.join(", ")}${"error" in server && server.error ? `；${server.error}` : ""}`).join("\n");
				return { content: [{ type: "text", text }], details };
			}
			const position = needsPosition ? { line: params.line! - 1, character: params.character! - 1 } : undefined;
			const details = await service.query(params.action, params.path!, position, signal);
			return { content: [{ type: "text", text: queryText(params.action, details.path, details.result) }], details };
		},
	});
	pi.on("session_shutdown", async () => {
		closed = true;
		await Promise.all([...workspaces.values()].map(async (workspace) => {
			let service: LanguageWorkspace;
			try { service = await workspace; } catch { return; }
			await service.close();
		}));
		workspaces.clear();
	});
}
