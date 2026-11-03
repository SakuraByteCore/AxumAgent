import assert from "node:assert/strict";
import test from "node:test";
import { installAxumBackgroundCompaction } from "../src/pi-background-compaction.js";
import { patchPiBackgroundCompaction, patchPiBackgroundCompactionRunner } from "../src/bundled-pi-patches.js";

function fixture(softThreshold = 75, hardThreshold = 95) {
  let entries = [
    { id: "user", type: "message", message: { role: "user", content: "goal" } },
    { id: "call", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t" }] } },
    { id: "result", type: "message", message: { role: "toolResult", toolCallId: "t" } },
  ];
  const events = [], generations = [], failures = [], extensionEvents = [];
  const state = { tokens: 80, sessionId: "original", nativeCalls: 0 };
  const manager = {
    getSessionId: () => state.sessionId,
    getBranch: () => entries.slice(),
    getEntry: id => entries.find(entry => entry.id === id),
    append(entry) { entries.push(entry); },
    replace(next) { entries = next; },
    appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage) {
      entries.push({ type: "compaction", id: "checkpoint", summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage });
      state.tokens = 20;
      return "checkpoint";
    },
    buildSessionProjection() {
      const checkpoint = entries.findLastIndex(entry => entry.type === "compaction");
      const visible = checkpoint < 0 ? entries : [entries[checkpoint], ...entries.slice(
        entries.findIndex(entry => entry.id === entries[checkpoint].firstKeptEntryId), checkpoint), ...entries.slice(checkpoint + 1)];
      return { messages: visible.map(entry => entry.message ?? { role: "compactionSummary", content: entry.summary }) };
    },
  };
  const session = {
    sessionManager: manager, model: { id: "model", contextWindow: 100 }, agent: { state: {} },
    settingsManager: { getCompactionSettings: () => ({ keepRecentTokens: 20 }) },
    _extensionRunner: { hasHandlers: () => false, async emit(event) { extensionEvents.push(event); } },
    _emit: event => events.push(event),
    _refreshFinalizedContext() { this.agent.state.messages = manager.buildSessionProjection().messages; },
    _runDefaultCompaction(preparation, model, instructions, signal) {
      return new Promise((resolve, reject) => generations.push({ preparation, model, instructions, signal, resolve, reject }));
    },
    async _runAutoCompaction() { state.nativeCalls++; return false; },
    async _compactBeforeNextAssistantResponse(context) { return context; },
    compact() {}, abortCompaction() {}, dispose() {}, reload() {}, navigateTree() {},
  };
  installAxumBackgroundCompaction(session, {
    prepareCompaction: () => ({ firstKeptEntryId: "call", tokensBefore: state.tokens }),
    estimateProjectedContextTokens: () => ({ tokens: state.tokens }),
    estimateMessagesTokens: messages => messages.length,
    isVirtualModel: model => model.provider === "virtual",
  });
  const options = { softThreshold, hardThreshold, customInstructions: "ledger", onError: error => failures.push(error) };
  const api = session._axumBackgroundCompaction;
  const finish = async () => {
    generations.at(-1).resolve({ summary: "summary", firstKeptEntryId: "call", tokensBefore: 80, usage: { totalTokens: 5 } });
    await new Promise(resolve => setImmediate(resolve));
  };
  return { session, manager, state, events, extensionEvents, generations, failures, api, options, finish };
}

test("soft preparation leaves tools running; only a request commits the checkpoint and all new messages", async () => {
  const f = fixture();
  f.api.configure(f.options);
  await f.api.beforeRequest();
  assert.equal(f.generations.length, 1);
  assert.equal(f.events.length, 0);
  assert.equal(f.manager.getBranch().length, 3);
  f.manager.append({ id: "new-user", type: "message", message: { role: "user", content: "new instruction" } });
  await f.finish();
  assert.equal(f.events.length, 0, "generation must not change the foreground context");
  await f.api.beforeRequest();
  assert.deepEqual(f.session.agent.state.messages.map(message => message.role), ["compactionSummary", "assistant", "toolResult", "user"]);
  assert.equal(f.session.agent.state.messages.at(-1).content, "new instruction");
  assert.deepEqual(f.events.map(event => event.type), ["compaction_start", "compaction_end"]);
  assert.equal(f.extensionEvents[0].compactionEntry.id, "checkpoint");
  assert.equal(f.events.at(-1).willRetry, false);
  assert.equal(f.state.nativeCalls, 0);
});

