import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deleteSystemPromptFile, diffSystemPromptFile, readSystemPromptFile, resolveSystemPromptFile, saveSystemPromptFile } from "../src/system-prompt-config.js";

test("resolves global append prompt under Pi agent dir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-system-global-"));
  const target = resolveSystemPromptFile({ scope: "global", mode: "append", env: { PI_CODING_AGENT_DIR: dir } });
  assert.equal(target.path, path.join(dir, "APPEND_SYSTEM.md"));
  assert.equal(target.replaceDefault, false);
});

test("resolves project system prompt under cwd .pi", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "axum-system-project-"));
  const target = resolveSystemPromptFile({ scope: "project", mode: "system", cwd });
  assert.equal(target.path, path.join(cwd, ".pi", "SYSTEM.md"));
  assert.equal(target.replaceDefault, true);
});

test("diffs and saves system prompt with hash guard", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-system-save-"));
  const options = { scope: "global", mode: "append", env: { PI_CODING_AGENT_DIR: dir } };
  const empty = readSystemPromptFile(options);
  const diff = diffSystemPromptFile({ ...options, content: "Be sharp.\n" });
  assert.match(diff.diff, /\+Be sharp\./);
  const saved = saveSystemPromptFile({ ...options, content: "Be sharp.", baseHash: empty.hash });
  assert.equal(saved.content, "Be sharp.\n");
  assert.throws(() => saveSystemPromptFile({ ...options, content: "Overwrite.", baseHash: empty.hash }), /changed on disk/);
});

test("rejects empty system prompt saves", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-system-empty-"));
  assert.throws(() => saveSystemPromptFile({ scope: "global", mode: "append", content: "", env: { PI_CODING_AGENT_DIR: dir } }), /cannot be empty/);
});

test("resolves plan template via HOME regardless of scope and Pi agent dir", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "axum-plan-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const target = resolveSystemPromptFile({ scope: "project", mode: "plan", env: { PI_CODING_AGENT_DIR: "/nonexistent-agent-dir" } });
    assert.equal(target.path, path.join(home, ".pi", "agent", "plan-prompt.md"));
    assert.equal(target.scope, "global");
    assert.equal(target.mode, "plan");
    assert.equal(target.replaceDefault, false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("saves plan template only with the requirement placeholder and deletes it on request", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "axum-plan-save-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const options = { scope: "project", mode: "plan", env: { PI_CODING_AGENT_DIR: "/nonexistent-agent-dir" } };
    const planPath = path.join(home, ".pi", "agent", "plan-prompt.md");
    assert.throws(() => saveSystemPromptFile({ ...options, content: "no placeholder" }), /must include \{\{requirement\}\}/);
    assert.throws(() => saveSystemPromptFile({ ...options, content: "   " }), /cannot be empty/);
    const saved = saveSystemPromptFile({ ...options, content: "Plan: {{requirement}}" });
    assert.equal(saved.path, planPath);
    assert.equal(saved.content, "Plan: {{requirement}}\n");
    assert.equal(saved.exists, true);
    const removed = deleteSystemPromptFile(options);
    assert.equal(removed.deleted, true);
    assert.equal(removed.exists, false);
    assert.equal(fs.existsSync(planPath), false);
    assert.equal(deleteSystemPromptFile(options).deleted, false);
    assert.throws(() => deleteSystemPromptFile({ scope: "global", mode: "append", env: { PI_CODING_AGENT_DIR: home } }), /\/plan template/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
