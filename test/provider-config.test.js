import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { API_FORMS, DEFAULT_THINKING_LEVEL, PROVIDER_PRESETS, buildProvider, deleteProvider, ensureDefaultProviderReasoningSupport, ensureWebSearchWorkflowDefault, getDefaultProviderSelection, getModelsPath, getRetrySettings, getSettingsPath, getSteeringMode, getWebSearchConfigPath, listProviders, loadModelsConfig, normalizeBaseUrl, normalizeThinkingLevel, readSettingsRaw, saveDefaultProviderSelection, saveRetrySettings, saveSteeringMode, upsertProvider } from "../src/provider-config.js";

test("writes OpenAI-compatible provider config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-provider-"));
  const file = path.join(dir, "models.json");
  const result = upsertProvider({
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

test("writes multiple models with a default marker", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-provider-multi-"));
  const file = path.join(dir, "models.json");
  upsertProvider({
    name: "multimock",
    baseUrl: "https://api.example.com/v1",
    apiKey: "test-key",
    models: [
      { id: "mock-a", default: false },
      { id: "mock-b", default: true },
    ],
  }, file);

  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  const models = json.providers.multimock.models;
  assert.equal(models.length, 2);
  assert.equal(models[0].id, "mock-a");
  assert.equal(models[0].default, undefined);
  assert.equal(models[1].id, "mock-b");
  assert.equal(models[1].default, true);

  const listed = listProviders(file)[0];
  assert.deepEqual(listed.models, ["mock-a", "mock-b"]);
  assert.equal(listed.defaultModel, "mock-b");
  assert.deepEqual(listed.modelConfigs.map((m) => m.default), [false, true]);
});

test("writes reasoning-capable provider config and default thinking level", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-provider-reasoning-"));
  const file = path.join(dir, "models.json");
  const settings = path.join(dir, "settings.json");
  const result = upsertProvider({
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

test("upsert with an unparseable base URL surfaces a friendly error, not Invalid URL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-provider-badurl-"));
  const file = path.join(dir, "models.json");
  assert.throws(
    () => upsertProvider({ baseUrl: "not a url", model: "m", apiKey: "k" }, file),
    (error) => /Invalid base URL|Base URL/.test(error.message) && !/^Invalid URL$/.test(error.message),
  );
});

test("getRetrySettings falls back to defaults for non-finite or wrong-typed values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-retry-invalid-"));
  const settings = getSettingsPath({ PI_CODING_AGENT_DIR: dir });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ retry: { enabled: true, maxRetries: "5", baseDelayMs: null } }));
  assert.deepEqual(getRetrySettings(settings), { enabled: true, maxRetries: 3, baseDelayMs: 2000, fixedDelayMs: 3000 });
});

test("saves default provider selection to Pi settings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-provider-default-"));
  const settings = getSettingsPath({ PI_CODING_AGENT_DIR: dir });
  const result = saveDefaultProviderSelection({ provider: "localmock", model: "mock-a" }, settings);

  assert.equal(result.file, settings);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, "utf8")), { defaultProvider: "localmock", defaultModel: "mock-a", defaultThinkingLevel: "high" });
  assert.deepEqual(getDefaultProviderSelection(settings), { provider: "localmock", model: "mock-a", thinkingLevel: "high" });
});

test("accepts native Pi thinking levels xhigh and max on the read path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-provider-xhigh-"));
  const settings = getSettingsPath({ PI_CODING_AGENT_DIR: dir });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ defaultProvider: "localmock", defaultModel: "mock-a", defaultThinkingLevel: "xhigh" }));
  assert.deepEqual(getDefaultProviderSelection(settings), { provider: "localmock", model: "mock-a", thinkingLevel: "xhigh" });

  const saveResult = saveDefaultProviderSelection({ provider: "localmock", model: "mock-a", thinkingLevel: "max" }, settings);
  assert.equal(saveResult.config.defaultThinkingLevel, "max");
  assert.deepEqual(getDefaultProviderSelection(settings), { provider: "localmock", model: "mock-a", thinkingLevel: "max" });
});

