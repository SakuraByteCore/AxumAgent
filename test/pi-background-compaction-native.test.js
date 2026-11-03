import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installAxumBackgroundCompaction } from "../src/pi-background-compaction.js";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { getBundledPiNodeModules } from "../src/bundled-pi-cache.js";
import { patchPiBackgroundCompaction } from "../src/bundled-pi-patches.js";

const core = path.join(getBundledPiNodeModules(), "@earendil-works/pi-coding-agent/dist/core");
const filename = path.join(core, "agent-session.js");
test("installed Pi request hook persists and reloads the summary, retained tool pair and concurrent user message", { skip: !fs.existsSync(filename) }, async t => {
  const source = patchPiBackgroundCompaction(fs.readFileSync(filename, "utf8"));
  const { AgentSession } = await import(pathToFileURL(filename).href);
  const { SessionManager } = await import(pathToFileURL(path.join(core, "session-manager.js")).href);
  const helpers = await import(pathToFileURL(path.join(core, "compaction/index.js")).href);
  const { isVirtualModel } = await import(pathToFileURL(path.join(core, "virtual-models.js")).href);
  const method = source.slice(source.indexOf("    _installAgentRequestProjection() {"), source.indexOf("    async _dispatchTurnEndBoundary("));
  const install = new Function("installAxumBackgroundCompaction", "prepareCompaction", "estimateProjectedContextTokens", "estimateMessagesTokens", "isVirtualModel",
    `return ({${method}})._installAgentRequestProjection;`)(installAxumBackgroundCompaction, helpers.prepareCompaction, helpers.estimateProjectedContextTokens,
      messages => messages.reduce((sum, message) => sum + helpers.estimateTokens(message), 0), isVirtualModel);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "axum-bg-native-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manager = SessionManager.create(process.cwd(), directory);
  for (let i = 0; i < 12; i++) manager.appendMessage({ role: "user", content: "history ".repeat(200), timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }],
    api: "openai-responses", provider: "test", model: "test", stopReason: "toolUse", timestamp: Date.now(),
    usage: { input: 6000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 6100 } });
  manager.appendMessage({ role: "toolResult", toolCallId: "tool-1", toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: Date.now() });
  const session = Object.create(AgentSession.prototype), events = [];
  session.agent = { state: { model: { id: "test", provider: "test", contextWindow: 100000 }, tools: [] } };
  session.sessionManager = manager; session._entryIdsByMessage = new WeakMap();
  session.settingsManager = { getCompactionSettings: () => ({ keepRecentTokens: 100, reserveTokens: 1000 }) };
  session._extensionRunner = { hasHandlers: () => false, async emit() {} }; session._emit = event => events.push(event);
  let complete, preparation;
  session._runDefaultCompaction = async input => { preparation = input; return new Promise(resolve => { complete = resolve; }); };
  install.call(session);
  session._axumBackgroundCompaction.configure({ softThreshold: 1, hardThreshold: 99, customInstructions: "ledger" });
  const request = { context: { messages: [], tools: [], systemPrompt: "test" } };
  const before = await session.agent.prepareRequest(request);
  assert.ok(complete); assert.equal(events.length, 0); assert.equal(before.context.messages.at(-1).role, "toolResult");
  manager.appendMessage({ role: "user", content: "new instruction", timestamp: Date.now() });
  complete({ summary: "checkpoint", firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore });
  await new Promise(resolve => setImmediate(resolve));
  const after = await session.agent.prepareRequest(request);
  assert.equal(after.context.messages[0].role, "compactionSummary");
  assert.deepEqual(after.context.messages.slice(-3).map(message => message.role), ["assistant", "toolResult", "user"]);
  assert.equal(events.at(-1).type, "compaction_end");
  assert.deepEqual(SessionManager.open(manager.getSessionFile()).buildSessionProjection().messages, after.context.messages);
});
