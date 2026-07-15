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
      const parsedBody = JSON.parse(body || "{}");
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: parsedBody });
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: (options.models || ["fetched-a", "fetched-b"]).map((id) => ({ id })) }));
        return;
      }
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
      if (parsedBody.stream) {
        const chunks = options.streamChunks || ["mock ", "answer"];
        res.writeHead(200, { "content-type": "text/event-stream" });
        chunks.forEach((chunk, index) => {
          setTimeout(() => {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
            if (index === chunks.length - 1) res.end("data: [DONE]\n\n");
          }, options.delayMs || index * 200);
        });
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
  assert.doesNotMatch(result.stdout, /Run \/help for commands/);
  assert.doesNotMatch(result.stdout, /Run \/help for commands █/);
  assert.match(result.stdout, /^› █\s*$/m);
  assert.match(result.stdout, /dry-run: provider call skipped/);
  assert.doesNotMatch(result.stdout, /▌ user/);
  assert.doesNotMatch(result.stdout, /▌ assistant/);
  assert.doesNotMatch(result.stdout, /\bUser\b/);
  assert.doesNotMatch(result.stdout, /\bAI\b/);
  assert.doesNotMatch(result.stdout, /╭─ message/);
}

async function testInteractiveTuiDryRun() {
  const result = await runCli(["tui", "--dry-run", "--model", "gpt-5.5"], {}, "hello interactive\n/exit\n");
  assert.strictEqual(result.code, 0, result.stderr);
  assert.match(result.stdout, />_ AxumAgent \(v0\.1\.0\)/);
  assert.match(result.stdout, /model:\s+gpt-5\.5\s+\/model to change/);
  assert.doesNotMatch(result.stdout, /Run \/help for commands/);
  assert.doesNotMatch(result.stdout, /Run \/help for commands █/);
  assert.match(result.stdout, /permissions: YOLO mode/);
  assert.doesNotMatch(result.stdout, /waiting for input/);
  assert.doesNotMatch(result.stdout, /\(type a message\)/);
  assert.doesNotMatch(result.stdout, /No messages yet\./);
  assert.match(result.stdout, /^› █\s*$/m);
  assert.match(result.stdout, /hello interactive/);
  assert.match(result.stdout, /dry-run: provider call skipped/);
  assert.doesNotMatch(result.stdout, /▌ user/);
  assert.doesNotMatch(result.stdout, /▌ assistant/);
}

async function testInteractiveTuiShowsSlashCommands() {
  const result = await runCli(["tui", "--dry-run"], {}, "/\n/exit\n");
  assert.strictEqual(result.code, 0, result.stderr);
  assert.match(result.stdout, /commands/);
  assert.match(result.stdout, /│ › \/help\s+│ show commands\s+│/);
  assert.match(result.stdout, /│   \/provider\s+│ show or set provider url\/key\s+│/);
  assert.match(result.stdout, /│   \/model\s+│ list or switch models\s+│/);
  assert.match(result.stdout, /^› █\s*$/m);
}

async function testTuiConfiguresProviderUrlAndKeyWhenMissing() {
  const { server, requests, port } = await startMockServer({ models: ["configured-first", "configured-second"] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-config-test-"));
  const file = path.join(dir, "config.toml");
  try {
    const result = await runCli(["tui", "--config", file], {}, `/provider url http://127.0.0.1:${port}/v1\n/provider key test-key\n/model\nhello configured\n/exit\n`);
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /provider url saved/);
    assert.match(result.stdout, /provider key saved/);
    assert.match(result.stdout, /\* 1\. configured-first/);
    assert.strictEqual(requests[0].method, "GET");
    assert.strictEqual(requests[0].url, "/v1/models");
    assert.strictEqual(requests.at(-1).body.model, "configured-first");
    const saved = fs.readFileSync(file, "utf8");
    assert.match(saved, /base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"/);
    assert.match(saved, /api_key = "test-key"/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testTuiUsesFirstConfiguredModelAndSwitchesWithModelCommand() {
  const { server, requests, port } = await startMockServer();
  const cfg = writeConfig(`
provider = "openai-chat"

[providers.openai-chat]
type = "openai-chat"
base_url = "http://127.0.0.1:${port}/v1"
api_key = "test-key"
models = ["first-model", "second-model"]
max_retries = 10
retry_delay_ms = 0
`);
  try {
    const result = await runCli(["tui", "--config", cfg.file], {}, "/model\n/model 2\nhello switched\n/exit\n");
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /\* 1\. first-model/);
    assert.match(result.stdout, /  2\. second-model/);
    assert.match(result.stdout, /model switched to second-model/);
    assert.strictEqual(requests.at(-1).body.model, "second-model");
  } finally {
    server.close();
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testTuiFetchesFirstModelWhenConfigOmitsModel() {
  const { server, requests, port } = await startMockServer({ models: ["remote-first", "remote-second"] });
  const cfg = writeConfig(`
provider = "openai-chat"

[providers.openai-chat]
type = "openai-chat"
base_url = "http://127.0.0.1:${port}/v1"
api_key = "test-key"
max_retries = 10
retry_delay_ms = 0
`);
  try {
    const result = await runCli(["tui", "--config", cfg.file], {}, "hello fetched\n/exit\n");
    assert.strictEqual(result.code, 0, result.stderr);
    assert.strictEqual(requests[0].method, "GET");
    assert.strictEqual(requests[0].url, "/v1/models");
    assert.strictEqual(requests.at(-1).body.model, "remote-first");
    assert.match(result.stdout, /model:\s+remote-first\s+\/model to change/);
  } finally {
    server.close();
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testInteractiveTuiWorkingTimer() {
  const { server, requests, port } = await startMockServer({ delayMs: 1200 });
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
    assert.strictEqual(requests[0].body.stream, true);
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
  await testInteractiveTuiShowsSlashCommands();
  await testTuiConfiguresProviderUrlAndKeyWhenMissing();
  await testTuiUsesFirstConfiguredModelAndSwitchesWithModelCommand();
  await testTuiFetchesFirstModelWhenConfigOmitsModel();
  await testInteractiveTuiWorkingTimer();
  await testMissingKey();
})();
