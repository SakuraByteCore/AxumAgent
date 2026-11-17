import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { startProviderWeb } from "../src/provider-web.js";

test("model strength controls persist independently across defaults, providers and reloads", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-model-strength-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { server, url } = await startProviderWeb({ openBrowser: false });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const html = await (await fetch(url)).text();
  const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  new vm.Script(script);
  assert.doesNotMatch(html, /id="maxTokens"/);
  assert.doesNotMatch(script, /\$\('maxTokens'\)/);
  assert.doesNotMatch(html, /id="reasoningEffort"/);
  assert.doesNotMatch(script, /\$\('reasoningEffort'\)/);
  const token = JSON.parse(script.match(/const token=("[^"]+")/)[1]);
  const request = (route, body) => fetch(new URL(route, url), {
    method: body ? "POST" : "GET",
    headers: { "x-axum-token": token, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const controls = new Map();
  const $ = id => {
    assert.notEqual(id, "maxTokens", "removed global output control must not be accessed");
    assert.notEqual(id, "reasoningEffort", "removed global control must not be accessed");
    if (!controls.has(id)) controls.set(id, { value: "", checked: false });
    return controls.get(id);
  };
  const nodes = new Map();
  Object.defineProperty($("modelList"), "innerHTML", { set(html) {
    for (const [selector, pattern] of [
      ["select[data-effort]", /<select data-effort="([^"]+)"[^>]*>(.*?)<\/select>/g],
      ["input[data-setdef]", /data-setdef="([^"]+)"/g],
      [".m-del", /data-del="([^"]+)"/g],
    ]) nodes.set(selector, Array.from(html.matchAll(pattern), match => ({
      getAttribute: () => match[1], value: match[2]?.match(/value="([^"]+)" selected/)?.[1],
    })));
  } });
  $("modelList").querySelectorAll = selector => nodes.get(selector) || [];
  let providerInputs = [];
  Object.defineProperty($("providersList"), "innerHTML", { set(html) {
    providerInputs = Array.from(html.matchAll(/data-provider-tokens="([^"]+)"[^>]*value="([^"]+)"/g), match => ({
      getAttribute: () => match[1], value: match[2], disabled: false,
    }));
  } });
  $("providersList").querySelectorAll = selector => selector === "[data-provider-tokens]" ? providerInputs : [];
  const failures = [];
  const context = vm.createContext({ $, Headers, token, currentModels: [], currentDefaultId: "", currentModelEfforts: new Map(),
    loadedProvider: null, providerLoaded: false, allDefaultProvider: "", allDefaultModel: "",
    providerDefaults: { maxTokens: 32000, reasoningEffort: "high" }, providerLastValid: { maxTokens: 32000, reasoningEffort: "high" },
    DEFAULT_API_FORM: "openai-completions", T: key => key, esc: String, setComboModels() {}, setApiForm() {},
    setTokenField(id, value) { $(id).value = value; }, currentApiForm: () => "openai-completions",
    step() {}, setStatus(kind, message) { if (kind === "err") failures.push(message); }, loadExisting() {},
    fetch: (route, options) => fetch(new URL(route, url), options),
  });
  for (const name of ["apiFetch", "renderModelList", "addModel", "removeModel", "currentModelConfig", "fillProvider", "newProviderForm", "renderProviderList"]) {
    const start = script.indexOf("function " + name + "(");
    assert.ok(start >= 0, name);
    const next = script.slice(start + 9).search(/(?:async )?function \w+\(/);
    const end = name === "apiFetch" ? script.indexOf("const PRESETS=", start)
      : name === "newProviderForm" ? script.indexOf("let allProviders=", start) : start + 9 + next;
    vm.runInContext(script.slice(start, end), context);
  }
  const saveStart = script.indexOf("$('save').onclick=");
  vm.runInContext(script.slice(saveStart, script.indexOf(";async function loadCommandSettings", saveStart)), context);
  $("providerName").value = "alpha";
  $("baseUrl").value = "http://127.0.0.1:1/v1";
  $("apiKey").value = "test-key";
  context.addModel("shared");
  context.addModel("second");
  assert.equal(nodes.get("select[data-effort]").length, 2);
  const second = nodes.get("select[data-effort]")[1];
  second.value = "off";
  second.onchange();
  assert.equal(context.currentModelEfforts.get("shared"), "high");
  nodes.get("input[data-setdef]")[1].onchange();
  assert.equal(nodes.get("select[data-effort]")[1].value, "off");
  await $("save").onclick();
  assert.deepEqual(failures, []);
  let config = await (await request("/api/config")).json();
  let alpha = config.providers.find(p => p.id === "alpha");
  assert.deepEqual(alpha.modelConfigs.map(m => m.reasoningEffort), ["high", "off"]);
  assert.deepEqual(alpha.modelConfigs.map(m => m.reasoning), [true, false]);
  assert.equal(config.defaultThinkingLevel, "off");
  context.allDefaultProvider = "alpha";
  context.allDefaultModel = "second";
  context.fillProvider(alpha, "second", "off");
  assert.equal(context.currentModelEfforts.get("shared"), "high");
  assert.equal(context.currentModelEfforts.get("second"), "off");
  context.newProviderForm();
  assert.equal(context.currentModelEfforts.size, 0);
  $("providerName").value = "beta";
  $("baseUrl").value = "http://127.0.0.1:1/v1";
  $("apiKey").value = "test-key";
  context.addModel("shared");
  const shared = nodes.get("select[data-effort]")[0];
  shared.value = "max";
  shared.onchange();
  await $("save").onclick();
  assert.deepEqual(failures, []);
  config = await (await request("/api/config")).json();
  assert.equal(config.providers.find(p => p.id === "alpha").modelConfigs[0].reasoningEffort, "high");
  assert.equal(config.providers.find(p => p.id === "beta").modelConfigs[0].reasoningEffort, "max");
  assert.equal(config.defaultThinkingLevel, "max");
  const select = await request("/api/providers/default", { provider: "alpha", model: "second" });
  assert.equal(select.status, 200);
  assert.equal((await (await request("/api/config")).json()).defaultThinkingLevel, "off");
  const invalid = await request("/api/save", { name: "alpha", originalName: "alpha", baseUrl: alpha.baseUrl, apiKey: "test-key", models: [{ id: "shared", reasoningEffort: "ultra" }] });
  assert.equal(invalid.status, 400);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8"));
  assert.deepEqual(saved.providers.alpha.models.map(m => m.reasoningEffort), ["high", "off"]);
  context.allProviders = config.providers;
  context.fillProvider(alpha, "second", "off");
  context.renderProviderList();
  assert.deepEqual(providerInputs.map(input => input.value), ["32000", "32000"]);
  const input = providerInputs[0];
  input.value = "4096";
  await input.onchange();
  assert.equal(input.disabled, false);
  assert.deepEqual(failures, []);
  let updated = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8"));
  assert.equal(updated.providers.alpha.maxTokens, 4096);
  assert.deepEqual(updated.providers.alpha.models.map(m => m.maxTokens), [4096, 4096]);
  assert.equal(updated.providers.beta.models[0].maxTokens, 32000);
  assert.deepEqual(updated.providers.alpha.models.map(m => m.contextWindow), saved.providers.alpha.models.map(m => m.contextWindow));
  assert.deepEqual(updated.providers.alpha.models.map(m => m.reasoningEffort), ["high", "off"]);
  assert.equal((await (await request("/api/config")).json()).defaultThinkingLevel, "off");
  await $("save").onclick();
  assert.deepEqual(failures, []);
  updated = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8"));
  assert.equal(updated.providers.alpha.maxTokens, 4096, "editing the provider must preserve its output cap");
  assert.deepEqual(updated.providers.alpha.models.map(m => m.maxTokens), [4096, 4096]);
  input.value = "0";
  await input.onchange();
  assert.equal(input.value, "4096", "a rejected edit must restore the saved value");
  assert.equal(input.disabled, false);
  assert.match(failures.pop(), /positive integer/);
  for (const maxTokens of ["", -1, 1.5, true, null, {}, [4096], Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await request("/api/providers/max-tokens", { provider: "alpha", maxTokens })).status, 400);
  }
  assert.equal((await request("/api/providers/max-tokens", { provider: "missing", maxTokens: 1 })).status, 400);
  assert.equal((await fetch(new URL("/api/providers/max-tokens", url), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "alpha", maxTokens: 1 }),
  })).status, 403);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "models.json"))).providers.alpha.maxTokens, 4096);
  const clone = await request("/api/providers/clone", { name: "alpha" });
  assert.equal(clone.status, 200);
  const exported = await (await request("/api/providers/export")).json();
  assert.deepEqual(exported.providers["alpha-copy"].models.map(m => m.reasoningEffort), ["high", "off"]);
  assert.equal(exported.providers["alpha-copy"].maxTokens, 4096);
  assert.deepEqual(exported.providers["alpha-copy"].models.map(m => m.maxTokens), [4096, 4096]);
});
