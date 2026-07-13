#!/usr/bin/env node

const http = require("http");
const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");

function startMockServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body || "{}") });
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        model: "mock-chat-model",
        choices: [{ index: 0, message: { role: "assistant", content: "mock answer" }, finish_reason: "stop" }],
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port }));
  });
}

function runCli(args, env) {
  const child = spawn(process.execPath, [path.resolve(__dirname, "..", "bin", "axum.js"), ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

(async () => {
  const { server, requests, port } = await startMockServer();
  try {
    const result = await runCli([
      "chat",
      "--base-url", `http://127.0.0.1:${port}/v1`,
      "--model", "mock-model",
      "--system", "be concise",
      "hello",
    ], { OPENAI_API_KEY: "test-key" });

    assert.strictEqual(result.code, 0, result.stderr);
    assert.strictEqual(result.stdout.trim(), "mock answer");
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].method, "POST");
    assert.strictEqual(requests[0].url, "/v1/chat/completions");
    assert.strictEqual(requests[0].headers.authorization, "Bearer test-key");
    assert.deepStrictEqual(requests[0].body.messages, [
      { role: "system", content: "be concise" },
      { role: "user", content: "hello" },
    ]);
    assert.strictEqual(requests[0].body.model, "mock-model");

    const missingKey = await runCli(["chat", "hello"], { OPENAI_API_KEY: "" });
    assert.strictEqual(missingKey.code, 2);
    assert.match(missingKey.stderr, /missing API key/);
  } finally {
    server.close();
  }
})();