test("rejects unknown thinking levels", () => {
  assert.throws(() => saveDefaultProviderSelection({ provider: "p", model: "m", thinkingLevel: "ultra" }), /Unsupported reasoning strength/);
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
  assert.throws(() => upsertProvider({
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

test("getWebSearchConfigPath honors PI_CODING_AGENT_DIR and defaults to ~/.pi", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-websearch-dir-"));
  assert.equal(getWebSearchConfigPath({ PI_CODING_AGENT_DIR: dir }), path.join(dir, "web-search.json"));
  assert.equal(getWebSearchConfigPath({}), path.join(os.homedir(), ".pi", "web-search.json"));
});

test("ensureWebSearchWorkflowDefault seeds workflow none when file is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-websearch-new-"));
  const file = path.join(dir, "web-search.json");
  const result = ensureWebSearchWorkflowDefault(file);
  assert.equal(result.seeded, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { workflow: "none" });
});

test("ensureWebSearchWorkflowDefault preserves existing keys and fills missing workflow", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-websearch-merge-"));
  const file = path.join(dir, "web-search.json");
  fs.writeFileSync(file, JSON.stringify({ searxng: { baseUrl: "http://127.0.0.1:8888" } }));
  const result = ensureWebSearchWorkflowDefault(file);
  assert.equal(result.seeded, true);
  const merged = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(merged.workflow, "none");
  assert.equal(merged.searxng.baseUrl, "http://127.0.0.1:8888");
});

test("ensureWebSearchWorkflowDefault never overrides an explicit workflow", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-websearch-keep-"));
  const file = path.join(dir, "web-search.json");
  fs.writeFileSync(file, JSON.stringify({ workflow: "auto-summary" }));
  const result = ensureWebSearchWorkflowDefault(file);
  assert.equal(result.seeded, false);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).workflow, "auto-summary");
});

test("ensureWebSearchWorkflowDefault leaves malformed JSON untouched", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-websearch-broken-"));
  const file = path.join(dir, "web-search.json");
  const broken = "{ this is not valid json }";
  fs.writeFileSync(file, broken);
  const result = ensureWebSearchWorkflowDefault(file);
  assert.equal(result.seeded, false);
  assert.equal(fs.readFileSync(file, "utf8"), broken);
});


test("deleteProvider removes a provider and cleans default pointers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-provider-del-"));
  const modelsFile = path.join(dir, "models.json");
  const settingsFile = path.join(dir, "settings.json");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try { upsertProvider({ name: "alpha", baseUrl: "https://alpha.example.com/v1", model: "a-1", apiKey: "k" }, modelsFile);
  upsertProvider({ name: "beta", baseUrl: "https://beta.example.com/v1", model: "b-1", apiKey: "k" }, modelsFile);
  saveDefaultProviderSelection({ provider: "alpha", model: "a-1", thinkingLevel: "high" }, settingsFile);

  const result = deleteProvider("alpha", modelsFile);
  assert.equal(result.deleted, true);
  const models = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
  assert.equal(models.providers.alpha, undefined);
  assert.ok(models.providers.beta);
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal(settings.defaultProvider, undefined);
  assert.equal(settings.defaultModel, undefined);
  assert.equal(settings.defaultThinkingLevel, undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("deleteProvider returns deleted false for missing provider", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-provider-del-missing-"));
  const modelsFile = path.join(dir, "models.json");
  const result = deleteProvider("ghost", modelsFile);
  assert.equal(result.deleted, false);
});

test("upsert renames in place instead of cloning when originalName differs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-provider-rename-"));
  const modelsFile = path.join(dir, "models.json");
  const settingsFile = path.join(dir, "settings.json");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    upsertProvider({ name: "alpha", baseUrl: "https://alpha.example.com/v1", model: "a-1", apiKey: "k" }, modelsFile);
    upsertProvider({ name: "beta", baseUrl: "https://beta.example.com/v1", model: "b-1", apiKey: "k" }, modelsFile);
    saveDefaultProviderSelection({ provider: "alpha", model: "a-1", thinkingLevel: "high" }, settingsFile);

    const result = upsertProvider({ originalName: "alpha", name: "gamma", baseUrl: "https://alpha.example.com/v1", model: "a-2", apiKey: "k2" }, modelsFile);
    assert.equal(result.renamed, true);
    assert.equal(result.renamedDefault, true);

    const models = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
    assert.equal(models.providers.alpha, undefined, "old key must be removed");
    assert.equal(models.providers.gamma.models[0].id, "a-2", "renamed key holds the updated config");
    assert.ok(models.providers.beta, "unrelated provider untouched");

    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.equal(settings.defaultProvider, "gamma", "default pointer follows the rename");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("upsert rename onto an existing provider name throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-provider-rename-conflict-"));
  const modelsFile = path.join(dir, "models.json");
  upsertProvider({ name: "alpha", baseUrl: "https://alpha.example.com/v1", model: "a-1", apiKey: "k" }, modelsFile);
  upsertProvider({ name: "beta", baseUrl: "https://beta.example.com/v1", model: "b-1", apiKey: "k" }, modelsFile);

  assert.throws(
    () => upsertProvider({ originalName: "alpha", name: "beta", baseUrl: "https://alpha.example.com/v1", model: "a-1", apiKey: "k" }, modelsFile),
    /already exists/,
  );
  const models = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
  assert.ok(models.providers.alpha, "failed rename must not delete the original");
  assert.equal(models.providers.beta.models[0].id, "b-1", "target must not be clobbered");
});

