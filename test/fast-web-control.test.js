import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { startProviderWeb } from "../src/provider-web.js";

test("rendered Fast checkbox save handler persists off/on/off through authenticated Web API", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-fast-control-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  const { server, url } = await startProviderWeb({ openBrowser: false });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const target = new URL(url);
  const html = await (await fetch(url)).text();
  assert.match(html, /<label for="fastMode"/);
  assert.match(html, /type="checkbox" id="fastMode"/);
  assert.doesNotMatch(html, /id="fastMode"[^>]*checked/);
  for (const key of ["fastMode", "fastModeHint"]) assert.equal(html.split('"' + key + '":').length - 1, 3);
  const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  assert.ok(script);
  const start = script.indexOf("$('save').onclick=");
  const end = script.indexOf(";async function loadCommandSettings", start);
  assert.ok(start > 0 && end > start);
  const controls = new Map();
  const $ = id => { if (!controls.has(id)) controls.set(id, { value: "", checked: false, disabled: false }); return controls.get(id); };
  $("providerName").value = "local";
  $("baseUrl").value = "http://127.0.0.1:1/v1";
  $("apiKey").value = "***";
  $("maxTokens").value = "16";
  $("reasoningEffort").value = "off";
  $("apiShape").value = "openai-completions";
  const failures = [];
  const context = vm.createContext({ $, currentModels: ["mock"], currentDefaultId: "mock", loadedProvider: null,
    token: target.searchParams.get("token"), encodeURIComponent, JSON, Number,
    providerLastValid: { maxTokens: 16, reasoningEffort: "off" }, providerDefaults: { maxTokens: 16, reasoningEffort: "off" },
    currentApiForm: () => $("apiShape").value,
    tokenValue: id => Number($(id).value), tokenNumber: id => Number($(id).value),
    readTokenField: id => Number($(id).value),
    setStatus: (kind, message) => { if (kind === "err") failures.push(message); }, step: () => {}, T: key => key, loadExisting: () => {},
    fetch: (url, options) => fetch(new URL(url, target), options),
  });
  vm.runInContext(script.slice(start, end), context);
  for (const enabled of [false, true, false]) {
    $("fastMode").checked = enabled;
    await $("save").onclick();
    assert.deepEqual(failures, []);
    const config = await (await fetch(new URL('/api/config?token=' + target.searchParams.get('token'), target))).json();
    assert.equal(config.providers[0].fastMode, enabled);
    const metadata = JSON.parse(fs.readFileSync(path.join(dir, "axum.json"), "utf8"));
    assert.deepEqual(metadata.fastModels, enabled ? { local: ["mock"] } : {});
    assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, "models.json")))).includes("service_tier"), false);
    context.loadedProvider = { id: "local" };
  }
});
