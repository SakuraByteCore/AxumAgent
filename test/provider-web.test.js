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
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "test-key", model: "mock-b", name: "localmock" }),
    });
    assert.equal(saveRes.status, 200);
    const modelsJson = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    assert.equal(modelsJson.providers.localmock.models[0].id, "mock-b");
    assert.equal(modelsJson.providers.localmock.apiKey, "test-key");
    const axumJson = JSON.parse(fs.readFileSync(path.join(agentDir, "axum.json"), "utf8"));
    assert.deepEqual(axumJson, { defaultProvider: "localmock", defaultModel: "mock-b" });

    const configRes = await fetch(`${base}/api/config?token=${token}`);
    assert.equal(configRes.status, 200);
    const configJson = await configRes.json();
    assert.equal(configJson.defaultProvider, "localmock");
    assert.equal(configJson.defaultModel, "mock-b");
    assert.deepEqual(configJson.providers[0].models, ["mock-b"]);
    assert.equal(configJson.providers[0].hasApiKey, true);

    const preserveRes = await fetch(`${base}/api/save?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "", model: "mock-a", name: "localmock" }),
    });
    assert.equal(preserveRes.status, 200);
    const preservedJson = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    assert.equal(preservedJson.providers.localmock.apiKey, "test-key");
    assert.equal(preservedJson.providers.localmock.models[0].id, "mock-a");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => mock.close(resolve));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("provider web browser auto-open can be disabled for non-interactive runs", async () => {
  const { openBrowser } = await import("../src/provider-web.js");
  assert.equal(openBrowser("http://127.0.0.1:1", { env: { AXUM_PROVIDER_WEB_NO_OPEN: "1" } }), false);
});
