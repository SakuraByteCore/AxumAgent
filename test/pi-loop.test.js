import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cronFireTime, FIVE_MINUTE_CADENCE, LOOP_TTL, nextCronTime, parseCron, parseLoopArguments } from "../plugin/pi-companion/loop-cron.ts";
import { isLoopSnapshot, LOOP_ENTRY, LoopScheduler } from "../plugin/pi-companion/loop-scheduler.ts";
import { MAINTENANCE_PROMPT, readLoopPrompt, registerLoop } from "../plugin/pi-companion/loop.ts";

const MINUTE = 60_000;
const start = new Date(2026, 0, 5, 9, 1).getTime();
function schedulerFixture() {
  let now = start, serial = 0;
  const scheduler = new LoopScheduler({ now: () => now, random: () => 0.5, id: () => (++serial).toString(16).padStart(8, "0") });
  return { scheduler, advance(value) { now = value; }, now: () => now };
}
function harness(t) {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: start });
  const commands = new Map(), tools = new Map(), handlers = new Map(), messages = [], notifications = [], entries = [];
  let keyHandler, serial = 0;
  const ctx = {
    cwd: os.tmpdir(), hasUI: true, idle: true, pending: false, editor: "", session: "first",
    isIdle() { return this.idle; }, hasPendingMessages() { return this.pending; },
    ui: { notify(text, level) { notifications.push({ text, level }); }, setStatus() {}, getEditorText() { return ctx.editor; },
      onTerminalInput(handler) { keyHandler = handler; return () => { keyHandler = undefined; }; } },
    sessionManager: { getSessionId() { return ctx.session; }, getEntries() { return entries; } },
  };
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    registerTool(definition) { tools.set(definition.name, definition); },
    on(event, handler) { handlers.set(event, handler); },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data: structuredClone(data) }); },
    sendUserMessage(text, options) { messages.push({ text, options }); ctx.idle = false; },
  };
  registerLoop(pi, { id: () => (++serial).toString(16).padStart(8, "0"), random: () => 0 });
  const emit = async (name, event = {}) => handlers.get(name)?.(event, ctx);
  t.after(() => emit("session_shutdown"));
  const tool = async (name, params = {}) => tools.get(name).execute("call", params, undefined, undefined, ctx);
  const command = text => commands.get("loop").handler(text, ctx);
  const tick = async (duration = 1000) => { t.mock.timers.tick(duration); await Promise.resolve(); await Promise.resolve(); };
  return { ctx, messages, notifications, entries, tools, commands, emit, tool, command, tick, key: data => keyHandler?.(data) };
}

test("loop argument routing preserves prompts and rounds cron-incompatible intervals", () => {
  for (const [input, schedule, minutes] of [["30s 检查", "*/1 * * * *", 1], ["5m /review-pr 123", "*/5 * * * *", 5], ["7m 检查", "*/6 * * * *", 6], ["90m 检查", "0 */2 * * *", 120], ["2h", "0 */2 * * *", 120], ["1d 检查", "0 0 * * *", 1440], ["检查 every 2 hours", "0 */2 * * *", 120]]) {
    const parsed = parseLoopArguments(input);
    assert.equal(parsed.schedule, schedule); assert.equal(parsed.actualMinutes, minutes);
  }
  assert.equal(parseLoopArguments("5m /review-pr 123").prompt, "/review-pr 123");
  assert.deepEqual(parseLoopArguments("检查部署"), { prompt: "检查部署" });
  assert.deepEqual(parseLoopArguments(""), { prompt: "" });
  for (const invalid of ["0m x", "-2m x", "5w x"]) assert.throws(() => parseLoopArguments(invalid));
});

test("cron implements local time, ranges, steps, lists, Sunday aliases and Vixie day OR", () => {
  assert.equal(new Date(nextCronTime("3 9 * * *", start)).getHours(), 9);
  assert.equal(new Date(nextCronTime("3 9 * * *", start)).getMinutes(), 3);
  assert.equal(new Date(nextCronTime("0 9 * * 1-5", start)).getDay(), 2);
  assert.equal(new Date(nextCronTime("0 9 15 * 1", start)).getDate(), 12, "Monday matches before the 15th");
  assert.equal(new Date(nextCronTime("0 9 * * 7", start)).getDay(), 0);
  assert.deepEqual([...parseCron("1,10-14/2 * * * *")[0].values], [1, 10, 12, 14]);
  assert.equal(new Date(nextCronTime("0 0 29 2 *", start)).getFullYear(), 2028);
  for (const invalid of ["* * * *", "60 * * * *", "*/0 * * * *", "* 24 * * *", "* * * * MON", "0 0 L * *", "* * ? * *", "3-1 * * * *", "1,,2 * * * *"]) assert.throws(() => parseCron(invalid), invalid);
  assert.throws(() => nextCronTime("0 0 30 2 *", start), /八年/);
});

