import "./helpers/isolated-home.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { startProviderWeb } from "../src/provider-web.js";

test("single provider transfers preserve unrelated data and overwrite matching names", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-web-transfer-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const provider = { api: "openai-responses", baseUrl: "https://example.com/v1", apiKey: "test-key", headers: { "X-Test": "retained" }, maxTokens: 64000, models: [{ id: "m-1", default: true, contextWindow: 128000, maxTokens: 64000, reasoning: true }] };
  const modelsFile = path.join(dir, "models.json");
  const settingsFile = path.join(dir, "settings.json");
  const original = { userAgent: "retained-agent", providers: { alpha: provider, beta: { ...provider, api: "anthropic-messages", apiKey: "test-beta" } } };
  const settings = { defaultProvider: "alpha", defaultModel: "m-1", defaultThinkingLevel: "high", language: "zh" };
  fs.writeFileSync(modelsFile, JSON.stringify(original));
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  const { server, url } = await startProviderWeb({ openBrowser: false });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const html = await (await fetch(url)).text();
  const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  new vm.Script(script);
  assert.match(script, /data-export=/);
  assert.match(script, /exportProviderAction\(b\.getAttribute\('data-export'\)\)/);
  const dictionaries = JSON.parse(script.match(/const I18N=(\{.*?\});/s)[1]);
  for (const dictionary of Object.values(dictionaries)) {
    for (const key of ["provExport", "exportProviders", "providerTransferHint"]) assert.ok(dictionary[key]);
  }
  const token = JSON.parse(script.match(/const token=("(?:[^"\\]|\\.)*")/)[1]);
  const request = (route, body) => fetch(new URL(route, url), {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-axum-token": token, "content-type": "application/json", connection: "close" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const exportedRes = await request("/api/providers/export", { name: "beta", files: ["../invalid.jsonl"] });
  assert.equal(exportedRes.status, 200);
  assert.match(exportedRes.headers.get("content-disposition"), /axum-provider-.*\.json/);
  assert.equal(exportedRes.headers.get("cache-control"), "no-store");
  const exported = await exportedRes.json();
  assert.deepEqual(exported, { providers: { beta: original.providers.beta } });
  const defaultRes = await request("/api/providers/export?name=alpha");
  assert.equal(defaultRes.status, 200);
  assert.deepEqual(await defaultRes.json(), { providers: { alpha: provider }, defaultProvider: "alpha", defaultModel: "m-1", defaultThinkingLevel: "high" });
  const getRes = await request("/api/providers/export?name=beta");
  assert.deepEqual(await getRes.json(), exported);
  for (const name of ["missing", "", [], "__proto__"]) {
    assert.equal((await request("/api/providers/export", { name })).status, 400);
  }
  assert.equal((await request("/api/providers/export?name=missing")).status, 400);
  const changed = { ...provider, apiKey: "replacement-test-key", models: [{ id: "m-2", maxTokens: 32000 }] };
  const config = { providers: { beta: changed } };
  const skipped = await request("/api/providers/import", { config, overwrite: false });
  assert.equal((await skipped.json()).skipped, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(modelsFile, "utf8")), original);
  const imported = await request("/api/providers/import", { config });
  assert.equal(imported.status, 200);
  assert.deepEqual(await imported.json(), { added: 0, skipped: 0, replaced: 1, rejected: 0, total: 2, defaultRestored: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(modelsFile, "utf8")), { ...original, providers: { alpha: provider, beta: changed } });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")), settings);
  const restored = await request("/api/providers/import", { config: exported });
  assert.equal((await restored.json()).replaced, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(modelsFile, "utf8")), original);
  const added = await request("/api/providers/import", { config: { providers: { gamma: provider } } });
  assert.equal((await added.json()).added, 1);
});

test("Web export actions send only the chosen provider or the existing bulk session selection", async () => {
  const source = fs.readFileSync(new URL("../src/provider-web.js", import.meta.url), "utf8");
  const requests = [];
  const statuses = [];
  let downloads = 0;
  const link = { click() { downloads++; }, remove() {} };
  const controls = new Map();
  const context = vm.createContext({
    $: id => { if (!controls.has(id)) controls.set(id, {}); return controls.get(id); },
    selectedSessions: new Set(["project/session.jsonl"]),
    apiFetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: true, blob: async () => new Blob(["{}"]), headers: new Headers() }; },
    document: { createElement: () => link, body: { appendChild() {} } },
    URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
    T: key => key,
    setStatus: (type, message) => statuses.push({ type, message }),
  });
  vm.runInContext(source.slice(source.indexOf("async function exportProviderAction("), source.indexOf("$('importProviders').onclick=")), context);
  await context.exportProviderAction("beta");
  await controls.get("exportProviders").onclick();
  assert.deepEqual(requests, [
    { url: "/api/providers/export", body: { name: "beta" } },
    { url: "/api/providers/export", body: { files: ["project/session.jsonl"] } },
  ]);
  assert.equal(downloads, 2);
  assert.deepEqual(statuses, [{ type: "ok", message: "exported" }, { type: "ok", message: "exported" }]);
});
