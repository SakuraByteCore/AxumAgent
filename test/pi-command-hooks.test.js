import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommandHooks, HOOK_EVENTS } from "../plugin/pi-companion/command-hooks.ts";
import { registerCommandHooks } from "../plugin/pi-companion/hooks.ts";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axum-hooks-"));
  const cwd = path.join(root, "project space"), agent = path.join(root, "agent");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true }); fs.mkdirSync(agent);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, PI_CODING_AGENT_DIR: agent };
  const request = { event: "PreToolUse", cwd, sessionId: "session-id", transcriptPath: "session.jsonl", trusted: true, env, fields: { tool_name: "bash", tool_input: { command: "echo hi" } } };
  const save = (value, scope = "project") => fs.writeFileSync(scope === "global" ? path.join(agent, "hooks.json") : path.join(cwd, ".pi", scope === "local" ? "hooks.local.json" : "hooks.json"), JSON.stringify(value));
  let counter = 0;
  const command = (body) => {
    const file = path.join(cwd, `hook-${counter++}.cjs`);
    fs.writeFileSync(file, `let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const input=JSON.parse(raw);${body}});`);
    return `"${process.execPath}" "${file}"`;
  };
  const hook = (event, body, options = {}) => ({ hooks: { [event]: [{ matcher: options.matcher, hooks: [{ type: "command", command: command(body), timeout: options.timeout ?? 2 }] }] } });
  return { cwd, agent, env, request, save, command, hook };
}

test("no hooks is a no-op; untrusted project hooks do not run", async (t) => {
  const f = fixture(t);
  assert.equal((await runCommandHooks(f.request)).blocked, false);
  f.save(f.hook("PreToolUse", "process.stderr.write('blocked');process.exit(2);"));
  assert.equal((await runCommandHooks({ ...f.request, trusted: false })).blocked, false);
  const result = await runCommandHooks(f.request);
  assert.equal(result.blocked, true); assert.equal(result.reason, "blocked");
});

test("global, project, local hooks merge in order with hot reload and disable", async (t) => {
  const f = fixture(t);
  for (const scope of ["global", "project", "local"]) f.save(f.hook("UserPromptSubmit", `console.log('${scope}');`), scope);
  const request = { ...f.request, event: "UserPromptSubmit" };
  assert.deepEqual((await runCommandHooks(request)).context, ["global", "project", "local"]);
  assert.deepEqual((await runCommandHooks({ ...request, trusted: false })).context, ["global"]);
  f.save({ disableAllHooks: true }, "local");
  assert.deepEqual((await runCommandHooks(request)).context, []);
  f.save({ disableAllHooks: true }, "global");
  fs.writeFileSync(path.join(f.cwd, ".pi", "hooks.json"), "invalid JSON");
  assert.deepEqual((await runCommandHooks(request)).warnings, []);
});

test("JSON stdin, environment and regex Claude aliases preserve actual tool names", async (t) => {
  const f = fixture(t);
  f.save(f.hook("PreToolUse", "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:input.hook_event_name,additionalContext:JSON.stringify({input,cwd:process.cwd(),project:process.env.CLAUDE_PROJECT_DIR,id:process.env.AXUM_SESSION_ID})}}));", { matcher: "^Bash$" }));
  const result = await runCommandHooks(f.request);
  const data = JSON.parse(result.context[0]);
  assert.equal(data.input.tool_name, "bash"); assert.equal(data.input.tool_input.command, "echo hi");
  assert.equal(data.input.session_id, "session-id"); assert.equal(data.input.transcript_path, "session.jsonl");
  assert.equal(data.cwd, f.cwd); assert.equal(data.project, f.cwd); assert.equal(data.id, "session-id");
  assert.deepEqual((await runCommandHooks({ ...f.request, fields: { tool_name: "read" } })).context, []);
});

test("deny wins over allow, updatedInput is parsed, ask cannot bypass permissions", async (t) => {
  const f = fixture(t);
  const config = { hooks: { PreToolUse: [{ hooks: [
    { type: "command", command: f.command("console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'no'}}));") },
    { type: "command", command: f.command("console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command:'safe'}}}));") },
  ] }] } };
  f.save(config);
  const result = await runCommandHooks(f.request);
  assert.equal(result.blocked, true); assert.equal(result.reason, "no"); assert.deepEqual(result.updatedInput, { command: "safe" });
  f.save(f.hook("PreToolUse", "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'ask'}}));"));
  assert.equal((await runCommandHooks(f.request)).blocked, true);
});

test("invalid configuration, JSON and command errors fail closed only before actions", async (t) => {
  const f = fixture(t);
  for (const config of [{ hooks: { Unknown: [] } }, { hooks: { PreToolUse: [{ matcher: "[", hooks: [] }] } }, { hooks: { PreToolUse: [{ hooks: [{ type: "prompt", command: "x" }] }] } }, { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "x", timeout: 61 }] }] } }]) {
    f.save(config); const result = await runCommandHooks(f.request);
    assert.equal(result.blocked, true); assert.ok(result.warnings.length);
  }
  for (const body of ["console.log('{broken');", "process.stderr.write('failure');process.exit(1);", "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'Stop'}}));"]) {
    f.save(f.hook("PreToolUse", body)); assert.equal((await runCommandHooks(f.request)).blocked, true);
    f.save(f.hook("PostToolUse", body)); const post = await runCommandHooks({ ...f.request, event: "PostToolUse" });
    assert.equal(post.blocked, false); assert.ok(post.warnings.length);
  }
});

