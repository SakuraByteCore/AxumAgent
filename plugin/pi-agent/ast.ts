import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type * as TypeScript from "typescript";
let ts: typeof TypeScript;
import { Type } from "typebox";
import type { ExtensionAPI } from "./shared.ts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const SCRIPT_KINDS: Record<string, "JS" | "JSX" | "TS" | "TSX"> = {
	".js": "JS", ".jsx": "JSX",
	".ts": "TS", ".tsx": "TSX",
	".mjs": "JS", ".cjs": "JS",
};
const PARAMETERS = Type.Object({
	action: Type.Union([Type.Literal("query"), Type.Literal("preview"), Type.Literal("apply")]),
	path: Type.String({ minLength: 1, description: "工作区内 JS/JSX/TS/TSX/mjs/cjs 文件路径。" }),
	selector: Type.Object({
		kind: Type.String({ minLength: 1, description: "TypeScript SyntaxKind 名称，例如 FunctionDeclaration、Identifier。" }),
		name: Type.Optional(Type.String({ description: "节点名称的精确源码匹配；Identifier 匹配自身，声明匹配 name 节点。" })),
		text: Type.Optional(Type.String({ description: "节点实际源码的精确匹配，不含前置注释和空白。" })),
		start: Type.Optional(Type.Integer({ minimum: 0, description: "精确节点起始 UTF-16 offset；须与 end、expectedHash 一起提供。" })),
		end: Type.Optional(Type.Integer({ minimum: 0, description: "节点结束 UTF-16 offset，不含该位置。" })),
	}),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: "仅限制展示节点数量；编辑始终处理全部匹配节点。默认 100。" })),
	replacement: Type.Optional(Type.String({ description: "preview/apply 必填；原样替换每个完整匹配节点，空串表示删除。" })),
	expectedHash: Type.Optional(Type.String({ pattern: "^[a-fA-F0-9]{64}$", description: "原文件 SHA-256；apply 必填，精确 offset 选择也必填。" })),
});
type Selector = { kind: string; name?: string; text?: string; start?: number; end?: number };
type Match = {
	kind: string; text: string; start: number; end: number;
	startPosition: { line: number; character: number };
	endPosition: { line: number; character: number };
};
type WriteBridge = {
	executeTool?: (name: string, args: { path: string; content: string }, options: { signal?: AbortSignal }) => Promise<{
		isError?: boolean; result?: { isError?: boolean; content?: { type: string; text?: string }[] };
	}>;
};

function sha256(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

async function workspacePath(cwd: string, input: string): Promise<string> {
	const root = await realpath(cwd);
	const path = await realpath(resolve(root, input));
	const inside = relative(root, path);
	if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error("AST 路径必须位于当前工作区内（含符号链接目标）。");
	if (!Object.hasOwn(SCRIPT_KINDS, extname(path).toLowerCase())) throw new Error("AST 仅支持 JS/JSX/TS/TSX/mjs/cjs 文件。");
	return path;
}

function parse(path: string, text: string) {
	const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind[SCRIPT_KINDS[extname(path).toLowerCase()]]);
	const diagnostics = (source as TypeScript.SourceFile & { parseDiagnostics: readonly TypeScript.Diagnostic[] }).parseDiagnostics
		.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
		.map(diagnostic => ({
			code: diagnostic.code,
			message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
			...position(source, diagnostic.start ?? 0),
		}));
	return { source, diagnostics };
}

function position(source: TypeScript.SourceFile, offset: number) {
	const point = source.getLineAndCharacterOfPosition(offset);
	return { line: point.line + 1, character: point.character + 1 };
}

