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

export function buildOpenAICompatibleProvider(options) {
  const provider = {
    baseUrl: options.baseUrl,
    api: "openai-completions",
    models: [
      {
        id: options.model,
        name: options.modelName || options.model,
        reasoning: Boolean(options.reasoning),
        contextWindow: Number(options.contextWindow || 128000),
        maxTokens: Number(options.maxTokens || 32000),
      },
    ],
  };

  if (options.apiKeyEnv) provider.apiKey = `$${options.apiKeyEnv}`;
  else if (options.apiKey) provider.apiKey = options.apiKey;
  else provider.apiKey = "***";

  if (!options.supportsDeveloperRole || !options.supportsReasoningEffort) {
    provider.compat = {};
    if (!options.supportsDeveloperRole) provider.compat.supportsDeveloperRole = false;
    if (!options.supportsReasoningEffort) provider.compat.supportsReasoningEffort = false;
  }

  return provider;
}

export function upsertOpenAICompatibleProvider(options, file = getModelsPath()) {
  const config = loadModelsConfig(file);
  config.providers[options.name] = buildOpenAICompatibleProvider(options);
  saveModelsConfig(config, file);
  return { file, provider: config.providers[options.name] };
}

export function listProviders(file = getModelsPath()) {
  const config = loadModelsConfig(file);
  return Object.entries(config.providers).map(([id, provider]) => ({
    id,
    api: provider.api || "",
    baseUrl: provider.baseUrl || "",
    models: Array.isArray(provider.models) ? provider.models.map((model) => model.id) : [],
  }));
}
