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
      if (options.destroyToolRequests && parsedBody.tools) {
        req.socket.destroy();
        return;
      }
      if (options.htmlChallenge) {
        res.writeHead(403, { "content-type": "text/html; charset=UTF-8", server: "cloudflare" });
        res.end("<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Cloudflare challenge</body></html>");
        return;
      }
      if (req.method === "GET" && req.url === "/v1/models") {
        if (options.modelsHtmlChallenge) {
          res.writeHead(403, { "content-type": "text/html; charset=UTF-8", server: "cloudflare" });
          res.end("<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Cloudflare challenge</body></html>");
          return;
        }
        if (options.modelsStatus) {
          res.writeHead(options.modelsStatus, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: options.modelsError || "models endpoint unavailable" } }));
          return;
        }
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

function startConfigWeb(configPath, env = {}) {
  const child = spawn(process.execPath, [path.resolve(__dirname, "..", "bin", "axum.js"), "config-web", "--config", configPath, "--port", "0"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, OPENAI_API_KEY: "", AXUM_CONFIG: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`config-web did not start\nstdout=${stdout}\nstderr=${stderr}`)), 5000);
    child.stdout.on("data", () => {
      const match = stdout.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({ child, url: match[1], stdout: () => stdout, stderr: () => stderr });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`config-web exited early with ${code}\nstdout=${stdout}\nstderr=${stderr}`));
    });
  });
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

async function testVersionFlag() {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"));
  const result = await runCli(["--version"]);
  assert.strictEqual(result.code, 0, result.stderr);
  assert.strictEqual(result.stdout.trim(), pkg.version);
}

async function testHelpShowsProductFlow() {
  const result = await runCli(["--help"]);
  assert.strictEqual(result.code, 0, result.stderr);
  assert.match(result.stdout, /Recommended first run:/);
  assert.match(result.stdout, /axum init --provider-config/);
  assert.match(result.stdout, /Config web options:/);
  assert.match(result.stdout, /axum --version/);
}

async function testPackageInstallDoesNotMutateHome() {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"));
  assert.ok(!pkg.scripts?.postinstall, "package install should not write user config; use axum init explicitly");
}

