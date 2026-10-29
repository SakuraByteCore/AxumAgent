import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { applyFastServiceTier, readFastModels, saveFastModels } from "../src/fast-service-tier.js";
import { instrumentWebSdk } from "../src/pi-web-fast-loader.js";

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-fast-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("Fast defaults off, preserves Axum settings, scopes by model/protocol, and switches off again", t => {
  const file = path.join(temporary(t), "axum.json");
  fs.writeFileSync(file, JSON.stringify({ userAgent: "keep" }));
  const model = { provider: "local", id: "mock", api: "openai-responses" };
  const payload = { model: "mock", input: [], stream: true };
  assert.deepEqual(applyFastServiceTier(payload, model, file), payload);
  saveFastModels("local", ["mock"], true, file);
  assert.deepEqual(applyFastServiceTier(payload, model, file), { ...payload, service_tier: "fast" });
  assert.deepEqual(applyFastServiceTier(payload, { ...model, id: "other" }, file), payload);
  const native = { ...model, api: "anthropic-messages" };
  assert.equal(applyFastServiceTier(payload, native, file), payload);
  assert.equal(JSON.parse(fs.readFileSync(file)).userAgent, "keep");
  saveFastModels("renamed", ["mock"], true, file, "local");
  assert.deepEqual(readFastModels(file), { renamed: ["mock"] });
  saveFastModels("renamed", ["mock"], false, file);
  assert.deepEqual(readFastModels(file), {});
  assert.deepEqual(applyFastServiceTier(payload, { ...model, provider: "renamed" }, file), payload);
});

test("SDK instrumentation fails loudly on an incompatible callback", () => {
  assert.throws(() => instrumentWebSdk("changed SDK"), /unsupported Pi SDK/);
});

let sdkAvailable = true;
try { import.meta.resolve("@earendil-works/pi-coding-agent"); }
catch { sdkAvailable = false; }

test("real Web SDK sends top-level literal fast off/on/off for Chat and Responses, including retries and continued prompts", { skip: !sdkAvailable, timeout: 30000 }, async t => {
  const dir = temporary(t);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const captured = [];
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    captured.push({ url: req.url, body: JSON.parse(body) });
    res.writeHead(captured.length % 2 === 1 ? 500 : 400, { "content-type": "application/json", "retry-after": "0" });
    res.end(JSON.stringify({ error: { message: "mock capture only", type: "invalid_request_error" } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
  const providers = {};
  for (const [provider, api] of [["chat", "openai-completions"], ["responses", "openai-responses"]]) {
    providers[provider] = { api, apiKey: "mock-not-real", baseUrl, models: [{ id: "mock", name: "mock", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 16 }] };
  }
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers }));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 1, maxRetryDelayMs: 100 } } }));
  const { createAgentSessionServices, createAgentSessionFromServices, SessionManager } = await import("@earendil-works/pi-coding-agent");
  for (const provider of ["chat", "responses"]) {
    const services = await createAgentSessionServices({ cwd: dir, agentDir: dir, resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true } });
    const model = services.modelRuntime.getModel(provider, "mock");
    assert.ok(model);
    const { session } = await createAgentSessionFromServices({ services, model, tools: [], sessionManager: SessionManager.inMemory(dir) });
    try {
      for (const enabled of [false, true, false]) {
        saveFastModels(provider, ["mock"], enabled, path.join(dir, "axum.json"));
        const before = captured.length;
        await session.prompt("capture only").catch(() => {});
        assert.equal(captured.length, before + 2);
        for (const attempt of captured.slice(before)) {
          assert.equal(Object.hasOwn(attempt.body, "service_tier"), enabled);
          if (enabled) assert.equal(attempt.body.service_tier, "fast");
        }
        const request = captured.at(-1);
        assert.equal(request.url, provider === "chat" ? "/v1/chat/completions" : "/v1/responses");
        assert.equal(request.body.model, "mock");
        assert.ok(provider === "chat" ? Array.isArray(request.body.messages) : Array.isArray(request.body.input));
        assert.equal(Object.hasOwn(request.body, "service_tier"), enabled);
        if (enabled) assert.equal(request.body.service_tier, "fast");
      }
    } finally { session.dispose(); }
  }
});