test("jitter matches recurring delay bounds, stable equal gaps, five-minute special and one-shot advance", () => {
  const hourly = { schedule: "0 * * * *", after: start, recurring: true, jitter: 0.5 };
  const nominal = nextCronTime(hourly.schedule, start);
  assert.equal(cronFireTime(hourly) - nominal, 15 * MINUTE);
  const second = { ...hourly, after: nominal + 15 * MINUTE };
  assert.equal(cronFireTime(second) - nextCronTime(second.schedule, second.after), 15 * MINUTE);
  assert.equal(cronFireTime({ ...hourly, schedule: "*/10 * * * *" }) - nextCronTime("*/10 * * * *", start), 2.5 * MINUTE);
  assert.equal(cronFireTime({ ...hourly, schedule: "*/5 * * * *" }), start + FIVE_MINUTE_CADENCE);
  assert.equal(cronFireTime({ ...hourly, recurring: false }), nominal - 45_000);
  assert.equal(cronFireTime({ ...hourly, schedule: "3 9 * * *", recurring: false }), nextCronTime("3 9 * * *", start));
});

test("scheduler coalesces missed intervals and deletes one-shot and final expired fire", () => {
  const { scheduler: s, advance } = schedulerFixture();
  const task = s.create({ prompt: "check", schedule: "*/5 * * * *" });
  assert.match(task.id, /^[a-f0-9]{8}$/); assert.equal(s.due(), undefined);
  advance(start + 50 * MINUTE); assert.equal(s.due().id, task.id);
  s.begin(task.id); assert.equal(s.due(), undefined); s.settle(); assert.equal(s.due(), undefined);
  assert.equal(s.list()[0].nextRun, start + 50 * MINUTE + FIVE_MINUTE_CADENCE);
  advance(start + LOOP_TTL); s.begin(task.id); s.settle(); assert.equal(s.list().length, 0);
  const one = s.create({ prompt: "remind", schedule: "3 9 * * *", recurring: false });
  advance(one.nextRun); s.begin(one.id); assert.equal(s.list().length, 0); s.settle();
});

test("dynamic loops rearm, report delay, stop, retain seven-day origin and get only one fallback", () => {
  const { scheduler: s, advance } = schedulerFixture();
  const task = s.create({ prompt: "watch" }); s.begin(task.id);
  for (const delaySeconds of [0, 59, 3601, 60.5]) assert.throws(() => s.wakeup({ delaySeconds, reason: "waiting" }));
  assert.throws(() => s.wakeup({ delaySeconds: 60, reason: " " }));
  const next = s.wakeup({ delaySeconds: 120, reason: "CI active" });
  assert.equal(next.createdAt, task.createdAt); assert.equal(next.recurring, false); s.settle();
  advance(next.nextRun); s.begin(task.id); s.settle();
  assert.equal(s.list()[0].fallbackUsed, true);
  advance(s.list()[0].nextRun); s.begin(task.id); s.settle(); assert.equal(s.list().length, 0);
  const final = s.create({ prompt: "watch" }); s.begin(final.id);
  s.wakeup({ delaySeconds: 60, reason: "wait" }); s.settle(); advance(final.createdAt + LOOP_TTL);
  s.begin(final.id); assert.equal(s.wakeup({ delaySeconds: 60, reason: "wait" }), undefined); s.settle();
  assert.equal(s.list().length, 0);
  const stopped = s.create({ prompt: "watch" }); s.begin(stopped.id); s.wakeup({ stop: true }); s.settle();
  assert.equal(s.list().length, 0);
});

test("capacity, cancellation during a turn, failed delivery and snapshot boundaries", () => {
  const { scheduler: s, advance } = schedulerFixture();
  for (const schedule of ["", "   "]) assert.throws(() => s.create({ prompt: "invalid", schedule }));
  for (let i = 0; i < 50; i++) s.create({ prompt: "x", schedule: "0 * * * *" });
  assert.throws(() => s.create({ prompt: "overflow" }), /50/);
  const saved = s.snapshot("/project"); assert.ok(isLoopSnapshot(saved));
  assert.equal(isLoopSnapshot({ ...saved, tasks: [{ ...saved.tasks[0], jitter: NaN }] }), false);
  s.clear(); s.restore(saved, "/elsewhere"); assert.equal(s.list().length, 0);
  advance(start + 10 * MINUTE); s.restore(saved, "/project"); assert.equal(s.list().length, 50);
  assert.ok(s.list().every(task => task.nextRun > start + 10 * MINUTE));
  advance(start + LOOP_TTL); s.restore(saved, "/project"); assert.equal(s.list().length, 0);
  const task = s.create({ prompt: "x" }); s.begin(task.id); s.delete(task.id); s.settle(); assert.equal(s.list().length, 0);
  const failed = s.create({ prompt: "retry" }); s.begin(failed.id); s.failed(failed.id); assert.equal(s.busy, false);
  assert.equal(s.list()[0].nextRun, s.now() + MINUTE);
  advance(s.list()[0].nextRun); s.begin(failed.id); s.delete(failed.id); s.failed(failed.id); assert.equal(s.list().length, 0, "delivery failure must not revive a cancelled task");
});

