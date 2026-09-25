import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  deleteAllPromptHistory,
  deletePromptHistoryEntries,
  exportPromptHistory,
  importPromptHistory,
  listPromptHistory,
} from "../src/prompt-history-store.js";

function makeEnv(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axum-prompt-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { PI_CODING_AGENT_DIR: root };
}

function historyFile(env, project) {
  return path.join(env.PI_CODING_AGENT_DIR, "sessions", project, "prompt-history");
}

function writeRaw(env, project, entries) {
  const file = historyFile(env, project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return file;
}

test("", (t) => {
  const env = makeEnv(t);
  assert.deepEqual(listPromptHistory({ env }), { projects: [], totalEntries: 0, totalDuplicates: 0 });
});

test("", (t) => {
  const env = makeEnv(t);
  writeRaw(env, "--home-proj--", ["first", "second", "third"]);

  const result = listPromptHistory({ env });
  assert.equal(result.totalEntries, 3);
  assert.equal(result.totalDuplicates, 0);
  assert.equal(result.projects.length, 1);
  const project = result.projects[0];
  assert.equal(project.dir, "--home-proj--");
  assert.equal(project.cwdHint, "/home/proj");
  assert.equal(project.total, 3);
  assert.deepEqual(project.entries.map((e) => [e.index, e.text]), [
    [2, "third"],
    [1, "second"],
    [0, "first"],
  ]);
});

test("", (t) => {
  const env = makeEnv(t);
  const file = historyFile(env, "--p--");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [JSON.stringify("dup"), "not-json", JSON.stringify(42), JSON.stringify("dup"), JSON.stringify(""), JSON.stringify("real")].join("\n") + "\n");

  const result = listPromptHistory({ env });
  assert.equal(result.totalDuplicates, 1);
  const project = result.projects[0];
  assert.equal(project.duplicates, 1);
  assert.deepEqual(project.entries.map((e) => e.text), ["real", "dup"]);
  assert.equal(project.total, 2);
});

test("", (t) => {
  const env = makeEnv(t);
  const long = "x".repeat(800);
  writeRaw(env, "--p--", [long]);

  const [entry] = listPromptHistory({ env, maxEntryChars: 10 }).projects[0].entries;
  assert.equal(entry.text, "x".repeat(10));
  assert.equal(entry.truncated, true);
  assert.equal(entry.length, 800);
});

test("", (t) => {
  const env = makeEnv(t);
  writeRaw(env, "--p--", ["keep", "drop", "also-drop"]);

  const result = deletePromptHistoryEntries({ env, project: "--p--", indexes: [1, 2] });
  assert.equal(result.deleted, 2);
  assert.equal(result.total, 3);
  assert.deepEqual(result.failed, []);
  assert.equal(fs.readFileSync(historyFile(env, "--p--"), "utf8"), JSON.stringify("keep") + "\n");
  assert.equal(fs.existsSync(path.dirname(historyFile(env, "--p--"))), true);

  const after = deletePromptHistoryEntries({ env, project: "--p--", indexes: [0] });
  assert.equal(after.deleted, 1);
  assert.equal(fs.existsSync(historyFile(env, "--p--")), false);
  assert.equal(fs.existsSync(path.dirname(historyFile(env, "--p--"))), false);
});

test("", (t) => {
  const env = makeEnv(t);
  writeRaw(env, "--p--", ["one", "two"]);

  const result = deletePromptHistoryEntries({ env, project: "--p--", indexes: [0, 5, "bad"] });
  assert.equal(result.deleted, 1);
  assert.equal(result.total, 2);
  assert.equal(result.failed.length, 2);
  assert.deepEqual(result.failed.map((f) => f.reason), ["out of range", "out of range"]);
  assert.equal(fs.readFileSync(historyFile(env, "--p--"), "utf8"), JSON.stringify("two") + "\n");
});

test("", (t) => {
  const env = makeEnv(t);
  writeRaw(env, "--p--", ["one"]);
  assert.throws(() => deletePromptHistoryEntries({ env, project: "../evil", indexes: [0] }), /Invalid project/);
  assert.throws(() => deletePromptHistoryEntries({ env, project: "a/b", indexes: [0] }), /Invalid project/);
  assert.throws(() => deletePromptHistoryEntries({ env, project: "..", indexes: [0] }), /Invalid project/);
  assert.equal(fs.readFileSync(historyFile(env, "--p--"), "utf8"), JSON.stringify("one") + "\n");
});

