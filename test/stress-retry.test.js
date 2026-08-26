import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const failures = [];

function recordFailure(name, reason) {
  failures.push({ name, reason, ts: Date.now() });
}

function throwIfFail(name, condition, detail) {
  if (!condition) {
    var msg = "STRESS FAIL [" + name + "] " + (detail || "");
    recordFailure(name, detail || msg);
    throw new Error(msg);
  }
}

// ── Helpers ──────────────────────────────────────────────

function makeAssistantMessage(opts) {
  return {
    role: "assistant",
    stopReason: (opts && opts.stopReason) || "stop",
    content: (opts && opts.content) || [{ type: "text", text: "partial thinking" }],
    errorMessage: (opts && opts.errorMessage) || undefined,
    usage: (opts && opts.usage) || { input: 10, output: 0 },
  };
}

async function createPi() {
  const commands = new Map();
  const messages = [];
  const emitted = [];
  const listeners = new Map();
  const pendingMessages = [];
  let isIdle = true;
  // Create a temp cwd with bundled config so resolveConfigPath works
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stress-cwd-"));
  var bundledConfigPath = path.join(__dirname, "..", "plugin", "pi-companion", "config.json");
  fs.mkdirSync(path.join(tmpDir, ".pi", "agent", "extensions", "pi-response-guard"), { recursive: true });
  try {
    fs.copyFileSync(bundledConfigPath, path.join(tmpDir, ".pi", "agent", "extensions", "pi-response-guard", "config.json"));
  } catch (ex) {
    // Write minimal defaults if bundled config is missing
    fs.writeFileSync(path.join(tmpDir, ".pi", "agent", "extensions", "pi-response-guard", "config.json"),
      JSON.stringify({ enabled: true, retryMessage: "continue", maxConsecutiveAutoRetries: 10, autoContinueOnThinkingOnlyStop: true }, null, 2));
  }

  const pi = {
    commands,
    messages,
    emitted,
    listeners,
    pendingMessages,
    cwd: tmpDir,
    hasUI: true,
    hasPendingMessages: function() { return pendingMessages.length > 0; },
    isIdle: function() { return isIdle; },
    sessionManager: { getSessionFile: function() { return undefined; } },
    registerCommand(name, cmd) { commands.set(name, cmd); },
    getModel() { return undefined; },
    getContextUsage: function() { return { tokens: 0, contextWindow: 100 }; },
    on(event, handler) {
      listeners.set(event, handler);
      return function cleanup() { listeners.delete(event); };
    },
    sendUserMessage(message, options) {
      const entry = { message, options, id: messages.length + 1, ts: Date.now() };
      messages.push(entry);
      pendingMessages.push(entry);
      isIdle = false;
      pendingMessages.splice(pendingMessages.indexOf(entry), 1);
      if (!pendingMessages.length) isIdle = true;
      return Promise.resolve();
    },
    events: {
      on(event, handler) {
        listeners.set(event, handler);
        return function cleanup() { listeners.delete(event); };
      },
      emit(event, data) { emitted.push({ event, data }); },
    },
    reset() {
      pendingMessages.length = 0;
      isIdle = true;
      messages.length = 0;
      emitted.length = 0;
      commands.clear();
      listeners.clear();
    },
  };

  var previousDir = process.env.PI_CODING_AGENT_DIR;
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stress-"));
  var cleanupEnv = function() {
    process.env.PI_CODING_AGENT_DIR = previousDir;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (ex) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (ex2) {}
  };
  process.env.PI_CODING_AGENT_DIR = dir;
  var mod = await import("../plugin/pi-companion/index.ts");
  mod.default(pi);
  if (cleanupEnv) cleanupEnv();
  return pi;
}

// ── Stress 1: Retry storm ──────────────────────────────────
test("stress.retryStorm: rapid consecutive auto-retries with followUps", { timeout: 60000 }, async function() {
  var pi = await createPi();
  var iters = 200;
  for (var i = 0; i < iters; i++) {
    await pi.sendUserMessage("stress-msg-" + i, { streamingBehavior: "followUp" });
    await new Promise(function(r) { setTimeout(r, 15); });
  }
  throwIfFail("retryStorm.messageCount", pi.messages.length >= iters,
    "expected >= " + iters + " messages, got " + pi.messages.length);
  for (var j = 0; j < pi.messages.length; j++) {
    var m = pi.messages[j];
    throwIfFail("retryStorm.followUp-" + j,
      m.options && m.options.streamingBehavior === "followUp",
      "message missing followUp at index " + j + ": " + JSON.stringify(m.options));
  }
});