test("timeout, output limit and abort terminate hook execution", async (t) => {
  const f = fixture(t);
  f.save(f.hook("PreToolUse", "setInterval(()=>{},1000);", { timeout: 0.1 }));
  let result = await runCommandHooks(f.request);
  assert.equal(result.blocked, true); assert.match(result.reason, /timed out/);
  f.save(f.hook("PreToolUse", "process.stdout.write('x'.repeat(300000));"));
  result = await runCommandHooks(f.request);
  assert.equal(result.blocked, true); assert.match(result.reason, /256 KiB/);
  const controller = new AbortController(); controller.abort();
  assert.match((await runCommandHooks({ ...f.request, signal: controller.signal })).reason, /aborted/);
  f.save(f.hook("PreToolUse", "setInterval(()=>{},1000);"));
  const live = new AbortController();
  const pending = runCommandHooks({ ...f.request, signal: live.signal });
  setTimeout(() => live.abort(), 300);
  assert.match((await pending).reason, /aborted/);
});

test("timeout kills descendant processes before returning", async (t) => {
  const f = fixture(t);
  f.save(f.hook("PreToolUse", "const fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e', 'setInterval(()=>{},1000)'],{stdio:'inherit'});fs.writeFileSync('descendant.pid',String(child.pid));setInterval(()=>{},1000);", { timeout: 0.7 }));
  const result = await runCommandHooks(f.request);
  assert.match(result.reason, /timed out/);
  const pid = Number(fs.readFileSync(path.join(f.cwd, "descendant.pid"), "utf8"));
  let alive = true;
  try { process.kill(pid, 0); } catch (error) { if (error.code !== "ESRCH") throw error; alive = false; }
  assert.equal(alive, false, "the descendant must not outlive the hook");
});

function adapter(f) {
  const listeners = new Map(), notifications = [];
  registerCommandHooks({ getAllTools: () => [{ name: "bash", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }], on(name, handler) { listeners.set(name, handler); } });
  const ctx = { cwd: f.cwd, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "s", getSessionFile: () => "s.jsonl" }, ui: { notify: (...args) => notifications.push(args) } };
  return { emit: (name, event) => listeners.get(name)(event, ctx), notifications };
}

test("adapter maps all nine events; input block, context and tool result preservation", async (t) => {
  const f = fixture(t), old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.agent;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; });
  f.save({ hooks: Object.fromEntries(HOOK_EVENTS.map(event => [event, [{ hooks: [{ type: "command", command: f.command("console.log(JSON.stringify({hookSpecificOutput:{hookEventName:input.hook_event_name,additionalContext:input.hook_event_name}}));") }] }]])) });
  const a = adapter(f);
  await a.emit("session_start", { reason: "startup" }); await a.emit("input", { text: "hi", source: "interactive" });
  assert.equal(a.emit("before_agent_start", {}).message.content, "SessionStart\n\nUserPromptSubmit");
  const call = { toolName: "bash", input: { command: "old" }, toolCallId: "t" };
  await a.emit("tool_call", call);
  const content = [{ type: "text", text: "original" }];
  const post = await a.emit("tool_result", { ...call, content, isError: false, structuredContent: { ok: true } });
  assert.deepEqual(post.content[0], content[0]); assert.equal(post.content[1].text, "PreToolUse\n\nPostToolUse"); assert.deepEqual(post.structuredContent, { ok: true });
  const failed = await a.emit("tool_result", { ...call, content, isError: true }); assert.equal(failed.content[1].text, "PostToolUseFailure");
  await a.emit("session_before_compact", { reason: "manual" }); await a.emit("session_compact", { reason: "manual" }); await a.emit("session_shutdown", { reason: "quit" });
  f.save(f.hook("UserPromptSubmit", "process.exit(2);"));
  assert.deepEqual(await a.emit("input", { text: "hi", source: "interactive" }), { action: "handled" });
  f.save(f.hook("PreToolUse", "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:{command:'new'}}}));"));
  await a.emit("tool_call", call); assert.deepEqual(call.input, { command: "new" });
  f.save(f.hook("PreToolUse", "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:{unexpected:true}}}));"));
  await assert.rejects(a.emit("tool_call", call), /validation|Expected/i);
  f.save(f.hook("PreCompact", "process.exit(2);")); assert.deepEqual(await a.emit("session_before_compact", { reason: "threshold" }), { cancel: true });
});

test("Stop requests one continuation, skips error/abort and never loops forever", async (t) => {
  const f = fixture(t), old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.agent;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; });
  f.save(f.hook("Stop", "process.stderr.write(input.stop_hook_active?'again':'run tests');process.exit(2);"));
  const a = adapter(f), event = { outcome: "completed", continue: false, context: { canContinue: false, llmMessages: [] } };
  assert.equal((await a.emit("agent_before_settle", event)).continue, true);
  assert.equal(await a.emit("agent_before_settle", event), undefined); assert.ok(a.notifications.length);
  for (const outcome of ["error", "aborted"]) assert.equal(await a.emit("agent_before_settle", { ...event, outcome }), undefined);
  await a.emit("input", { text: "new", source: "interactive" });
  assert.equal((await a.emit("agent_before_settle", event)).entries[0].content, "run tests");
});
