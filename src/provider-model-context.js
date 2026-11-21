import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getBundledPiNodeModules } from "./bundled-pi-cache.js";

// Prefer first-party catalogs to gateways that impose their own smaller limits.
const FIRST_PARTY_PROVIDERS = new Set(["openai", "anthropic", "google", "xai", "deepseek", "moonshotai", "mistral", "minimax", "zai"]);
let catalogPromise;

export function modelContextFromMetadata(row) {
  const values = [row?.contextWindow, row?.context_length, row?.context_window, row?.top_provider?.context_length];
  for (const value of values) {
    if (typeof value !== "number" && typeof value !== "string") continue;
    const number = Number(value);
    if (Number.isSafeInteger(number) && number > 0) return number;
  }
}

async function loadCatalog() {
  let file;
  try {
    file = new URL("./models.generated.js", import.meta.resolve("@earendil-works/pi-ai"));
  } catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
    file = pathToFileURL(path.join(getBundledPiNodeModules(), "@earendil-works", "pi-ai", "dist", "models.generated.js"));
  }
  // Provider setup also works before the optional bundled runtime is installed.
  if (!fs.existsSync(file)) return new Map();
  const { MODELS } = await import(file.href);
  const candidates = new Map();
  for (const [provider, models] of Object.entries(MODELS)) {
    for (const model of Object.values(models)) {
      const window = modelContextFromMetadata(model);
      if (window === undefined) continue;
      const candidate = candidates.get(model.id) ?? { official: new Set(), all: new Set() };
      candidate.all.add(window);
      if (FIRST_PARTY_PROVIDERS.has(provider)) candidate.official.add(window);
      candidates.set(model.id, candidate);
    }
  }
  const contexts = new Map();
  for (const [id, candidate] of candidates) {
    const windows = candidate.official.size ? candidate.official : candidate.all;
    // Never guess between conflicting catalog entries or fuzzy model aliases.
    if (windows.size === 1) contexts.set(id, windows.values().next().value);
  }
  return contexts;
}

export async function knownModelContexts() {
  catalogPromise ??= loadCatalog();
  return catalogPromise;
}