test("resume restores only live fixed tasks and future one-shot reminders", () => {
  const { scheduler: s, advance } = schedulerFixture();
  s.create({ prompt: "dynamic" }); s.create({ prompt: "fixed", schedule: "*/5 * * * *" });
  const reminder = s.create({ prompt: "reminder", schedule: "3 9 * * *", recurring: false });
  const saved = s.snapshot("/project"); assert.equal(saved.tasks.length, 2);
  advance(reminder.nextRun + MINUTE); s.restore(saved, "/project");
  assert.deepEqual(s.list().map(x => x.prompt), ["fixed"]);
  assert.ok(s.list()[0].nextRun > s.now(), "do not catch up after resume");
});

test("default prompt honors project/user precedence, live edits, byte cap and read errors", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-prompts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project"), home = path.join(root, "home");
  for (const directory of [path.join(cwd, ".pi"), path.join(cwd, ".claude"), path.join(home, ".claude"), path.join(home, ".pi", "agent")]) fs.mkdirSync(directory, { recursive: true });
  assert.equal(await readLoopPrompt(cwd, home), MAINTENANCE_PROMPT);
  fs.writeFileSync(path.join(home, ".claude", "loop.md"), "user claude"); assert.equal(await readLoopPrompt(cwd, home), "user claude");
  fs.writeFileSync(path.join(home, ".pi", "agent", "loop.md"), "user pi"); assert.equal(await readLoopPrompt(cwd, home), "user pi");
  fs.writeFileSync(path.join(cwd, ".claude", "loop.md"), "project claude"); assert.equal(await readLoopPrompt(cwd, home), "project claude");
  fs.writeFileSync(path.join(cwd, ".pi", "loop.md"), "project pi"); assert.equal(await readLoopPrompt(cwd, home), "project pi");
  fs.writeFileSync(path.join(cwd, ".pi", "loop.md"), "中".repeat(10000));
  const capped = await readLoopPrompt(cwd, home); assert.ok(Buffer.byteLength(capped) <= 25000); assert.ok(!capped.includes("�"));
  fs.unlinkSync(path.join(cwd, ".pi", "loop.md")); fs.mkdirSync(path.join(cwd, ".pi", "loop.md"));
  await assert.rejects(readLoopPrompt(cwd, home));
});

test("registered command defers fixed jobs, honors busy/user queues and never expands slash commands", async t => {
  const h = harness(t); await h.emit("session_start", { reason: "startup" });
  assert.deepEqual([...h.tools.keys()], ["CronCreate", "CronList", "CronDelete", "ScheduleWakeup"]);
  await h.command("5m /clear"); assert.equal(h.messages.length, 0);
  h.ctx.idle = false; await h.tick(30 * MINUTE); assert.equal(h.messages.length, 0);
  h.ctx.idle = true; h.ctx.pending = true; await h.tick(); assert.equal(h.messages.length, 0);
  h.ctx.pending = false; await h.tick(); assert.equal(h.messages.length, 1);
  assert.deepEqual(h.messages[0], { text: "/clear", options: { deliverAs: "followUp", expandPromptTemplates: false } });
  h.ctx.idle = true; await h.emit("agent_settled"); await h.tick(); assert.equal(h.messages.length, 1, "no backlog burst");
  const listing = await h.tool("CronList"); assert.match(listing.content[0].text, /00000001/);
  await h.tool("CronDelete", { id: "00000001" }); await h.tick(60 * MINUTE); assert.equal(h.messages.length, 1);
});

test("dynamic command starts on idle tick, rearm tools work and Esc cancels only waiting dynamic loops", async t => {
  const h = harness(t); await h.emit("session_start", { reason: "startup" });
  await h.command("检查部署"); await h.tick(); assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].text, /ScheduleWakeup/);
  await h.tool("ScheduleWakeup", { delaySeconds: 120, reason: "CI active" });
  h.ctx.idle = true; await h.emit("agent_settled");
  await h.command("5m fixed");
  h.ctx.editor = "typing"; assert.equal(h.key("\u001b"), undefined);
  h.ctx.editor = ""; assert.deepEqual(h.key("\u001b"), { consume: true });
  const listing = await h.tool("CronList"); assert.match(listing.content[0].text, /fixed/); assert.doesNotMatch(listing.content[0].text, /动态单次/);
  await h.command("cancel all"); assert.match((await h.tool("CronList")).content[0].text, /没有/);
});

