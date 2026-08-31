import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import test from "node:test";
import { fetchAvailableTags } from "../src/version-config.js";

function mockHangingRequest(t) {
  const state = {};
  t.mock.method(https, "get", () => {
    const req = new EventEmitter();
    req.setTimeout = (ms, fn) => {
      state.timeoutMs = ms;
      state.onTimeout = fn;
    };
    req.destroy = (err) => {
      req.emit("error", err);
    };
    return req;
  });
  return state;
}

test("fetchAvailableTags registers a 15s request timeout", (t) => {
  const state = mockHangingRequest(t);
  const pending = fetchAvailableTags();
  assert.equal(state.timeoutMs, 15000);
  assert.equal(typeof state.onTimeout, "function");
  state.onTimeout();
  return assert.rejects(pending, /GitHub API request timed out after 15000ms/);
});

test("fetchAvailableTags rejects instead of hanging when the timeout fires", (t) => {
  const state = mockHangingRequest(t);
  const pending = fetchAvailableTags();
  state.onTimeout();
  return assert.rejects(pending, /request failed: GitHub API request timed out/);
});
