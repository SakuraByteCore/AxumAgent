import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { deleteAllSessions, deleteSession, getSessionsDir, listSessions, readSession } from "../src/session-store.js";

function makeEnv(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axum-sessions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { PI_CODING_AGENT_DIR: root };
}

function writeSession(env, project, name, lines) {
  const dir = path.join(getSessionsDir(env), project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), lines.join("\n") + "\n");
  return `${project}/${name}`;
}

const SESSION_LINE = JSON.stringify({ type: "session", id: "s1", timestamp: "2024-01-02T03:04:05Z", cwd: "/work/proj", version: 2 });
const USER_MSG = JSON.stringify({ type: "message", id: "m1", timestamp: "2024-01-02T03:04:06Z", message: { role: "user", content: "fix the flaky test" } });
const ASSISTANT_MSG = JSON.stringify({ type: "message", id: "m2", timestamp: "2024-01-02T03:04:07Z", message: { role: "assistant", content: [{ type: "text", text: "on it" }] } });

test("listSessions returns empty projects when sessions dir is missing", (t) => {
  const env = makeEnv(t);
  assert.deepEqual(listSessions({ env }), { projects: [] });
});

test("listSessions reports meta, summary and messageCount", (t) => {
  const env = makeEnv(t);
  writeSession(env, "-work-proj", "2024.jsonl", [SESSION_LINE, USER_MSG, ASSISTANT_MSG]);

  const { projects } = listSessions({ env });
  assert.equal(projects.length, 1);
  assert.equal(projects[0].dir, "-work-proj");
  assert.equal(projects[0].cwdHint, "/work/proj");
  assert.equal(projects[0].count, 1);

  const s = projects[0].sessions[0];
  assert.equal(s.id, "s1");
  assert.equal(s.cwd, "/work/proj");
  assert.equal(s.summary, "fix the flaky test");
  assert.equal(s.messageCount, 2);
  assert.equal(s.exists, true);
});

test("listSessions truncates summary to maxSummaryChars", (t) => {
  const env = makeEnv(t);
  const long = JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "x".repeat(500) } });
  writeSession(env, "p", "a.jsonl", [SESSION_LINE, long]);
  const { projects } = listSessions({ env, maxSummaryChars: 10 });
  assert.equal(projects[0].sessions[0].summary, "x".repeat(10));
});

test("listSessions tolerates files without a session header", (t) => {
  const env = makeEnv(t);
  writeSession(env, "p", "broken.jsonl", ["not json", USER_MSG]);
  const { projects } = listSessions({ env });
  const s = projects[0].sessions[0];
  assert.equal(s.id, "");
  assert.equal(s.messageCount, 0);
});

test("readSession rejects path traversal outside sessions dir", (t) => {
  const env = makeEnv(t);
  assert.throws(() => readSession({ file: "../../etc/passwd", env }), /Invalid session file path/);
});

test("readSession throws for missing file", (t) => {
  const env = makeEnv(t);
  assert.throws(() => readSession({ file: "p/nope.jsonl", env }), /Session file not found/);
});

test("readSession returns meta and role-tagged messages", (t) => {
  const env = makeEnv(t);
  const file = writeSession(env, "p", "a.jsonl", [SESSION_LINE, USER_MSG, ASSISTANT_MSG]);
  const result = readSession({ file, env });
  assert.equal(result.session.id, "s1");
  assert.equal(result.count, 2);
  assert.deepEqual(result.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(result.messages[1].text, "on it");
});

test("readSession caps message content at maxContentChars", (t) => {
  const env = makeEnv(t);
  const long = JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "y".repeat(100) } });
  const file = writeSession(env, "p", "a.jsonl", [SESSION_LINE, long]);
  const result = readSession({ file, env, maxContentChars: 5 });
  assert.equal(result.messages[0].text, "yyyyy");
  assert.equal(result.messages[0].truncated, true);
});

test("deleteSession removes the file and prunes empty project dir", (t) => {
  const env = makeEnv(t);
  const file = writeSession(env, "p", "a.jsonl", [SESSION_LINE]);
  const result = deleteSession({ file, env });
  assert.deepEqual(result, { deleted: true, file });
  assert.equal(fs.existsSync(path.join(getSessionsDir(env), "p")), false);
});

test("deleteSession keeps project dir when other sessions remain", (t) => {
  const env = makeEnv(t);
  writeSession(env, "p", "a.jsonl", [SESSION_LINE]);
  const file = writeSession(env, "p", "b.jsonl", [SESSION_LINE]);
  deleteSession({ file, env });
  assert.equal(fs.existsSync(path.join(getSessionsDir(env), "p")), true);
  assert.equal(fs.existsSync(path.join(getSessionsDir(env), "p", "a.jsonl")), true);
});

test("deleteSession reports not found and rejects traversal", (t) => {
  const env = makeEnv(t);
  assert.deepEqual(deleteSession({ file: "p/nope.jsonl", env }), { deleted: false, file: "p/nope.jsonl", reason: "not found" });
  assert.throws(() => deleteSession({ file: "../escape.jsonl", env }), /Invalid session file path/);
});

test("deleteAllSessions clears every project", (t) => {
  const env = makeEnv(t);
  writeSession(env, "p1", "a.jsonl", [SESSION_LINE]);
  writeSession(env, "p1", "b.jsonl", [SESSION_LINE]);
  writeSession(env, "p2", "c.jsonl", [SESSION_LINE]);
  const result = deleteAllSessions({ env });
  assert.equal(result.deleted, 3);
  assert.equal(result.total, 3);
  assert.deepEqual(result.failed, []);
  assert.equal(fs.existsSync(getSessionsDir(env)), true);
  assert.deepEqual(fs.readdirSync(getSessionsDir(env)), []);
});

test("deleteAllSessions on missing dir is a no-op", (t) => {
  const env = makeEnv(t);
  assert.deepEqual(deleteAllSessions({ env }), { deleted: 0, total: 0, failed: [] });
});
