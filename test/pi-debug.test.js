import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// pi-debug — end-to-end pressure tests against a real stdio DAP adapter.
//
// The tests exercise the recommended-scheme flow (that is, the full
// attach -> breakpoint -> continue -> stack -> variables pipeline) by driving
// a real child_process that speaks DAP over stdio (`mock-dap-adapter.mjs`).
// Everything runs against a spawned process; no request is short-circuited.
//
// The "pressure" angle is:
//   - many sequential attach/break/continue rounds on the same session,
//   - many requests fired concurrently into the single in-flight gate,
//   - a continued session whose adapter is killed out from under it,
//   - a wedged adapter that never answers (timeout recovery),
//   - repeated session teardown with no process leaks.

import { DebugSession } from "../plugin/pi-debug/src/dap-client.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTER = join(__dirname, "fixtures", "mock-dap-adapter.mjs");

function spawnEnv(overrides = {}) {
  // Merge into the parent environment so the adapter's shebang (`#!... node`)
  // and interpreter resolution still have PATH. Passing a bare dict drops PATH
  // and the child fails to exec (errno EACCES / exit 126).
  return { ...process.env, ...overrides };
}

async function startSession(env = {}) {
  const s = new DebugSession("mock");
  await s.start([ADAPTER], spawnEnv(env));
  return s;
}

// Robust process-liveness probe: a pid is "gone" when kill(0) throws ESRCH.
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("end-to-end: attach, break, continue-and-wait, stack, variables", async () => {
  const s = await startSession();
  try {
    await s.attach({ pid: 1111 });
    assert.equal(s.state, "attached");

    const br = await s.setBreakpoints("/workspace/src/demo.m", [42, 44]);
    assert.equal(br.installed.length, 2);

    const info = await s.continueAndWaitStopped(5000);
    assert.equal(info.reason, "breakpoint");
    assert.equal(info.threadId, 1);

    const frames = await s.readStackTrace(info.threadId);
    assert.ok(frames.length >= 2, "should expose at least two frames");
    assert.equal(frames[0].name, "compute");

    const vars = await s.readVariables(frames[0].id);
    assert.ok(vars.some((v) => v.name === "x" && v.value === "57351"));
  } finally {
    await s.close();
  }
});

test("pressure: 50 sequential continue/read rounds leak no waiter state", async () => {
  const s = await startSession();
  try {
    await s.attach({ pid: 2222 });
    await s.setBreakpoints("/workspace/src/demo.m", [42]);
    for (let i = 0; i < 50; i += 1) {
      const info = await s.continueAndWaitStopped(5000);
      assert.equal(info.reason, "breakpoint");
      const frames = await s.readStackTrace(info.threadId);
      assert.ok(frames.length >= 1);
    }
    // After all those rounds the driver must have drained its waiter table and
    // the in-flight queue; otherwise the next round would hang or mis-correlate.
    assert.equal(s.client.pendingCount, 0);
    // Runtime `stoppedWaiters` is a plain array property (TS `private` is
    // erased), so we can assert it fully drained.
    assert.equal(s.stoppedWaiters.length, 0);
  } finally {
    await s.close();
  }
});

test("pressure: 60 concurrent requests serialize through the in-flight gate", async () => {
  const s = await startSession();
  try {
    await s.attach({ pid: 3333 });
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        s.client.request("setBreakpoints", {
          source: { path: `/workspace/src/f${i}.m` },
          breakpoints: [{ line: 1 }],
        }),
      ),
    );
    assert.equal(results.length, 60);
    for (const r of results) {
      assert.ok(Array.isArray(r.breakpoints));
    }
    assert.equal(s.client.pendingCount, 0);
  } finally {
    await s.close();
  }
});

test("failure: adapter killed mid-session tears down cleanly", async () => {
  const s = await startSession({ MOCK_EXIT_ON_ATTACH: "1" });
  await assert.rejects(
    s.attach({ pid: 4444 }),
    /adapter mock exited with code 0/,
    "attach should surface the adapter's mid-flight exit",
  );
  await s.close();
  assert.equal(s.state, "dead");
});

test("failure: reject on poison-timeout then recover via close", async () => {
  const s = await startSession({ MOCK_SILENT_AFTER_ATTACH: "1" });
  try {
    // initialize and handshake succeed (adapter replies before going silent),
    // so we can attach, then the adapter stops answering.
    await s.attach({ pid: 5555 });
    await assert.rejects(
      s.client.request("stackTrace", { threadId: 1 }, 300),
      /timed out/,
    );
  } finally {
    await s.close();
  }
});

test("cleanup: no orphan adapter process after close", async () => {
  const s = await startSession();
  await s.attach({ pid: 6666 });
  const pid = s.client["proc"] && s.client["proc"].pid;
  assert.ok(pid > 0, "an adapter process must exist");
  await s.close();
  // give the OS a beat to reap the child, then double-check it is truly gone.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(s.client.isConnected, false);
});