async function testOneLineProviderConfig() {
  const { server, requests, port } = await startMockServer();
  const cfg = writeConfig(`
provider_config = "http://127.0.0.1:${port}/v1 test-key one-line-model"
`);
  try {
    const result = await runCli(["chat", "--config", cfg.file, "hello one line"]);

    assert.strictEqual(result.code, 0, result.stderr);
    assert.strictEqual(result.stdout.trim(), "mock answer");
    assert.strictEqual(requests[0].headers.authorization, "Bearer test-key");
    assert.strictEqual(requests[0].body.model, "one-line-model");
  } finally {
    server.close();
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testProviderFlagSelectsConfiguredProvider() {
  const primary = await startMockServer();
  const secondary = await startMockServer();
  const cfg = writeConfig(`
provider = "primary"

[providers.primary]
type = "openai-chat"
base_url = "http://127.0.0.1:${primary.port}/v1"
api_key = "primary-key"
model = "primary-model"

[providers.secondary]
type = "openai-chat"
base_url = "http://127.0.0.1:${secondary.port}/v1"
api_key = "secondary-key"
model = "secondary-model"
`);
  try {
    const result = await runCli(["chat", "--config", cfg.file, "--provider", "secondary", "hello provider"]);
    assert.strictEqual(result.code, 0, result.stderr);
    assert.strictEqual(primary.requests.length, 0);
    assert.strictEqual(secondary.requests.length, 1);
    assert.strictEqual(secondary.requests[0].headers.authorization, "Bearer secondary-key");
    assert.strictEqual(secondary.requests[0].body.model, "secondary-model");

    const doctor = await runCli(["doctor", "--config", cfg.file, "--provider", "secondary", "--json"]);
    assert.strictEqual(doctor.code, 0, doctor.stderr);
    const report = JSON.parse(doctor.stdout);
    assert.strictEqual(report.provider, "secondary");
    assert.strictEqual(report.model, "secondary-model");
  } finally {
    primary.server.close();
    secondary.server.close();
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testProvidersListsConfiguredProviders() {
  const cfg = writeConfig(`
provider = "primary"

[providers.primary]
type = "openai-chat"
base_url = "https://primary.example/v1"
api_key = "env:PRIMARY_KEY"
model = "primary-model"

[providers.secondary]
type = "openai-chat"
base_url = "https://secondary.example/v1"
api_key = "secondary-secret"
model = "secondary-model"
`);
  try {
    const text = await runCli(["providers", "--config", cfg.file]);
    assert.strictEqual(text.code, 0, text.stderr);
    assert.match(text.stdout, /AxumAgent providers/);
    assert.match(text.stdout, /\* primary/);
    assert.match(text.stdout, /secondary/);
    assert.match(text.stdout, /env:PRIMARY_KEY/);
    assert.doesNotMatch(text.stdout, /secondary-secret/);

    const json = await runCli(["providers", "--config", cfg.file, "--json"]);
    assert.strictEqual(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.strictEqual(parsed.providers.length, 2);
    assert.strictEqual(parsed.providers[0].id, "primary");
    assert.strictEqual(parsed.providers[0].default, true);
  } finally {
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testTuiSwitchesDefaultProvider() {
  const cfg = writeConfig(`
provider = "primary"

[providers.primary]
type = "openai-chat"
base_url = "https://primary.example/v1"
api_key = "env:PRIMARY_KEY"
model = "primary-model"

[providers.secondary]
type = "openai-chat"
base_url = "https://secondary.example/v1"
api_key = "env:SECONDARY_KEY"
model = "secondary-model"
`);
  try {
    const result = await runCli(["tui", "--config", cfg.file, "--dry-run"], {}, "/providers\n/provider use 2\n/provider\n/exit\n");
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /providers/);
    assert.match(result.stdout, /provider switched to secondary/);
    assert.match(result.stdout, /provider url: https:\/\/secondary\.example\/v1/);
    assert.match(fs.readFileSync(cfg.file, "utf8"), /provider = "secondary"/);
  } finally {
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testProvidersShowsRootProviderConfig() {
  const cfg = writeConfig(`
provider_config = "https://root.example/v1 env:ROOT_KEY root-model"
`);
  try {
    const json = await runCli(["providers", "--config", cfg.file, "--json"]);
    assert.strictEqual(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.strictEqual(parsed.providers.length, 1);
    assert.strictEqual(parsed.providers[0].baseUrl, "https://root.example/v1");
    assert.strictEqual(parsed.providers[0].model, "root-model");
    assert.strictEqual(parsed.providers[0].key, "env:ROOT_KEY");
  } finally {
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testInitCreatesConfigWithoutOverwriting() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-init-test-"));
  const file = path.join(dir, "config.toml");
  try {
    const created = await runCli(["init", "--config", file, "--provider-config", "https://init.example/v1 env:INIT_KEY init-model"]);
    assert.strictEqual(created.code, 0, created.stderr);
    assert.match(created.stdout, /axum config created:/);
    let saved = fs.readFileSync(file, "utf8");
    assert.match(saved, /base_url = "https:\/\/init\.example\/v1"/);
    assert.match(saved, /api_key = "env:INIT_KEY"/);
    assert.match(saved, /model = "init-model"/);

    const forcedNew = path.join(dir, "forced.toml");
    const forcedCreated = await runCli(["init", "--config", forcedNew, "--force"]);
    assert.strictEqual(forcedCreated.code, 0, forcedCreated.stderr);
    assert.match(forcedCreated.stdout, /axum config created:/);

    const exists = await runCli(["init", "--config", file, "--provider-config", "https://other.example/v1 env:OTHER_KEY other-model"]);
    assert.strictEqual(exists.code, 0, exists.stderr);
    assert.match(exists.stdout, /axum config exists:/);
    saved = fs.readFileSync(file, "utf8");
    assert.match(saved, /base_url = "https:\/\/init\.example\/v1"/);
    assert.doesNotMatch(saved, /other-model/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testConfigWebSavesProviderFields() {
  const cfg = writeConfig(`
provider = "openai-chat"

[providers.openai-chat]
type = "openai-chat"
base_url = "https://old.example/v1"
api_key = "old-key"
model = "old-model"
`);
  let web;
  try {
    web = await startConfigWeb(cfg.file);
    const page = await fetch(web.url).then((res) => res.text());
    assert.match(page, /AxumAgent Provider Config/);
    assert.match(page, /https:\/\/old\.example\/v1/);
    assert.doesNotMatch(page, /old-key/);

    const response = await fetch(`${web.url}/save`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ base_url: "https://new.example/v1", api_key: "env:NEW_KEY", model: "new-model" }),
    });
    assert.strictEqual(response.status, 200);
    assert.match(await response.text(), /Saved/);
    const saved = fs.readFileSync(cfg.file, "utf8");
    assert.match(saved, /base_url = "https:\/\/new\.example\/v1"/);
    assert.match(saved, /api_key = "env:NEW_KEY"/);
    assert.match(saved, /model = "new-model"/);
  } finally {
    if (web) web.child.kill("SIGTERM");
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testConfigWebBlankKeyKeepsExistingSecret() {
  const cfg = writeConfig(`
provider = "openai-chat"

[providers.openai-chat]
type = "openai-chat"
base_url = "https://old.example/v1"
api_key = "old-key"
model = "old-model"
`);
  let web;
  try {
    web = await startConfigWeb(cfg.file);
    const page = await fetch(web.url).then((res) => res.text());
    assert.doesNotMatch(page, /old-key/);
    const response = await fetch(`${web.url}/save`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ base_url: "https://new.example/v1", api_key: "", model: "new-model" }),
    });
    assert.strictEqual(response.status, 200);
    const saved = fs.readFileSync(cfg.file, "utf8");
    assert.match(saved, /base_url = "https:\/\/new\.example\/v1"/);
    assert.match(saved, /api_key = "old-key"/);
    assert.match(saved, /model = "new-model"/);
  } finally {
    if (web) web.child.kill("SIGTERM");
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testConfigWebDoesNotExposeResolvedEnvSecret() {
  const cfg = writeConfig(`
provider = "openai-chat"

[providers.openai-chat]
type = "openai-chat"
base_url = "https://old.example/v1"
api_key = "env:AXUM_TEST_SECRET_KEY"
model = "old-model"
`);
  let web;
  try {
    web = await startConfigWeb(cfg.file, { AXUM_TEST_SECRET_KEY: "super-secret-value" });
    const page = await fetch(web.url).then((res) => res.text());
    assert.match(page, /env:AXUM_TEST_SECRET_KEY/);
    assert.doesNotMatch(page, /super-secret-value/);
  } finally {
    if (web) web.child.kill("SIGTERM");
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testDoctorChecksProviderModels() {
  const { server, port } = await startMockServer({ models: ["doctor-model"] });
  const cfg = writeConfig(`
provider = "openai-chat"

[providers.openai-chat]
type = "openai-chat"
base_url = "http://127.0.0.1:${port}/v1"
api_key = "test-key"
model = "doctor-model"
`);
  try {
    const result = await runCli(["doctor", "--config", cfg.file]);
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /AxumAgent doctor/);
    assert.match(result.stdout, /models endpoint: ok \(1\)/);
    assert.match(result.stdout, /status: ok/);
  } finally {
    server.close();
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testDoctorJsonReport() {
  const { server, port } = await startMockServer({ models: ["json-model"] });
  const cfg = writeConfig(`
provider = "openai-chat"

[providers.openai-chat]
type = "openai-chat"
base_url = "http://127.0.0.1:${port}/v1"
api_key = "test-key"
model = "json-model"
`);
  try {
    const result = await runCli(["doctor", "--config", cfg.file, "--json"]);
    assert.strictEqual(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.strictEqual(report.status, "ok");
    assert.strictEqual(report.modelsEndpoint, "ok");
    assert.strictEqual(report.modelCount, 1);
    assert.strictEqual(report.firstModel, "json-model");
    assert.strictEqual(report.providerKey, "***");
    assert.strictEqual(report.providerKeySource, "literal");
    assert.strictEqual(report.requestPreview.models.method, "GET");
    assert.strictEqual(report.requestPreview.models.url, `http://127.0.0.1:${port}/v1/models`);
    assert.strictEqual(report.requestPreview.models.headers.Authorization, "Bearer ***");
    assert.strictEqual(report.requestPreview.models.headers.Accept, "application/json");
    assert.strictEqual(report.requestPreview.chat.method, "POST");
    assert.strictEqual(report.requestPreview.chat.url, `http://127.0.0.1:${port}/v1/chat/completions`);
    assert.strictEqual(report.requestPreview.chat.headers.Authorization, "Bearer ***");
    assert.strictEqual(report.requestPreview.chat.headers["Content-Type"], "application/json");
    assert.strictEqual(report.requestPreview.chat.body.model, "json-model");
    assert.doesNotMatch(JSON.stringify(report), /test-key/);
  } finally {
    server.close();
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testDoctorRunsRuntimeEquivalentProbe() {
  const { server, requests, port } = await startMockServer({ models: ["runtime-model"] });
  const cfg = writeConfig(`
provider = "openai-chat"

[providers.openai-chat]
type = "openai-chat"
base_url = "http://127.0.0.1:${port}/v1"
api_key = "test-key"
model = "runtime-model"
`);
  try {
    const result = await runCli(["doctor", "--config", cfg.file, "--json"]);
    assert.strictEqual(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.strictEqual(report.runtimeEndpoint, "ok");
    const runtimeRequest = requests.find((request) => Array.isArray(request.body.tools));
    assert.ok(runtimeRequest, "doctor should probe the runtime/TUI tool-call request shape");
    assert.strictEqual(runtimeRequest.headers.authorization, "Bearer test-key");
    assert.strictEqual(runtimeRequest.body.model, "runtime-model");
  } finally {
    server.close();
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testRuntimeFallsBackWhenToolPayloadBreaksTransport() {
  const { server, requests, port } = await startMockServer({ destroyToolRequests: true });
  const cfg = writeConfig(`
provider = "openai-chat"

[providers.openai-chat]
type = "openai-chat"
base_url = "http://127.0.0.1:${port}/v1"
api_key = "test-key"
model = "fallback-model"
max_retries = 0
`);
  try {
    const result = await runCli(["chat", "--config", cfg.file, "hello"]);
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /mock answer/);
    assert.ok(requests.some((request) => Array.isArray(request.body.tools)), "first runtime request should include tools");
    assert.ok(requests.some((request) => request.method === "POST" && request.url === "/v1/chat/completions" && !request.body.tools), "fallback request should omit tools");
  } finally {
    server.close();
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testDoctorFallsBackToChatProbeWhenModelsUnavailable() {
  const { server, port } = await startMockServer({ modelsStatus: 404, modelsError: "models endpoint not available" });
  const cfg = writeConfig(`
provider = "openai-chat"

[providers.openai-chat]
type = "openai-chat"
base_url = "http://127.0.0.1:${port}/v1"
api_key = "test-key"
model = "json-model"
`);
  try {
    const result = await runCli(["doctor", "--config", cfg.file, "--json"]);
    assert.strictEqual(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.strictEqual(report.status, "ok");
    assert.strictEqual(report.modelsEndpoint, "failed");
    assert.strictEqual(report.chatEndpoint, "ok");
    assert.match(report.warning, /chat\/completions succeeded/);
  } finally {
    server.close();
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testProviderHtmlChallengeErrorsAreSummarized() {
  const { server, port } = await startMockServer({ htmlChallenge: true });
  const cfg = writeConfig(`
provider = "openai-chat"

[providers.openai-chat]
type = "openai-chat"
base_url = "http://127.0.0.1:${port}/v1"
api_key = "test-key"
model = "json-model"
`);
  try {
    const result = await runCli(["doctor", "--config", cfg.file, "--json"]);
    assert.strictEqual(result.code, 1);
    const report = JSON.parse(result.stdout);
    assert.strictEqual(report.status, "failed");
    assert.match(report.modelsError, /\(403, http 403 html challenge\)/);
    assert.match(report.modelsError, /Cloudflare\/browser challenge/);
    assert.match(report.chatError, /\(403, http 403 html challenge\)/);
    assert.match(report.chatError, /Cloudflare\/browser challenge/);
    assert.doesNotMatch(JSON.stringify(report), /<!DOCTYPE html>/i);
  } finally {
    server.close();
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testDefaultSystemPromptKeepsShortInputsConcise() {
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
    const result = await runCli(["chat", "--config", cfg.file, "6666"]);

    assert.strictEqual(result.code, 0, result.stderr);
    assert.strictEqual(requests.length, 1);
    assert.deepStrictEqual(requests[0].body.messages.at(-1), { role: "user", content: "6666" });
    assert.match(requests[0].body.messages[0].content, /concise terminal assistant/);
    assert.match(requests[0].body.messages[0].content, /short, ambiguous, or chat-like inputs/);
    assert.match(requests[0].body.messages[0].content, /Answer in the user's language/);
  } finally {
    server.close();
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testRequestTimeoutConfig() {
  const { server, port } = await startMockServer({ delayMs: 200 });
  const cfg = writeConfig(`
model = "mock-model"
provider = "openai-chat"

[providers.openai-chat]
type = "openai-chat"
base_url = "http://127.0.0.1:${port}/v1"
api_key = "test-key"
request_timeout_ms = 50
max_retries = 0
retry_delay_ms = 0
`);
  try {
    const result = await runCli(["chat", "--config", cfg.file, "slow request"]);

    assert.strictEqual(result.code, 1);
    assert.match(result.stderr, /OpenAI Chat request timed out after 50ms/);
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
  assert.match(result.stdout, /◇ AxumAgent v0\.1\.0/);
  assert.match(result.stdout, /◌ gpt-4o-mini/);
  assert.doesNotMatch(result.stdout, /model gpt-4o-mini/);
  assert.doesNotMatch(result.stdout, /mode YOLO/);
  assert.doesNotMatch(result.stdout, /Run \/help for commands/);
  assert.doesNotMatch(result.stdout, /Run \/help for commands █/);
  assert.match(result.stdout, /▌ █/);
  assert.match(result.stdout, /✓ dry-run · provider call skipped/);
  assert.doesNotMatch(result.stdout, /▌ user/);
  assert.doesNotMatch(result.stdout, /▌ assistant/);
  assert.doesNotMatch(result.stdout, /\bUser\b/);
  assert.doesNotMatch(result.stdout, /\bAI\b/);
  assert.doesNotMatch(result.stdout, /╭─ message/);
}

async function testInteractiveTuiDryRun() {
  const result = await runCli(["tui", "--dry-run", "--model", "gpt-5.5"], {}, "hello interactive\n/exit\n");
  assert.strictEqual(result.code, 0, result.stderr);
  assert.match(result.stdout, /◇ AxumAgent v0\.1\.0/);
  assert.match(result.stdout, /◌ gpt-5\.5/);
  assert.doesNotMatch(result.stdout, /model gpt-5\.5/);
  assert.doesNotMatch(result.stdout, /Run \/help for commands/);
  assert.doesNotMatch(result.stdout, /Run \/help for commands █/);
  assert.doesNotMatch(result.stdout, /mode YOLO/);
  assert.doesNotMatch(result.stdout, /waiting for input/);
  assert.doesNotMatch(result.stdout, /\(type a message\)/);
  assert.doesNotMatch(result.stdout, /No messages yet\./);
  assert.match(result.stdout, /▌ █/);
  assert.match(result.stdout, /hello interactive/);
  assert.match(result.stdout, /✓ dry-run · provider call skipped/);
  assert.doesNotMatch(result.stdout, /▌ user/);
  assert.doesNotMatch(result.stdout, /▌ assistant/);
}

async function testInteractiveTuiShowsSlashCommands() {
  const result = await runCli(["tui", "--dry-run"], {}, "/\n/exit\n");
  assert.strictEqual(result.code, 0, result.stderr);
  assert.match(result.stdout, /commands/);
  assert.match(result.stdout, /▸ \/help\s+show commands/);
  assert.match(result.stdout, /\/provider\s+show\/set provider url\/key/);
  assert.match(result.stdout, /\/model\s+fetch\/list\/switch models/);
  assert.match(result.stdout, /\/exit \/ \/quit\s+exit TUI/);
  assert.doesNotMatch(result.stdout, /^  \/quit\s+exit TUI$/m);
  assert.doesNotMatch(result.stdout, /^▌ \/█\s*$/m);
}

async function testTuiConfiguresProviderInOneLine() {
  const { server, requests, port } = await startMockServer({ models: ["one-line-model", "other-model"] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-config-test-"));
  const file = path.join(dir, "config.toml");
  try {
    const result = await runCli(["tui", "--config", file], {}, `/provider set http://127.0.0.1:${port}/v1 test-key one-line-model\n/provider\nhello configured\n/exit\n`);
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /provider saved/);
    assert.match(result.stdout, /provider key: \*\*\*/);
    assert.match(result.stdout, /provider key source: literal/);
    assert.match(result.stdout, /model one-line-model/);
    assert.strictEqual(requests[0].method, "POST");
    assert.strictEqual(requests[0].url, "/v1/chat/completions");
    assert.strictEqual(requests[0].headers.authorization, "Bearer test-key");
    assert.strictEqual(requests[0].headers["content-type"], "application/json");
    assert.strictEqual(requests[0].headers.accept, "application/json");
    assert.strictEqual(requests[0].body.model, "one-line-model");
    const saved = fs.readFileSync(file, "utf8");
    assert.match(saved, /base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"/);
    assert.match(saved, /api_key = "test-key"/);
    assert.match(saved, /model = "one-line-model"/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testTuiProviderSetOverridesRootModel() {
  const { server, requests, port } = await startMockServer({ models: ["deepseek-v4-pro"] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-config-test-"));
  const file = path.join(dir, "config.toml");
  fs.writeFileSync(file, `model = "gpt-4o-mini"
provider = "openai-chat"

[providers.openai-chat]
type = "openai-chat"
base_url = "http://127.0.0.1:${port}/v1"
api_key = "old-key"
model = "old-model"
models = ["old-model"]
`, "utf8");
  try {
    const result = await runCli(["tui", "--config", file], {}, `/provider set http://127.0.0.1:${port}/v1 test-key deepseek-v4-pro\nhello configured\n/exit\n`);
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /model deepseek-v4-pro/);
    assert.doesNotMatch(result.stdout, /model gpt-4o-mini/);
    assert.strictEqual(requests.at(-1).body.model, "deepseek-v4-pro");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    assert.match(result.stdout, /models/);
    assert.match(result.stdout, /▸ 1\s+configured-first\s+current/);
    assert.match(result.stdout, /  2\s+configured-second/);
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

async function testTuiFetchesModelListAndSwitchesWithModelCommand() {
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
    assert.match(result.stdout, /models/);
    assert.match(result.stdout, /model list refreshed/);
    assert.match(result.stdout, /▸ 1\s+fetched-a\s+current/);
    assert.match(result.stdout, /  2\s+fetched-b/);
    assert.match(result.stdout, /model switched to fetched-b/);
    assert.strictEqual(requests.at(-1).body.model, "fetched-b");
    const saved = fs.readFileSync(cfg.file, "utf8");
    assert.match(saved, /model = "fetched-b"/);
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
    assert.match(result.stdout, /◌ remote-first/);
    assert.doesNotMatch(result.stdout, /model remote-first/);
  } finally {
    server.close();
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testTuiFetchesModelListEvenWhenConfigHasModel() {
  const { server, requests, port } = await startMockServer({ models: ["remote-first", "remote-second"] });
  const cfg = writeConfig(`
model = "configured-model"
provider = "openai-chat"

[providers.openai-chat]
type = "openai-chat"
base_url = "http://127.0.0.1:${port}/v1"
api_key = "test-key"
max_retries = 10
retry_delay_ms = 0
`);
  try {
    const result = await runCli(["tui", "--config", cfg.file], {}, "/model\n/exit\n");
    assert.strictEqual(result.code, 0, result.stderr);
    assert.strictEqual(requests[0].method, "GET");
    assert.strictEqual(requests[0].url, "/v1/models");
    assert.match(result.stdout, /remote-first/);
    assert.match(result.stdout, /remote-second/);
    assert.doesNotMatch(result.stdout, /no configured\/fetched model list/);
    assert.match(result.stdout, /◌ configured-model/);
    assert.doesNotMatch(result.stdout, /model configured-model/);
  } finally {
    server.close();
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testInteractiveTuiWorkingTimer() {
  const { server, requests, port } = await startMockServer({ delayMs: 1800 });
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
    assert.ok(requests.at(-1).body.tools.some((tool) => tool.function.name === "read"));
  } finally {
    server.close();
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testMissingKey() {
  const cfg = writeConfig(`
model = "mock-model"
provider = "openai-chat"

[providers.openai-chat]
type = "openai-chat"
base_url = "http://127.0.0.1:9/v1"
api_key_env = "AXUM_TEST_MISSING_KEY"
`);
  try {
    const missingKey = await runCli(["chat", "--config", cfg.file, "hello"], { AXUM_TEST_MISSING_KEY: "" });
    assert.strictEqual(missingKey.code, 2);
    assert.match(missingKey.stderr, /missing API key/);
  } finally {
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testKiloStyleModesList() {
  const result = await runCli(["modes"]);
  assert.strictEqual(result.code, 0, result.stderr);
  assert.match(result.stdout, /Kilo-style shell; Axum\/pi runtime owns execution state/);
  assert.match(result.stdout, /\* build\s+builtin/);
  assert.match(result.stdout, /plan\s+builtin/);
  assert.match(result.stdout, /debug\s+builtin/);
}

async function testWorkflowDryRunUsesPiRuntimeShape() {
  const result = await runCli(["workflow", "--dry-run", "--mode", "plan", "ship", "feature"]);
  assert.strictEqual(result.code, 0, result.stderr);
  assert.match(result.stdout, /◇ Axum workflow/);
  assert.match(result.stdout, /◌ plan · ship feature/);
  assert.match(result.stdout, /✓ plan · request anchored/);
  assert.match(result.stdout, /⤷ 4 steps folded \(--verbose to expand\)/);
  assert.doesNotMatch(result.stdout, /shell:/);
  assert.doesNotMatch(result.stdout, /runtime:/);
  assert.doesNotMatch(result.stdout, /permission-gated:/);
  assert.doesNotMatch(result.stdout, /◆ checkpoint/);

  const verbose = await runCli(["workflow", "--dry-run", "--verbose", "--mode", "plan", "ship", "feature"]);
  assert.strictEqual(verbose.code, 0, verbose.stderr);
  assert.match(verbose.stdout, /anchor .* sha256:/);
  assert.match(verbose.stdout, /├─ shape plan stage/);
  assert.match(verbose.stdout, /├─ gate tools read, lsp_symbols/);
  assert.match(verbose.stdout, /├─ enter execute stage/);
  assert.match(verbose.stdout, /├─ auto-fix loop 3x via hash anchor/);
}

async function testParallelDryRunPlansSubAgents() {
  const result = await runCli(["parallel", "--dry-run", "--mode", "build", "--task", "inspect runtime", "--task", "inspect tools", "refactor core workflow"]);
  assert.strictEqual(result.code, 0, result.stderr);
  assert.match(result.stdout, /◇ Axum parallel/);
  assert.match(result.stdout, /coordinator main-agent · refactor core workflow/);
  assert.match(result.stdout, /✓ 2 sub-agents planned/);
  assert.match(result.stdout, /agent-1 \[build\] inspect runtime/);
  assert.match(result.stdout, /merge policy · hash-anchor-review · review pending/);
  assert.doesNotMatch(result.stdout, /◆ checkpoint/);
}

async function testParallelStateModelTracksChildTasksAndMergeReview() {
  const { buildSwarmPlan, transitionChildTask } = require("../dist/runtime/pi-workflow.js");
  const plan = buildSwarmPlan("refactor runtime", ["inspect protocol", "inspect tools"], { mode: "debug", cwd: __dirname });

  assert.strictEqual(plan.tasks.length, 2);
  assert.deepStrictEqual(plan.tasks.map((task) => task.status), ["planned", "planned"]);
  assert.ok(plan.tasks.every((task) => task.createdAt === plan.createdAt));
  assert.deepStrictEqual(plan.mergeReview, {
    status: "pending",
    policy: "hash-anchor-review",
    taskIds: ["agent-1", "agent-2"],
  });

  const running = transitionChildTask(plan.tasks[0], "running", { at: "2026-07-18T05:00:00.000Z" });
  assert.strictEqual(running.status, "running");
  assert.strictEqual(running.startedAt, "2026-07-18T05:00:00.000Z");

  const failed = transitionChildTask(running, "failed", { error: "merge conflict", at: "2026-07-18T05:01:00.000Z" });
  assert.strictEqual(failed.status, "failed");
  assert.strictEqual(failed.error, "merge conflict");
  assert.strictEqual(failed.completedAt, "2026-07-18T05:01:00.000Z");
}

async function testProviderSafetyGuardExportsCorrections() {
  const { sanitizeToolCallsForProvider } = require("../dist/providers/openai-chat.js");
  const guarded = sanitizeToolCallsForProvider([
    { id: "1", type: "unsafe", function: { name: "safe_exec", arguments: "{}" } },
    { id: "2", type: "function", function: { name: "raw_shell", arguments: "{}" } },
  ], ["safe_exec"]);
  assert.strictEqual(guarded.value.length, 1);
  assert.strictEqual(guarded.value[0].type, "function");
  assert.match(guarded.corrections.join("\n"), /type corrected to function/);
  assert.match(guarded.corrections.join("\n"), /raw_shell is not allowed/);
}

async function testRuntimeToolExecutorsHonorGates() {
  const { runPreciseEdit, runSafeExec, runLspSymbols } = require("../dist/runtime/tools.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-tools-test-"));
  try {
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "sample.ts"), "export function alpha() {\n  return 1;\n}\n", "utf8");
    const gate = { cwd: dir, allowedTools: ["precise_edit", "safe_exec", "lsp_symbols"], allowedCommands: [process.execPath] };

    const symbols = runLspSymbols(gate, { query: "alpha" });
    assert.strictEqual(symbols.ok, true);
    assert.deepStrictEqual(symbols.result.matches.map((item) => item.name), ["alpha"]);

    const edit = runPreciseEdit(gate, { file: "src/sample.ts", oldText: "return 1;", newText: "return 2;" });
    assert.strictEqual(edit.ok, true);
    assert.match(fs.readFileSync(path.join(dir, "src", "sample.ts"), "utf8"), /return 2;/);
    assert.ok(edit.anchors[0].hash);

    const execResult = await runSafeExec(gate, { command: process.execPath, args: ["-e", "console.log('safe')"] });
    assert.strictEqual(execResult.ok, true);
    assert.strictEqual(execResult.result.stdout.trim(), "safe");

    const shellLikeExec = await runSafeExec(gate, { command: `${process.execPath} -e "console.log('split-safe')"` });
    assert.strictEqual(shellLikeExec.ok, true);
    assert.strictEqual(shellLikeExec.result.stdout.trim(), "split-safe");

    const findResult = await runSafeExec({ cwd: dir, allowedTools: ["safe_exec"] }, { command: "find . -name sample.ts" });
    assert.strictEqual(findResult.ok, true);
    assert.match(findResult.result.stdout, /src\/sample\.ts/);
    await assert.rejects(
      () => runSafeExec({ cwd: dir, allowedTools: ["safe_exec"] }, { command: "find / -name sample.ts" }),
      /find path escapes project sandbox/,
    );
    await assert.rejects(
      () => runSafeExec({ cwd: dir, allowedTools: ["safe_exec"] }, { command: "find . -delete" }),
      /find action not allowed/,
    );
    const grepResult = await runSafeExec({ cwd: dir, allowedTools: ["safe_exec"] }, { command: "grep -R alpha src" });
    assert.strictEqual(grepResult.ok, true);
    assert.match(grepResult.result.stdout, /alpha/);
    const catResult = await runSafeExec({ cwd: dir, allowedTools: ["safe_exec"] }, { command: "cat src/sample.ts" });
    assert.strictEqual(catResult.ok, true);
    assert.match(catResult.result.stdout, /alpha/);
    await assert.rejects(
      () => runSafeExec({ cwd: dir, allowedTools: ["safe_exec"] }, { command: "cat /etc/passwd" }),
      /cat path escapes project sandbox/,
    );
    await assert.rejects(
      () => runSafeExec({ cwd: dir, allowedTools: ["safe_exec"] }, { command: "sed -i s/alpha/beta/ src/sample.ts" }),
      /sed write action not allowed/,
    );

    assert.throws(() => runPreciseEdit({ cwd: dir, allowedTools: ["read"] }, { file: "src/sample.ts", oldText: "return 2;", newText: "return 3;" }), /tool not allowed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testLineTuiParallelSlashCommandPlansSwarm() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "axum-home-test-"));
  try {
    const result = await runCli(["tui", "--dry-run"], { HOME: home }, "/parallel refactor runtime :: inspect workflow | inspect tools\n/exit\n");
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /◇ Axum parallel/);
    assert.match(result.stdout, /agent-1 \[build\] inspect workflow/);
    assert.match(result.stdout, /agent-2 \[build\] inspect tools/);
    assert.doesNotMatch(result.stdout, /◆ checkpoint/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function testTuiPromptUsesRuntimeToolLoop() {
  const cfg = writeConfig(`
provider_config = "http://127.0.0.1:0/v1 test-key mock-tool-model"
`);
  const requests = [];
  let count = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "mock-tool-model" }] }));
        return;
      }
      requests.push(parsed);
      count += 1;
      res.writeHead(200, { "content-type": "application/json" });
      if (count === 1) {
        assert.ok(parsed.tools.some((tool) => tool.function.name === "read"));
        res.end(JSON.stringify({ model: "mock-tool-model", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "", tool_calls: [{ id: "call-read-package", type: "function", function: { name: "read", arguments: JSON.stringify({ file: "package.json" }) } }] } }] }));
        return;
      }
      const toolMessage = parsed.messages.find((message) => message.role === "tool" && message.tool_call_id === "call-read-package");
      assert.ok(toolMessage, "TUI prompt should feed runtime tool output into the next sampling request");
      assert.match(toolMessage.content, /axum-agent/);
      res.end(JSON.stringify({ model: "mock-tool-model", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "tui saw package" } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  fs.writeFileSync(cfg.file, `provider_config = "http://127.0.0.1:${port}/v1 test-key mock-tool-model"\n`, "utf8");
  try {
    const result = await runCli(["tui", "--config", cfg.file, "inspect package"]);
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /tui saw package/);
    assert.strictEqual(requests.length, 2);
  } finally {
    server.close();
    fs.rmSync(cfg.dir, { recursive: true, force: true });
  }
}

async function testCodexLikeRuntimeLoopsThroughToolCalls() {
  const { OpenAIChatProvider } = require("../dist/providers/openai-chat.js");
  const { AxumRuntimeSession } = require("../dist/runtime/session.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-session-test-"));
  fs.writeFileSync(path.join(dir, "note.txt"), "runtime evidence", "utf8");
  const requests = [];
  let count = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      requests.push(parsed);
      count += 1;
      res.writeHead(200, { "content-type": "application/json" });
      if (count === 1) {
        assert.ok(parsed.tools.some((tool) => tool.function.name === "read"));
        res.end(JSON.stringify({
          model: "mock-tool-model",
          choices: [{
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ id: "call-read-1", type: "function", function: { name: "read", arguments: JSON.stringify({ file: "note.txt" }) } }],
            },
          }],
        }));
        return;
      }
      const toolMessage = parsed.messages.find((message) => message.role === "tool" && message.tool_call_id === "call-read-1");
      assert.ok(toolMessage, "runtime should feed tool output back into the next sampling request");
      assert.match(toolMessage.content, /runtime evidence/);
      res.end(JSON.stringify({ model: "mock-tool-model", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "saw runtime evidence" } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const provider = new OpenAIChatProvider({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test", model: "mock-tool-model", maxRetries: 0 });
    const session = new AxumRuntimeSession({ provider, cwd: dir, mode: "build" });
    const result = await session.runUserTurn("read note");
    assert.strictEqual(result.assistantMessage, "saw runtime evidence");
    assert.strictEqual(result.toolOutputs.length, 1);
    assert.ok(result.events.some((event) => event.kind === "tool_call_requested"));
    assert.ok(result.events.some((event) => event.kind === "tool_call_completed"));
    assert.strictEqual(requests.length, 2);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  await testBasicChatFromConfig();
  await testVersionFlag();
  await testHelpShowsProductFlow();
  await testPackageInstallDoesNotMutateHome();
  await testOneLineProviderConfig();
  await testProviderFlagSelectsConfiguredProvider();
  await testProvidersListsConfiguredProviders();
  await testTuiSwitchesDefaultProvider();
  await testProvidersShowsRootProviderConfig();
  await testInitCreatesConfigWithoutOverwriting();
  await testConfigWebSavesProviderFields();
  await testConfigWebBlankKeyKeepsExistingSecret();
  await testConfigWebDoesNotExposeResolvedEnvSecret();
  await testDoctorChecksProviderModels();
  await testDoctorJsonReport();
  await testDoctorRunsRuntimeEquivalentProbe();
  await testRuntimeFallsBackWhenToolPayloadBreaksTransport();
  await testDoctorFallsBackToChatProbeWhenModelsUnavailable();
  await testProviderHtmlChallengeErrorsAreSummarized();
  await testDefaultSystemPromptKeepsShortInputsConcise();
  await testRequestTimeoutConfig();
  await testRetryConfig();
  await testTuiDryRun();
  await testInteractiveTuiDryRun();
  await testInteractiveTuiShowsSlashCommands();
  await testTuiConfiguresProviderInOneLine();
  await testTuiProviderSetOverridesRootModel();
  await testTuiConfiguresProviderUrlAndKeyWhenMissing();
  await testTuiFetchesModelListAndSwitchesWithModelCommand();
  await testTuiFetchesFirstModelWhenConfigOmitsModel();
  await testTuiFetchesModelListEvenWhenConfigHasModel();
  await testInteractiveTuiWorkingTimer();
  await testMissingKey();
  await testKiloStyleModesList();
  await testWorkflowDryRunUsesPiRuntimeShape();
  await testParallelDryRunPlansSubAgents();
  await testParallelStateModelTracksChildTasksAndMergeReview();
  await testProviderSafetyGuardExportsCorrections();
  await testRuntimeToolExecutorsHonorGates();
  await testLineTuiParallelSlashCommandPlansSwarm();
  await testTuiPromptUsesRuntimeToolLoop();
  await testCodexLikeRuntimeLoopsThroughToolCalls();
})();
