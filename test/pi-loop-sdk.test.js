import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { getBundledPiNodeModules } from "../src/bundled-pi-cache.js";
import { compileExtensionPackage } from "../src/compile-bundled-extensions.js";

// The extension, compiled imports, SDK, tools, journal and scheduler are real.
// Scripted responses verify the model/tool contract without a network model.
test("compiled /loop runs through real SDK commands, scheduled turns and wakeup tools", { timeout: 20000 }, async t => {
  const modules = getBundledPiNodeModules();
  const sdk = await import(pathToFileURL(path.join(modules, "@earendil-works/pi-coding-agent/dist/index.js")).href);
  const ai = await import(pathToFileURL(path.join(modules, "@earendil-works/pi-ai/dist/index.js")).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axum-loop-sdk-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "companion"); fs.mkdirSync(packageRoot);
  fs.symlinkSync(modules, path.join(root, "node_modules"), "junction");
  const manifest = JSON.parse(fs.readFileSync("plugin/pi-companion/package.json", "utf8"));
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify(manifest));
  for (const file of ["loop.ts", "loop-cron.ts", "loop-scheduler.ts"]) {
    assert.ok(manifest.files.includes(file), `${file} must ship in companion package`);
    fs.copyFileSync(path.join("plugin/pi-companion", file), path.join(packageRoot, file));
  }
  compileExtensionPackage({ packageRoot });
  assert.match(fs.readFileSync(path.join(packageRoot, "loop.js"), "utf8"), /from "\.\/loop-scheduler\.js"/);
  const { registerLoop } = await import(pathToFileURL(path.join(packageRoot, "loop.js")).href);
  const { LOOP_ENTRY } = await import(pathToFileURL(path.join(packageRoot, "loop-scheduler.js")).href);
  let now = new Date(2026, 0, 5, 9, 1).getTime();
  t.mock.timers.enable({ apis: ["setInterval"] });
  const runtime = await sdk.ModelRuntime.create({ modelsPath: null, authPath: path.join(root, "auth.json"), refreshOnCreate: false });
  runtime.registerProvider("loop-fixture", { api: "openai-completions", apiKey: "offline-fixture", baseUrl: "http://invalid.local",
    models: [{ id: "fixed", name: "fixed", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] });
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [pi => registerLoop(pi, { now: () => now, random: () => 0 })] });
  await loader.reload();
  const sessionDir = path.join(root, "sessions");
  const manager = sdk.SessionManager.create(root, sessionDir);
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model: runtime.getModel("loop-fixture", "fixed"), settingsManager: settings, sessionManager: manager, resourceLoader: loader });
  t.after(() => session.dispose());
  const errors = []; await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
  let dynamicTurns = 0;
  session.agent.streamFunction = async (model, context) => {
    const lastUser = context.messages.findLastIndex(message => message.role === "user");
    const prompt = context.messages[lastUser].content.map(part => part.text ?? "").join("");
    const called = context.messages.slice(lastUser + 1).some(message => message.role === "toolResult");
    let content = [{ type: "text", text: "checked" }];
    if (prompt.includes("ScheduleWakeup") && !called) {
      dynamicTurns++;
      assert.match(prompt, /^检查 CI\n\n/);
      if (dynamicTurns === 1 || dynamicTurns === 4) {
        content = [{ type: "toolCall", id: `wakeup-${dynamicTurns}`, name: "ScheduleWakeup", arguments: dynamicTurns === 1 ? { delaySeconds: 60, reason: "等待下一轮 CI" } : { stop: true } }];
      }
    }
    const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
      stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const output = new ai.AssistantMessageEventStream(); output.push({ type: "done", reason: message.stopReason, message }); output.end(message); return output;
  };
  const tick = async advance => {
    now += advance; t.mock.timers.tick(1000);
    await new Promise(resolve => setImmediate(resolve)); await session.waitForIdle();
  };
  const latest = () => manager.getEntries().findLast(entry => entry.type === "custom" && entry.customType === LOOP_ENTRY).data;
  await session.prompt("/loop 1m /clear"); assert.equal(session.agent.state.messages.length, 0);
  assert.equal(latest().tasks.length, 1); await tick(60000);
  assert.equal(session.agent.state.messages.find(message => message.role === "user").content[0].text, "/clear", "scheduled slash text must reach the model, not run /clear");
  assert.ok(session.agent.state.messages.some(message => message.role === "assistant"));
  await session.prompt("/loop cancel all"); assert.equal(latest().tasks.length, 0);
  await session.prompt("/loop 检查 CI");
  await new Promise(resolve => setImmediate(resolve)); await session.waitForIdle();
  assert.equal(dynamicTurns, 1, "the first dynamic round starts without ticking the interval");
  const first = session.agent.state.messages.find(message => message.role === "toolResult" && message.toolName === "ScheduleWakeup");
  assert.ok(first && !first.isError, JSON.stringify(session.agent.state.messages)); assert.match(first.content[0].text, /动态单次/);
  await tick(59999); assert.equal(dynamicTurns, 1, "explicit wakeup cannot run early");
  await tick(1);
  for (let i = 0; i < 4 && dynamicTurns < 4; i++) {
    await new Promise(resolve => setImmediate(resolve)); await session.waitForIdle();
  }
  assert.equal(dynamicTurns, 4, "two omitted delays must immediately rerun the prompt without advancing timers");
  const results = session.agent.state.messages.filter(message => message.role === "toolResult" && message.toolName === "ScheduleWakeup");
  assert.equal(results.length, 2); assert.equal(results[1].isError, false); assert.match(results[1].content[0].text, /停止/);
  await tick(3600000); assert.equal(dynamicTurns, 4, "stop prevents further real model turns");
  assert.deepEqual(errors, []);
  await session.prompt("/loop 1m disposed");
  const stopped = []; t.mock.method(console, "error", message => stopped.push(message));
  const count = session.agent.state.messages.length; session.dispose();
  now += 60000; t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.agent.state.messages.length, count); assert.equal(stopped.length, 1);
  assert.match(stopped[0], /ctx is stale/);
  t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped.length, 1, "disposed SDK timer stops after one diagnostic");
  const sessionFile = manager.getSessionFile(); assert.ok(fs.existsSync(sessionFile), "real session journal must exist on disk");
  const restoredManager = sdk.SessionManager.open(sessionFile, sessionDir);
  const resumedLoader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [pi => registerLoop(pi, { now: () => now, random: () => 0 })] });
  await resumedLoader.reload();
  const { session: resumed } = await sdk.createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model: runtime.getModel("loop-fixture", "fixed"), settingsManager: settings, sessionManager: restoredManager, resourceLoader: resumedLoader, sessionStartEvent: { type: "session_start", reason: "resume" } });
  t.after(() => resumed.dispose());
  await resumed.bindExtensions({ mode: "print", onError: error => errors.push(error) });
  const restored = restoredManager.getEntries().findLast(entry => entry.type === "custom" && entry.customType === LOOP_ENTRY).data.tasks;
  assert.equal(restored.length, 1); assert.equal(restored[0].prompt, "disposed"); assert.ok(restored[0].nextRun > now);
  resumed.agent.streamFunction = session.agent.streamFunction;
  now += 60000; t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve)); await resumed.waitForIdle();
  assert.equal(resumed.agent.state.messages.filter(message => message.role === "user").at(-1).content[0].text, "disposed", "restored fixed task fires through a new real SDK session");
  assert.deepEqual(errors, []); await resumed.prompt("/loop cancel all");
});
