#!/usr/bin/env node

const http = require("http");
const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

function startMockServer(options = {}) {
  const requests = [];
  let failuresLeft = options.failures || 0;
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
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "temporary upstream failure" } }));
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          model: "mock-chat-model",
          choices: [{ index: 0, message: { role: "assistant", content: "mock answer" }, finish_reason: "stop" }],
        }));
      }, options.delayMs || 0);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port }));
  });
}

function runCli(args, env = {}, inputText) {
  const child = spawn(process.execPath, [path.resolve(__dirname, "..", "bin", "axum.js"), ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, OPENAI_API_KEY: "", AXUM_CONFIG: "", ...env },
    stdio: [inputText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  if (inputText !== undefined && child.stdin) child.stdin.end(inputText);
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

function writeConfig(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-config-test-"));
  const file = path.join(dir, "config.toml");
  fs.writeFileSync(file, content);
  return { dir, file };
}

async function testBasicChatFromConfig() {
  const { server, requests, port } = await startMockServer();
  const cfg = writeConfig(`
model = "mock-model"
provider = "openai-chat"

[providers.openai-chat]
type = "openai-chat"
base_url = "http://127.0.0.1:${port}/v1"
api_key = "test-key"
max_retries = 10
retry_delay_ms = 0
`);
  try {
    const result = await runCli([
      "chat",
      "--config", cfg.file,
      "--system", "be concise",
      "hello",
    ]);

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
  } finally {
    server.close();
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testRetryConfig() {
  const { server, requests, port } = await startMockServer({ failures: 2 });
  const cfg = writeConfig(`
model = "mock-model"
provider = "openai-chat"

[providers.openai-chat]
type = "openai-chat"
base_url = "http://127.0.0.1:${port}/v1"
api_key = "test-key"
max_retries = 2
retry_delay_ms = 0
`);
  try {
    const result = await runCli(["chat", "--config", cfg.file, "hello"]);

    assert.strictEqual(result.code, 0, result.stderr);
    assert.strictEqual(result.stdout.trim(), "mock answer");
    assert.strictEqual(requests.length, 3);
  } finally {
    server.close();
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testTuiDryRun() {
  const result = await runCli(["tui", "--dry-run", "hello"]);
  assert.strictEqual(result.code, 0, result.stderr);
  assert.match(result.stdout, />_ AxumAgent \(v0\.1\.0\)/);
  assert.match(result.stdout, /model:\s+gpt-4o-mini\s+\/model to change/);
  assert.match(result.stdout, /permissions: YOLO mode/);
  assert.match(result.stdout, /› Run \/help for commands/);
  assert.match(result.stdout, /dry-run: provider call skipped/);
  assert.doesNotMatch(result.stdout, /╭─ message/);
}

async function testInteractiveTuiDryRun() {
  const result = await runCli(["tui", "--dry-run", "--model", "gpt-5.5"], {}, "hello interactive\n/exit\n");
  assert.strictEqual(result.code, 0, result.stderr);
  assert.match(result.stdout, />_ AxumAgent \(v0\.1\.0\)/);
  assert.match(result.stdout, /model:\s+gpt-5\.5\s+\/model to change/);
  assert.match(result.stdout, /Run \/help for commands/);
  assert.match(result.stdout, /permissions: YOLO mode/);
  assert.doesNotMatch(result.stdout, /waiting for input/);
  assert.doesNotMatch(result.stdout, /\(type a message\)/);
  assert.doesNotMatch(result.stdout, /No messages yet\./);
  assert.doesNotMatch(result.stdout, /\n›\s*$/m);
  assert.match(result.stdout, /hello interactive/);
  assert.match(result.stdout, /dry-run: provider call skipped/);
}

async function testInteractiveTuiWorkingTimer() {
  const { server, port } = await startMockServer({ delayMs: 1200 });
  const cfg = writeConfig(`
model = "mock-model"
provider = "openai-chat"

[providers.openai-chat]
type = "openai-chat"
base_url = "http://127.0.0.1:${port}/v1"
api_key = "test-key"
max_retries = 10
retry_delay_ms = 0
`);
  try {
    const result = await runCli(["tui", "--config", cfg.file], {}, "hello timer\n/exit\n");
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /• Working \(0s • esc to interrupt\)/);
    assert.match(result.stdout, /• Working \(1s • esc to interrupt\)/);
    assert.match(result.stdout, /mock answer/);
  } finally {
    server.close();
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testMissingKey() {
  const missingKey = await runCli(["chat", "hello"]);
  assert.strictEqual(missingKey.code, 2);
  assert.match(missingKey.stderr, /missing API key/);
}

(async () => {
  await testBasicChatFromConfig();
  await testRetryConfig();
  await testTuiDryRun();
  await testInteractiveTuiDryRun();
  await testInteractiveTuiWorkingTimer();
  await testMissingKey();
})();
