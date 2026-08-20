import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureDefaultProviderReasoningSupport, getDefaultProviderSelection, getModelsPath, getRetrySettings, getSettingsPath, getSteeringMode, listProviders, loadModelsConfig, readSettingsRaw, saveDefaultProviderSelection, saveRetrySettings, saveSteeringMode, upsertOpenAICompatibleProvider } from "../src/provider-config.js";

test("writes OpenAI-compatible provider config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-provider-"));
  const file = path.join(dir, "models.json");
  const result = upsertOpenAICompatibleProvider({
    name: "kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k2",
    apiKeyEnv: "KIMI_API_KEY",
  }, file);

  assert.equal(result.file, file);
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(json.providers.kimi.api, "openai-completions");
  assert.equal(json.providers.kimi.apiKey, "$KIMI_API_KEY");
  assert.equal(json.providers.kimi.models[0].id, "kimi-k2");
  assert.equal(json.providers.kimi.compat.supportsDeveloperRole, false);
  assert.equal(json.providers.kimi.compat.supportsReasoningEffort, false);
  assert.deepEqual(listProviders(file)[0].models, ["kimi-k2"]);
  assert.equal(listProviders(file)[0].hasApiKey, true);
  assert.equal(listProviders(file, { includeSecrets: true })[0].apiKey, "$KIMI_API_KEY");
});

test("writes reasoning-capable provider config and default thinking level", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-provider-reasoning-"));
  const file = path.join(dir, "models.json");
  const settings = path.join(dir, "settings.json");
  const result = upsertOpenAICompatibleProvider({
    name: "reasoner",
    baseUrl: "https://api.example.com/v1",
    model: "reasoner-a",
    apiKey: "test-key",
    reasoningEffort: "high",
  }, file);
  saveDefaultProviderSelection({ provider: result.name, model: "reasoner-a", thinkingLevel: "high" }, settings);

  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  const model = json.providers.reasoner.models[0];
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.thinkingLevelMap, { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high" });
  assert.deepEqual(json.providers.reasoner.compat, { supportsDeveloperRole: false });
  assert.deepEqual(getDefaultProviderSelection(settings), { provider: "reasoner", model: "reasoner-a", thinkingLevel: "high" });
});

test("respects PI_CODING_AGENT_DIR for models path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-agent-dir-"));
  assert.equal(getModelsPath({ PI_CODING_AGENT_DIR: dir }), path.join(dir, "models.json"));
});

test("saves default provider selection to Pi settings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-provider-default-"));
  const settings = getSettingsPath({ PI_CODING_AGENT_DIR: dir });
  const result = saveDefaultProviderSelection({ provider: "localmock", model: "mock-a" }, settings);

  assert.equal(result.file, settings);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, "utf8")), { defaultProvider: "localmock", defaultModel: "mock-a", defaultThinkingLevel: "high" });
  assert.deepEqual(getDefaultProviderSelection(settings), { provider: "localmock", model: "mock-a", thinkingLevel: "high" });
});

test("upgrades legacy default model config for high thinking", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-model-migrate-"));
  const models = getModelsPath({ PI_CODING_AGENT_DIR: dir });
  fs.mkdirSync(path.dirname(models), { recursive: true });
  fs.writeFileSync(models, JSON.stringify({
    providers: {
      localmock: {
        baseUrl: "https://api.example.com/v1",
        api: "openai-completions",
        apiKey: "sk-test",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: "mock-a", name: "Mock A", reasoning: false, contextWindow: 128000, maxTokens: 32000 }],
      },
    },
  }));

  const result = ensureDefaultProviderReasoningSupport({ provider: "localmock", model: "mock-a", thinkingLevel: "high" }, models);
  const config = loadModelsConfig(models);
  const provider = config.providers.localmock;
  const model = provider.models[0];

  assert.equal(result.changed, true);
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.thinkingLevelMap, { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high" });
  assert.deepEqual(provider.compat, { supportsDeveloperRole: false });
});


test("rejects blank API key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-provider-blank-key-"));
  const file = path.join(dir, "models.json");
  assert.throws(() => upsertOpenAICompatibleProvider({
    name: "localmock",
    baseUrl: "https://api.example.com/v1",
    model: "model-a",
    apiKey: "",
  }, file), /API Key is required/);
});

test("readSettingsRaw returns missing file marker when absent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-settings-missing-"));
  const file = path.join(dir, "settings.json");
  const result = readSettingsRaw(file);
  assert.equal(result.exists, false);
  assert.equal(result.path, file);
  assert.equal(result.content, "");
  assert.deepEqual(result.json, {});
  assert.equal(result.parseError, null);
});

test("readSettingsRaw parses valid settings object with retry block", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-settings-valid-"));
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({
    defaultProvider: "localmock",
    defaultModel: "mock-a",
    defaultThinkingLevel: "high",
    retry: { enabled: true, maxRetries: 5, baseDelayMs: 1500 },
  }, null, 2));
  const result = readSettingsRaw(file);
  assert.equal(result.exists, true);
  assert.equal(result.path, file);
  assert.equal(result.parseError, null);
  assert.equal(result.json.defaultProvider, "localmock");
  assert.equal(result.json.retry.enabled, true);
  assert.ok(result.content.includes("\"defaultModel\": \"mock-a\""));
});

test("readSettingsRaw reports parse errors without throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-settings-broken-"));
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, "{ this is not valid json }");
  const result = readSettingsRaw(file);
  assert.equal(result.exists, true);
  assert.ok(result.parseError);
  assert.deepEqual(result.json, {});
  assert.equal(result.content, "{ this is not valid json }");
});

test("readSettingsRaw treats empty file as empty object", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-settings-empty-"));
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, "");
  const result = readSettingsRaw(file);
  assert.equal(result.exists, true);
  assert.equal(result.parseError, null);
  assert.deepEqual(result.json, {});
  assert.equal(result.content, "");
});

test("getSteeringMode defaults to one-at-a-time when unset", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-steer-default-"));
  const file = path.join(dir, "settings.json");
  assert.deepEqual(getSteeringMode(file), { mode: "one-at-a-time", available: ["all", "one-at-a-time"] });
});

test("getSteeringMode falls back when disk holds an unsupported value", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-steer-unsupported-"));
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ steeringMode: "bogus" }));
  assert.equal(getSteeringMode(file).mode, "one-at-a-time");
});

test("saveSteeringMode persists and reads back 'all' and 'one-at-a-time'", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-steer-save-"));
  const file = path.join(dir, "settings.json");
  const r1 = saveSteeringMode("all", file);
  assert.equal(r1.mode, "all");
  assert.equal(r1.file, file);
  assert.equal(getSteeringMode(file).mode, "all");
  const raw1 = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw1.steeringMode, "all");
  saveSteeringMode("one-at-a-time", file);
  assert.equal(getSteeringMode(file).mode, "one-at-a-time");
});

test("saveSteeringMode preserves existing settings keys", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-steer-preserve-"));
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ retry: { enabled: true, maxRetries: 5 }, defaultProvider: "acme" }));
  saveSteeringMode("all", file);
  const merged = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(merged.steeringMode, "all");
  assert.equal(merged.retry.enabled, true);
  assert.equal(merged.defaultProvider, "acme");
});

test("saveSteeringMode rejects unsupported mode", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-steer-reject-"));
  const file = path.join(dir, "settings.json");
  assert.throws(() => saveSteeringMode("bogus", file), /Unsupported steering mode/);
  assert.throws(() => saveSteeringMode("followUp", file), /Unsupported steering mode/);
  assert.throws(() => saveSteeringMode(undefined, file), /Unsupported steering mode/);
});

