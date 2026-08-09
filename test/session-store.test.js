import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deleteSession, deleteAllSessions, listSessions, readSession } from "../src/session-store.js";

function makeAgentRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-sessions-"));
  return { dir, env: { PI_CODING_AGENT_DIR: dir } };
}

function writeSessionFile(root, projectDir, fileName, lines) {
  const dir = path.join(root, "sessions", projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

test("listSessions returns empty when sessions dir does not exist", () => {
  const { env } = makeAgentRoot();
  const result = listSessions({ env });
  assert.deepEqual(result.projects, []);
});

test("listSessions enumerates projects and sessions with meta", () => {
  const { dir, env } = makeAgentRoot();
  writeSessionFile(dir, "--D--project-A--", "2026-08-01T10-00-00-000Z_abc.jsonl", [
    { type: "session", version: 3, id: "abc", timestamp: "2026-08-01T10:00:00.000Z", cwd: "D:\\project\\A" },
    { type: "message", id: "m1", parentId: null, timestamp: "2026-08-01T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello world" }] } },
    { type: "message", id: "m2", parentId: "m1", timestamp: "2026-08-01T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi there" }] } },
  ]);

  writeSessionFile(dir, "--D--project-B--", "2026-08-02T10-00-00-000Z_def.jsonl", [
    { type: "session", version: 3, id: "def", timestamp: "2026-08-02T10:00:00.000Z", cwd: "D:\\project\\B" },
    { type: "message", id: "m3", parentId: null, timestamp: "2026-08-02T10:00:01.000Z", message: { role: "user", content: "test prompt" } },
  ]);

  const result = listSessions({ env });
  assert.equal(result.projects.length, 2);
  const projA = result.projects.find((p) => p.dir === "--D--project-A--");
  assert.ok(projA);
  assert.equal(projA.count, 1);
  assert.equal(projA.cwdHint, "D:\\project\\A");
  const sessA = projA.sessions[0];
  assert.ok(sessA.exists);
  assert.equal(sessA.id, "abc");
  assert.equal(sessA.messageCount, 2);
  assert.equal(sessA.summary, "hello world");
});

test("listSessions skips non-jsonl files and invalid first lines", () => {
  const { dir, env } = makeAgentRoot();
  fs.mkdirSync(path.join(dir, "sessions", "--X--"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sessions", "--X--", "readme.txt"), "not jsonl\n");
  fs.writeFileSync(path.join(dir, "sessions", "--X--", "bad.jsonl"), "not json\n");
  const result = listSessions({ env });
  // bad.jsonl has no valid session line → included but empty meta
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].sessions[0].id, "");
});

test("readSession returns messages with path-traversal guard", () => {
  const { dir, env } = makeAgentRoot();
  writeSessionFile(dir, "--D--proj--", "sess1.jsonl", [
    { type: "session", version: 3, id: "sid", timestamp: "2026-08-01T10:00:00.000Z", cwd: "D:\\proj" },
    { type: "message", id: "m1", parentId: null, timestamp: "2026-08-01T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
  ]);
  const result = readSession({ file: "--D--proj--/sess1.jsonl", env });
  assert.equal(result.session.id, "sid");
  assert.equal(result.count, 1);
  assert.equal(result.messages[0].role, "user");
  assert.equal(result.messages[0].text, "hello");

  assert.throws(() => readSession({ file: "../../../etc/passwd", env }), /Invalid session file path|not found/);
});

test("deleteSession removes file and cleans empty project dir", () => {
  const { dir, env } = makeAgentRoot();
  writeSessionFile(dir, "--D--proj--", "sess1.jsonl", [
    { type: "session", version: 3, id: "sid", timestamp: "2026-08-01T10:00:00.000Z", cwd: "D:\\proj" },
  ]);
  const sessionsDir = path.join(dir, "sessions");
  assert.ok(fs.existsSync(path.join(sessionsDir, "--D--proj--", "sess1.jsonl")));

  const result = deleteSession({ file: "--D--proj--/sess1.jsonl", env });
  assert.equal(result.deleted, true);
  assert.ok(!fs.existsSync(path.join(sessionsDir, "--D--proj--")));
});

test("deleteSession returns not-found for missing file", () => {
  const { dir, env } = makeAgentRoot();
  const result = deleteSession({ file: "--nope--/missing.jsonl", env });
  assert.equal(result.deleted, false);
});

test("deleteSession rejects path traversal", () => {
  const { dir, env } = makeAgentRoot();
  assert.throws(() => deleteSession({ file: "../../secret.txt", env }), /Invalid session file path/);
});

test("deleteAllSessions removes all jsonl files and cleans project dirs", () => {
  const { dir, env } = makeAgentRoot();
  writeSessionFile(dir, "--D--proj-A--", "sess1.jsonl", [
    { type: "session", version: 3, id: "s1", timestamp: "2026-08-01T10:00:00.000Z", cwd: "D:\\proj\\A" },
  ]);
  writeSessionFile(dir, "--D--proj-A--", "sess2.jsonl", [
    { type: "session", version: 3, id: "s2", timestamp: "2026-08-02T10:00:00.000Z", cwd: "D:\\proj\\A" },
  ]);
  writeSessionFile(dir, "--D--proj-B--", "sess3.jsonl", [
    { type: "session", version: 3, id: "s3", timestamp: "2026-08-03T10:00:00.000Z", cwd: "D:\\proj\\B" },
  ]);
  const sessionsDir = path.join(dir, "sessions");
  assert.ok(fs.existsSync(path.join(sessionsDir, "--D--proj-A--", "sess1.jsonl")));

  const result = deleteAllSessions({ env });
  assert.equal(result.total, 3);
  assert.equal(result.deleted, 3);
  assert.deepEqual(result.failed, []);
  assert.ok(!fs.existsSync(path.join(sessionsDir, "--D--proj-A--")));
  assert.ok(!fs.existsSync(path.join(sessionsDir, "--D--proj-B--")));
});

test("deleteAllSessions returns zero when sessions dir does not exist", () => {
  const { env } = makeAgentRoot();
  const result = deleteAllSessions({ env });
  assert.equal(result.total, 0);
  assert.equal(result.deleted, 0);
  assert.deepEqual(result.failed, []);
});

test("deleteAllSessions leaves non-jsonl files untouched", () => {
  const { dir, env } = makeAgentRoot();
  fs.mkdirSync(path.join(dir, "sessions", "--X--proj--"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sessions", "--X--proj--", "readme.txt"), "keep me\n");
  fs.writeFileSync(path.join(dir, "sessions", "--X--proj--", "s.jsonl"), JSON.stringify({ type: "session", version: 3, id: "sx", timestamp: "2026-08-01T10:00:00.000Z", cwd: "X:\\proj" }) + "\n");

  const result = deleteAllSessions({ env });
  assert.equal(result.total, 1);
  assert.equal(result.deleted, 1);
  const sessionsDir = path.join(dir, "sessions");
  assert.ok(fs.existsSync(path.join(sessionsDir, "--X--proj--", "readme.txt")), "non-jsonl file should survive");
});
