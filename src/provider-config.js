import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function getAgentDir(env = process.env) {
  if (env.PI_CODING_AGENT_DIR) return expandTilde(env.PI_CODING_AGENT_DIR);
  return path.join(os.homedir(), ".pi", "agent");
}

export function getModelsPath(env = process.env) {
  return path.join(getAgentDir(env), "models.json");
}

export function getAxumConfigPath(env = process.env) {
  return path.join(getAgentDir(env), "axum.json");
}

export function getSettingsPath(env = process.env) {
  return path.join(getAgentDir(env), "settings.json");
}

function expandTilde(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function readJsonFile(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse ${file}: ${error.message}`);
  }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function loadModelsConfig(file = getModelsPath()) {
  const config = readJsonFile(file);
  if (config.providers === undefined) config.providers = {};
  if (typeof config.providers !== "object" || config.providers === null || Array.isArray(config.providers)) {
    throw new Error(`${file}: providers must be an object`);
  }
  return config;
}

export function saveModelsConfig(config, file = getModelsPath()) {
  writeJsonFile(file, config);
}

export function providerNameFromBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  return url.hostname.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "openai-compatible";
}

export function normalizeBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Base URL is required");
  const url = new URL(trimmed);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Base URL must start with http:// or https://");
  return url.toString().replace(/\/+$/, "");
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];

function positiveNumber(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number`);
  return Math.floor(number);
}

export function normalizeThinkingLevel(value, fallback = "off") {
  const level = String(value ?? "").trim().toLowerCase();
  if (THINKING_LEVELS.includes(level)) return level;
  if (value === undefined || value === null || value === "") return fallback;
  throw new Error(`Unsupported reasoning strength: ${value}`);
}

function thinkingLevelMap() {
  return {
    off: null,
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
  };
}

export function buildOpenAICompatibleProvider(options) {
  const model = String(options.model || "").trim();
  if (!model) throw new Error("Model is required");
  const reasoningEffort = normalizeThinkingLevel(options.reasoningEffort ?? options.thinkingLevel);
  const reasoningEnabled = reasoningEffort !== "off" || Boolean(options.reasoning);
  const modelConfig = {
    id: model,
    name: options.modelName || model,
    reasoning: reasoningEnabled,
    contextWindow: positiveNumber(options.contextWindow, 128000, "Context window"),
    maxTokens: positiveNumber(options.maxTokens, 32000, "Max output tokens"),
  };
  if (reasoningEnabled) modelConfig.thinkingLevelMap = thinkingLevelMap();

  const provider = {
    baseUrl: normalizeBaseUrl(options.baseUrl),
    api: "openai-completions",
    models: [modelConfig],
  };

  if (options.apiKeyEnv) provider.apiKey = `$${options.apiKeyEnv}`;
  else if (String(options.apiKey || "").trim()) provider.apiKey = String(options.apiKey).trim();
  else throw new Error("API Key is required");

  const supportsReasoningEffort = options.supportsReasoningEffort ?? reasoningEnabled;
  if (!options.supportsDeveloperRole || !supportsReasoningEffort) {
    provider.compat = {};
    if (!options.supportsDeveloperRole) provider.compat.supportsDeveloperRole = false;
    if (!supportsReasoningEffort) provider.compat.supportsReasoningEffort = false;
  }

  return provider;
}

export function upsertOpenAICompatibleProvider(options, file = getModelsPath()) {
  const name = options.name || providerNameFromBaseUrl(options.baseUrl);
  const config = loadModelsConfig(file);
  const provider = buildOpenAICompatibleProvider(options);
  config.providers[name] = provider;
  saveModelsConfig(config, file);
  return { file, name, provider: config.providers[name] };
}

export function listProviders(file = getModelsPath(), options = {}) {
  const config = loadModelsConfig(file);
  return Object.entries(config.providers).map(([id, provider]) => {
    const item = {
      id,
      api: provider.api || "",
      baseUrl: provider.baseUrl || "",
      models: Array.isArray(provider.models) ? provider.models.map((model) => model.id) : [],
      modelConfigs: Array.isArray(provider.models) ? provider.models.map((model) => ({
        id: model.id,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: Boolean(model.reasoning),
      })) : [],
      hasApiKey: Boolean(provider.apiKey),
    };
    if (options.includeSecrets) item.apiKey = provider.apiKey || "";
    return item;
  });
}

export function saveDefaultProviderSelection(selection, file = getSettingsPath()) {
  const config = readJsonFile(file);
  config.defaultProvider = selection.provider;
  config.defaultModel = selection.model;
  config.defaultThinkingLevel = normalizeThinkingLevel(selection.thinkingLevel, "high");
  writeJsonFile(file, config);
  return { file, config };
}

export function getDefaultProviderSelection(file = getSettingsPath()) {
  const config = readJsonFile(file);
  if (config.defaultProvider && config.defaultModel) {
    return { provider: config.defaultProvider, model: config.defaultModel, thinkingLevel: normalizeThinkingLevel(config.defaultThinkingLevel, "high") };
  }
  if (file === getSettingsPath()) {
    const legacy = readJsonFile(getAxumConfigPath());
    if (legacy.defaultProvider && legacy.defaultModel) {
      return { provider: legacy.defaultProvider, model: legacy.defaultModel, thinkingLevel: "high" };
    }
  }
  return undefined;
}

