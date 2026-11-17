import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { getBundledPiNodeModules } from "../src/bundled-pi-cache.js";

import { patchPiSystemPromptRefresh } from "../src/bundled-pi-patches.js";
import { installAxumSystemPromptRefresh } from "../src/pi-system-prompt-refresh.js";

function createSession(root, { trusted = true } = {}) {
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });

  const loader = {
    cwd,
    agentDir,
    systemPromptSource: undefined,
    appendSystemPromptSource: undefined,
    systemPromptOverride: undefined,
    appendSystemPromptOverride: undefined,
    systemPrompt: undefined,
    systemPromptSourcePath: undefined,
    appendSystemPrompt: [],
    appendSystemPromptSourcePaths: [],
    discoverSystemPromptFile() {
      const projectPath = path.join(cwd, ".pi", "SYSTEM.md");
      if (trusted && fs.existsSync(projectPath)) return projectPath;
      const globalPath = path.join(agentDir, "SYSTEM.md");
      return fs.existsSync(globalPath) ? globalPath : undefined;
    },
    discoverAppendSystemPromptFile() {
      const projectPath = path.join(cwd, ".pi", "APPEND_SYSTEM.md");
      if (trusted && fs.existsSync(projectPath)) return projectPath;
      const globalPath = path.join(agentDir, "APPEND_SYSTEM.md");
      return fs.existsSync(globalPath) ? globalPath : undefined;
    },
  };

  let reads = 0;
  const session = {
    _resourceLoader: loader,
    _baseSystemPromptOptions: { customPrompt: undefined, appendSystemPrompt: "" },
    _runSystemPromptOptions: undefined,
    agent: { prepareRequest: undefined },
    getActiveToolNames: () => ["read"],
    _rebuildSystemPrompt() {
      this._baseSystemPromptOptions = {
        customPrompt: loader.systemPrompt,
        appendSystemPrompt: loader.appendSystemPrompt.join("\n\n"),
      };
    },
    _preparePromptAndToolLoadout(options, messages) {
      const sections = {
        preamble: options.customPrompt ?? "default",
        addendum: options.appendSystemPrompt,
      };
      const previous = Object.assign({}, ...messages.filter((message) => message.role === "system").map((message) => message.sections));
      if (Object.entries(sections).every(([key, value]) => previous[key] === value)) return undefined;
      return { role: "system", content: "", sections, timestamp: Date.now() };
    },
  };
  installAxumSystemPromptRefresh(session, {
    existsSync: (file) => fs.existsSync(file),
    readFileSync: (file, encoding) => {
      reads++;
      return fs.readFileSync(file, encoding);
    },
    buildSystemPrompt: (options) => `${options.customPrompt ?? ""}\n${options.appendSystemPrompt ?? ""}`,
  });
  return { session, loader, agentDir, cwd, reads: () => reads };
}

function userMessage(text) {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

test("system prompt refresh updates the same user's tool continuation and keeps the latest patch last", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axum-system-prompt-refresh-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = createSession(root);
  const system = path.join(fixture.agentDir, "SYSTEM.md");
  fs.writeFileSync(system, "RULES_V1");
  const user = userMessage("first");
  const initial = await fixture.session.agent.prepareRequest({ context: { messages: [user] } });
  const messages = [...initial.context.messages, { role: "assistant", content: [] }, { role: "toolResult", content: [] }];
  fs.writeFileSync(system, "RULES_V2");
  const next = await fixture.session.agent.prepareRequest({ context: { messages } });
  assert.equal(next.context.messages.at(-1).sections.preamble, "RULES_V2");
  assert.equal(next.context.messages.filter((message) => message.role === "user").length, 1);
  assert.deepEqual(next.context.messages.slice(0, -1), messages, "tool history must remain intact");
  assert.equal(await fixture.session.agent.prepareRequest({ context: next.context }), undefined, "unchanged context needs no duplicate patch");
  assert.equal(fixture.reads(), 3, "every request must re-read the source");
  const replay = await fixture.session.agent.prepareRequest({ context: { messages } });
  assert.equal(replay.context.messages.at(-1).sections.preamble, "RULES_V2", "canonical history without transient patches must still get the latest rules");
});