test("upsert with matching originalName is a plain update", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-provider-same-name-"));
  const modelsFile = path.join(dir, "models.json");
  upsertProvider({ name: "alpha", baseUrl: "https://alpha.example.com/v1", model: "a-1", apiKey: "k" }, modelsFile);
  const result = upsertProvider({ originalName: "alpha", name: "alpha", baseUrl: "https://alpha.example.com/v1", model: "a-2", apiKey: "k" }, modelsFile);
  assert.equal(result.renamed, false);
  const models = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
  assert.equal(Object.keys(models.providers).length, 1);
  assert.equal(models.providers.alpha.models[0].id, "a-2");
});

test("upsert refuses to create a provider that duplicates an existing name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-provider-dup-"));
  const file = path.join(dir, "models.json");
  upsertProvider({ name: "alpha", baseUrl: "https://alpha.example.com/v1", model: "a-1", apiKey: "k" }, file);

  assert.throws(
    () => upsertProvider({ name: "alpha", baseUrl: "https://alpha.example.com/v1", model: "a-2", apiKey: "k2" }, file),
    /already exists/,
  );

  // the same call with originalName is an update and must succeed
  const result = upsertProvider({ originalName: "alpha", name: "alpha", baseUrl: "https://alpha.example.com/v1", model: "a-2", apiKey: "k2" }, file);
  assert.equal(result.renamed, false);
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(json.providers), ["alpha"]);
  assert.equal(json.providers.alpha.models[0].id, "a-2");
  assert.equal(json.providers.alpha.apiKey, "k2");
});
test("PROVIDER_PRESETS ships a valid anthropic and openai-chat reference template", () => {
  assert.deepEqual(PROVIDER_PRESETS.map((p) => p.id), ["anthropic", "openai-chat"]);
  const knownApiForms = new Set(API_FORMS.map((form) => form.id));
  for (const preset of PROVIDER_PRESETS) {
    assert.equal(normalizeBaseUrl(preset.baseUrl), preset.baseUrl);
    assert.equal(normalizeThinkingLevel(preset.reasoningEffort), preset.reasoningEffort);
    assert.ok(preset.contextWindow > 0, "contextWindow must be positive");
    assert.ok(preset.maxTokens > 0, "maxTokens must be positive");
    assert.ok(Array.isArray(preset.suggestedModels) && preset.suggestedModels.length > 0);
    assert.ok(!("apiKey" in preset), "presets must never ship credentials");
    assert.ok(knownApiForms.has(preset.api), `preset ${preset.id} must declare a known API form`);
  }
  const anthropic = PROVIDER_PRESETS[0];
  assert.equal(anthropic.api, "anthropic-messages");
  assert.equal(anthropic.baseUrl, "https://api.anthropic.com");
  assert.deepEqual(anthropic.suggestedModels, ["claude-sonnet-5", "claude-opus-5"]);
  const openaiChat = PROVIDER_PRESETS[1];
  assert.equal(openaiChat.api, "openai-completions");
  assert.equal(openaiChat.baseUrl, "https://api.openai.com/v1");
  assert.deepEqual(openaiChat.suggestedModels, ["gpt-4o", "gpt-4.1"]);
});

test("buildProvider writes the requested API form and only emits OpenAI compat for openai-completions", () => {
  const anthropic = buildProvider({
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    model: "claude-sonnet-5",
    apiKey: "k",
    reasoningEffort: "high",
  });
  assert.equal(anthropic.api, "anthropic-messages");
  assert.ok(!("compat" in anthropic), "native anthropic-messages defers compat to pi-ai");

  const defaulted = buildProvider({ baseUrl: "https://api.example.com/v1", model: "m", apiKey: "k" });
  assert.equal(defaulted.api, "openai-completions");
  assert.equal(defaulted.compat.supportsDeveloperRole, false);

  assert.throws(
    () => buildProvider({ baseUrl: "https://api.example.com/v1", api: "not-a-form", model: "m", apiKey: "k" }),
    /Unsupported API form: not-a-form/
  );
});
