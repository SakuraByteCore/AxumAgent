import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { saveFastModels } from "../src/fast-service-tier.js";

// Opt-in because this starts the real packaged Next server, not a mock route.
test("production axum chat Web host emits Fast off/on/off for Chat and Responses", { skip: process.env.AXUM_FAST_WEB_E2E !== "1", timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-fast-host-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const captured = [];
  const upstream = http.createServer(async (req, res) => {
    let data = ""; for await (const chunk of req) data += chunk;
    captured.push({ url: req.url, body: JSON.parse(data) });
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "mock capture only" } }));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const portProbe = http.createServer();
  await new Promise(resolve => portProbe.listen(0, "127.0.0.1", resolve));
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const providers = {};
  for (const [provider, api] of [["chat", "openai-completions"], ["responses", "openai-responses"]]) providers[provider] = { api, apiKey: "***", baseUrl: 'http://127.0.0.1:' + upstream.address().port + '/v1', models: [{ id: "mock", reasoning: false, contextWindow: 32000, maxTokens: 16 }] };
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers }));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ retry: { enabled: false }, providerRetry: { maxRetries: 0 } }));
  const child = spawn(process.execPath, ["bin/axum.js", "chat", "--no-open", "--port", String(port)], { cwd: new URL("..", import.meta.url), env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_WEB_PASSWORD: "", PI_WEB_ALLOWED_HOSTS: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, "exit"); if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); await exited; } });
  const origin = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 20000;
  while (true) {
    try { const r = await fetch(origin); if (r.ok) break; } catch {}
    assert.ok(Date.now() < deadline && child.exitCode === null, output);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  async function post(route, body) {
    const r = await fetch(origin + route, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
    const result = await r.json(); assert.equal(r.status, 200, JSON.stringify(result) + output); return result;
  }
  for (const provider of ["chat", "responses"]) {
    const { sessionId } = await post("/api/agent/new", { cwd: dir, provider, modelId: "mock", toolNames: [], thinkingLevel: "off", type: "ensure_session" });
    for (const enabled of [false, true, false]) {
      saveFastModels(provider, ["mock"], enabled, path.join(dir, "axum.json"));
      const before = captured.length;
      await post('/api/agent/' + sessionId, { type: "prompt", message: "local capture only" });
      const deadline = Date.now() + 5000;
      while (captured.length === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(captured.length, before + 1, output);
      const req = captured.at(-1);
      assert.equal(req.url, provider === "chat" ? "/v1/chat/completions" : "/v1/responses");
      assert.equal(req.body.model, "mock");
      assert.equal(Object.hasOwn(req.body, "service_tier"), enabled);
      if (enabled) assert.equal(req.body.service_tier, "fast");
      // Wait for the host turn to leave streaming before the next prompt.
      for (let i = 0; i < 100; i++) {
        const state = await post('/api/agent/' + sessionId, { type: "get_state" });
        if (!state.data?.isStreaming) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  }
});