test("system prompt refresh preserves project priority and trust fallback", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axum-system-prompt-trust-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = createSession(root);
  const globalAppend = path.join(fixture.agentDir, "APPEND_SYSTEM.md");
  const projectAppend = path.join(fixture.cwd, ".pi", "APPEND_SYSTEM.md");
  fs.writeFileSync(globalAppend, "GLOBAL_V1");
  fs.writeFileSync(projectAppend, "PROJECT_V1");

  fixture.session._axumRefreshSystemPrompt();
  assert.deepEqual(fixture.loader.appendSystemPrompt, ["PROJECT_V1"]);

  fixture.loader.discoverAppendSystemPromptFile = () => {
    const globalPath = path.join(fixture.agentDir, "APPEND_SYSTEM.md");
    return fs.existsSync(globalPath) ? globalPath : undefined;
  };
  fixture.session._axumRefreshSystemPrompt();
  assert.deepEqual(fixture.loader.appendSystemPrompt, ["GLOBAL_V1"]);
});

test("system prompt refresh removes deleted append content on the next prompt", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axum-system-prompt-delete-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = createSession(root);
  const globalAppend = path.join(fixture.agentDir, "APPEND_SYSTEM.md");
  fs.writeFileSync(globalAppend, "REMOVE_ME");

  fixture.session._axumRefreshSystemPrompt();
  assert.deepEqual(fixture.loader.appendSystemPrompt, ["REMOVE_ME"]);

  fs.rmSync(globalAppend);
  fixture.session._axumRefreshSystemPrompt();
  assert.deepEqual(fixture.loader.appendSystemPrompt, []);
});

test("patchPiSystemPromptRefresh wires the request boundary and is idempotent", () => {
  const content = [
    'import { readFileSync } from "node:fs";',
    'import { buildSystemPrompt } from "./system-prompt.js";',
    "export class AgentSession {",
    "    constructor() {",
    "        this._installAgentRequestProjection();",
    "    }",
    "    async prompt() {",
    '        const userText = "request";',
    "        const messages = [];",
    '        const userContent = [{ type: "text", text: userText }];',
    '        messages.push({',
    '            role: "user",',
    '            content: userContent,',
    '            timestamp: Date.now(),',
    '        });',
    "        const selectedToolsBefore = this._baseSystemPromptOptions.selectedTools;",
    "        return selectedToolsBefore;",
    "    }",
    "}",
  ].join("\n");
  const once = patchPiSystemPromptRefresh(content);
  assert.ok(once.includes("// AXUM_PI_SYSTEM_PROMPT_REFRESH_V2"));
  assert.equal(once.includes("\nAXUM_PI_SYSTEM_PROMPT_REFRESH_V2\n"), false);
  assert.ok(once.includes("installAxumSystemPromptRefresh(this"));
  assert.ok(once.includes("this._axumRefreshSystemPrompt();"));
  assert.equal(once.includes("_axumMarkPromptUser"), false);
  assert.equal(patchPiSystemPromptRefresh(once), once);
});

test("patchPiSystemPromptRefresh fails clearly when upstream anchors drift", () => {
  assert.throws(
    () => patchPiSystemPromptRefresh("export class AgentSession {}"),
    /unable to patch Pi system prompt refresh/,
  );
});

test("V1 prompt refresh upgrades in place without dropping later patches", () => {
  for (const prefix of ["", "// "]) {
    const legacy = [
      "class AgentSession {",
      "    prompt() {",
      "        const userMessage = {};",
      "        this._axumMarkPromptUser(userMessage);",
      "    }",
      "}",
      `${prefix}AXUM_PI_SYSTEM_PROMPT_REFRESH_V1`,
      "function installAxumSystemPromptRefresh(session, helpers) {",
      "  session._axumMarkPromptUser = () => {};",
      "}",
      "// Later independent patch",
      "const tail = '$&';",
    ].join("\n");
    const upgraded = patchPiSystemPromptRefresh(legacy);
    assert.ok(upgraded.includes(installAxumSystemPromptRefresh.toString()));
    assert.equal(upgraded.includes("AXUM_PI_SYSTEM_PROMPT_REFRESH_V1"), false);
    assert.equal(upgraded.includes("_axumMarkPromptUser"), false);
    assert.ok(upgraded.endsWith("// Later independent patch\nconst tail = '$&';"));
    assert.equal(patchPiSystemPromptRefresh(upgraded), upgraded);
  }
  assert.throws(() => patchPiSystemPromptRefresh("// AXUM_PI_SYSTEM_PROMPT_REFRESH_V1\n"), /missing V1 installer/);
});