test("", (t) => {
  const env = makeEnv(t);
  assert.throws(() => deletePromptHistoryEntries({ env, project: "--p--", indexes: [] }), /indexes must be a non-empty array/);
  assert.throws(() => deletePromptHistoryEntries({ env, project: "", indexes: [0] }), /project is required/);
});

test("", (t) => {
  const env = makeEnv(t);
  writeRaw(env, "--a--", ["a1", "a2"]);
  writeRaw(env, "--b--", ["b1"]);

  const result = deleteAllPromptHistory({ env });
  assert.equal(result.deleted, 3);
  assert.equal(result.total, 3);
  assert.deepEqual(result.failed, []);
  assert.equal(fs.existsSync(historyFile(env, "--a--")), false);
  assert.equal(fs.existsSync(historyFile(env, "--b--")), false);
});

test("", (t) => {
  const env = makeEnv(t);
  assert.deepEqual(deleteAllPromptHistory({ env }), { deleted: 0, total: 0, failed: [] });
});

test("", (t) => {
  const env = makeEnv(t);
  const file = historyFile(env, "--p--");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [JSON.stringify("dup"), JSON.stringify("dup"), JSON.stringify("x".repeat(40))].join("\n") + "\n");

  const exported = exportPromptHistory({ env });
  assert.equal(exported.totalEntries, 2);
  assert.equal(exported.items[0].project, "--p--");
  assert.deepEqual(exported.items[0].entries, ["dup", "x".repeat(40)]);

  assert.throws(() => exportPromptHistory({ env, maxBytes: 10 }), /exceeds 10 bytes/);
});

test("", (t) => {
  const env = makeEnv(t);
  writeRaw(env, "--a--", ["a"]);
  writeRaw(env, "--b--", ["b"]);

  const exported = exportPromptHistory({ env, projects: ["--b--"] });
  assert.deepEqual(exported.items.map((i) => i.project), ["--b--"]);
});

test("", (t) => {
  const env = makeEnv(t);
  writeRaw(env, "--p--", ["old"]);

  const merged = importPromptHistory({ items: [{ project: "--p--", entries: ["old", "new"] }], env });
  assert.equal(merged.added, 1);
  assert.equal(merged.skipped, 1);
  assert.equal(merged.replaced, 0);
  assert.equal(merged.failed.length, 0);
  assert.equal(fs.readFileSync(historyFile(env, "--p--"), "utf8"), [JSON.stringify("old"), JSON.stringify("new")].join("\n") + "\n");
});

test("", (t) => {
  const env = makeEnv(t);
  writeRaw(env, "--p--", ["old", "old"]);

  const overwritten = importPromptHistory({ items: [{ project: "--p--", entries: ["fresh", "fresh", "other"] }], env, overwrite: true });
  assert.equal(overwritten.replaced, 3);
  assert.equal(overwritten.added, 0);
  const entries = listPromptHistory({ env }).projects[0].entries.map((e) => e.text);
  assert.deepEqual(entries, ["other", "fresh"]);
});

test("", (t) => {
  const env = makeEnv(t);
  const result = importPromptHistory({ items: [{ project: "--new--", entries: ["hello"] }, { project: "", entries: ["x"] }], env });
  assert.equal(result.added, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].reason, "empty project name");
  assert.equal(fs.readFileSync(historyFile(env, "--new--"), "utf8"), JSON.stringify("hello") + "\n");
});

test("", (t) => {
  const env = makeEnv(t);
  const entries = Array.from({ length: 120 }, (_, i) => `prompt-${i}`);
  importPromptHistory({ items: [{ project: "--p--", entries }], env });

  const listed = listPromptHistory({ env }).projects[0].entries;
  assert.equal(listed.length, 100);
  assert.equal(listed[0].text, "prompt-119");
  assert.equal(listed[99].text, "prompt-20");
});

test("", (t) => {
  const src = makeEnv(t);
  const dst = makeEnv(t);
  writeRaw(src, "--proj--", ["alpha", "beta"]);
  const exported = exportPromptHistory({ env: src });
  assert.equal(exported.totalEntries, 2);

  const imported = importPromptHistory({ items: exported.items, env: dst });
  assert.equal(imported.added, 2);
  assert.deepEqual(listPromptHistory({ env: dst }).projects[0].entries.map((e) => e.text), ["beta", "alpha"]);
});