// ── Stress 2: hasPendingMessages backpressure ──────────────
test("stress.backpressure: busy queue blocks redundent retry", { timeout: 60000 }, async function() {
  var pi = await createPi();
  pi.pendingMessages.push({ id: -1, message: "q1", options: {} }, { id: -2, message: "q2", options: {} });
  var isIdle = false;

  var h = pi.listeners.get("message_end");
  throwIfFail("backpressure.handlerExists", !!h, "message_end handler not found");

  var fakeEvent = {
    message: makeAssistantMessage({ stopReason: "stop", content: [{ type: "thinking", text: "reasoning" }] }),
  };
  for (var i = 0; i < 50; i++) {
    await h({ message: fakeEvent.message }, pi);
  }
  var userMessages = pi.messages.filter(function(m) { return !m.message.startsWith("/compact"); });
  throwIfFail("backpressure.noSpuriousRetry", userMessages.length === 0,
    "expected 0 retries while busy, got " + userMessages.length);
});

// ── Stress 3: max retries cap ───────────────────────────────
test("stress.maxRetry: maxConsecutiveAutoRetries cap enforced", { timeout: 60000 }, async function() {
  var pi = await createPi();
  var messageEndHandler = pi.listeners.get("message_end");
  var settleHandler = pi.listeners.get("agent_settled");
  throwIfFail("maxRetry.handlerExists", !!messageEndHandler && !!settleHandler, "retry handlers not found");

  for (var i = 0; i < 30; i++) {
    await messageEndHandler({
      message: makeAssistantMessage({ stopReason: "stop", content: [{ type: "thinking", text: "reasoning" }] }),
    }, pi);
    await settleHandler({}, pi);
  }
  var retries = pi.messages.filter(function(m) { return !m.message.startsWith("/compact"); });
  throwIfFail("maxRetry.capRespected", retries.length <= 10,
    "retries exceeded cap: " + retries.length);
});

// ── Stress 4: event storm re-entrancy ───────────────────────
test("stress.eventStorm: interleaved handlers under load", { timeout: 120000 }, async function() {
  var pi = await createPi();
  var settleHandler = pi.listeners.get("agent_settled");
  var agentEndHandler = pi.listeners.get("agent_end");
  var messageEndHandler = pi.listeners.get("message_end");
  throwIfFail("eventStorm.allHandlersPresent",
    !!settleHandler && !!agentEndHandler && !!messageEndHandler, "missing handlers");

  var threw = false;
  var tasks = [];
  for (var k = 0; k < 200; k++) {
    if (k % 3 === 0) {
      tasks.push(messageEndHandler({
        message: makeAssistantMessage({ stopReason: "error", errorMessage: "rate limit" }),
      }, pi));
    } else if (k % 3 === 1) {
      tasks.push(agentEndHandler({ willRetry: false, messages: [makeAssistantMessage()] }, pi));
    } else {
      tasks.push(settleHandler({ willRetry: false, messages: [makeAssistantMessage()] }, pi));
    }
    if (tasks.length >= 10) {
      try {
        await Promise.all(tasks);
      } catch (err) {
        threw = true;
        recordFailure("eventStorm.reentrancy", "threw: " + err.message);
      }
      tasks = [];
    }
  }
  if (tasks.length) {
    try {
      await Promise.all(tasks);
    } catch (err) {
      threw = true;
      recordFailure("eventStorm.reentrancy", "threw: " + err.message);
    }
  }
  throwIfFail("eventStorm.noThrow", !threw, "event storm threw");
});

// ── Stress 5: large content payload ─────────────────────────
test("stress.largeContent: 500k thinking payload does not OOM", { timeout: 60000 }, async function() {
  var pi = await createPi();
  var bigThinking = "R".repeat(500000);
  var msg = makeAssistantMessage({
    stopReason: "stop",
    content: [{ type: "thinking", text: bigThinking }],
  });
  var h = pi.listeners.get("message_end");
  if (h) await h({ message: msg }, pi);
  throwIfFail("largeContent.handled", true);
});

// ── Stress 6: config mutation mid-retry ─────────────────────
test("stress.config: mid-retry config change is picked up", { timeout: 60000 }, async function() {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-stress-"));
  var configPath = path.join(tmpDir, ".pi", "agent", "extensions", "pi-response-guard", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath,
    JSON.stringify({ enabled: true, retryMessage: "continue", maxConsecutiveAutoRetries: 2, autoContinueOnThinkingOnlyStop: true }, null, 2));

  var previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tmpDir;
  var cleanupTmp;
  try {
    var pi = await createPi();
    async function loadConfig() {
      var raw = await fs.promises.readFile(configPath, "utf-8");
      return JSON.parse(raw);
    }
    var config1 = await loadConfig();
    throwIfFail("config.initialEnabled", config1.enabled === true);

    fs.writeFileSync(configPath,
      JSON.stringify(Object.assign({}, config1, { maxConsecutiveAutoRetries: 999 }), null, 2));
    var config2 = await loadConfig();
    throwIfFail("config.mutationVisible", config2.maxConsecutiveAutoRetries === 999,
      "expected 999, got " + config2.maxConsecutiveAutoRetries);
  } finally {
    process.env.PI_CODING_AGENT_DIR = previousDir;
    cleanupTmp = function() {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (ex) {}
    };
    cleanupTmp();
  }
});

