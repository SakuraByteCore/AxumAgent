import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function run(args) {
  return spawnSync(process.execPath, ["bin/axum.js", ...args], { encoding: "utf8" });
}

test("axum without args shows Axum command help", () => {
  const result = run([]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:\n  axum\n  axum code \[pi args\.\.\.\]/);
  assert.match(result.stdout, /provider web/);
});

test("provider help only exposes web setup", () => {
  const result = run(["provider", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /axum provider web/);
  assert.doesNotMatch(result.stdout, /add-openai/);
  assert.doesNotMatch(result.stdout, /provider list/);
});

test("command-style provider configuration is removed", () => {
  const result = run(["provider", "add-openai", "--name", "x"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown provider command: add-openai/);
});
