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

export function modelsUrlForBaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  return `${normalized}/models`;
}

function positiveNumber(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number`);
  return Math.floor(number);
}

export function buildOpenAICompatibleProvider(options) {
  const model = String(options.model || "").trim();
  if (!model) throw new Error("Model is required");
  const provider = {
    baseUrl: normalizeBaseUrl(options.baseUrl),
    api: "openai-completions",
    models: [
      {
        id: model,
        name: options.modelName || model,
        reasoning: Boolean(options.reasoning),
        contextWindow: positiveNumber(options.contextWindow, 128000, "Context window"),
        maxTokens: positiveNumber(options.maxTokens, 32000, "Max output tokens"),
      },
    ],
  };

  if (options.apiKeyEnv) provider.apiKey = `$${options.apiKeyEnv}`;
  else if (String(options.apiKey || "").trim()) provider.apiKey = String(options.apiKey).trim();
  else throw new Error("API Key is required");

  if (!options.supportsDeveloperRole || !options.supportsReasoningEffort) {
    provider.compat = {};
    if (!options.supportsDeveloperRole) provider.compat.supportsDeveloperRole = false;
    if (!options.supportsReasoningEffort) provider.compat.supportsReasoningEffort = false;
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
      })) : [],
      hasApiKey: Boolean(provider.apiKey),
    };
    if (options.includeSecrets) item.apiKey = provider.apiKey || "";
    return item;
  });
}

export function saveDefaultProviderSelection(selection, file = getAxumConfigPath()) {
  const config = readJsonFile(file);
  config.defaultProvider = selection.provider;
  config.defaultModel = selection.model;
  writeJsonFile(file, config);
  return { file, config };
}

export function getDefaultProviderSelection(file = getAxumConfigPath()) {
  const config = readJsonFile(file);
  if (!config.defaultProvider || !config.defaultModel) return undefined;
  return { provider: config.defaultProvider, model: config.defaultModel };
}

export async function fetchOpenAICompatibleModels({ baseUrl, apiKey, timeoutMs = 15000 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(modelsUrlForBaseUrl(baseUrl), {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`GET /models failed: HTTP ${response.status} ${text.slice(0, 240)}`);
    let json;
    try { json = JSON.parse(text); } catch (error) { throw new Error(`GET /models returned invalid JSON: ${error.message}`); }
    const models = Array.isArray(json.data) ? json.data.map((item) => item?.id).filter(Boolean) : [];
    if (!models.length) throw new Error("GET /models returned no model ids");
    return [...new Set(models)].sort();
  } finally {
    clearTimeout(timeout);
  }
}
