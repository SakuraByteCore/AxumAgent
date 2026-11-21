import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { startProviderWeb } from "../src/provider-web.js";
import { fetchOpenAICompatibleModels } from "../src/provider-config.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

// Exercise the shipped form handlers against the real HTTP save/config routes.
test("web model contexts use listing metadata, catalog and presets without resetting /ctx", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-web-context-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const rows = [{ id: "large", context_length: 262144 }, { id: "giant", contextWindow: 1000000 },
    { id: "nested", top_provider: { context_length: 32000 } }, { id: "unknown" },
    { id: "invalid", context_length: -1 }, { id: "gpt-4.1" }];
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: rows }));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  assert.deepEqual(await fetchOpenAICompatibleModels({ baseUrl, apiKey: "fixture-key" }), rows.map(row => row.id).sort(), "legacy model-list callers still receive IDs");
  const { server, url } = await startProviderWeb({ openBrowser: false });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const html = await (await fetch(url)).text();
  const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  new vm.Script(script);
  const token = JSON.parse(script.match(/const token=("[^\"]+")/)[1]);
  const request = (route, body) => fetch(new URL(route, url), {
    method: body ? "POST" : "GET", headers: { "x-axum-token": token, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const controls = new Map();
  const $ = id => {
    if (!controls.has(id)) controls.set(id, { value: "", checked: false });
    return controls.get(id);
  };
  const errors = [];
  const context = vm.createContext({ $, Headers, token, currentModels: [], currentDefaultId: "",
    currentModelEfforts: new Map(), loadedProvider: null, providerLoaded: false, allDefaultProvider: "", allDefaultModel: "",
    providerDefaults: { maxTokens: 32000, reasoningEffort: "high" }, providerLastValid: { maxTokens: 32000, reasoningEffort: "high" },
    DEFAULT_API_FORM: "openai-completions", comboModels: [], comboActiveIndex: -1,
    T: String, renderModelList() {}, setApiForm(api) { $("apiShape").value = api; },
    currentApiForm: () => $("apiShape").value, step() {}, openComboDropdown() {},
    setStatus(kind, message) { if (kind === "err") errors.push(message); }, loadExisting() {},
    fetch: (route, options) => fetch(new URL(route, url), options),
  });
  for (const name of ["apiFetch", "setComboModels", "addModel", "currentModelConfig", "fillProvider", "newProviderForm", "fetchModelsAction", "applyPreset"]) {
    const match = new RegExp("(?:async )?function " + name + "\\(").exec(script);
    assert.ok(match, name);
    const start = match.index;
    const next = script.slice(start + match[0].length).search(/(?:async )?function \w+\(/);
    const end = name === "apiFetch" ? script.indexOf("const PRESETS=", start)
      : name === "newProviderForm" ? script.indexOf("let allProviders=", start)
      : name === "applyPreset" ? script.indexOf("PRESETS.forEach", start) : start + match[0].length + next;
    vm.runInContext(script.slice(start, end), context);
  }
  const saveStart = script.indexOf("$('save').onclick=");
  vm.runInContext(script.slice(saveStart, script.indexOf(";async function loadCommandSettings", saveStart)), context);
  const readModels = () => JSON.parse(fs.readFileSync(path.join(dir, "models.json"))).providers;
  context.newProviderForm();
  $("providerName").value = "listed"; $("baseUrl").value = baseUrl; $("apiKey").value = "fixture-key";
  await context.fetchModelsAction();
  for (const row of rows) context.addModel(row.id);
  await $("save").onclick();
  assert.deepEqual(errors, []);
  assert.deepEqual(readModels().listed.models.map(m => m.contextWindow), [262144, 1000000, 32000, 128000, 128000, 1047576]);
  const saved = readModels();
  saved.listed.models[0].contextWindow = 64000;
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: saved }));
  const config = await (await request("/api/config")).json();
  context.fillProvider(config.providers[0], "large", "high");
  await context.fetchModelsAction();
  context.addModel("manual");
  await $("save").onclick();
  assert.deepEqual(errors, []);
  assert.equal(readModels().listed.models[0].contextWindow, 64000);
  assert.equal(readModels().listed.models.at(-1).contextWindow, 128000);
  const presets = JSON.parse(script.match(/const PRESETS=(.*?);const API_FORMS=/)[1]);
  context.applyPreset(presets.find(p => p.id === "anthropic"));
  $("apiKey").value = "fixture-key";
  context.addModel("claude-sonnet-5"); context.addModel("custom-anthropic");
  await $("save").onclick();
  assert.deepEqual(errors, []);
  assert.deepEqual(readModels().anthropic.models.map(m => m.contextWindow), [1000000, 1000000]);
  context.applyPreset(presets.find(p => p.id === "openai-chat"));
  $("apiKey").value = "fixture-key"; context.addModel("gpt-4.1");
  await $("save").onclick();
  assert.equal(readModels().openai.models[0].contextWindow, 1047576, "exact model catalog beats the generic preset");
  context.newProviderForm();
  $("providerName").value = "fresh"; $("baseUrl").value = baseUrl; $("apiKey").value = "fixture-key";
  context.addModel("large");
  await $("save").onclick();
  assert.equal(readModels().fresh.models[0].contextWindow, 128000, "new form must not leak prior metadata or presets");
  context.newProviderForm();
  $("providerName").value = "changed"; $("baseUrl").value = baseUrl; $("apiKey").value = "fixture-key";
  await context.fetchModelsAction();
  $("apiKey").value = "another-fixture-key";
  context.addModel("large");
  await $("save").onclick();
  assert.equal(readModels().changed.models[0].contextWindow, 128000, "a changed connection must not reuse old listing metadata");
  const explicit = await request("/api/save", { name: "explicit", baseUrl, apiKey: "fixture-key", models: [{ id: "gpt-4.1", contextWindow: 65536 }] });
  assert.equal(explicit.status, 200);
  assert.equal(readModels().explicit.models[0].contextWindow, 65536);
  const before = fs.readFileSync(path.join(dir, "models.json"), "utf8");
  const invalid = await request("/api/save", { name: "invalid", baseUrl, apiKey: "fixture-key", models: [{ id: "bad", contextWindow: -1 }] });
  assert.equal(invalid.status, 400);
  assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf8"), before);
  const runtime = await ModelRuntime.create({ modelsPath: path.join(dir, "models.json"), authPath: path.join(dir, "auth.json"), refreshOnCreate: false });
  assert.equal(runtime.getError(), undefined);
  assert.equal(runtime.getModel("listed", "large").contextWindow, 64000);
  assert.equal(runtime.getModel("listed", "gpt-4.1").contextWindow, 1047576);
  assert.equal(runtime.getModel("anthropic", "claude-sonnet-5").contextWindow, 1000000);
  assert.equal(runtime.getModel("explicit", "gpt-4.1").contextWindow, 65536);
});
