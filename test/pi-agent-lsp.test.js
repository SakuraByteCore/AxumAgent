import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { LanguageWorkspace, LspClient } from "../plugin/pi-agent/lsp-client.ts";
import { registerLanguageTools } from "../plugin/pi-agent/lsp.ts";

const FAKE_SERVER = String.raw`
import { appendFileSync } from "node:fs";
let buffer = Buffer.alloc(0), output = Promise.resolve();
const documents = new Map();
const log = process.argv[2];
function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
  const frame = Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n"), body]);
  const unicode = frame.findIndex(byte => byte >= 128);
  const split = unicode < 0 ? 13 : unicode + 1;
  output = output.then(async () => {
    process.stdout.write(frame.subarray(0, split));
    await new Promise(done => setImmediate(done));
    process.stdout.write(frame.subarray(split));
  });
}
function diagnostic(text) {
  return text.includes("clean") ? [] : [{ range: { start: { line: 0, character: 4 }, end: { line: 0, character: 5 } }, severity: 1, code: "fixture", message: "未定义：" + text }];
}
function handle(message) {
  appendFileSync(log, JSON.stringify(message) + "\n");
  const { id, method, params } = message;
  const reply = result => send({ id, result });
  if (method === "initialize") {
    process.stderr.write("x".repeat(20000));
    reply({ capabilities: { textDocumentSync: 2, hoverProvider: true, definitionProvider: true, referencesProvider: true, diagnosticProvider: process.argv.includes("--pull") ? {} : undefined } });
  } else if (method === "initialized") {
    send({ id: "config", method: "workspace/configuration", params: { items: [{ section: "fixture" }] } });
    send({ id: "folders", method: "workspace/workspaceFolders", params: {} });
    send({ id: "register", method: "client/registerCapability", params: { registrations: [] } });
    send({ id: "edit", method: "workspace/applyEdit", params: { edit: { changes: {} } } });
    send({ id: "unknown", method: "fixture/unknown", params: {} });
  } else if (method === "textDocument/didOpen" || method === "textDocument/didChange") {
    const doc = params.textDocument;
    const text = method.endsWith("didOpen") ? doc.text : params.contentChanges[0].text;
    documents.set(doc.uri, { text, version: doc.version });
    if (method.endsWith("didChange")) send({ method: "textDocument/publishDiagnostics", params: { uri: doc.uri, version: doc.version - 1, diagnostics: diagnostic("stale") } });
    send({ method: "textDocument/publishDiagnostics", params: { uri: doc.uri, version: doc.version, diagnostics: diagnostic(text) } });
  } else if (method === "textDocument/diagnostic") {
    reply({ kind: "full", items: diagnostic(documents.get(params.textDocument.uri).text) });
  } else if (method === "textDocument/definition" || method === "textDocument/references") {
    reply([{ uri: params.textDocument.uri, range: { start: params.position, end: params.position } }]);
  } else if (method === "textDocument/hover") {
    reply({ contents: { kind: "markdown", value: "类型：你好 🌍" } });
  } else if (method === "trace") {
    import("node:fs").then(({ readFileSync }) => reply(readFileSync(log, "utf8").trim().split("\n").map(JSON.parse)));
  } else if (method === "error") {
    send({ id, error: { code: -32602, message: "fixture 参数错误" } });
  } else if (method === "exit-now") process.exit(7);
  else if (method === "shutdown") reply(null);
  else if (method === "exit") process.exit(0);
}
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
    buffer = buffer.subarray(end + 4 + length);
    handle(message);
  }
});
`;

