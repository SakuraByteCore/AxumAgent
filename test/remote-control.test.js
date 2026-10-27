import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { createTaskQueue } from "../plugin/pi-remote-control/queue.js";
import { startBridge } from "../plugin/pi-remote-control/server.js";
import remoteControl from "../plugin/pi-remote-control/index.js";
import { registerAxumBridge } from "../plugin/openclaw-axum/index.js";

const turn = () => new Promise(resolve => setImmediate(resolve));
const message = text => ({ role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text }], stopReason: "stop" });

test("remote queue preserves local work, deduplicates, serializes, and closes binding", async () => {
  let idle = false;
  const sent = [];
  const queue = createTaskQueue({ sessionId: "session", isIdle: () => idle, send: text => sent.push(text) });
  const input = { id: "one", task: "修改测试文件", binding: queue.status().binding };
  assert.equal(queue.submit(input).status, "queued");
  queue.submit(input);
  assert.equal(queue.status().queued, 1);
  assert.throws(() => queue.submit({ ...input, task: "different" }), /另一任务/);
  assert.throws(() => queue.submit({ ...input, binding: "old" }), /失效/);
  queue.submit({ ...input, id: "two" });
  queue.message(message("local reply"));
  idle = true; queue.settled(); await turn();
  assert.equal(sent.length, 1);
  assert.equal(queue.input("unrelated"), false);
  assert.equal(queue.input(sent[0]), true);
  queue.message(message("remote result")); queue.settled(); await turn();
  assert.equal(queue.get("one").result, "remote result");
  assert.equal(sent.length, 2);
  queue.close();
  assert.equal(queue.get("two").status, "failed");
  assert.throws(() => queue.submit({ ...input, id: "three" }), /失效/);
  const rebound = createTaskQueue({ sessionId: "session", isIdle: () => true, send() {} });
  assert.throws(() => rebound.submit(input), /失效/);
});

test("OpenClaw command authenticates and relays through real loopback HTTP", async (t) => {
  const token = randomBytes(32).toString("hex");
  const queue = createTaskQueue({ sessionId: "live", isIdle: () => true, send() {} });
  const bridge = await startBridge({ queue, port: 0, token });
  t.after(() => bridge.close());
  const commands = new Map(), services = [], replies = [];
  const api = {
    pluginConfig: { senderId: "owner", accountId: "wx" }, config: {},
    registerCommand: cmd => commands.set(cmd.name, cmd), registerService: service => services.push(service),
    runtime: { channel: { outbound: { loadAdapter: async () => ({ sendText: async value => replies.push(value) }) } } },
    logger: { error: error => assert.fail(error) },
  };
  registerAxumBridge(api, { AXUM_REMOTE_URL: `http://127.0.0.1:${bridge.port}`, AXUM_REMOTE_TOKEN: token });
  const ctx = { channel: "openclaw-weixin", senderId: "owner", accountId: "wx", isAuthorizedSender: true };
  const run = args => commands.get("axum").handler({ ...ctx, args });
  const unauthorized = await fetch(`http://127.0.0.1:${bridge.port}/status`);
  assert.equal(unauthorized.status, 401);
  assert.match((await commands.get("axum").handler({ ...ctx, senderId: "other", args: "bind" })).text, /未授权/);
  assert.match((await run("bind")).text, /live/);
  assert.match((await run("run stable-id 检查项目")).text, /running/);
  await run("run stable-id 检查项目");
  queue.message(message("完成")); queue.settled();
  t.mock.timers.enable({ apis: ["setInterval"] });
  services[0].start(); t.after(() => services[0].stop());
  t.mock.timers.tick(2000);
  for (let i = 0; i < 30 && replies.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(replies.length, 1);
  assert.equal(replies[0].to, "owner");
  assert.match(replies[0].text, /完成/);
  assert.doesNotMatch(replies[0].text, /private/);
  assert.match((await run("result stable-id")).text, /completed/);
  const stale = await fetch(`http://127.0.0.1:${bridge.port}/tasks/stable-id`, { headers: { Authorization: `Bearer ${token}`, "X-Axum-Binding": "old" } });
  assert.equal(stale.status, 409);
});

test("Pi bridge stays disabled until explicit command and installs lifecycle hooks", () => {
  const commands = new Map(), hooks = new Map();
  remoteControl({ registerCommand: (name, cmd) => commands.set(name, cmd), on: (name, fn) => hooks.set(name, fn) });
  assert.ok(commands.has("remote"));
  for (const name of ["input", "message_end", "agent_settled", "session_start", "session_shutdown"]) assert.ok(hooks.has(name));
  assert.deepEqual(hooks.get("input")({ text: "local" }, {}), { action: "continue" });
});
