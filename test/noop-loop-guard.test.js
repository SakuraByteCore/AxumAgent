import assert from "node:assert/strict";
import test from "node:test";

// Faithful JS mirror of plugin/pi-edit/src/noop-loop-guard.ts (pure functions).
// node --test exercises this without a TS loader; keep in sync when the source
// changes.

const NOOP_HARD_LIMIT = 3;

const noopTracker = new Map();
const appliedPayloadTracker = new Map();

function recordNoopEdit(path, payloadKey) {
  const existing = noopTracker.get(path);
  if (existing && existing.payloadKey === payloadKey) {
    existing.count += 1;
  } else {
    noopTracker.set(path, { payloadKey, count: 1 });
  }
  const count = noopTracker.get(path).count;
  return { count, escalate: count >= NOOP_HARD_LIMIT };
}

function recordAppliedEdit(path, payloadKey) {
  noopTracker.delete(path);
  appliedPayloadTracker.set(path, payloadKey);
}

function isDuplicateAppliedPayload(path, payloadKey) {
  return appliedPayloadTracker.get(path) === payloadKey;
}

function clearAppliedPayload(path) {
  appliedPayloadTracker.delete(path);
  noopTracker.delete(path);
}

function reset() {
  noopTracker.clear();
  appliedPayloadTracker.clear();
}

test("recordNoopEdit escalates after NOOP_HARD_LIMIT consecutive identical payloads", () => {
  reset();
  const p = "/tmp/a.txt";
  const key = JSON.stringify([{ content_lines: ["x"], hash_range_inclusive: ["AAA", "AAA"] }]);
  assert.equal(recordNoopEdit(p, key).escalate, false);
  assert.equal(recordNoopEdit(p, key).escalate, false);
  const third = recordNoopEdit(p, key);
  assert.equal(third.count, 3);
  assert.equal(third.escalate, true);
});

test("recordNoopEdit resets count when payloadKey changes", () => {
  reset();
  const p = "/tmp/b.txt";
  recordNoopEdit(p, "key1");
  recordNoopEdit(p, "key1");
  const r = recordNoopEdit(p, "key2");
  assert.equal(r.count, 1);
  assert.equal(r.escalate, false);
});

test("recordAppliedEdit marks payload as duplicate and clears noop counter", () => {
  reset();
  const p = "/tmp/c.txt";
  recordNoopEdit(p, "key1");
  recordNoopEdit(p, "key1");
  recordAppliedEdit(p, "key1");
  // After a successful apply, the same payload is flagged as duplicate.
  assert.equal(isDuplicateAppliedPayload(p, "key1"), true);
  // A different payload is not a duplicate.
  assert.equal(isDuplicateAppliedPayload(p, "key2"), false);
  // re-sending the same identical payload after success should restart the
  // noop counter at 1 (recordAppliedEdit cleared the tracker).
  const r = recordNoopEdit(p, "key1");
  assert.equal(r.count, 1);
});

test("clearAppliedPayload allows an intentional re-send after a re-read", () => {
  reset();
  const p = "/tmp/d.txt";
  recordAppliedEdit(p, "key1");
  assert.equal(isDuplicateAppliedPayload(p, "key1"), true);
  clearAppliedPayload(p);
  assert.equal(isDuplicateAppliedPayload(p, "key1"), false);
});
