import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { getBundledPiNodeModules } from "../src/bundled-pi-cache.js";
import { prepareCodexResponsesOptions, instrumentCodexResponses, finalizeCodexResponsesHeaders } from "../src/codex-responses.js";
import "../src/pi-web-fast-loader.js";

const model = { api: "openai-responses", provider: "capture", id: "gpt-5.4", name: "capture", reasoning: true,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 32 };
const providerRoots = [path.resolve("node_modules"), getBundledPiNodeModules()].filter(root => fs.existsSync(path.join(root, "@earendil-works/pi-coding-agent/dist/core/session-manager.js")));
const payload = { input: [], instructions: "keep", reasoning: { effort: "high" }, tools: [], store: false };
const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "capture" } })).toString("base64")}.mock`;

test("final payload survives replacement, cache none, overrides and invalid shape checks", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-codex-options-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "axum.json");
  const options = prepareCodexResponsesOptions(model, { sessionId: "thread-1", cacheRetention: "none", onPayload: () => ({ ...payload }) }, file);
  assert.deepEqual(await options.onPayload({ input: [] }, model), { ...payload, prompt_cache_key: "thread-1" });
  const anonymous = prepareCodexResponsesOptions(model, {}, file);
  assert.match(anonymous.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(anonymous.sessionId, prepareCodexResponsesOptions(model, {}, file).sessionId);
  fs.writeFileSync(file, JSON.stringify({ prompt_cache_key: "manual", userAgent: "custom/1", codexHeaders: { "OpenAI-Beta": "custom", originator: "custom" } }));
  const custom = prepareCodexResponsesOptions({ ...model, headers: { "User-Agent": "model/1" } }, { sessionId: "thread-2", headers: { "USER-AGENT": "request/1" } }, file);
  assert.equal((await custom.onPayload(payload)).prompt_cache_key, "manual");
  assert.equal(custom.headers["user-agent"], "request/1");
  for (const transport of ["sse", "websocket"]) {
    const headers = new Headers({ authorization: "Bearer mock", "openai-beta": "sdk-beta" });
    finalizeCodexResponsesHeaders(headers, custom, transport);
    assert.equal(headers.get("authorization"), "Bearer mock");
    assert.equal(headers.get("openai-beta"), "custom");
    assert.equal(headers.get("originator"), "custom");
  }
  await assert.rejects(prepareCodexResponsesOptions(model, {}, file).onPayload({ messages: [] }), /input array/);
  await assert.rejects(prepareCodexResponsesOptions(model, { onPayload: () => ({ input: [], reasoning: [] }) }, file).onPayload(payload), /reasoning/);
  fs.writeFileSync(file, JSON.stringify({ prompt_cache_key: " " }));
  assert.throws(() => prepareCodexResponsesOptions(model, {}, file), /prompt_cache_key/);
  const unrelated = { sessionId: "other" };
  assert.equal(prepareCodexResponsesOptions({ api: "anthropic-messages" }, unrelated, file), unrelated);
  assert.throws(() => instrumentCodexResponses("changed"), /unsupported/);
  for (const transport of ["sse", "websocket"]) {
    const headers = new Headers({ "openai-beta": "sdk-beta" });
    finalizeCodexResponsesHeaders(headers, anonymous, transport);
    assert.equal(headers.get("openai-beta"), transport === "sse" ? null : "sdk-beta");
  }
});

test("real installed and bundled providers send final HTTP bodies and stable session identity", { timeout: 30000, skip: providerRoots.length === 0 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-codex-wire-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR, previousUA = process.env.AXUM_USER_AGENT;
  process.env.PI_CODING_AGENT_DIR = dir; delete process.env.AXUM_USER_AGENT;
  t.after(() => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousUA === undefined) delete process.env.AXUM_USER_AGENT; else process.env.AXUM_USER_AGENT = previousUA;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks), body = req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw;
    requests.push({ body: JSON.parse(body.toString("utf8")), headers: req.headers });
    res.writeHead(requests.length % 2 ? 500 : 400, { "content-type": "application/json", "retry-after": "0" });
    res.end(JSON.stringify({ error: { message: "capture", type: "invalid_request_error" } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  for (const root of providerRoots) {
    const managerFile = path.join(root, "@earendil-works/pi-coding-agent/dist/core/session-manager.js");
    assert.ok(fs.existsSync(managerFile), "required installed SDK missing");
    const { SessionManager } = await import(pathToFileURL(managerFile).href);
    const manager = SessionManager.create(dir, dir), id = manager.getSessionId();
    manager.appendMessage({ role: "user", content: "capture", timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
    const resumed = SessionManager.open(manager.getSessionFile());
    assert.equal(resumed.getSessionId(), id);
    const fork = SessionManager.open(manager.getSessionFile());
    fork.createBranchedSession(fork.getLeafId());
    assert.notEqual(fork.getSessionId(), id);
    manager.newSession();
    assert.notEqual(manager.getSessionId(), id);
    for (const api of ["openai-responses", "openai-codex-responses"]) {
      const filename = path.join(root, `@earendil-works/pi-ai/dist/api/${api}.js`);
      const source = fs.readFileSync(filename, "utf8"), patched = instrumentCodexResponses(source, api.includes("codex"));
      assert.equal(instrumentCodexResponses(patched, api.includes("codex")), patched);
      const { stream } = await import(pathToFileURL(filename).href);
      fs.writeFileSync(path.join(dir, "axum.json"), "{}");
      for (const sessionId of [id, resumed.getSessionId(), manager.getSessionId(), fork.getSessionId(), undefined, "configured"]) {
        const custom = sessionId === "configured";
        if (custom) fs.writeFileSync(path.join(dir, "axum.json"), JSON.stringify({ prompt_cache_key: "manual", userAgent: "config/1", codexHeaders: { "OpenAI-Beta": "gateway-beta" } }));
        const before = requests.length;
        const context = { systemPrompt: "system", messages: [{ role: "user", content: "capture", timestamp: Date.now() }], tools: [{ name: "capture", description: "capture", parameters: { type: "object", properties: {} } }] };
        if (source.includes("resolveTranscript")) context.messages.unshift({ role: "system", content: "system", toolsAdded: context.tools, timestamp: Date.now() });
        context.messages.push({ role: "assistant", content: [{ type: "toolCall", id: "call_capture", name: "capture", arguments: {} }], api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: Date.now() }, { role: "toolResult", toolCallId: "call_capture", toolName: "capture", content: [{ type: "text", text: "tool-output" }], isError: false, timestamp: Date.now() });
        await stream({ ...model, api, baseUrl }, context, { apiKey: token, sessionId, transport: "sse", cacheRetention: "none", maxRetries: 1, maxRetryDelayMs: 100, signal: AbortSignal.timeout(2000), headers: custom ? { "User-Agent": "request/1" } : undefined,
          onPayload: body => ({ ...body, instructions: "preserved", reasoning: { effort: "high" } }) }).result();
        assert.equal(requests.length, before + 2, `${api} sends initial + retry`);
        const pair = requests.slice(before), key = pair[0].body.prompt_cache_key;
        if (sessionId) assert.equal(key, custom ? "manual" : sessionId); else assert.match(key, /^[0-9a-f-]{14}4[0-9a-f-]{21}$/);
        for (const request of pair) {
          assert.equal(request.body.prompt_cache_key, key);
          assert.ok(Array.isArray(request.body.input));
          assert.ok(request.body.input.some(item => item.type === "function_call_output" && item.output.includes("tool-output")));
          assert.ok(request.body.tools.some(tool => tool.name === "capture"));
          assert.equal(request.body.instructions, "preserved");
          assert.deepEqual(request.body.reasoning, { effort: "high" });
          assert.equal(request.headers["session-id"], sessionId ?? key);
          if (custom) assert.equal(request.headers["user-agent"], "request/1");
          else assert.match(request.headers["user-agent"], /^codex_cli_rs\/0\.125\.0 /);
          assert.equal(request.headers.originator, "codex_cli_rs");
          assert.equal(request.headers["openai-beta"], custom ? "gateway-beta" : undefined);
        }
      }
    }
  }
});


test("protocol hook still registers after a legacy Fast preload", { skip: providerRoots.length === 0 }, () => {
  const loader = new URL("../src/pi-web-fast-loader.js", import.meta.url).href;
  const provider = pathToFileURL(path.join(providerRoots[0], "@earendil-works/pi-ai/dist/api/openai-responses.js")).href;
  const script = `globalThis[Symbol.for("axum.fast-service-tier.loader-hook")]=true; await import(${JSON.stringify(loader)}); const {stream}=await import(${JSON.stringify(provider)}); console.log(stream.toString().includes("prepareAxumCodexResponsesOptions"));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "true");
});
