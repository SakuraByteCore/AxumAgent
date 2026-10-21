import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureTodoProgressPolicy,
  ensureParallelToolBatchingPolicy,
  ensureFocusExecutionPolicy,
  ensureSubagentDelegationPolicy,
  SUBAGENT_POLICY_BEGIN,
  SUBAGENT_POLICY_END,
  TODO_POLICY_BEGIN,
  TODO_POLICY_END,
  PARALLEL_POLICY_BEGIN,
  PARALLEL_POLICY_END,
  FOCUS_POLICY_BEGIN,
  FOCUS_POLICY_END,
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

test("todo progress policy: creates the file, is idempotent, and stores mode 600", (t) => {
  const env = withTempEnv(t);
  const result = ensureTodoProgressPolicy({ env });
  const content = fs.readFileSync(result.path, "utf8");
  assert.equal(result.changed, true);
  assert.ok(content.includes(TODO_POLICY_BEGIN));
  assert.ok(content.includes(TODO_POLICY_END));
  assert.ok(content.includes("Todo Progress Policy"));
  assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
  assert.equal(ensureTodoProgressPolicy({ env }).changed, false, "idempotent second run");
});

test("todo progress policy: replaces only its own block on upgrade, keeping user content", (t) => {
  const env = withTempEnv(t);
  const target = resolveAppendSystemPromptFile(env);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `My custom rules.\n${TODO_POLICY_BEGIN}\nstale todo draft\n${TODO_POLICY_END}\n`);
  const result = ensureTodoProgressPolicy({ env });
  const content = fs.readFileSync(target, "utf8");
  assert.equal(result.changed, true);
  assert.ok(!content.includes("stale todo draft"));
  assert.ok(content.includes("My custom rules."), "surrounding user content untouched");
  assert.ok(content.includes("progress panel"));
});

test("parallel tool batching policy: creates the file, is idempotent, and stores mode 600", (t) => {
  const env = withTempEnv(t);
  const result = ensureParallelToolBatchingPolicy({ env });
  const content = fs.readFileSync(result.path, "utf8");
  assert.equal(result.changed, true);
  assert.ok(content.includes(PARALLEL_POLICY_BEGIN));
  assert.ok(content.includes(PARALLEL_POLICY_END));
  assert.ok(content.includes("Parallel Tool Batching Policy"));
  assert.ok(content.includes("Never batch"));
  assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
  assert.equal(ensureParallelToolBatchingPolicy({ env }).changed, false, "idempotent second run");
});

test("parallel tool batching policy: replaces only its own block on upgrade, keeping user content", (t) => {
  const env = withTempEnv(t);
  const target = resolveAppendSystemPromptFile(env);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `My custom rules.\n${PARALLEL_POLICY_BEGIN}\nstale parallel draft\n${PARALLEL_POLICY_END}\n`);
  const result = ensureParallelToolBatchingPolicy({ env });
  const content = fs.readFileSync(target, "utf8");
  assert.equal(result.changed, true);
  assert.ok(!content.includes("stale parallel draft"));
  assert.ok(content.includes("My custom rules."), "surrounding user content untouched");
  assert.ok(content.includes("Always batch in one message"));
});

test("focus execution policy: creates the file, is idempotent, and stores mode 600", (t) => {
  const env = withTempEnv(t);
  const result = ensureFocusExecutionPolicy({ env });
  const content = fs.readFileSync(result.path, "utf8");
  assert.equal(result.changed, true);
  assert.ok(content.includes(FOCUS_POLICY_BEGIN));
  assert.ok(content.includes(FOCUS_POLICY_END));
  assert.ok(content.includes("Focus Execution Policy"));
  assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
  assert.equal(ensureFocusExecutionPolicy({ env }).changed, false, "idempotent second run");
});

test("focus execution policy: replaces only its own block on upgrade, keeping user content", (t) => {
  const env = withTempEnv(t);
  const target = resolveAppendSystemPromptFile(env);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `My custom rules.\n${FOCUS_POLICY_BEGIN}\nstale focus draft\n${FOCUS_POLICY_END}\n`);
  const result = ensureFocusExecutionPolicy({ env });
  const content = fs.readFileSync(target, "utf8");
  assert.equal(result.changed, true);
  assert.ok(!content.includes("stale focus draft"));
  assert.ok(content.includes("My custom rules."), "surrounding user content untouched");
  assert.ok(content.includes("performing the process"));
});

test("policy blocks coexist: todo and parallel blocks upsert independently", (t) => {
  const env = withTempEnv(t);
  ensureTodoProgressPolicy({ env });
  ensureParallelToolBatchingPolicy({ env });
  ensureFocusExecutionPolicy({ env });
  const target = resolveAppendSystemPromptFile(env);
  let content = fs.readFileSync(target, "utf8");
  assert.ok(content.includes(TODO_POLICY_BEGIN));
  assert.ok(content.includes(PARALLEL_POLICY_BEGIN));
  assert.ok(content.includes(FOCUS_POLICY_BEGIN));
  assert.ok(content.indexOf(TODO_POLICY_BEGIN) < content.indexOf(PARALLEL_POLICY_BEGIN));
  ensureTodoProgressPolicy({ env });
  content = fs.readFileSync(target, "utf8");
  assert.ok(content.includes(TODO_POLICY_BEGIN));
  assert.ok(content.includes(PARALLEL_POLICY_BEGIN), "todo re-upsert does not clobber parallel block");
});

test("subagent delegation policy: creates the file, is idempotent, and stores mode 600", (t) => {
  const env = withTempEnv(t);
  const result = ensureSubagentDelegationPolicy({ env });
  const content = fs.readFileSync(result.path, "utf8");
  assert.equal(result.changed, true);
  assert.ok(content.includes(SUBAGENT_POLICY_BEGIN));
  assert.ok(content.includes(SUBAGENT_POLICY_END));
  assert.ok(content.includes("Delegate only when it pays"));
  assert.ok(content.includes("Foreground first"));
  assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
  assert.equal(ensureSubagentDelegationPolicy({ env }).changed, false, "idempotent second run");
});

test("subagent delegation policy: cleans up orphaned v1/v2 blocks while refreshing to v3", (t) => {
  const env = withTempEnv(t);
  const target = resolveAppendSystemPromptFile(env);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `My custom rules.\n<!-- axum:subagent-delegation-policy v1 -->\nstale v1 guidance\n<!-- /axum:subagent-delegation-policy -->\n<!-- axum:subagent-delegation-policy v2 -->\nstale v2 guidance\n<!-- /axum:subagent-delegation-policy -->\n`);
  const result = ensureSubagentDelegationPolicy({ env });
  const content = fs.readFileSync(target, "utf8");
  assert.equal(result.changed, true);
  assert.ok(!content.includes("axum:subagent-delegation-policy v1"), "legacy v1 block removed");
  assert.ok(!content.includes("stale v1 guidance"));
  assert.ok(!content.includes("axum:subagent-delegation-policy v2"), "legacy v2 block removed");
  assert.ok(!content.includes("stale v2 guidance"));
  assert.ok(content.includes(SUBAGENT_POLICY_BEGIN), "v3 block installed");
  assert.ok(content.includes("My custom rules."), "surrounding user content untouched");
  assert.equal(ensureSubagentDelegationPolicy({ env }).changed, false, "idempotent after cleanup");
});
