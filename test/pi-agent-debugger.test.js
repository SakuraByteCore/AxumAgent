import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { registerDebuggerTools } from "../plugin/pi-agent/debugger.ts";

const SOURCE = [
  "globalThis.debugMarker = 7;",
  "function twice(value) {",
  "  const doubled = value * 2;",
  "  return doubled;",
  "}",
  "function work() {",
  "  let count = 20;",
  "  count += 2;",
  "  const answer = twice(count);",
  '  console.log("answer=" + answer);',
  "  return answer;",
  "}",
  "work();",
  "setInterval(() => {}, 1000);",
];
const lineOf = (text) => SOURCE.indexOf(text) + 1;

async function fixture(t, source = SOURCE.join("\n")) {
  const directory = await mkdtemp(join(tmpdir(), "pi-node-debugger-"));
  const root = join(await realpath(directory), "workspace");
  await mkdir(root);
  const path = join(root, "target.cjs");
  await writeFile(path, source);
  let tool, shutdown;
  registerDebuggerTools({
    registerTool(value) { tool = value; },
    on(event, handler) { assert.equal(event, "session_shutdown"); shutdown = handler; },
  });
  t.after(async () => { await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const query = async (params, signal) => (await tool.execute("test", params, signal, undefined, { cwd: root })).details;
  return { root, path, query, shutdown, tool };
}

async function waitFor(query, sessionId, predicate) {
  const deadline = Date.now() + 4000;
  let status;
  do {
    status = await query({ action: "status", sessionId });
    if (predicate(status)) return status;
    if (["error", "exited", "stopped"].includes(status.state)) assert.fail(JSON.stringify(status));
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail(`等待调试状态超时：${JSON.stringify(status)}`);
}

async function launchPaused(query, path, sessionId) {
  const launch = await query({ action: "launch", path, sessionId });
  assert.ok(["paused", "initializing"].includes(launch.state), JSON.stringify(launch));
  return launch.state === "paused" ? launch : waitFor(query, launch.sessionId, (status) => status.state === "paused");
}

function assertExited(pid) {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("Node Inspector 真实调试链", { timeout: 25000 }, async (t) => {
  await t.test("首行暂停、文件断点、局部值、三种步进和停止", async (t) => {
    const { query, path, tool } = await fixture(t);
    assert.equal(tool.name, "debugger");
    const first = await launchPaused(query, path, "main");
    assert.equal(first.callFrames[0].location.url, pathToFileURL(path).href);
    assert.equal(first.callFrames[0].location.line, lineOf(SOURCE[0]));
    assert.ok(first.scripts.some((script) => script.url === pathToFileURL(path).href));
    const call = (action, params = {}) => query({ action, sessionId: first.sessionId, ...params });
    const breakpoint = await call("set_breakpoint", { path, line: lineOf("  count += 2;") });
    assert.ok(breakpoint.result.breakpointId);
    assert.ok(breakpoint.result.locations.some((location) => location.line === lineOf("  count += 2;")));
    assert.equal((await call("continue")).result.resumed, true);
    await waitFor(query, first.sessionId, (status) => status.state === "paused");
    const stack = (await call("stack")).result.callFrames;
    assert.equal(stack[0].functionName, "work");
    assert.equal(stack[0].location.line, lineOf("  count += 2;"));
    const callFrameId = stack[0].callFrameId;
    const scopes = (await call("scopes", { callFrameId })).result.scopes;
    assert.equal(scopes.find((scope) => scope.type === "local").properties.find((property) => property.name === "count").value.value, 20);
    assert.equal((await call("evaluate", { callFrameId, expression: "count + 2" })).result.result.value, 22);
    assert.equal((await call("evaluate", { expression: "globalThis.debugMarker" })).result.result.value, 7);
    assert.ok((await call("evaluate", { callFrameId, expression: "missingDebuggerVariable" })).result.exceptionDetails);
    await call("remove_breakpoint", { breakpointId: breakpoint.result.breakpointId });
    await call("step_over");
    const next = await waitFor(query, first.sessionId, (status) => status.state === "paused");
    assert.equal(next.callFrames[0].location.line, lineOf("  const answer = twice(count);"));
    assert.equal((await call("evaluate", { callFrameId: next.callFrames[0].callFrameId, expression: "count" })).result.result.value, 22);
    await call("step_into");
    const inside = await waitFor(query, first.sessionId, (status) => status.state === "paused");
    assert.equal(inside.callFrames[0].functionName, "twice");
    await call("step_over");
    const returned = await waitFor(query, first.sessionId, (status) => status.state === "paused");
    assert.equal((await call("evaluate", { callFrameId: returned.callFrames[0].callFrameId, expression: "doubled" })).result.result.value, 44);
    await call("step_out");
    const outside = await waitFor(query, first.sessionId, (status) => status.state === "paused");
    assert.equal(outside.callFrames[0].functionName, "work");
    await call("continue");
    await waitFor(query, first.sessionId, (status) => status.state === "running" && status.stdout.includes("answer=44"));
    await call("pause");
    await waitFor(query, first.sessionId, (status) => status.state === "paused");
    assert.equal((await call("stop")).state, "stopped");
    assertExited(first.pid);
    assert.match((await call("status")).stdout, /answer=44/);
    await assert.rejects(call("continue"), /暂停/);
    assert.equal((await call("stop")).state, "stopped");
  });

  await t.test("多会话独立、shutdown 拒绝通信请求并回收进程", async (t) => {
    const { query, path, shutdown } = await fixture(t);
    const first = await launchPaused(query, path, "one");
    const second = await launchPaused(query, path, "two");
    assert.notEqual(first.pid, second.pid);
    await query({ action: "continue", sessionId: "one" });
    assert.equal((await query({ action: "status", sessionId: "two" })).state, "paused");
    const pending = query({ action: "evaluate", sessionId: "two", callFrameId: second.callFrames[0].callFrameId, expression: "(() => { while (true) {} })()" });
    const rejection = assert.rejects(pending, /停止|退出|断开|结束/);
    await delay(40);
    await shutdown();
    await rejection;
    assertExited(first.pid);
    assertExited(second.pid);
    await assert.rejects(query({ action: "status", sessionId: "one" }), /关闭/);
  });

  await t.test("自然退出、错误退出与输出缓存", async (t) => {
    const { query, path } = await fixture(t, 'console.log("x".repeat(40000));\nconsole.error("诊断信息");\n');
    const normal = await launchPaused(query, path, "normal");
    await query({ action: "continue", sessionId: "normal" });
    const finished = await waitFor(query, "normal", (status) => status.state === "exited");
    assert.equal(finished.exitCode, 0);
    assert.equal(finished.outputTruncated.stdout, true);
    assert.ok(finished.stdout.length <= 32768);
    assert.match(finished.stderr, /诊断信息/);
    assertExited(normal.pid);
    await writeFile(path, 'console.log("退出前输出");\nthrow new Error("真实脚本错误");\n');
    const failure = await launchPaused(query, path, "failure");
    await query({ action: "continue", sessionId: "failure" });
    const failed = await waitFor(query, "failure", (status) => status.state === "error" && status.exitCode !== null);
    assert.equal(failed.exitCode, 1);
    assert.match(failed.stdout, /退出前输出/);
    assert.match(failed.stderr, /真实脚本错误/);
    assertExited(failure.pid);
  });

  await t.test("真实路径边界和显式会话契约", async (t) => {
    const { root, path, query } = await fixture(t);
    const external = join(root, "..", "outside.cjs");
    await writeFile(external, "console.log('outside');");
    await symlink(external, join(root, "escape.cjs"));
    await assert.rejects(query({ action: "launch", path: external }), /工作区/);
    await assert.rejects(query({ action: "launch", path: "escape.cjs" }), /工作区/);
    await assert.rejects(query({ action: "continue", sessionId: "missing" }), /sessionId/);
    const session = await launchPaused(query, path, "same");
    await assert.rejects(query({ action: "launch", path, sessionId: "same" }), /已存在/);
    assert.equal((await query({ action: "status", sessionId: "same" })).pid, session.pid);
  });
});
