import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureTodoProgressPolicy,
  TODO_POLICY_BEGIN,
  TODO_POLICY_END,
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