test("session switches and shutdown clear timers; resume loads own snapshot and forks do not inherit", async t => {
  const h = harness(t); await h.emit("session_start", { reason: "startup" }); await h.command("5m fixed");
  const snapshot = h.entries.findLast(e => e.customType === LOOP_ENTRY);
  h.ctx.session = "second"; h.entries.length = 0; await h.emit("session_start", { reason: "new" });
  await h.tick(10 * MINUTE); assert.equal(h.messages.length, 0);
  h.ctx.session = "first"; h.entries.push(snapshot); await h.emit("session_start", { reason: "resume" });
  assert.match((await h.tool("CronList")).content[0].text, /fixed/);
  await h.tick(FIVE_MINUTE_CADENCE); assert.equal(h.messages.length, 1);
  h.ctx.idle = true; h.ctx.session = "fork"; h.entries.push(snapshot); await h.emit("session_start", { reason: "fork" });
  assert.match((await h.tool("CronList")).content[0].text, /没有/);
  await h.command("pending dynamic"); await h.emit("session_shutdown"); await h.tick(10 * MINUTE); assert.equal(h.messages.length, 1);
});

test("disable flags stop dispatch and creation while keeping list/delete available", async t => {
  const h = harness(t); await h.emit("session_start", { reason: "startup" }); await h.command("5m fixed");
  const previous = process.env.AXUM_DISABLE_CRON; process.env.AXUM_DISABLE_CRON = "1";
  t.after(() => { if (previous === undefined) delete process.env.AXUM_DISABLE_CRON; else process.env.AXUM_DISABLE_CRON = previous; });
  await h.tick(10 * MINUTE); assert.equal(h.messages.length, 0);
  await assert.rejects(h.tool("CronCreate", { cron: "* * * * *", prompt: "blocked" }), /关闭/);
  assert.match((await h.tool("CronList")).content[0].text, /fixed/);
  await h.tool("CronDelete", { id: "00000001" }); assert.match((await h.tool("CronList")).content[0].text, /没有/);
});


test("Cron tools create one-shot reminders and cancel active loops without interrupting the turn", async t => {
  const h = harness(t); await h.emit("session_start", { reason: "startup" });
  const created = await h.tool("CronCreate", { cron: "2 9 * * *", prompt: "remind", recurring: false });
  assert.match(created.content[0].text, /单次/);
  await h.tick(MINUTE); assert.equal(h.messages.length, 1);
  assert.match((await h.tool("CronList")).content[0].text, /没有/);
  h.ctx.idle = true; await h.emit("agent_settled");
  await h.command("dynamic"); await h.tick();
  const listing = await h.tool("CronList"); assert.match(listing.content[0].text, /本轮执行中/);
  await h.tool("CronDelete", { id: "00000002" });
  assert.equal(h.ctx.idle, false, "cancellation does not abort the active model turn");
  h.ctx.idle = true; await h.emit("agent_settled"); await h.tick(30 * MINUTE);
  assert.equal(h.messages.length, 2, "settlement cannot recreate a cancelled dynamic loop");
});

test("prompt read failure backs off instead of firing every idle tick", { timeout: 2000 }, async t => {
  const h = harness(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-read-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".pi", "loop.md"), { recursive: true }); h.ctx.cwd = root;
  const notify = h.ctx.ui.notify;
  const failed = new Promise(resolve => { h.ctx.ui.notify = (text, level) => { notify(text, level); if (level === "error") resolve(); }; });
  await h.emit("session_start", { reason: "startup" }); await h.command("");
  await h.tick(); await failed;
  const errors = () => h.notifications.filter(x => x.level === "error");
  assert.equal(errors().length, 1); await h.tick(30000); assert.equal(errors().length, 1);
  await h.command("cancel all");
});

test("dynamic delay stays within the one-minute/one-hour bounds outside expiry", () => {
  const { scheduler: s, advance } = schedulerFixture();
  advance(start + 1234); const task = s.create({ prompt: "watch" }); s.begin(task.id);
  assert.equal(s.wakeup({ delaySeconds: 3600, reason: "wait" }).nextRun - s.now(), 3600000);
  assert.ok(s.wakeup({ delaySeconds: 60, reason: "wait" }).nextRun - s.now() >= MINUTE);
});


test("sparse recurring schedules still get one final idle fire at seven-day expiry", () => {
  const { scheduler: s, advance } = schedulerFixture();
  const task = s.create({ prompt: "yearly", schedule: "0 0 1 1 *" });
  assert.equal(task.nextRun, start + LOOP_TTL);
  advance(start + LOOP_TTL); assert.equal(s.due().id, task.id);
  s.begin(task.id); s.settle(); assert.equal(s.list().length, 0);
});
