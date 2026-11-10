import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
    _preparePromptAndToolLoadout(options) {
      const sections = {
        preamble: options.customPrompt ?? "default",
        addendum: options.appendSystemPrompt,
      };
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

test("system prompt refresh reads once per new user prompt and updates the request", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axum-system-prompt-refresh-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = createSession(root);
  const globalAppend = path.join(fixture.agentDir, "APPEND_SYSTEM.md");
  fs.writeFileSync(globalAppend, "GLOBAL_V1");

  const first = userMessage("first");
  fixture.session._axumRefreshSystemPrompt();
  fixture.session._axumMarkPromptUser(first);
  let context = { messages: [first] };
  await fixture.session.agent.prepareRequest({ context });
  assert.equal(fixture.reads(), 1);
  assert.equal(fixture.loader.appendSystemPrompt[0], "GLOBAL_V1");

  await fixture.session.agent.prepareRequest({ context });
  assert.equal(fixture.reads(), 1, "the same user prompt must not trigger another read");

  fs.writeFileSync(globalAppend, "GLOBAL_V2");
  const second = userMessage("second");
  context = { messages: [first, second] };
  const result = await fixture.session.agent.prepareRequest({ context });
  assert.equal(fixture.reads(), 2);
  assert.equal(fixture.loader.appendSystemPrompt[0], "GLOBAL_V2");
  assert.equal(result.context.messages[1].role, "system");
  assert.equal(result.context.messages[1].sections.addendum, "GLOBAL_V2");
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
  assert.ok(once.includes("// AXUM_PI_SYSTEM_PROMPT_REFRESH_V1"));
  assert.equal(once.includes("\nAXUM_PI_SYSTEM_PROMPT_REFRESH_V1\n"), false);
  assert.ok(once.includes("installAxumSystemPromptRefresh(this"));
  assert.ok(once.includes("this._axumRefreshSystemPrompt();"));
  assert.ok(once.includes("this._axumMarkPromptUser(userMessage);"));
  assert.equal(patchPiSystemPromptRefresh(once), once);
});

test("patchPiSystemPromptRefresh fails clearly when upstream anchors drift", () => {
  assert.throws(
    () => patchPiSystemPromptRefresh("export class AgentSession {}"),
    /unable to patch Pi system prompt refresh/,
  );
});
