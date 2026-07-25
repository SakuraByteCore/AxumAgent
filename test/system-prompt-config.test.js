import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { diffSystemPromptFile, readSystemPromptFile, resolveSystemPromptFile, saveSystemPromptFile } from "../src/system-prompt-config.js";

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