async function fixture(t, pull = false) {
  const root = await mkdtemp(join(tmpdir(), "axum-lsp-"));
  const script = join(root, "fake-server.mjs"), log = join(root, "requests.jsonl");
  await writeFile(script, FAKE_SERVER);
  await mkdir(join(root, ".pi"));
  const server = { name: "fixture", command: process.execPath, args: [script, log, ...(pull ? ["--pull"] : [])], extensions: [".ts"] };
  await writeFile(join(root, ".pi/lsp.json"), JSON.stringify({ servers: {
    fixture: { command: server.command, args: server.args, extensions: ["ts"] },
    missing: { command: join(root, "missing-language-server"), extensions: [".broken"] },
  } }));
  const path = join(root, "entry #1.ts");
  await writeFile(path, "const old = missing;\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, server, path, log };
}

// 所有协议断言通过真实子进程和 stdin/stdout 管道完成。
test("LSP 帧、握手、服务器请求、取消、超时与退出清理", { timeout: 10000 }, async t => {
  const { root, server, path } = await fixture(t);
  const client = new LspClient(root, server);
  t.after(() => client.close());
  await client.initialize();
  const uri = await client.openDocument(path);
  const diagnostics = await client.getDiagnostics(uri);
  assert.equal(diagnostics.version, 1);
  assert.match(diagnostics.diagnostics[0].message, /const old/);
  const hover = await client.request("textDocument/hover", { textDocument: { uri }, position: { line: 0, character: 0 } });
  assert.equal(hover.contents.value, "类型：你好 🌍");
  await assert.rejects(client.request("error"), /-32602.*fixture 参数错误/);
  const controller = new AbortController();
  const aborted = assert.rejects(client.request("hang", {}, controller.signal), { name: "AbortError" });
  controller.abort();
  await aborted;
  await assert.rejects(client.request("hang", {}, undefined, 35), /请求超时/);
  assert.equal(client.status().pendingRequests, 0);
  const waiting = new AbortController();
  const waitingResult = assert.rejects(client.getDiagnostics(uri + ".other", waiting.signal), { name: "AbortError" });
  waiting.abort();
  await waitingResult;
  assert.equal(client.status().diagnosticWaiters, 0);
  const trace = await client.request("trace");
  assert.equal(trace.filter(x => x.method === "initialize").length, 1);
  assert.equal(trace.filter(x => x.method === "$/cancelRequest").length, 2);
  assert.deepEqual(trace.find(x => x.id === "config" && !x.method).result, [null]);
  assert.equal(trace.find(x => x.id === "folders" && !x.method).result[0].uri, pathToFileURL(root).href);
  assert.equal(trace.find(x => x.id === "register" && !x.method).result, null);
  assert.equal(trace.find(x => x.id === "edit" && !x.method).result.applied, false);
  assert.equal(trace.find(x => x.id === "unknown" && !x.method).error.code, -32601);
  assert.ok(client.status().stderr.length <= 8192);
  const pendingExit = assert.rejects(client.request("hang"), /已退出/);
  const exit = assert.rejects(client.request("exit-now"), /已退出/);
  await Promise.all([pendingExit, exit]);
  assert.equal(client.status().pendingRequests, 0);
  await client.close();
  assert.equal(client.process.exitCode, 7);
});

test("lsp 工具使用工作区配置、1-based 坐标和版本同步，关闭时回收进程", { timeout: 10000 }, async t => {
  const { root, path, log } = await fixture(t);
  let tool, shutdown;
  registerLanguageTools({ registerTool(value) { tool = value; }, on(event, handler) { assert.equal(event, "session_shutdown"); shutdown = handler; } });
  t.after(() => shutdown());
  const query = (params, signal) => tool.execute("call", params, signal, undefined, { cwd: root });
  assert.equal(tool.name, "lsp");
  const status = await query({ action: "status" });
  assert.equal(status.details.servers.find(x => x.name === "fixture").state, "not_started");
  assert.equal(existsSync(log), false);
  await assert.rejects(query({ action: "definition", path }), /line 和 character/);
  await assert.rejects(query({ action: "hover", path, line: 0, character: 1 }), /从 1 开始/);
  const [definition, references] = await Promise.all([
    query({ action: "definition", path, line: 2, character: 5 }),
    query({ action: "references", path, line: 2, character: 5 }),
  ]);
  assert.deepEqual(definition.details.result[0].range.start, { line: 1, character: 4 });
  assert.match(definition.content[0].text, /entry #1\.ts:2:5/);
  assert.equal(references.details.result.length, 1);
  assert.equal((await query({ action: "hover", path, line: 1, character: 1 })).content[0].text, "类型：你好 🌍");
  const first = await query({ action: "diagnostics", path });
  assert.equal(first.details.result.version, 1);
  await writeFile(path, "const newer = missing;\n");
  const changed = await query({ action: "diagnostics", path });
  assert.equal(changed.details.result.version, 2);
  assert.match(changed.content[0].text, /entry #1\.ts:1:5.*const newer/);
  await writeFile(path, "// clean\n");
  assert.deepEqual((await query({ action: "diagnostics", path })).details.result.diagnostics, []);
  await assert.rejects(query({ action: "hover", path: "../outside.ts", line: 1, character: 1 }), /当前工作区/);
  await symlink(tmpdir(), join(root, "outside"));
  await assert.rejects(query({ action: "diagnostics", path: "outside" }), /当前工作区/);
  await writeFile(join(root, "file.unknown"), "");
  await assert.rejects(query({ action: "diagnostics", path: "file.unknown" }), /未配置/);
  await writeFile(join(root, "file.broken"), "");
  await assert.rejects(query({ action: "diagnostics", path: "file.broken" }), /无法启动.*missing-language-server/);
  const ready = (await query({ action: "status" })).details.servers.find(x => x.name === "fixture");
  assert.equal(ready.pendingRequests, 0);
  await shutdown();
  assert.throws(() => process.kill(ready.pid, 0), { code: "ESRCH" });
  await assert.rejects(query({ action: "status" }), /会话已关闭/);
  const trace = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(trace.filter(x => x.method === "initialize").length, 1);
  assert.equal(trace.filter(x => x.method === "textDocument/didOpen").length, 1);
  const changes = trace.filter(x => x.method === "textDocument/didChange");
  assert.deepEqual(changes.map(x => x.params.textDocument.version), [2, 3]);
  assert.deepEqual(changes[0].params.contentChanges[0].range.end, { line: 1, character: 0 });
  assert.equal(trace.find(x => x.method === "textDocument/references").params.context.includeDeclaration, true);
  assert.ok(trace.some(x => x.method === "shutdown"));
});

test("支持拉取诊断，非法配置明确报错", { timeout: 10000 }, async t => {
  const { root, path } = await fixture(t, true);
  const workspace = await LanguageWorkspace.create(root);
  t.after(() => workspace.close());
  const report = await workspace.query("diagnostics", path);
  assert.equal(report.result.kind, "full");
  assert.match(report.result.items[0].message, /const old/);
  await workspace.close();
  await writeFile(join(root, ".pi/lsp.json"), '{"servers":{"bad":{"command":"node","extensions":[],"args":"--stdio"}}}');
  await assert.rejects(LanguageWorkspace.create(root), /服务器配置无效：bad/);
});
