// Simulate the pi-loop-guard extension lifecycle against a mock ExtensionAPI,
// loading the actual extension via jiti (same loader pi uses at runtime) so the
// .ts imports resolve identically to production.
import { createRequire } from "node:module";

// jiti is nested inside the axum-agent node_modules; resolve via a relative
// URL from this test file so the path is stable regardless of install location.
const require = createRequire(import.meta.url);
const jitiPath = new URL("../../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs", import.meta.url).pathname;
const { createJiti } = require(jitiPath);

// Mock ExtensionAPI matching the real contract from types.d.ts.
const handlers = {};
const sentMessages = [];
const mockCtx = { hasUI: true, ui: { notify() {} } };

const mockPi = {
  on(event, handler) {
    const key = event.replace(/"/g, "");
    if (handlers[key] === undefined) handlers[key] = [];
    handlers[key].push(handler);
  },
  events: { on() {}, emit() {} },
  sendUserMessage(content, options) {
    sentMessages.push({ content, options });
  },
};

// Load the extension via jiti, exactly like pi's loader does at runtime.
const jiti = createJiti(import.meta.url, { moduleCache: false });
const mod = jiti(new URL("../plugin/pi-loop-guard/index.ts", import.meta.url).pathname);
mod.default(mockPi);

console.log("=== registered handlers ===");
for (const [k, v] of Object.entries(handlers)) {
  console.log(`  ${k}: ${v.length} handler(s)`);
}

function emit(event, evt, ctx = mockCtx) {
  const key = event.replace(/"/g, "");
  const results = [];
  for (const h of handlers[key] || []) {
    const r = h(evt, ctx);
    results.push(r);
  }
  return results;
}

const degenerateText = (n) => "御坂".repeat(n);
const makeTurn = (turnIndex, text) => ({
  type: "turn_end",
  turnIndex,
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: {}, stopReason: "stop", timestamp: 0,
  },
  toolResults: [],
});

let pass = true;
function check(desc, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) pass = false;
  console.log(`${ok ? "PASS" : "FAIL"} - ${desc}${detail ? " | " + detail : ""}`);
}

// --- Scenario 1: normal assistant turn, no injection ---
console.log("\n--- Scenario 1: normal text, should NOT inject ---");
sentMessages.length = 0;
emit("turn_start", { type: "turn_start", turnIndex: 0 });
emit("turn_end", makeTurn(0, "御坂已确认项目结构，现在开始实施改动。"));
check("no injection on normal text", sentMessages.length === 0, `got ${sentMessages.length}`);

// --- Scenario 2: degeneration, SHOULD inject ---
console.log("\n--- Scenario 2: 御坂御坂... stacking, SHOULD inject ---");
sentMessages.length = 0;
emit("turn_start", { type: "turn_start", turnIndex: 1 });
emit("turn_end", makeTurn(1, degenerateText(11)));
check("injection on degeneration", sentMessages.length === 1, `got ${sentMessages.length}`);
if (sentMessages.length === 1) {
  console.log("  content:", sentMessages[0].content.slice(0, 60));
  console.log("  options:", JSON.stringify(sentMessages[0].options));
  check("deliverAs is steer", sentMessages[0].options?.deliverAs === "steer");
  check("content mentions degradation", sentMessages[0].content.includes("重复退化") || sentMessages[0].content.includes("循环"));
}

// --- Scenario 3: same turn again, suppression latch ---
console.log("\n--- Scenario 3: same turn re-emit, should suppress (latch) ---");
sentMessages.length = 0;
emit("turn_end", makeTurn(1, degenerateText(8)));
check("suppressed by latch within same run", sentMessages.length === 0, `got ${sentMessages.length}`);

// --- Scenario 4: new turn resets latch, degeneration again ---
console.log("\n--- Scenario 4: new turn, degeneration again, SHOULD inject ---");
sentMessages.length = 0;
emit("turn_start", { type: "turn_start", turnIndex: 2 });
emit("turn_end", makeTurn(2, degenerateText(7)));
check("injection after latch reset", sentMessages.length === 1, `got ${sentMessages.length}`);

// --- Scenario 5: third consecutive degradation, hard cap reached ---
console.log("\n--- Scenario 5: third consecutive, hard cap, should suppress ---");
sentMessages.length = 0;
emit("turn_start", { type: "turn_start", turnIndex: 3 });
emit("turn_end", makeTurn(3, degenerateText(7)));
check("suppressed by hard cap (3rd consecutive)", sentMessages.length === 0, `got ${sentMessages.length}`);

// --- Scenario 6: before_agent_start system prompt augmentation ---
console.log("\n--- Scenario 6: before_agent_start prompts guard block ---");
const baResults = emit("before_agent_start", {
  type: "before_agent_start",
  prompt: "do task",
  systemPrompt: "BASE SYSTEM PROMPT\nYou are helpful.",
  systemPromptOptions: {},
});
const prompt = baResults.map((r) => r?.systemPrompt).find((p) => p);
check("returns systemPrompt", Boolean(prompt));
check("prompt contains guard block", prompt?.includes("Output Degradation Guard"));
check("prompt keeps base prompt", prompt?.includes("BASE SYSTEM PROMPT"));

// --- Scenario 7: agent_start resets counters ---
console.log("\n--- Scenario 7: agent_start resets, degeneration injects again ---");
sentMessages.length = 0;
emit("agent_start", { type: "agent_start" });
emit("turn_start", { type: "turn_start", turnIndex: 0 });
emit("turn_end", makeTurn(0, degenerateText(10)));
check("injection after agent_start reset", sentMessages.length === 1, `got ${sentMessages.length}`);

// --- Scenario 8: mixed short and long degeneration patterns ---
console.log("\n--- Scenario 8: short 3-repeat pattern triggers ---");
sentMessages.length = 0;
emit("agent_start", { type: "agent_start" });
emit("turn_start", { type: "turn_start", turnIndex: 0 });
emit("turn_end", makeTurn(0, degenerateText(3)));
check("3x 御坂 (6 chars) triggers injection", sentMessages.length === 1, `got ${sentMessages.length}`);

// --- Scenario 9: non-assistant message ignored ---
console.log("\n--- Scenario 9: user message (not assistant) ignored ---");
sentMessages.length = 0;
emit("agent_start", { type: "agent_start" });
emit("turn_start", { type: "turn_start", turnIndex: 0 });
emit("turn_end", {
  type: "turn_end",
  turnIndex: 0,
  message: { role: "user", content: degenerateText(11), timestamp: 0 },
  toolResults: [],
});
check("user message ignored", sentMessages.length === 0, `got ${sentMessages.length}`);

// --- Scenario 10: assistant message with only tool calls (no text) ---
console.log("\n--- Scenario 10: assistant with only tool calls, no text ---");
sentMessages.length = 0;
emit("agent_start", { type: "agent_start" });
emit("turn_start", { type: "turn_start", turnIndex: 0 });
emit("turn_end", {
  type: "turn_end",
  turnIndex: 0,
  message: {
    role: "assistant",
    content: [{ type: "tool_call", name: "bash" }],
    usage: {}, stopReason: "toolUse", timestamp: 0,
  },
  toolResults: [],
});
check("tool-call-only message ignored", sentMessages.length === 0, `got ${sentMessages.length}`);

console.log(`\n=== RESULT: ${pass ? "ALL PASS" : "FAILURES DETECTED"} ===`);
process.exit(pass ? 0 : 1);