test("hard requests share one background task; equal thresholds wait immediately", async () => {
  for (const thresholds of [[75, 95], [80, 80]]) {
    const f = fixture(...thresholds);
    f.api.configure(f.options);
    f.state.tokens = 95;
    let requestsFinished = 0;
    const first = f.api.beforeRequest().then(() => requestsFinished++);
    const second = f.api.beforeRequest().then(() => requestsFinished++);
    f.api.configure(f.options);
    await Promise.resolve();
    assert.equal(requestsFinished, 0);
    assert.equal(f.generations.length, 1);
    await f.finish();
    await Promise.all([first, second]);
    assert.equal(requestsFinished, 2);
    assert.equal(f.events.filter(event => event.type === "compaction_end").length, 1);
    assert.equal(f.state.nativeCalls, 0);
  }
});

test("stale sessions, divergent branches, edits and lifecycle operations discard late summaries", async () => {
  const invalidations = [
    f => { f.state.sessionId = "new-session"; },
    f => f.manager.replace([{ id: "other", type: "message", message: { role: "user" } }]),
    f => f.manager.append({ id: "edit", type: "context_edit" }),
    f => { f.session.model = { id: "other", contextWindow: 100 }; },
    ...["compact", "abortCompaction", "dispose", "reload", "navigateTree"].map(name => f => f.session[name]()),
  ];
  for (const invalidate of invalidations) {
    const f = fixture();
    f.api.configure(f.options);
    invalidate(f);
    await f.finish();
    f.state.tokens = 0;
    await f.api.beforeRequest();
    assert.equal(f.manager.getBranch().some(entry => entry.type === "compaction"), false);
    assert.equal(f.events.length, 0);
  }
});

test("background failure preserves original context; hard boundary performs one native retry", async () => {
  const f = fixture();
  f.api.configure(f.options);
  const original = f.manager.getBranch();
  f.generations[0].reject(new Error("provider failed"));
  await new Promise(resolve => setImmediate(resolve));
  await f.api.beforeRequest();
  assert.deepEqual(f.manager.getBranch(), original);
  assert.equal(f.failures.length, 1);
  assert.equal(f.state.nativeCalls, 0);
  f.state.tokens = 95;
  await f.api.beforeRequest();
  assert.equal(f.state.nativeCalls, 1);
  assert.equal(f.generations.length, 1);
  assert.deepEqual(f.manager.getBranch(), original);
});

test("request cancellation interrupts a hard wait without applying a late summary", async () => {
  const f = fixture(80, 80);
  f.api.configure(f.options);
  const controller = new AbortController();
  const pending = f.api.beforeRequest(controller.signal);
  controller.abort(new Error("user cancelled"));
  await assert.rejects(pending, /user cancelled/);
  f.session.abortCompaction();
  assert.equal(f.generations[0].signal.aborted, true);
  await f.finish();
  assert.equal(f.events.length, 0);
});

test("threshold auto compaction schedules without blocking; overflow keeps native recovery", async () => {
  const f = fixture();
  f.api.configure(f.options);
  assert.equal(await f.session._runAutoCompaction("threshold", false), false);
  assert.equal(f.generations.length, 1);
  assert.equal(f.state.nativeCalls, 0);
  await f.session._runAutoCompaction("overflow", true);
  assert.equal(f.generations[0].signal.aborted, true);
  assert.equal(f.state.nativeCalls, 1);
  const routed = fixture();
  routed.session.model.provider = "virtual";
  routed.api.configure(routed.options);
  await routed.session._runAutoCompaction("threshold", false);
  assert.equal(routed.generations.length, 0);
  assert.equal(routed.state.nativeCalls, 1);
});

test("kernel and guarded extension context patches are repeatable and reject missing anchors", () => {
  const kernel = ["    _installAgentRequestProjection() {", "        this.agent.prepareRequest = async (request, signal) => {",
    "            getContextUsage: () => this.getContextUsage(),"].join("\n");
  const patched = patchPiBackgroundCompaction(kernel);
  assert.match(patched, /await this\._axumBackgroundCompaction.beforeRequest\(signal\)/);
  assert.equal(patchPiBackgroundCompaction(patched), patched);
  assert.throws(() => patchPiBackgroundCompaction(""), /missing/);
  const runner = "        this.compactFn = contextActions.compact;\n            compact: (options) => {";
  const context = patchPiBackgroundCompactionRunner(runner);
  assert.match(context, /runner.assertActive\(\);\n\s+runner.backgroundCompactFn\(options\)/);
  assert.equal(patchPiBackgroundCompactionRunner(context), context);
  assert.throws(() => patchPiBackgroundCompactionRunner(""), /anchors/);
});
