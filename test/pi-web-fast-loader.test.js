import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { instrumentWebSdk } from "../src/pi-web-fast-loader.js";

const HOOK_FLAG = Symbol.for("axum.fast-service-tier.loader-hook");
const SDK_SOURCE = `
export function createSdk(runner) {
  return {
    onPayload: async (payload, _model) => {
      if (payload.skip) {
        return payload;
      }
      return runner.emitBeforeProviderRequest(payload);
    },
    onResponse: async (response, _model) => {
      return response;
    },
  };
}
`;

test("the loader registers its hook once per process", () => {
  assert.equal(globalThis[HOOK_FLAG], true);
});

test("an already instrumented SDK source is returned unchanged", () => {
  const patched = instrumentWebSdk(SDK_SOURCE);

  assert.match(patched, /applyAxumFastServiceTier/);
  assert.equal(instrumentWebSdk(patched), patched);
});

test("a second loader copy does not register a second hook", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-fast-loader-"));
  try {
    const helperUrl = new URL("../src/fast-service-tier.js", import.meta.url).href;
    const copy = path.join(dir, "pi-web-fast-loader.js");
    fs.writeFileSync(
      copy,
      fs.readFileSync(new URL("../src/pi-web-fast-loader.js", import.meta.url), "utf8").replaceAll(
        '"./fast-service-tier.js"',
        JSON.stringify(helperUrl),
      ),
    );

    await import(pathToFileURL(copy).href);

    assert.equal(globalThis[HOOK_FLAG], true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