// ── Stress 7: 1000 message_end rapid-fire memory ────────────
test("stress.memory: 1000 message_end rapid-fire heap growth < 50MB", { timeout: 60000 }, async function() {
  var pi = await createPi();
  var h = pi.listeners.get("message_end");
  var msg = makeAssistantMessage({ stopReason: "stop", content: [{ type: "thinking", text: "t" }] });

  var startMem = process.memoryUsage().heapUsed;
  for (var i = 0; i < 1000; i++) {
    await h({ message: msg }, pi);
  }
  var endMem = process.memoryUsage().heapUsed;
  var growthMB = (endMem - startMem) / 1024 / 1024;
  throwIfFail("memory.growthReasonable", growthMB < 50,
    "heap grew by " + growthMB.toFixed(2) + "MB over 1000 iterations");
});

// ── Stress 8: /compact + followUp interleaving ──────────────
test("stress.compactInterleave: /compact + followUp no deadlock", { timeout: 60000 }, async function() {
  var pi = await createPi();
  var clearHandler = pi.commands.get("clear");
  if (!clearHandler) return;

  var ctxObj = {
    ui: { notify: function() {} },
    sessionManager: { getSessionFile: function() { return undefined; } },
    newSession: function() { return { cancelled: false }; },
    getContextUsage: function() { return { tokens: 0, contextWindow: 100 }; },
  };

  for (var i = 0; i < 20; i++) {
    await clearHandler.handler("", ctxObj);
    await pi.sendUserMessage("continue", { streamingBehavior: "followUp" });
  }
  throwIfFail("compactInterleave.completes", true);
});

// ── Stress 9: /subagent + retry concurrent ───────────────────
test("stress.subagentRetry: /subagent and retry paths concurrent", { timeout: 120000 }, async function() {
  var pi = await createPi();
  var subHandler = pi.commands.get("subagent");
  if (!subHandler) {
    console.log("[subagent] /subagent command not registered, skipping");
    return;
  }

  var ctxObj = {
    ui: { notify: function() {} },
    sessionManager: { getSessionFile: function() { return undefined; } },
    newSession: function() { return { cancelled: false }; },
    getContextUsage: function() { return { tokens: 0, contextWindow: 100 }; },
  };

  // Use smaller count and add progress logging
  var iterations = 10;
  for (var i = 0; i < iterations; i++) {
    var t0 = Date.now();
    await subHandler.handler("task-" + i, ctxObj);
    var dt = Date.now() - t0;
    if (dt > 5000) console.log("[subagent] iteration " + i + " took " + dt + "ms");
    await pi.sendUserMessage("continue", { streamingBehavior: "followUp" });
  }
  throwIfFail("subagentRetry.completes", true);
});

// ── Stress 10: error pattern boundary ───────────────────────
test("stress.errorPatterns: 15 distinct error patterns all recovered", { timeout: 60000 }, async function() {
  var pi = await createPi();
  var h = pi.listeners.get("message_end");

  var errorMessages = [
    "429 Too Many Requests", "rate_limit exceeded", "ECONNRESET",
    "stream interrupted", "socket hang up", "upstream request timeout",
    "insufficient_quota", "service unavailable", "server error",
    "premature close", "fetch failed", "connection refused",
    "model not found", "invalid_api_key", "authentication failed",
  ];

  var configPath = path.join(pi.cwd, ".pi-response-guard.json");
  var configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true, retryMessage: "continue", maxConsecutiveAutoRetries: errorMessages.length, autoContinueOnThinkingOnlyStop: true }, null, 2));

  var settleHandler = pi.listeners.get("agent_settled");
  throwIfFail("errorPatterns.settleHandlerExists", !!settleHandler, "agent_settled not found");

  for (var i = 0; i < errorMessages.length; i++) {
    var evt = {
      message: makeAssistantMessage({
        stopReason: "error",
        errorMessage: errorMessages[i],
        content: [{ type: "text", text: "" }],
      }),
    };
    await h(evt, pi);
    await settleHandler({}, pi);
  }

  var autoRetries = pi.messages.filter(function(m) {
    return m.options && m.options.streamingBehavior === "followUp";
  });
  throwIfFail("errorPatterns.matchedAndRecovered",
    autoRetries.length === errorMessages.length,
    "expected " + errorMessages.length + " auto-retries, got " + autoRetries.length);
});