function select(source: TypeScript.SourceFile, selector: Selector): Match[] {
	const kind = ts.SyntaxKind[selector.kind as keyof typeof ts.SyntaxKind];
	if (typeof kind !== "number") throw new Error(`未知 SyntaxKind：${selector.kind}`);
	const matches: Match[] = [];
	function visit(node: TypeScript.Node): void {
		if (node.kind === kind) {
			const start = node.getStart(source), end = node.getEnd();
			const text = source.text.slice(start, end);
			const name = ts.isIdentifier(node) || ts.isPrivateIdentifier(node)
				? node.getText(source) : (node as TypeScript.NamedDeclaration).name?.getText(source);
			if ((selector.name === undefined || name === selector.name)
				&& (selector.text === undefined || text === selector.text)
				&& (selector.start === undefined || start === selector.start)
				&& (selector.end === undefined || end === selector.end)) {
				matches.push({ kind: selector.kind, text, start, end, startPosition: position(source, start), endPosition: position(source, end) });
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	return matches.sort((a, b) => a.start - b.start || b.end - a.end);
}

function replaceMatches(text: string, matches: Match[], replacement: string): string {
	for (let i = 1; i < matches.length; i++) {
		if (matches[i].start < matches[i - 1].end || matches[i].start === matches[i - 1].start) {
			throw new Error("匹配节点重叠，拒绝嵌套或重复替换；请收窄 selector。");
		}
	}
	let result = text;
	for (let i = matches.length - 1; i >= 0; i--) {
		const { start, end } = matches[i];
		result = result.slice(0, start) + replacement + result.slice(end);
	}
	return result;
}

function requireValidSyntax(diagnostics: ReturnType<typeof parse>["diagnostics"], phase: string): void {
	if (diagnostics.length) throw new Error(`${phase}存在语法错误，拒绝编辑：${JSON.stringify(diagnostics)}`);
}

export function registerAstTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ast",
		label: "AST 语法树",
		description: "使用 TypeScript compiler API 查询和替换真实语法树节点。query 返回源码、SHA-256、UTF-16 offset 和从 1 开始的行列（end 不含该位置）；name/text 为精确匹配。preview 不写入，返回完整修改后源码；apply 必须携带原文件 expectedHash，通过父 write 工具审批。limit 只限制展示，替换全部匹配；拒绝重叠节点及修改前后的解析错误。仅检查语法，不检查类型或业务语义。",
		parameters: PARAMETERS,
		async execute(_id, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const { action, selector, replacement, expectedHash } = params;
			if (!["query", "preview", "apply"].includes(action)) throw new Error("未知 AST action。");
			const limit = params.limit ?? DEFAULT_LIMIT;
			if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`limit 必须为 1 至 ${MAX_LIMIT} 的整数。`);
			if (action !== "query" && typeof replacement !== "string") throw new Error("preview/apply 必须提供 replacement。");
			if (action === "apply" && !expectedHash) throw new Error("apply 必须提供 expectedHash。");
			if (selector.start !== undefined || selector.end !== undefined) {
				if (!Number.isInteger(selector.start) || !Number.isInteger(selector.end) || selector.start! < 0 || selector.end! < selector.start! || !expectedHash) {
					throw new Error("精确定位须提供有效的 start、end 和 expectedHash；offset 必须对应 AST 节点。");
				}
			}
			const path = await workspacePath(ctx.cwd, params.path);
			const bytes = await readFile(path);
			const original = bytes.toString("utf8");
			if (!Buffer.from(original, "utf8").equals(bytes)) throw new Error("AST 文件必须采用有效 UTF-8 编码。");
			const hash = sha256(bytes);
			if (expectedHash !== undefined && expectedHash.toLowerCase() !== hash) throw new Error("expectedHash 与当前文件不符，请重新 query/preview。");
			ts ??= (await import("typescript")).default;
			const { source, diagnostics } = parse(path, original);
			if (action !== "query") requireValidSyntax(diagnostics, "原文件");
			const matches = select(source, selector);
			const details = {
				action, path, hash, totalMatches: matches.length, returnedMatches: Math.min(matches.length, limit),
				truncated: matches.length > limit, matches: matches.slice(0, limit), diagnostics,
				changedCount: 0, applied: false, resultingHash: hash, updatedContent: undefined as string | undefined,
			};
			let summary = matches.length ? `共匹配 ${matches.length} 个 AST 节点。` : "未匹配任何 AST 节点，未作修改。";
			if (details.truncated) summary += ` 仅展示前 ${limit} 个节点；编辑范围仍为全部 ${matches.length} 个匹配节点。`;
			if (action !== "query" && matches.length) {
				const updated = replaceMatches(original, matches, replacement!);
				requireValidSyntax(parse(path, updated).diagnostics, "替换后的文件");
				details.changedCount = matches.filter(match => match.text !== replacement).length;
				details.resultingHash = sha256(updated);
				if (action === "preview") {
					details.updatedContent = updated;
					summary += ` 预览 ${details.changedCount} 处修改，未写入。`;
				} else if (details.changedCount) {
					const bridge = ctx as typeof ctx & WriteBridge;
					if (typeof bridge.executeTool !== "function") throw new Error("缺少父 executeTool 审批桥，拒绝写入。");
					if (await workspacePath(ctx.cwd, params.path) !== path || sha256(await readFile(path)) !== hash) throw new Error("文件在编辑期间已变化，拒绝写入，请重新查询。");
					signal?.throwIfAborted();
					const outcome = await bridge.executeTool("write", { path, content: updated }, { signal });
					if (outcome.isError || outcome.result?.isError) {
						const reason = outcome.result?.content?.filter(item => item.type === "text").map(item => item.text).join("\n");
						throw new Error(`父 write 工具拒绝或失败：${reason || "未提供原因"}`);
					}
					if (sha256(await readFile(path)) !== details.resultingHash) throw new Error("父 write 返回后文件内容不符，无法确认应用结果；请重新查询。");
					details.applied = true;
					summary += ` 已通过父 write 工具应用 ${details.changedCount} 处修改。`;
				} else summary += " 替换内容与源码相同，未写入。";
			}
			return { content: [{ type: "text", text: `${summary}\n${JSON.stringify(details, null, 2)}` }], details };
		},
	});
}