test("refresh preserves extension rules and removes deleted system rules during one run", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axum-system-prompt-run-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = createSession(root);
  const system = path.join(fixture.agentDir, "SYSTEM.md");
  fs.writeFileSync(system, "RULES_V1");
  fixture.session._axumRefreshSystemPrompt();
  fixture.session._runSystemPromptOptions = {
    ...fixture.session._baseSystemPromptOptions,
    forceSystemPrompt: "RULES_V1\nEXTENSION_RULES",
    promptGuidelines: ["keep extension options"],
  };
  const context = { messages: [userMessage("continue")] };
  fs.writeFileSync(system, "RULES_V2");
  await fixture.session.agent.prepareRequest({ context });
  assert.equal(fixture.session._runSystemPromptOptions.forceSystemPrompt, "RULES_V2\nEXTENSION_RULES");
  assert.deepEqual(fixture.session._runSystemPromptOptions.promptGuidelines, ["keep extension options"]);
  fs.unlinkSync(system);
  const result = await fixture.session.agent.prepareRequest({ context });
  assert.equal(result.context.messages.at(-1).sections.preamble, "default");
  const prepare = fixture.session.agent.prepareRequest;
  installAxumSystemPromptRefresh(fixture.session, {});
  assert.equal(fixture.session.agent.prepareRequest, prepare, "installer must not wrap twice");
});

const runtimeModules = getBundledPiNodeModules();
const sdkEntry = path.join(runtimeModules, "@earendil-works/pi-coding-agent/dist/index.js");

test("bundled SDK uses updated rules after a real tool continuation without a second user message", {
  skip: !fs.existsSync(sdkEntry), timeout: 20000,
}, async (t) => {
  const installedSession = path.join(path.dirname(sdkEntry), "core/agent-session.js");
  const patchedSession = patchPiSystemPromptRefresh(fs.readFileSync(installedSession, "utf8"));
  assert.ok(patchedSession.includes(installAxumSystemPromptRefresh.toString()), "installed runtime anchors must accept the current installer");
  const sdk = await import(pathToFileURL(sdkEntry).href);
  const ai = await import(pathToFileURL(path.join(runtimeModules, "@earendil-works/pi-ai/dist/index.js")).href);
  const { buildSystemPrompt } = await import(pathToFileURL(path.join(runtimeModules, "@earendil-works/pi-coding-agent/dist/core/system-prompt.js")).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axum-live-rules-sdk-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir);
  const system = path.join(agentDir, "SYSTEM.md");
  fs.writeFileSync(system, "RULES_V1");
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const runtime = await sdk.ModelRuntime.create({ modelsPath: null, authPath: path.join(agentDir, "auth.json"), refreshOnCreate: false });
  runtime.registerProvider("live-rules-fixture", {
    api: "openai-completions", apiKey: "offline-fixture", baseUrl: "http://invalid.local",
    models: [{ id: "fixed", name: "fixed", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
  });
  const loader = new sdk.DefaultResourceLoader({
    cwd: root, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [pi => {
      pi.on("before_agent_start", event => ({ systemPrompt: `${event.systemPrompt}\nEXTENSION_RULES` }));
      pi.registerTool({ name: "change_rules", label: "change rules", description: "Update isolated fixture rules", parameters: { type: "object", properties: {} },
        execute: async () => {
          fs.writeFileSync(system, "RULES_V2");
          return { content: [{ type: "text", text: "changed" }] };
        },
      });
    }],
  });
  await loader.reload();
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model: runtime.getModel("live-rules-fixture", "fixed"), settingsManager: settings, sessionManager: sdk.SessionManager.inMemory(root), resourceLoader: loader });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "print" });
  installAxumSystemPromptRefresh(session, { existsSync: fs.existsSync, readFileSync: fs.readFileSync, buildSystemPrompt });
  const requests = [];
  session.agent.streamFunction = async (model, context) => {
    requests.push(structuredClone(context));
    const first = requests.length === 1;
    const message = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: first ? [{ type: "toolCall", id: "change", name: "change_rules", arguments: {} }] : [{ type: "text", text: "done" }],
      stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = new ai.AssistantMessageEventStream();
    stream.push({ type: "done", reason: message.stopReason, message });
    stream.end(message);
    return stream;
  };
  await session.prompt("Update rules during this task");
  assert.equal(requests.length, 2);
  const leadingSystem = context => context.messages.find(message => message.role === "system").content;
  assert.ok(leadingSystem(requests[0]).includes("RULES_V1"));
  assert.ok(leadingSystem(requests[1]).includes("RULES_V2"));
  assert.equal(leadingSystem(requests[1]).includes("RULES_V1"), false);
  assert.ok(leadingSystem(requests[1]).includes("EXTENSION_RULES"));
  assert.equal(requests[1].messages.filter(message => message.role === "user").length, 1);
  assert.ok(requests[1].messages.some(message => message.role === "toolResult" && message.toolName === "change_rules"));
});
