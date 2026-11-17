import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { startProviderWeb } from "../src/provider-web.js";

function element(id) {
  const attributes = new Map();
  const classes = new Set();
  return {
    id, value: "", textContent: "", disabled: false,
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: name => attributes.get(name),
    classList: { contains: name => classes.has(name), toggle(name, value) { value ? classes.add(name) : classes.delete(name); } },
  };
}

test("workspace navigation, theme preferences and save guards keep their contracts", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-workspace-"));
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
  const translations = JSON.parse(script.match(/const I18N=(\{.*?\});\s*const T=/s)[1]);
  const translatedKeys = [...html.matchAll(/data-i18n(?:-ph|-aria)?="([^"]+)"/g)].map(match => match[1]);
  for (const [language, dictionary] of Object.entries(translations)) {
    for (const key of translatedKeys) {
      assert.ok(dictionary[key]?.trim(), `${language}: missing visible translation ${key}`);
    }
  }
  const names = ["provider", "prompt", "retry", "sessions", "history", "settings"];
  const controls = new Map();
  const $ = id => {
    if (!controls.has(id)) controls.set(id, element(id));
    return controls.get(id);
  };
  const storage = new Map([["axumTheme", "dark"]]);
  const side = element("side");
  const loads = [];
  const document = {
    documentElement: { dataset: {} },
    querySelector: selector => selector === ".side" ? side : names.map(name => $(name + "Tab")).find(tab => tab.classList.contains("active")),
  };
  const context = vm.createContext({ $, document, T: key => `copy:${key}`,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
  });
  for (const loader of ["loadSystemPrompt", "loadRetry", "loadSteering", "loadSessions", "loadSettings", "loadPromptHistory"]) {
    context[loader] = () => loads.push(loader);
  }
  vm.runInContext(script.slice(script.indexOf("function updatePageHeading("), script.indexOf("let initialTab=")), context);
  for (const name of [...names, "invalid-stored-tab"]) {
    const selected = names.includes(name) ? name : "provider";
    context.activateTab(name);
    for (const key of names) {
      assert.equal($(key + "Tab").getAttribute("aria-selected"), String(key === selected));
      assert.equal($(key + "Tab").tabIndex, key === selected ? 0 : -1);
      assert.equal($(key + "Panel").hidden, key !== selected);
      assert.match(html, new RegExp(`id="${key}Panel" role="tabpanel" aria-labelledby="${key}Tab"`));
    }
    assert.equal(side.hidden, selected !== "provider");
    assert.equal(storage.get("axumTab"), selected);
    assert.match(document.title, /^copy:tab/);
    assert.equal($("pageDescription").textContent, `copy:${selected}Description`);
  }
  assert.deepEqual(loads, ["loadSystemPrompt", "loadRetry", "loadSteering", "loadSessions", "loadPromptHistory", "loadSettings"]);
  vm.runInContext(script.slice(script.indexOf("const savedTheme="), script.indexOf("const tablist=")), context);
  assert.equal(document.documentElement.dataset.theme, "dark");
  for (const theme of ["light", "system"]) {
    $("themeSelect").value = theme;
    $("themeSelect").onchange();
    assert.equal(storage.get("axumTheme"), theme);
    assert.equal(document.documentElement.dataset.theme, theme === "system" ? undefined : theme);
  }
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let saves = 0;
  const saveIds = ["save", "savePrompt", "saveRetry", "saveSteering", "saveCommands"];
  for (const id of saveIds) $(id).onclick = async () => { saves++; await gate; };
  context.saveCommandSettings = $("saveCommands").onclick;
  const start = script.indexOf("for(const id of ['save','savePrompt'");
  const assignment = script.indexOf("$('saveCommands').onclick=saveCommandSettings;");
  assert.ok(assignment >= 0 && assignment < start, "bind command saving before installing guards");
  vm.runInContext(script.slice(assignment, script.indexOf("loadLang();", start)), context);
  const saving = $("saveCommands").onclick();
  await $("saveCommands").onclick();
  assert.equal(saves, 1);
  assert.equal($("saveCommands").disabled, true);
  assert.equal($("saveCommands").getAttribute("aria-busy"), "true");
  release();
  await saving;
  assert.equal($("saveCommands").disabled, false);
  assert.equal($("saveCommands").getAttribute("aria-busy"), "false");
  assert.match(html, /id="commandsStatus" class="status" role="status" aria-live="polite"/);
});
