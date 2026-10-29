import fs from "node:fs";
import path from "node:path";
import { getAxumConfigPath } from "./provider-config.js";

const OPENAI_APIS = new Set(["openai-completions", "openai-responses"]);

export function readFastModels(file = getAxumConfigPath()) {
  try {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    return config.fastModels && typeof config.fastModels === "object" && !Array.isArray(config.fastModels) ? config.fastModels : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

// Axum-owned metadata stays outside models.json: the SDK validates that schema.
export function saveFastModels(provider, models, enabled, file = getAxumConfigPath(), originalName) {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const fastModels = { ...readFastModels(file) };
  if (originalName && originalName !== provider) delete fastModels[originalName];
  if (enabled === true && models.length) fastModels[provider] = [...new Set(models)];
  else delete fastModels[provider];
  config.fastModels = fastModels;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

// Runs after extension payload hooks, on every attempt/continuation. No global
// fetch patch, SDK mutation, protocol conversion or priority substitution.
export function applyFastServiceTier(payload, model, file = getAxumConfigPath()) {
  if (!OPENAI_APIS.has(model?.api) || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const configured = readFastModels(file);
  const selected = configured[model.provider];
  // Only configured Axum models are owned here; unrelated providers retain
  // their own service_tier policy. Off is represented by no configuration.
  if (!Array.isArray(selected) || !selected.includes(model.id)) return payload;
  return { ...payload, service_tier: "fast" };
}
