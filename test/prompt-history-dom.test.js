// Minimal DOM stub harness: renders the provider-web inline script and drives
// the Prompt history tree without a browser. Exercises project-level
// select/unselect-all interaction (button rendering, label flipping, filter
// awareness) against the real renderHistoryTree implementation.
import fs from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

function makeEl() {
  const e = {
    _html: "",
    _t: "",
    _tag: "",
    _parsedHtml: undefined,
    _children: [],
    onclick: null,
    disabled: false,
    value: "",
    hidden: false,
    className: "",
    style: {},
    dataset: {},
    classList: { toggle() {}, contains() { return false; }, add() {}, remove() {} },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    remove() {},
    setAttribute() {},
    getAttribute(name) {
      const m = new RegExp(name + '="([^"]*)"').exec(this._tag);
      return m ? m[1] : null;
    },
    querySelectorAll(sel) {
      const cls = sel.replace(/^\./, "");
      if (this._parsedHtml !== this._html) { this._children = []; this._parsedHtml = this._html; }
      const out = [];
      // toggle buttons are flat leaf elements; scan them directly
      const re = /<button([^>]*)>([^<]*)<\/button>/g;
      let m;
      let i = 0;
      while ((m = re.exec(this._html)) !== null) {
        if (!new RegExp('class="[^"]*' + cls + '[^"]*"').test(m[1])) continue;
        let child = this._children[i];
        if (!child) { child = makeEl(); this._children[i] = child; }
        child._tag = "<button" + m[1] + ">";
        child._t = m[2];
        out.push(child);
        i += 1;
      }
      return out;
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    click() {
      if (this.onclick) this.onclick({ stopPropagation() {} });
    },
  };
  Object.defineProperty(e, "innerHTML", {
    get() { return this._html; },
    set(v) { this._html = String(v); },
  });
  Object.defineProperty(e, "textContent", {
    get() { return this._t; },
    set(v) { this._t = String(v); },
  });
  return e;
}

function loadInlineScript() {
  const raw = fs.readFileSync(new URL("../src/provider-web.js", import.meta.url), "utf8");
  const start = raw.indexOf("<script>");
  const end = raw.indexOf("</script>", start);
  let js = raw.slice(start + "<script>".length, end);
  js = js
    .split("${JSON.stringify(token)}").join('"tok"')
    .split("${JSON.stringify(presets)}").join("[]")
    .split("${JSON.stringify(apiForms)}").join('[{"id":"openai","fetchable":true}]')
    .split("${JSON.stringify(DEFAULT_API_FORM)}").join('"openai"');
  assert.ok(!/\$\{/.test(js), "inline script must have no unresolved placeholders");
  return js;
}

function makeEnv() {
  const cache = new Map();
  const tree = makeEl();
  cache.set("histTree", tree);
  const doc = {
    getElementById(id) {
      if (!cache.has(id)) cache.set(id, makeEl());
      return cache.get(id);
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener() {},
    createElement() { return makeEl(); },
  };
  const fetch = () => Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: "stub" }) });
  const js = loadInlineScript();
  const fn = new Function(
    "document",
    "fetch",
    js + `
;return {
  get historyCache(){return historyCache},
  setCache(v){historyCache=v},
  renderHistoryTree, selectedHistory, tree:document.getElementById('histTree')
};`,
  );
  const api = fn(doc, fetch);
  api.search = doc.getElementById("histSearch");
  return api;
}

test("prompt history project toggle selects, unselects and respects the search filter", () => {
  const api = makeEnv();
  api.setCache([
    { dir: "--a--", cwdHint: "/proj/a", duplicates: 0, entries: [{ index: 0, text: "x", length: 1 }, { index: 1, text: "y", length: 1 }] },
    { dir: "--b--", cwdHint: "/proj/b", duplicates: 0, entries: [{ index: 0, text: "z", length: 1 }] },
  ]);
  api.renderHistoryTree();

  let toggles = api.tree.querySelectorAll(".hist-proj-toggle");
  assert.equal(toggles.length, 2, "one toggle button per project");
  assert.equal(toggles[0].getAttribute("data-project"), "--a--");
  assert.equal(toggles[1].getAttribute("data-project"), "--b--");
  assert.equal(toggles[0].textContent, "Select all", "unselected project shows Select all");
  assert.equal(api.selectedHistory.size, 0);

  toggles[0].click();
  assert.equal(api.selectedHistory.size, 2, "project a fully selected");
  assert.ok(api.selectedHistory.has("--a--::0"));
  assert.ok(api.selectedHistory.has("--a--::1"));
  assert.ok(!api.selectedHistory.has("--b--::0"), "other project untouched");
  toggles = api.tree.querySelectorAll(".hist-proj-toggle");
  assert.equal(toggles[0].textContent, "Unselect all", "label flips after full select");
  assert.equal(toggles[1].textContent, "Select all", "unrelated project label unchanged");

  toggles[0].click();
  assert.equal(api.selectedHistory.size, 0, "clicking again unselects the project");
  toggles = api.tree.querySelectorAll(".hist-proj-toggle");
  assert.equal(toggles[0].textContent, "Select all");

  api.search.value = "y";
  api.renderHistoryTree();
  toggles = api.tree.querySelectorAll(".hist-proj-toggle");
  assert.equal(toggles.length, 1, "only the matching project is rendered");
  toggles[0].click();
  assert.equal(api.selectedHistory.size, 1, "only the visible entry is selected");
  assert.ok(api.selectedHistory.has("--a--::1"));
  assert.ok(!api.selectedHistory.has("--a--::0"), "filtered-out entry stays unselected");
});