export function ensureDefaultProviderReasoningSupport(selection, file = getModelsPath()) {
  const thinkingLevel = normalizeThinkingLevel(selection?.thinkingLevel, "high");
  if (!selection?.provider || !selection?.model || thinkingLevel === "off") return { changed: false };
  const config = loadModelsConfig(file);
  const provider = config.providers[selection.provider];
  const model = Array.isArray(provider?.models)
    ? provider.models.find((item) => item.id === selection.model || item.name === selection.model)
    : undefined;
  if (!provider || !model) return { changed: false };

  let changed = false;
  if (model.reasoning !== true) {
    model.reasoning = true;
    changed = true;
  }
  const map = thinkingLevelMap();
  if (JSON.stringify(model.thinkingLevelMap || {}) !== JSON.stringify(map)) {
    model.thinkingLevelMap = map;
    changed = true;
  }
  if (provider.compat?.supportsReasoningEffort === false) {
    delete provider.compat.supportsReasoningEffort;
    if (Object.keys(provider.compat).length === 0) delete provider.compat;
    changed = true;
  }
  if (changed) saveModelsConfig(config, file);
  return { changed, file, provider: selection.provider, model: selection.model, thinkingLevel };
}

export function readSettingsRaw(file = getSettingsPath()) {
  if (!fs.existsSync(file)) return { exists: false, path: file, content: "", json: {}, parseError: null };
  const content = fs.readFileSync(file, "utf8");
  let parsed = {};
  let parseError = null;
  if (content.trim()) {
    try {
      parsed = JSON.parse(content);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        parseError = `Expected a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`;
        parsed = {};
      }
    } catch (error) {
      parseError = error.message;
    }
  }
  return { exists: true, path: file, content, json: parsed, parseError };
}

export function getRetrySettings(file = getSettingsPath()) {
  const config = readJsonFile(file);
  const retry = config.retry || {};
  return {
    enabled: retry.enabled === undefined ? false : Boolean(retry.enabled),
    maxRetries: typeof retry.maxRetries === "number" ? retry.maxRetries : 3,
    baseDelayMs: typeof retry.baseDelayMs === "number" ? retry.baseDelayMs : 2000,
  };
}

export function saveRetrySettings({ enabled, maxRetries, baseDelayMs } = {}, file = getSettingsPath()) {
  const config = readJsonFile(file);
  config.retry = {
    ...(config.retry || {}),
    enabled: Boolean(enabled),
    maxRetries: positiveNumber(maxRetries, 3, "Max retries"),
    baseDelayMs: positiveNumber(baseDelayMs, 2000, "Base delay"),
  };
  writeJsonFile(file, config);
  return { file, retry: getRetrySettings(file) };
}

export function exportProviders(file = getModelsPath()) {
  return loadModelsConfig(file);
}

export function importProviders({ config = {}, overwrite = false } = {}, file = getModelsPath()) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid config: expected an object");
  if (!config.providers || typeof config.providers !== "object" || Array.isArray(config.providers)) throw new Error("Invalid config: missing providers object");
  const current = loadModelsConfig(file);
  let added = 0, skipped = 0, replaced = 0;
  for (const [name, provider] of Object.entries(config.providers)) {
    if (current.providers[name] && !overwrite) { skipped += 1; continue; }
    if (current.providers[name]) replaced += 1;
    else added += 1;
    current.providers[name] = provider;
  }
  saveModelsConfig(current, file);
  return { added, skipped, replaced, total: Object.keys(current.providers).length };
}

function extractModelIds(json) {
  if (!json || typeof json !== "object") return [];
  let arr = null;
  if (Array.isArray(json.data)) arr = json.data;
  else if (Array.isArray(json.models)) arr = json.models;
  if (!arr) return [];
  const ids = [];
  for (const item of arr) {
    if (item == null) continue;
    if (typeof item === "string") { ids.push(item); continue; }
    const id = item.id ?? item.name ?? item.model;
    if (id) ids.push(String(id));
  }
  return ids;
}

export async function fetchOpenAICompatibleModels({ baseUrl, apiKey, timeoutMs = 15000 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const normalized = normalizeBaseUrl(baseUrl);
    const response = await fetch(`${normalized}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    const text = await response.text();
    if (response.status === 404) throw new Error(`GET /models failed: HTTP 404 — this service may not implement the /models endpoint`);
    if (response.status === 401 || response.status === 403) throw new Error(`GET /models failed: HTTP ${response.status} — check your API key or auth header`);
    if (!response.ok) throw new Error(`GET /models failed: HTTP ${response.status} ${text.slice(0, 240)}`);
    let json;
    try { json = JSON.parse(text); } catch (error) { throw new Error(`GET /models returned invalid JSON: ${error.message}`); }
    const models = extractModelIds(json);
    if (!models.length) throw new Error("GET /models returned no model ids");
    return [...new Set(models)].sort();
  } finally {
    clearTimeout(timeout);
  }
}

const SUPPORTED_LANGUAGES = ["en", "ja", "zh"];

export function getLanguagePreference(file = getSettingsPath()) {
  const config = readJsonFile(file);
  const lang = config.language;
  return SUPPORTED_LANGUAGES.includes(lang) ? lang : "en";
}

export function saveLanguagePreference(language, file = getSettingsPath()) {
  if (!SUPPORTED_LANGUAGES.includes(language)) throw new Error(`Unsupported language: ${language}`);
  const config = readJsonFile(file);
  config.language = language;
  writeJsonFile(file, config);
  return { file, language };
}
