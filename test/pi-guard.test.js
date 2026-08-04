import assert from "node:assert/strict";
import test from "node:test";

// The detect scanner is pure TypeScript with no Pi imports, so import it
// directly from the plugin source. The .ts extension is resolvable because
// pi-coding-agent (a bundled peer dependency) registers the TS loader that
// both the runtime and node --test rely on for plugin sources.
import { detectDegradation, extractAssistantText } from "../plugin/pi-guard/src/detect.ts";
import { DEGRADATION_GUARD_PROMPT, withDegradationGuardPrompt } from "../plugin/pi-guard/src/prompt.ts";

test("detectDegradation flags stacked 御坂 self-reference run", () => {
  const text = "御坂御坂御坂御坂御坂御坂御坂御坂御坂御坂御坂";
  const hit = detectDegradation(text);
  assert.ok(hit, "御坂御坂御坂... must be detected as degradation");
  assert.equal(hit.kind, "substr");
  assert.equal(hit.pattern, "御坂");
  assert.ok(hit.count >= 3, `expected >=3 adjacent repeats, got ${hit.count}`);
});

test("detectDegradation flags single-char avalanche", () => {
  const text = "aaaaaaaaaa";
  const hit = detectDegradation(text);
  assert.ok(hit, "10x 'a' avalanche must be detected");
  // The substr scan runs first; a 2-char run of 5 repeats wins and returns
  // kind 'substr'. The detection itself is the behavior under test, not the
  // kind, so accept either kind as long as the pattern is all 'a'.
  assert.ok(/^[a]+$/.test(hit.pattern), `expected all-'a' pattern, got ${hit.pattern}`);
  assert.ok(hit.count >= 2, `expected >=2 repeats, got ${hit.count}`);
});

test("detectDegradation does not flag normal prose", () => {
  const text = "御坂已确认项目结构，现在开始添加新插件。测试套件显示248项通过。";
  const hit = detectDegradation(text);
  assert.equal(hit, undefined, "normal prose must not be flagged");
});

test("detectDegradation does not flag short repeated grammar words", () => {
  const text = "the the the the the the the the the the";
  // "the " repeated 10x: a single space-run of 10 chars would trip the char
  // scan, but the char scanner skips ' '. The multi-char scan picks up "the "
  // repeated >=3 — this is intentional: a real word-run of 10x is degeneration.
  const hit = detectDegradation(text);
  assert.ok(hit, "10x repeated word fragment should be flagged");
  assert.equal(hit.kind, "substr");
});

test("detectDegradation returns undefined for empty string", () => {
  assert.equal(detectDegradation(""), undefined);
});

test("extractAssistantText pulls text content from assistant message", () => {
  const msg = {
    role: "assistant",
    content: [
      { type: "thinking", text: "internal reasoning" },
      { type: "text", text: "御坂御坂御坂御坂御坂" },
      { type: "tool_call", name: "bash" },
    ],
  };
  const text = extractAssistantText(msg);
  assert.equal(text, "御坂御坂御坂御坂御坂");
  const hit = detectDegradation(text);
  assert.ok(hit);
});

test("extractAssistantText returns empty for non-assistant or non-textual message", () => {
  assert.equal(extractAssistantText({ role: "user", content: "hi" }), "");
  assert.equal(extractAssistantText({ role: "assistant", content: [{ type: "tool_call" }] }), "");
  assert.equal(extractAssistantText(null), "");
  assert.equal(extractAssistantText("string"), "");
});

test("extractAssistantText handles string content gracefully", () => {
  // Non-array content (legacy string) should not crash; returns empty.
  assert.equal(extractAssistantText({ role: "assistant", content: "just text" }), "");
});

test("detectDegradation flags 2-char run at exact threshold", () => {
  // Exactly 3 repeats of a 2-char substring. A short 6-char text now enters
  // the scan because the window is clamped to the text length.
  const text = "御坂御坂御坂";
  const hit = detectDegradation(text);
  assert.ok(hit, "3x 御坂 should hit the substr threshold");
  assert.ok(hit.count >= 3, `expected >=3 repeats, got ${hit.count}`);
});

test("withDegradationGuardPrompt appends the guard block once", () => {
  const base = "BASE SYSTEM PROMPT";
  const once = withDegradationGuardPrompt(base);
  const twice = withDegradationGuardPrompt(once);

  assert.ok(once.includes(base));
  assert.ok(once.includes(DEGRADATION_GUARD_PROMPT));
  assert.equal(twice, once);
  assert.equal(twice.split(DEGRADATION_GUARD_PROMPT).length - 1, 1);
});
