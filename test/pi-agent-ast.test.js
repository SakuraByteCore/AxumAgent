import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerAstTools } from "../plugin/pi-agent/ast.ts";

const hash = text => createHash("sha256").update(text).digest("hex");
async function fixture(t, text, filename = "entry.ts") {
	const root = await mkdtemp(join(tmpdir(), "axum-ast-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, filename);
	await writeFile(path, text);
	let tool;
	registerAstTools({ registerTool(value) { tool = value; } });
	assert.equal(tool.name, "ast");
	const calls = [];
	const ctx = { cwd: root, async executeTool(name, args) {
		calls.push({ name, args });
		await writeFile(args.path, args.content);
		return { isError: false, result: { content: [] } };
	} };
	const run = (params, context = ctx) => tool.execute("ast-test", { path: filename, ...params }, undefined, undefined, context);
	return { root, path, text, calls, ctx, run };
}

test("真实 TS 节点、源码、UTF-16 行列、名称筛选与查询截断", async t => {
	const text = '// function ghost() {}\r\nconst emoji = "🌍"; function greet(name: string) { return name; }\r\nfunction other() {}\r\n';
	const f = await fixture(t, text);
	const result = await f.run({ action: "query", selector: { kind: "FunctionDeclaration" }, limit: 1 });
	const start = text.indexOf("function greet"), end = text.indexOf("}\r\n", start) + "}".length;
	const node = result.details.matches[0];
	assert.equal(result.details.hash, hash(text));
	assert.equal(result.details.totalMatches, 2);
	assert.equal(result.details.truncated, true);
	assert.equal(result.details.returnedMatches, 1);
	assert.equal(node.kind, "FunctionDeclaration");
	assert.equal(node.start, start);
	assert.equal(node.end, end);
	assert.equal(node.text, text.slice(start, end));
	assert.deepEqual(node.startPosition, { line: 2, character: start - text.indexOf("const emoji") + 1 });
	assert.deepEqual(node.endPosition, { line: 2, character: end - text.indexOf("const emoji") + 1 });
	const named = await f.run({ action: "query", selector: { kind: "FunctionDeclaration", name: "greet", text: node.text } });
	assert.equal(named.details.totalMatches, 1);
	assert.deepEqual(named.details.matches[0], node);
	assert.deepEqual(result.details.diagnostics, []);
});

test("JS/JSX/TSX/mjs/cjs 使用对应解析器生成真实节点", async t => {
	for (const extension of ["js", "jsx", "tsx", "mjs", "cjs"]) {
		const jsx = extension.endsWith("sx");
		const source = jsx ? "const view = <Panel title='你好' />;" : "const object = { run(value) { return value + 1; } };";
		const f = await fixture(t, source, `entry.${extension}`);
		const kind = jsx ? "JsxSelfClosingElement" : "MethodDeclaration";
		const result = await f.run({ action: "query", selector: { kind } });
		assert.equal(result.details.totalMatches, 1, extension);
		assert.deepEqual(result.details.diagnostics, []);
		const node = result.details.matches[0];
		assert.equal(node.text, jsx ? "<Panel title='你好' />" : "run(value) { return value + 1; }");
		assert.equal(source.slice(node.start, node.end), node.text);
	}
});

test("预览不写入；apply 忽略展示 limit 全量倒序替换且通过写桥", async t => {
	const f = await fixture(t, "const alpha = 1;\nconsole.log(alpha);\n");
	const params = { selector: { kind: "Identifier", name: "alpha" }, replacement: "longerName", limit: 1 };
	const preview = await f.run({ action: "preview", ...params });
	const updated = "const longerName = 1;\nconsole.log(longerName);\n";
	assert.equal(preview.details.updatedContent, updated);
	assert.equal(preview.details.changedCount, 2);
	assert.equal(preview.details.applied, false);
	assert.equal(await readFile(f.path, "utf8"), f.text);
	assert.equal(f.calls.length, 0);
	const applied = await f.run({ action: "apply", ...params, expectedHash: preview.details.hash });
	assert.deepEqual(f.calls, [{ name: "write", args: { path: f.path, content: updated } }]);
	assert.equal(applied.details.applied, true);
	assert.equal(applied.details.totalMatches, 2);
	assert.equal(applied.details.changedCount, 2);
	assert.equal(applied.details.resultingHash, hash(updated));
	assert.equal(await readFile(f.path, "utf8"), updated);
});

test("expectedHash 必填且必须匹配；审批拒绝与缺少桥均不改文件", async t => {
	const f = await fixture(t, "const value = 1;");
	const params = { action: "apply", selector: { kind: "Identifier", name: "value" }, replacement: "next" };
	await assert.rejects(f.run(params), /expectedHash/);
	await assert.rejects(f.run({ ...params, expectedHash: hash("旧版本") }), /expectedHash/);
	const exact = { ...params, expectedHash: hash(f.text) };
	await assert.rejects(f.run(exact, { cwd: f.root }), /审批桥/);
	let denied = 0;
	await assert.rejects(f.run(exact, { cwd: f.root, async executeTool() {
		denied++;
		return { isError: true, result: { content: [{ type: "text", text: "审批拒绝" }] } };
	} }), /审批拒绝/);
	assert.equal(denied, 1);
	assert.equal(f.calls.length, 0);
	assert.equal(await readFile(f.path, "utf8"), f.text);
});

test("hash 与 AST offset 精确定位；任意文本区间不能充当节点", async t => {
	const f = await fixture(t, "const value = 1; console.log(value);");
	const query = await f.run({ action: "query", selector: { kind: "Identifier", name: "value" } });
	const { start, end } = query.details.matches.at(-1);
	const selector = { kind: "Identifier", start, end };
	await assert.rejects(f.run({ action: "preview", selector, replacement: "next" }), /expectedHash/);
	const preview = await f.run({ action: "preview", selector, replacement: "next", expectedHash: query.details.hash });
	assert.equal(preview.details.updatedContent, "const value = 1; console.log(next);");
	assert.equal(preview.details.changedCount, 1);
	const noNode = await f.run({ action: "apply", selector: { ...selector, start: start + 1 }, replacement: "next", expectedHash: query.details.hash });
	assert.equal(noNode.details.totalMatches, 0);
	assert.equal(noNode.details.applied, false);
	assert.equal(f.calls.length, 0);
});

test("修改前后语法错误及重叠节点均拒绝编辑", async t => {
	const f = await fixture(t, "const value = 1;");
	for (const action of ["preview", "apply"]) {
		await assert.rejects(f.run({ action, selector: { kind: "Identifier", name: "value" }, replacement: ")", expectedHash: hash(f.text) }), /替换后的文件存在语法错误/);
	}
	const nested = await fixture(t, "outer(inner());");
	await assert.rejects(nested.run({ action: "preview", selector: { kind: "CallExpression" }, replacement: "done()" }), /重叠/);
	const broken = await fixture(t, "const value = ;");
	const query = await broken.run({ action: "query", selector: { kind: "Identifier" } });
	assert.ok(query.details.diagnostics.length > 0);
	await assert.rejects(broken.run({ action: "apply", selector: { kind: "Identifier" }, replacement: "next", expectedHash: hash(broken.text) }), /原文件存在语法错误/);
	for (const item of [f, nested, broken]) {
		assert.equal(item.calls.length, 0);
		assert.equal(await readFile(item.path, "utf8"), item.text);
	}
});

test("无匹配与相同替换不伪造修改；路径及 SyntaxKind 边界", async t => {
	const f = await fixture(t, "const value = 1;");
	for (const name of ["missing", "value"]) {
		const result = await f.run({ action: "apply", selector: { kind: "Identifier", name }, replacement: name, expectedHash: hash(f.text) });
		assert.equal(result.details.changedCount, 0);
		assert.equal(result.details.applied, false);
	}
	assert.equal(f.calls.length, 0);
	await assert.rejects(f.run({ action: "query", selector: { kind: "NotASyntaxKind" } }), /未知 SyntaxKind/);
	const inner = join(f.root, "inner");
	await mkdir(inner);
	await symlink(f.path, join(inner, "escape.ts"));
	await assert.rejects(f.run({ action: "query", path: "../entry.ts", selector: { kind: "Identifier" } }, { cwd: inner }), /工作区/);
	await assert.rejects(f.run({ action: "query", path: "escape.ts", selector: { kind: "Identifier" } }, { cwd: inner }), /工作区/);
});
