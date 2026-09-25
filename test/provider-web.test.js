import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startProviderWeb } from "../src/provider-web.js";

test("provider web fetches models and saves default config", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-web-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const mock = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      assert.equal(req.headers.authorization, "Bearer test-key");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mock-a" }, { id: "mock-b" }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const mockPort = mock.address().port;

  const { server, url } = await startProviderWeb({ openBrowser: false });
  try {
    const token = new URL(url).searchParams.get("token");
    const base = `http://127.0.0.1:${server.address().port}`;
    const modelsRes = await fetch(`${base}/api/models?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "test-key" }),
    });
    assert.equal(modelsRes.status, 200);
    assert.deepEqual((await modelsRes.json()).models, ["mock-a", "mock-b"]);

    const saveRes = await fetch(`${base}/api/save?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "test-key", model: "mock-b", name: "localmock", contextWindow: 256000, maxTokens: 64000, reasoningEffort: "medium" }),
    });
    assert.equal(saveRes.status, 200);
    const modelsJson = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    assert.equal(modelsJson.providers.localmock.models[0].id, "mock-b");
    assert.equal(modelsJson.providers.localmock.models[0].contextWindow, 256000);
    assert.equal(modelsJson.providers.localmock.models[0].maxTokens, 64000);
    assert.equal(modelsJson.providers.localmock.models[0].reasoning, true);
    assert.deepEqual(modelsJson.providers.localmock.models[0].thinkingLevelMap, { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high" });
    assert.equal(modelsJson.providers.localmock.apiKey, "test-key");
    const settingsJson = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.deepEqual(settingsJson, { defaultProvider: "localmock", defaultModel: "mock-b", defaultThinkingLevel: "medium" });

    const configRes = await fetch(`${base}/api/config?token=${token}`);
    assert.equal(configRes.status, 200);
    const configJson = await configRes.json();
    assert.equal(configJson.defaultProvider, "localmock");
    assert.equal(configJson.defaultModel, "mock-b");
    assert.equal(configJson.defaultThinkingLevel, "medium");
    assert.deepEqual(configJson.providers[0].models, ["mock-b"]);
    assert.deepEqual(configJson.providers[0].modelConfigs, [{ id: "mock-b", contextWindow: 256000, maxTokens: 64000, reasoning: true, default: true }]);
    assert.equal(configJson.providers[0].hasApiKey, true);
    assert.equal(configJson.providers[0].apiKey, "test-key");

    const defaultHighSaveRes = await fetch(`${base}/api/save?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "test-key", model: "mock-a", name: "localmock", originalName: "localmock", contextWindow: 128000, maxTokens: 32000 }),
    });
    assert.equal(defaultHighSaveRes.status, 200);
    const defaultHighSettingsJson = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(defaultHighSettingsJson.defaultThinkingLevel, "high");
    const defaultHighConfigRes = await fetch(`${base}/api/config?token=${token}`);
    assert.equal(defaultHighConfigRes.status, 200);
    const defaultHighConfigJson = await defaultHighConfigRes.json();
    assert.equal(defaultHighConfigJson.defaultModel, "mock-a");
    assert.equal(defaultHighConfigJson.defaultThinkingLevel, "high");

    const promptRes = await fetch(`${base}/api/system-prompt?token=${token}&scope=global&mode=append`);
    assert.equal(promptRes.status, 200);
    const promptJson = await promptRes.json();
    assert.equal(promptJson.path, path.join(agentDir, "APPEND_SYSTEM.md"));
    assert.equal(promptJson.content, "");

    const diffRes = await fetch(`${base}/api/system-prompt/diff?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", mode: "append", content: "Be useful.\n", baseHash: promptJson.hash }),
    });
    assert.equal(diffRes.status, 200);
    assert.match((await diffRes.json()).diff, /\+Be useful\./);

    const savePromptRes = await fetch(`${base}/api/system-prompt/save?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", mode: "append", content: "Be useful.\n", baseHash: promptJson.hash }),
    });
    assert.equal(savePromptRes.status, 200);
    assert.equal(fs.readFileSync(path.join(agentDir, "APPEND_SYSTEM.md"), "utf8"), "Be useful.\n");


    const invalidTokenSaveRes = await fetch(`${base}/api/save?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "test-key", model: "mock-a", name: "localmock", contextWindow: 0, maxTokens: 32000 }),
    });
    assert.equal(invalidTokenSaveRes.status, 400);
    assert.match((await invalidTokenSaveRes.json()).error, /Context window must be a positive number/);

    const blankSaveRes = await fetch(`${base}/api/save?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "", model: "mock-a", name: "localmock" }),
    });
    assert.equal(blankSaveRes.status, 400);
    assert.match((await blankSaveRes.json()).error, /API Key is required/);

    const blankModelsRes = await fetch(`${base}/api/models?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "" }),
    });
    assert.equal(blankModelsRes.status, 400);
    assert.match((await blankModelsRes.json()).error, /API Key is required/);

    const settingsRes = await fetch(`${base}/api/settings?token=${token}`);
    assert.equal(settingsRes.status, 200);
    const settingsPreviewJson = await settingsRes.json();
    assert.equal(settingsPreviewJson.exists, true);
    assert.equal(settingsPreviewJson.parseError, null);
    assert.equal(settingsPreviewJson.json.defaultProvider, "localmock");
    assert.equal(settingsPreviewJson.json.defaultModel, "mock-a");
    assert.equal(settingsPreviewJson.json.defaultThinkingLevel, "high");
    assert.ok(settingsPreviewJson.content.includes("\"defaultProvider\": \"localmock\""));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => mock.close(resolve));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("provider web saves multiple models with a default marker", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-web-multi-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const mock = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mock-a" }, { id: "mock-b" }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const mockPort = mock.address().port;

  const { server, url } = await startProviderWeb({ openBrowser: false });
  try {
    const token = new URL(url).searchParams.get("token");
    const base = `http://127.0.0.1:${server.address().port}`;

    const saveRes = await fetch(`${base}/api/save?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: `http://127.0.0.1:${mockPort}/v1`,
        apiKey: "test-key",
        name: "multimock",
        models: [
          { id: "mock-a", default: false },
          { id: "mock-b", default: true },
        ],
        defaultModel: "mock-b",
        contextWindow: 128000,
        maxTokens: 32000,
        reasoningEffort: "medium",
      }),
    });
    assert.equal(saveRes.status, 200);

    const modelsJson = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    const saved = modelsJson.providers.multimock.models;
    assert.equal(saved.length, 2);
    assert.equal(saved[0].id, "mock-a");
    assert.equal(saved[0].default, undefined);
    assert.equal(saved[1].id, "mock-b");
    assert.equal(saved[1].default, true);

    const settingsJson = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(settingsJson.defaultProvider, "multimock");
    assert.equal(settingsJson.defaultModel, "mock-b");

    const configRes = await fetch(`${base}/api/config?token=${token}`);
    assert.equal(configRes.status, 200);
    const configJson = await configRes.json();
    assert.equal(configJson.defaultModel, "mock-b");
    assert.deepEqual(configJson.providers[0].models, ["mock-a", "mock-b"]);
    assert.deepEqual(configJson.providers[0].modelConfigs.map((m) => m.id), ["mock-a", "mock-b"]);
    assert.deepEqual(configJson.providers[0].modelConfigs.map((m) => m.default), [false, true]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => mock.close(resolve));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("provider web rejects oversized request bodies and invalid base URLs", async () => {
  const { server, url } = await startProviderWeb({ openBrowser: false });
  try {
    const token = new URL(url).searchParams.get("token");
    const base = `http://127.0.0.1:${server.address().port}`;

    const oversized = await fetch(`${base}/api/save?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"pad":"${"x".repeat(5 * 1024 * 1024)}"}`,
    });
    assert.equal(oversized.status, 400);
    assert.match((await oversized.json()).error, /Request body too large/);

    const badUrl = await fetch(`${base}/api/save?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "not a url", apiKey: "k", model: "m" }),
    });
    assert.equal(badUrl.status, 400);
    assert.match((await badUrl.json()).error, /Invalid base URL/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("provider web browser auto-open can be disabled for non-interactive runs", async () => {
  const { openBrowser } = await import("../src/provider-web.js");
  assert.equal(openBrowser("http://127.0.0.1:1", { env: { AXUM_PROVIDER_WEB_NO_OPEN: "1" } }), false);
});

test("provider web deletes a provider and switches the default", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-web-manage-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const mock = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mock-a" }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const mockPort = mock.address().port;

  const { server, url } = await startProviderWeb({ openBrowser: false });
  try {
    const token = new URL(url).searchParams.get("token");
    const base = `http://127.0.0.1:${server.address().port}`;
    const baseUrl = `http://127.0.0.1:${mockPort}/v1`;

    const saveA = await fetch(`${base}/api/save?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl, apiKey: "test-key", name: "alpha", model: "mock-a", reasoningEffort: "high" }),
    });
    assert.equal(saveA.status, 200);
    const saveB = await fetch(`${base}/api/save?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl, apiKey: "test-key", name: "beta", model: "mock-a", reasoningEffort: "medium" }),
    });
    assert.equal(saveB.status, 200);

    const defaultRes = await fetch(`${base}/api/providers/default?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "alpha", model: "mock-a", thinkingLevel: "low" }),
    });
    assert.equal(defaultRes.status, 200);
    let settingsJson = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(settingsJson.defaultProvider, "alpha");
    assert.equal(settingsJson.defaultThinkingLevel, "low");

    const deleteRes = await fetch(`${base}/api/providers/delete?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "alpha" }),
    });
    assert.equal(deleteRes.status, 200);
    assert.equal((await deleteRes.json()).deleted, true);

    const modelsJson = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    assert.equal(modelsJson.providers.alpha, undefined);
    assert.ok(modelsJson.providers.beta);
    settingsJson = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(settingsJson.defaultProvider, undefined);

    const missingRes = await fetch(`${base}/api/providers/delete?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ghost" }),
    });
    assert.equal(missingRes.status, 200);
    assert.equal((await missingRes.json()).deleted, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => mock.close(resolve));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("provider web exposes new-provider entry and keeps both providers after a second save", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-web-new-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const mock = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mock-a" }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const mockPort = mock.address().port;

  const { server, url } = await startProviderWeb({ openBrowser: false });
  try {
    const token = new URL(url).searchParams.get("token");
    const base = `http://127.0.0.1:${server.address().port}`;

    const pageRes = await fetch(`${base}/?token=${token}`);
    assert.equal(pageRes.status, 200);
    const pageHtml = await pageRes.text();
    assert.ok(pageHtml.includes('id="newProvider"'));
    assert.ok(pageHtml.includes('data-i18n="provNew"'));
    assert.ok(pageHtml.includes("newProviderForm"));
    assert.ok(pageHtml.includes("refreshProvidersList"));
    assert.ok(pageHtml.includes('id="preset-anthropic"'));
    assert.ok(pageHtml.includes('id="preset-openai-chat"'));
    assert.ok(pageHtml.includes('data-i18n="presetAnthropic"'));
    assert.ok(pageHtml.includes('data-i18n="presetOpenAIChat"'));
    assert.ok(pageHtml.includes("applyPreset"));
    assert.ok(pageHtml.includes('"baseUrl":"https://api.anthropic.com"'));
    assert.ok(pageHtml.includes('id="apiShape"'));
    assert.ok(pageHtml.includes('value="anthropic-messages"'));
    assert.ok(pageHtml.includes('data-i18n="apiShapeLabel"'));
    assert.ok(pageHtml.includes('"apiShapeNoFetch":"This API form has no model list endpoint'));
    assert.ok(pageHtml.includes("https://api.openai.com/v1"));

    const saveBody = {
      baseUrl: `http://127.0.0.1:${mockPort}/v1`,
      apiKey: "test-key",
      name: "firstmock",
      models: [{ id: "mock-a", default: true }],
      defaultModel: "mock-a",
      contextWindow: 128000,
      maxTokens: 32000,
      reasoningEffort: "high",
    };
    const firstRes = await fetch(`${base}/api/save?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(saveBody),
    });
    assert.equal(firstRes.status, 200);

    const secondRes = await fetch(`${base}/api/save?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...saveBody, name: "secondmock" }),
    });
    assert.equal(secondRes.status, 200);

    const modelsJson = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    assert.ok(modelsJson.providers.firstmock);
    assert.ok(modelsJson.providers.secondmock);
    assert.deepEqual(modelsJson.providers.secondmock.models.map((m) => m.id), ["mock-a"]);

    const configRes = await fetch(`${base}/api/config?token=${token}`);
    assert.equal(configRes.status, 200);
    const configJson = await configRes.json();
    assert.equal(configJson.providers.length, 2);
    assert.equal(configJson.defaultProvider, "secondmock");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => mock.close(resolve));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("provider web session read endpoint paginates and exposes structured tool parts", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-web-sessions-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const sessDir = path.join(agentDir, "sessions", "proj");
  fs.mkdirSync(sessDir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", id: "s1", timestamp: "2024-01-02T03:04:05Z", cwd: "/work/proj", version: 2 }),
    JSON.stringify({ type: "message", id: "m1", message: { role: "assistant", content: [{ type: "tool_use", name: "bash", input: { command: "pwd" } }] } }),
    JSON.stringify({ type: "message", id: "m2", message: { role: "user", content: [{ type: "tool_result", content: "out" }] } }),
  ];
  fs.writeFileSync(path.join(sessDir, "a.jsonl"), lines.join("\n") + "\n");

  const { server, url } = await startProviderWeb({ openBrowser: false });
  try {
    const token = new URL(url).searchParams.get("token");
    const base = `http://127.0.0.1:${server.address().port}`;

    const listRes = await fetch(`${base}/api/sessions?token=${token}`);
    assert.equal(listRes.status, 200);
    assert.equal((await listRes.json()).projects[0].sessions[0].id, "s1");

    const fullRes = await fetch(`${base}/api/sessions/read?token=${token}&file=${encodeURIComponent("proj/a.jsonl")}`);
    assert.equal(fullRes.status, 200);
    const fullJson = await fullRes.json();
    assert.equal(fullJson.total, 2);
    assert.equal(fullJson.messages[0].toolUse, "bash");

    const pagedRes = await fetch(`${base}/api/sessions/read?token=${token}&file=${encodeURIComponent("proj/a.jsonl")}&skip=1`);
    assert.equal(pagedRes.status, 200);
    const pagedJson = await pagedRes.json();
    assert.equal(pagedJson.skip, 1);
    assert.equal(pagedJson.total, 2);
    assert.equal(pagedJson.messages[0].toolResult, true);
    assert.equal(pagedJson.messages[0].text, "out");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("provider web page emits a parseable inline script", async () => {
  const { server, url } = await startProviderWeb({ openBrowser: false });
  try {
    const token = new URL(url).searchParams.get("token");
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/?token=${token}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    const match = /<script>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(match, "page must embed an inline script");
    // Compiling (not executing) the emitted script catches template-literal
    // escape leaks that turn into real newlines inside string literals.
    assert.doesNotThrow(() => new Function(match[1]), "inline script must parse");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("provider web save renames the provider instead of cloning", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-web-rename-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const modelsFile = path.join(agentDir, "models.json");
  const mk = (name) => ({
    baseUrl: "https://api.example.com/v1",
    apiKey: "test-key",
    models: [{ id: "m-1", default: true }],
    name,
  });
  const { server, url } = await startProviderWeb({ openBrowser: false });
  try {
    const token = new URL(url).searchParams.get("token");
    const base = `http://127.0.0.1:${server.address().port}`;
    const save = async (body) => {
      const res = await fetch(`${base}/api/save?token=${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text(); // drain so keep-alive sockets close
      return { status: res.status, body: text };
    };

    assert.equal((await save(mk("alpha"))).status, 200);
    const renamed = await save({ ...mk("beta"), originalName: "alpha" });
    assert.equal(renamed.status, 200);
    assert.equal(JSON.parse(renamed.body).provider, "beta");
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(modelsFile, "utf8")).providers), ["beta"]);

    // renaming onto an unrelated existing provider must not silently overwrite
    await save(mk("gamma"));
    const conflict = await save({ ...mk("beta"), originalName: "gamma" });
    assert.equal(conflict.status, 400);
    assert.match(conflict.body, /already exists/);
    const modelsAfter = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
    assert.deepEqual(Object.keys(modelsAfter.providers).sort(), ["beta", "gamma"]);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    delete process.env.PI_CODING_AGENT_DIR;
    if (previous !== undefined) process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("provider web save refuses to clobber an existing provider on creation", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-web-dup-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const modelsFile = path.join(agentDir, "models.json");
  const { server, url } = await startProviderWeb({ openBrowser: false });
  try {
    const token = new URL(url).searchParams.get("token");
    const base = `http://127.0.0.1:${server.address().port}`;
    const save = async (body) => {
      const res = await fetch(`${base}/api/save?token=${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text };
    };
    const mk = (apiKey, model) => ({
      baseUrl: "https://api.example.com/v1",
      apiKey,
      models: [{ id: model, default: true }],
      name: "alpha",
    });

    assert.equal((await save(mk("key-1", "m-1"))).status, 200);
    const dup = await save(mk("key-2", "m-2"));
    assert.equal(dup.status, 400);
    assert.match(dup.body, /already exists/);

    const models = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
    assert.deepEqual(Object.keys(models.providers), ["alpha"]);
    assert.equal(models.providers.alpha.apiKey, "key-1", "existing provider must not be clobbered");
    assert.equal(models.providers.alpha.models[0].id, "m-1");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    delete process.env.PI_CODING_AGENT_DIR;
    if (previous !== undefined) process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("provider web saves the selected API form and refuses model listing for native forms", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-web-api-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const { server, url } = await startProviderWeb({ openBrowser: false });
  try {
    const token = new URL(url).searchParams.get("token");
    const base = `http://127.0.0.1:${server.address().port}`;

    const saveRes = await fetch(`${base}/api/save?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        apiKey: "test-key",
        name: "anthropic-native",
        models: [{ id: "claude-sonnet-5", default: true }],
        defaultModel: "claude-sonnet-5",
        contextWindow: 1000000,
        maxTokens: 128000,
        reasoningEffort: "high",
      }),
    });
    assert.equal(saveRes.status, 200);

    const modelsJson = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    assert.equal(modelsJson.providers["anthropic-native"].api, "anthropic-messages");
    assert.ok(!("compat" in modelsJson.providers["anthropic-native"]), "native form defers compat to pi-ai");

    const configRes = await fetch(`${base}/api/config?token=${token}`);
    const configJson = await configRes.json();
    assert.equal(configJson.providers[0].api, "anthropic-messages");

    const listRes = await fetch(`${base}/api/models?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api: "anthropic-messages", baseUrl: "https://api.anthropic.com", apiKey: "test-key" }),
    });
    assert.equal(listRes.status, 400);
    assert.match((await listRes.json()).error, /OpenAI-compatible API form/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("provider web export/import round-trip migrates providers and the default selection", async () => {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-web-export-src-"));
  const dstDir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-web-export-dst-"));
  const previous = process.env.PI_CODING_AGENT_DIR;

  process.env.PI_CODING_AGENT_DIR = srcDir;
  const srcServer = await startProviderWeb({ openBrowser: false });
  try {
    const token = new URL(srcServer.url).searchParams.get("token");
    const base = `http://127.0.0.1:${srcServer.server.address().port}`;
    const saveRes = await fetch(`${base}/api/save?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        apiKey: "test-key",
        name: "anthropic-native",
        models: [{ id: "claude-sonnet-5", default: true }],
        reasoningEffort: "high",
      }),
    });
    assert.equal(saveRes.status, 200);
    const defaultRes = await fetch(`${base}/api/providers/default?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "anthropic-native", model: "claude-sonnet-5", thinkingLevel: "high" }),
    });
    assert.equal(defaultRes.status, 200);

    const exportRes = await fetch(`${base}/api/providers/export?token=${token}`);
    assert.equal(exportRes.status, 200);
    const exported = await exportRes.json();
    assert.equal(exported.providers["anthropic-native"].api, "anthropic-messages");
    assert.equal(exported.defaultProvider, "anthropic-native");
    assert.equal(exported.defaultModel, "claude-sonnet-5");

    // import into a fresh target agent dir via its own server instance
    process.env.PI_CODING_AGENT_DIR = dstDir;
    const dstServer = await startProviderWeb({ openBrowser: false });
    try {
      const dstToken = new URL(dstServer.url).searchParams.get("token");
      const dstBase = `http://127.0.0.1:${dstServer.server.address().port}`;
      const importRes = await fetch(`${dstBase}/api/providers/import?token=${dstToken}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: exported, overwrite: true }),
      });
      assert.equal(importRes.status, 200);
      const importJson = await importRes.json();
      assert.equal(importJson.added, 1);
      assert.equal(importJson.defaultRestored, true);

      const dstModels = JSON.parse(fs.readFileSync(path.join(dstDir, "models.json"), "utf8"));
      assert.deepEqual(Object.keys(dstModels.providers), ["anthropic-native"]);
      assert.equal(dstModels.providers["anthropic-native"].apiKey, "test-key");
      const dstSettings = JSON.parse(fs.readFileSync(path.join(dstDir, "settings.json"), "utf8"));
      assert.equal(dstSettings.defaultProvider, "anthropic-native");
      assert.equal(dstSettings.defaultModel, "claude-sonnet-5");
      assert.equal(dstSettings.defaultThinkingLevel, "high");
    } finally {
      await new Promise((resolve) => dstServer.server.close(resolve));
    }
  } finally {
    await new Promise((resolve) => srcServer.server.close(resolve));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("provider web clones a provider under a fresh name without touching the source", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-web-clone-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const modelsFile = path.join(agentDir, "models.json");

  const { server, url } = await startProviderWeb({ openBrowser: false });
  try {
    const token = new URL(url).searchParams.get("token");
    const base = `http://127.0.0.1:${server.address().port}`;

    const saveRes = await fetch(`${base}/api/save?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        apiKey: "test-key",
        name: "alpha",
        models: [{ id: "claude-sonnet-5", default: true }],
        contextWindow: 1000000,
        maxTokens: 128000,
        reasoningEffort: "high",
      }),
    });
    assert.equal(saveRes.status, 200);

    const pageRes = await fetch(`${base}/?token=${token}`);
    const pageHtml = await pageRes.text();
    assert.ok(pageHtml.includes("\"provClone\":\"Clone\""), "page must ship the clone button label");
    assert.ok(pageHtml.includes("cloneProviderAction"), "page must ship the clone handler");
    assert.ok(pageHtml.includes("/api/providers/clone"), "page must call the clone endpoint");

    const cloneRes = await fetch(`${base}/api/providers/clone?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "alpha" }),
    });
    assert.equal(cloneRes.status, 200);
    const cloneJson = await cloneRes.json();
    assert.equal(cloneJson.source, "alpha");
    assert.equal(cloneJson.name, "alpha-copy");
    assert.equal(cloneJson.provider.api, "anthropic-messages");
    assert.equal(cloneJson.provider.apiKey, "test-key");
    assert.equal(cloneJson.provider.models[0].id, "claude-sonnet-5");

    const models = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
    assert.deepEqual(Object.keys(models.providers), ["alpha", "alpha-copy"]);
    assert.equal(models.providers.alpha.apiKey, "test-key");
    assert.equal(models.providers["alpha-copy"].models[0].contextWindow, 1000000);

    // the default pointer must stay on the source provider
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(settings.defaultProvider, "alpha");

    const missingRes = await fetch(`${base}/api/providers/clone?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ghost" }),
    });
    assert.equal(missingRes.status, 400);
    assert.match((await missingRes.json()).error, /does not exist/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("provider web batch-deletes sessions and round-trips them through provider export/import", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-web-batch-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  fs.mkdirSync(path.join(agentDir, "sessions", "proj"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "sessions", "other"), { recursive: true });
  const bodyA = JSON.stringify({ type: "session", id: "s1", timestamp: "2024-01-02T03:04:05Z", cwd: "/p", version: 2 }) + "\n"
    + JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "batch delete me" } }) + "\n";
  const bodyB = JSON.stringify({ type: "session", id: "s2", timestamp: "2024-01-03T03:04:05Z", cwd: "/p", version: 2 }) + "\n"
    + JSON.stringify({ type: "message", id: "m2", message: { role: "user", content: "keep and export me" } }) + "\n";
  const bodyC = bodyA.replace("s1", "s3").replace("m1", "m3");
  fs.writeFileSync(path.join(agentDir, "sessions", "proj", "a.jsonl"), bodyA);
  fs.writeFileSync(path.join(agentDir, "sessions", "proj", "b.jsonl"), bodyB);
  fs.writeFileSync(path.join(agentDir, "sessions", "other", "c.jsonl"), bodyC);

  const { server, url } = await startProviderWeb({ openBrowser: false });
  try {
    const token = new URL(url).searchParams.get("token");
    const base = `http://127.0.0.1:${server.address().port}`;

    const batchRes = await fetch(`${base}/api/sessions/delete-batch?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: ["proj/a.jsonl", "other/c.jsonl", "proj/missing.jsonl"] }),
    });
    assert.equal(batchRes.status, 200);
    const batch = await batchRes.json();
    assert.equal(batch.deleted, 2);
    assert.equal(batch.total, 3);
    assert.deepEqual(batch.failed, [{ file: "proj/missing.jsonl", reason: "not found" }]);
    assert.equal(fs.existsSync(path.join(agentDir, "sessions", "proj", "a.jsonl")), false);
    assert.equal(fs.existsSync(path.join(agentDir, "sessions", "other", "c.jsonl")), false);
    assert.equal(fs.existsSync(path.join(agentDir, "sessions", "other")), false);
    assert.equal(fs.existsSync(path.join(agentDir, "sessions", "proj", "b.jsonl")), true);

    const exportRes = await fetch(`${base}/api/providers/export?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: ["proj/b.jsonl"] }),
    });
    assert.equal(exportRes.status, 200);
    const exported = await exportRes.json();
    assert.ok(exported.providers, "export still carries providers");
    assert.equal(exported.sessions.length, 1);
    assert.equal(exported.sessions[0].file, "proj/b.jsonl");
    assert.equal(exported.sessions[0].content, bodyB);

    const dstDir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-web-batch-dst-"));
    process.env.PI_CODING_AGENT_DIR = dstDir;
    const importRes = await fetch(`${base}/api/providers/import?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: exported, overwrite: true }),
    });
    assert.equal(importRes.status, 200);
    const imported = await importRes.json();
    assert.ok(imported.sessions, "import result must report session restore");
    assert.equal(imported.sessions.added, 1);
    assert.equal(imported.sessions.failed.length, 0);
    assert.equal(fs.readFileSync(path.join(dstDir, "sessions", "proj", "b.jsonl"), "utf8"), bodyB);
    fs.rmSync(dstDir, { recursive: true, force: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("provider web batch delete rejects an empty file list", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-web-batch-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { server, url } = await startProviderWeb({ openBrowser: false });
  try {
    const token = new URL(url).searchParams.get("token");
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/sessions/delete-batch?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [] }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /files must be a non-empty array/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("provider web lists, deletes and round-trips prompt history through export/import", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-web-history-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  fs.mkdirSync(path.join(agentDir, "sessions", "--test-proj--"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "sessions", "--other-proj--"), { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "sessions", "--test-proj--", "prompt-history"),
    JSON.stringify("keep me") + "\n" + JSON.stringify("delete me") + "\n" + JSON.stringify("delete me") + "\n",
  );
  fs.writeFileSync(
    path.join(agentDir, "sessions", "--other-proj--", "prompt-history"),
    JSON.stringify("other prompt") + "\n",
  );

  const { server, url } = await startProviderWeb({ openBrowser: false });
  try {
    const token = new URL(url).searchParams.get("token");
    const base = `http://127.0.0.1:${server.address().port}`;

    const listRes = await fetch(`${base}/api/prompt-history?token=${token}`);
    assert.equal(listRes.status, 200);
    const listed = await listRes.json();
    assert.equal(listed.totalEntries, 3);
    const proj = listed.projects.find((p) => p.dir === "--test-proj--");
    assert.ok(proj, "test-proj must be listed");
    // duplicates collapse: 3 raw lines -> 2 entries + 1 duplicate
    assert.equal(proj.entries.length, 2);
    assert.equal(proj.duplicates, 1);
    assert.equal(proj.entries[0].text, "delete me");
    assert.equal(proj.entries[1].text, "keep me");
    const delIdx = proj.entries[0].index;

    const batchRes = await fetch(`${base}/api/prompt-history/delete-batch?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "--test-proj--", indexes: [delIdx, 99] }),
    });
    assert.equal(batchRes.status, 200);
    const batch = await batchRes.json();
    assert.equal(batch.deleted, 1);
    assert.equal(batch.failed.length, 1);
    assert.match(batch.failed[0].reason, /out of range|invalid|not found/i);

    const afterList = await (await fetch(`${base}/api/prompt-history?token=${token}`)).json();
    const afterProj = afterList.projects.find((p) => p.dir === "--test-proj--");
    assert.equal(afterProj.entries.length, 1);
    assert.equal(afterProj.entries[0].text, "keep me");

    // export must carry prompt history alongside providers/sessions
    const exportRes = await fetch(`${base}/api/providers/export?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(exportRes.status, 200);
    const exported = await exportRes.json();
    assert.ok(Array.isArray(exported.promptHistory), "export must carry promptHistory");
    assert.equal(exported.promptHistory.length, 2);
    const exportedProj = exported.promptHistory.find((p) => p.project === "--test-proj--");
    assert.deepEqual(exportedProj.entries, ["keep me"]);

    // import into a fresh agent dir restores history
    const dstDir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-web-history-dst-"));
    process.env.PI_CODING_AGENT_DIR = dstDir;
    const importRes = await fetch(`${base}/api/providers/import?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: exported, overwrite: true }),
    });
    assert.equal(importRes.status, 200);
    const imported = await importRes.json();
    assert.ok(imported.promptHistory, "import result must report prompt history restore");
    assert.equal(imported.promptHistory.added, 2);
    assert.equal(imported.promptHistory.failed.length, 0);
    const restored = fs.readFileSync(path.join(dstDir, "sessions", "--test-proj--", "prompt-history"), "utf8");
    assert.deepEqual(restored.trim().split("\n").map((l) => JSON.parse(l)), ["keep me"]);

    // delete-all clears every project
    const delAllRes = await fetch(`${base}/api/prompt-history/delete-all?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    assert.equal(delAllRes.status, 200);
    const delAll = await delAllRes.json();
    assert.equal(delAll.deleted, 2);
    assert.equal(fs.existsSync(path.join(dstDir, "sessions", "--test-proj--", "prompt-history")), false);
    fs.rmSync(dstDir, { recursive: true, force: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("provider web prompt history delete rejects traversal and missing project", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-web-history-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { server, url } = await startProviderWeb({ openBrowser: false });
  try {
    const token = new URL(url).searchParams.get("token");
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const project of ["../evil", "a/b", ".."]) {
      const res = await fetch(`${base}/api/prompt-history/delete?token=${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, index: 0 }),
      });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /Invalid project/);
    }
    const noProject = await fetch(`${base}/api/prompt-history/delete?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index: 0 }),
    });
    assert.equal(noProject.status, 400);
    const emptyBatch = await fetch(`${base}/api/prompt-history/delete-batch?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "--p--", indexes: [] }),
    });
    assert.equal(emptyBatch.status, 400);
    assert.match((await emptyBatch.json()).error, /indexes must be a non-empty array/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
