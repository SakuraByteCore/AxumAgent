import assert from "node:assert/strict";
import test from "node:test";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { patchPiSessionReadStreamCleanup as patch } from "../src/bundled-pi-patches.js";
const source = `async function buildSessionInfo(filePath, signal) { try { let header;
        const rl = createInterface({
            input: createReadStream(filePath, { encoding: "utf8", signal }),
            crlfDelay: Infinity });
        for await (const line of rl) { if (line !== "session") return null; header = line; }
        if (!header)
            return null;
        return header;
    } catch { signal?.throwIfAborted(); return null; } }
const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;`;
test("session stream cleanup closes early returns and preserves active aborts", async () => {
  const patched = patch(source);
  assert.equal(patch(patched), patched);
  assert.throws(() => patch("changed upstream"), /anchors not found/);
  for (const abortWhileReading of [false, true]) {
    const controller = new AbortController(); let input;
    const load = new Function("createReadStream", "createInterface", `${patched}; return buildSessionInfo;`)(
      (...args) => { input = createReadStream(...args); return input; },
      (options) => { if (abortWhileReading) options.input.once("data", () => controller.abort()); return createInterface(options); });
    const result = load("package.json", controller.signal);
    if (abortWhileReading) await assert.rejects(result, { name: "AbortError" });
    else assert.equal(await result, null);
    controller.abort(); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(input.destroyed, true);
  }
});
