import assert from "node:assert/strict";
import test from "node:test";

import {
  PI_RATE_LIMIT_429_PATTERN_SOURCE,
  PI_SUBAGENTS_PROACTIVE_MARKER,
  LEGACY_PI_SUBAGENTS_PROACTIVE_MARKER,
  applyBundledPiPatches,
  patchPiSubagentsProactiveDelegation,
  patchPiTuiStdinBuffer,
} from "../src/bundled-pi-patches.js";

test("429 pattern matches strict provider throttle shapes only", () => {
  const re = new RegExp(PI_RATE_LIMIT_429_PATTERN_SOURCE, "i");
  assert.ok(re.test("Error: 429: {\"message\":\"Too Many Requests\"}"));
  assert.ok(re.test("429 Too Many Requests"));
  assert.ok(re.test("  Error: 429: quota"));
  assert.equal(re.test("the file is 429 bytes long"), false);
  assert.equal(re.test("status 1429"), false);
});

test("patchPiTuiStdinBuffer throws when the paste constants are absent", () => {
  assert.throws(
    () => patchPiTuiStdinBuffer("const X = 1;"),
    /paste constants not found/,
  );
});

test("patchPiTuiStdinBuffer inserts the unbracketed-paste guard and is idempotent", () => {
  const content = [
    'const BRACKETED_PASTE_START = "\\x1b[200~";',
    'const BRACKETED_PASTE_END = "\\x1b[201~";',
    'class Parser {',
    '    process(str) {',
    '        if (str.length === 0 && this.buffer.length === 0) {',
    '            this.emitDataSequence("");',
    '            return;',
    '        }',
    '    }',
    '}',
    '',
  ].join("\n");
  const once = patchPiTuiStdinBuffer(content);
  assert.ok(once.includes("looksLikeUnbracketedPaste"));
  assert.ok(once.includes('this.emit("paste", str);'));
  const twice = patchPiTuiStdinBuffer(once);
  assert.equal(twice, once);
});

test("applyBundledPiPatches throws for a cache root without installed packages", () => {
  assert.throws(
    () => applyBundledPiPatches({ env: { ...process.env, AXUM_BUNDLED_PI_DIR: "/nonexistent-axum-cache" } }),
    /stdin buffer not found/,
  );
});

test("patchPiSubagentsProactiveDelegation rewrites passive tool wording and is idempotent", () => {
  const content = [
    'export const SUBAGENT_TOOL_PROMPT_SNIPPET = "Delegate to subagents; orchestrate in one workflowScript call.";',
    'const guideline = `Use subagent only when delegation is needed. keep`;',
  ].join("\n");
  const once = patchPiSubagentsProactiveDelegation(content);
  assert.ok(once.includes(PI_SUBAGENTS_PROACTIVE_MARKER));
  assert.ok(once.includes("Delegate aggressively to subagents"));
  assert.ok(once.includes("token cost is irrelevant"));
  assert.ok(once.includes("Default to subagent delegation"));
  assert.ok(!once.includes("Use subagent only when delegation is needed"));
  const twice = patchPiSubagentsProactiveDelegation(once);
  assert.equal(twice, once);
});

test("patchPiSubagentsProactiveDelegation upgrades a V1-patched bundle and clears the legacy marker", () => {
  const v1Patched = [
    "// " + LEGACY_PI_SUBAGENTS_PROACTIVE_MARKER + ": proactive delegation triggers (Axum).",
    'export const SUBAGENT_TOOL_PROMPT_SNIPPET = "Delegate proactively to subagents; orchestrate in one workflowScript call. When the request carries multiple independent tasks or requirements, partition them into non-overlapping scopes and launch all of them in one async workflow immediately, without a long planning pass first.";',
    'const guideline = `Use subagent proactively; do not wait for the user to explicitly request delegation. keep`;',
  ].join("\n");
  const upgraded = patchPiSubagentsProactiveDelegation(v1Patched);
  assert.ok(upgraded.includes(PI_SUBAGENTS_PROACTIVE_MARKER));
  assert.ok(!upgraded.includes(LEGACY_PI_SUBAGENTS_PROACTIVE_MARKER + ": proactive delegation triggers"));
  assert.ok(upgraded.includes("Delegate aggressively to subagents"));
  assert.ok(upgraded.includes("Default to subagent delegation"));
  assert.equal(patchPiSubagentsProactiveDelegation(upgraded), upgraded);
});

test("patchPiSubagentsProactiveDelegation skips upstream content that drifted", () => {
  const drifted = "export const SUBAGENT_TOOL_PROMPT_SNIPPET = \"something new\";";
  assert.equal(patchPiSubagentsProactiveDelegation(drifted), drifted);
});
