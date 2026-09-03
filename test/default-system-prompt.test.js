import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SUBAGENT_POLICY_BEGIN,
  SUBAGENT_POLICY_END,
  ensureSubagentDelegationPolicy,
  resolveAppendSystemPromptFile,
} from "../src/default-system-prompt.js";

function withTempEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-prompt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { ...process.env, PI_CODING_AGENT_DIR: dir };
}

test("resolves APPEND_SYSTEM.md under the agent dir", () => {
  const env = { ...process.env, PI_CODING_AGENT_DIR: path.join(os.tmpdir(), "axum-resolve") };
  assert.equal(resolveAppendSystemPromptFile(env), path.join(env.PI_CODING_AGENT_DIR, "APPEND_SYSTEM.md"));
});

test("creates the file with the policy block when missing", (t) => {
  const env = withTempEnv(t);
  const result = ensureSubagentDelegationPolicy({ env });
  const content = fs.readFileSync(result.path, "utf8");
  assert.equal(result.changed, true);
  assert.ok(content.includes(SUBAGENT_POLICY_BEGIN));
  assert.ok(content.includes(SUBAGENT_POLICY_END));
  assert.ok(content.includes("Subagent Delegation Policy"));
});

test("is idempotent when the block is already up to date", (t) => {
  const env = withTempEnv(t);
  assert.equal(ensureSubagentDelegationPolicy({ env }).changed, true);
  assert.equal(ensureSubagentDelegationPolicy({ env }).changed, false);
});

test("appends without clobbering pre-existing user content", (t) => {
  const env = withTempEnv(t);
  const target = resolveAppendSystemPromptFile(env);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "My custom rules.\n");
  const result = ensureSubagentDelegationPolicy({ env });
  const content = fs.readFileSync(result.path, "utf8");
  assert.equal(result.changed, true);
  assert.ok(content.startsWith("My custom rules.\n\n"));
  assert.ok(content.includes(SUBAGENT_POLICY_BEGIN));
});

test("replaces only the marked block on upgrade, keeping surrounding content", (t) => {
  const env = withTempEnv(t);
  const target = resolveAppendSystemPromptFile(env);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `before\n${SUBAGENT_POLICY_BEGIN}\nold policy draft\n${SUBAGENT_POLICY_END}\nafter\n`);
  const result = ensureSubagentDelegationPolicy({ env });
  const content = fs.readFileSync(result.path, "utf8");
  assert.equal(result.changed, true);
  assert.ok(content.startsWith("before\n"));
  assert.ok(content.endsWith("after\n"));
  assert.ok(!content.includes("old policy draft"));
  assert.ok(content.includes("Agent` tool"));
});

test("stores the file with mode 600", (t) => {
  const env = withTempEnv(t);
  const result = ensureSubagentDelegationPolicy({ env });
  const mode = fs.statSync(result.path).mode & 0o777;
  assert.equal(mode, 0o600);
});