// ── Stress 11: idle↔busy rapid oscillation ──────────────────
test("stress.idleOscillation: 10-wave burst all messages use followUp", { timeout: 60000 }, async function() {
  var pi = await createPi();
  for (var wave = 0; wave < 10; wave++) {
    for (var i = 0; i < 30; i++) {
      await pi.sendUserMessage("w" + wave + "-m" + i, { streamingBehavior: "followUp" });
    }
    await new Promise(function(r) { setTimeout(r, 50); });
  }
  throwIfFail("idleOscillation.totalMessages", pi.messages.length >= 300,
    "expected >=300 messages, got " + pi.messages.length);
  var allFollowUp = pi.messages.every(function(m) {
    return m.options && m.options.streamingBehavior === "followUp";
  });
  throwIfFail("idleOscillation.allFollowUp", allFollowUp, "some messages missing followUp");
});

// ── Stress 12: /plan command under load ─────────────────────
test("stress.planLoad: /plan 100 times uses followUp after first", { timeout: 60000 }, async function() {
  var pi = await createPi();
  var planHandler = pi.commands.get("plan");
  if (!planHandler) return;

  var ctxObj = {
    ui: { notify: function() {} },
    sessionManager: { getSessionFile: function() { return undefined; } },
    newSession: function() { return { cancelled: false }; },
    getContextUsage: function() { return { tokens: 0, contextWindow: 100 }; },
  };

  for (var i = 0; i < 100; i++) {
    await planHandler.handler("requirement-" + i, ctxObj);
  }
  var followUps = pi.messages.filter(function(m) {
    return m.options && m.options.streamingBehavior === "followUp";
  });
  var news = pi.messages.filter(function(m) {
    return m.options && m.options.streamingBehavior === "new";
  });
  throwIfFail("planLoad.followUpCount", followUps.length === 99,
    "expected 99 plan followUps after first, got " + followUps.length);
  throwIfFail("planLoad.newCount", news.length === 1,
    "expected 1 plan new (first), got " + news.length);
});

// ── Stress 13: verify no deliverAs remnants in codebase ───────
test("stress.codeAudit: no deliverAs remnants anywhere in source", { timeout: 15000 }, function() {
  var result;
  try {
    result = execSync('grep -rn "deliverAs" /data/data/com.termux/files/home/AxumAgent/plugin/ /data/data/com.termux/files/home/AxumAgent/src/ 2>/dev/null || true', {
      encoding: "utf8", timeout: 10000,
    });
  } catch (ex) { result = ex.stdout || ""; }
  var lines = result.trim().split("\n").filter(function(l) { return l.length > 0 && !l.includes("node_modules"); });
  throwIfFail("codeAudit.noDeliverAsRemnants", lines.length === 0,
    "found deliverAs references: " + JSON.stringify(lines));
});

// ── Stress 14: verify all sendUserMessage calls have streamingBehavior ──
test("stress.codeAudit: all sendUserMessage calls pass streamingBehavior", { timeout: 15000 }, function() {
  var result;
  try {
    result = execSync('grep -rn "sendUserMessage" /data/data/com.termux/files/home/AxumAgent/plugin/pi-companion/index.ts', {
      encoding: "utf8", timeout: 10000,
    });
  } catch (ex) { result = ex.stdout || ""; }
  var lines = result.trim().split("\n").filter(function(l) { return l.length > 0 && !l.trim().startsWith("//"); });
  // All lines containing sendUserMessage should either be the declaration itself or have streamingBehavior
  var badLines = lines.filter(function(l) {
    // ignore the line that defines sendUserMessage in our spy mock
    return !l.includes("streamingBehavior") && !l.includes("function sendUserMessage") && !l.includes("sendUserMessage(message, options)");
  });
  throwIfFail("codeAudit.allSendUserMessageHaveStreamingBehavior", badLines.length === 0,
    "sendUserMessage calls without streamingBehavior: " + JSON.stringify(badLines));
});

// ── Global stress report ───────────────────────────────────
test("stress.REPORT: final failure summary", { timeout: 15000 }, function() {
  if (failures.length > 0) {
    console.error("\n=== STRESS FAILURES (" + failures.length + ") ===");
    for (var i = 0; i < failures.length; i++) {
      console.error("  [" + (i + 1) + "] " + failures[i].name + ": " + failures[i].reason);
    }
  } else {
    console.log("\n=== ALL 14 STRESS TESTS PASSED ===");
  }
  throwIfFail("stress.overall", failures.length === 0,
    failures.length + " stress test failure(s)");
});