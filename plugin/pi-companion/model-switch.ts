// model-switch.ts — pure helpers for the /usemodel slash command.
// Zero runtime relative imports so node --test can import it directly from source.

/** A single selectable model entry parsed out of models.json. */
export interface ModelEntry {
  provider: string;
  model: string;
  isDefault: boolean;
}

export interface ModelSelection {
  provider: string;
  model: string;
}

/** Suffix appended to the default model's option label in the selector. */
export const DEFAULT_LABEL_SUFFIX = "  (default)";

/**
 * Providers whose entries are pinned to the top of the /usemodel selector
 * list. opencode-zen.ts keeps the opencode2dsh block fresh in models.json.
 */
export const TOP_PRIORITIZED_PROVIDERS: readonly string[] = ["opencode2dsh"];

/** Stable ordering: pinned providers first (in list order), then the rest in manifest order. */
function orderModelEntries(entries: ModelEntry[]): ModelEntry[] {
	if (TOP_PRIORITIZED_PROVIDERS.length === 0) return entries;
	const pinned = new Set(TOP_PRIORITIZED_PROVIDERS);
	const top = TOP_PRIORITIZED_PROVIDERS.flatMap((provider) => entries.filter((entry) => entry.provider === provider));
	const rest = entries.filter((entry) => !pinned.has(entry.provider));
	return [...top, ...rest];
}

/**
 * Parse a parsed models.json document into a flat list of entries.
 * models.json shape: { providers: { [provider]: { models: [{ id, default? }] } } }.
 * Malformed or incomplete entries are silently dropped.
 */
export function parseModelManifest(raw: unknown): ModelEntry[] {
  const entries: ModelEntry[] = [];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const providers = (raw as Record<string, unknown>).providers;
    if (providers && typeof providers === "object" && !Array.isArray(providers)) {
      for (const [provider, pRaw] of Object.entries(providers as Record<string, unknown>)) {
        if (!pRaw || typeof pRaw !== "object" || Array.isArray(pRaw)) continue;
        const models = (pRaw as Record<string, unknown>).models;
        if (!Array.isArray(models)) continue;
        for (const m of models) {
          if (!m || typeof m !== "object" || Array.isArray(m)) continue;
          const record = m as Record<string, unknown>;
          if (typeof record.id !== "string") continue;
          const modelId = record.id.trim();
          if (!modelId) continue;
          entries.push({ provider, model: modelId, isDefault: Boolean(record.default) });
        }
      }
    }
  }
	return orderModelEntries(entries);
}

/** Render a single entry as its selector label, annotating the default. */
export function formatModelLabel(entry: ModelEntry): string {
  const base = `${entry.provider}/${entry.model}`;
  return entry.isDefault ? `${base}${DEFAULT_LABEL_SUFFIX}` : base;
}

/** Build the ordered string option list for ctx.ui.select. */
export function buildModelOptions(entries: ModelEntry[]): string[] {
  return entries.map(formatModelLabel);
}

/**
 * Index of the entry matching the session's current model, or 0 when the
 * current model is unknown or absent from the manifest. Used to open the
 * /usemodel selector with the cursor already on the model in use.
 */
export function findCurrentModelIndex(
  entries: ModelEntry[],
  provider: string | undefined,
  model: string | undefined,
): number {
  if (!provider || !model) return 0;
  const index = entries.findIndex((entry) => entry.provider === provider && entry.model === model);
  return index >= 0 ? index : 0;
}

/** Resolve a selected option label back into a {provider, model} selection. */
export function resolveModelSelection(label: string): ModelSelection | null {
  const trimmed = label.trim();
  if (!trimmed) return null;
  const withoutSuffix = trimmed.endsWith(DEFAULT_LABEL_SUFFIX)
    ? trimmed.slice(0, trimmed.length - DEFAULT_LABEL_SUFFIX.length).trimEnd()
    : trimmed;
  const slash = withoutSuffix.indexOf("/");
  if (slash <= 0) return null;
  const provider = withoutSuffix.slice(0, slash).trim();
  const model = withoutSuffix.slice(slash + 1).trim();
  if (!provider || !model) return null;
  return { provider, model };
}

/** Merge a { provider, model } selection into a settings object, preserving other keys. */
export function applyDefaultSelection(
  config: Record<string, unknown>,
  selection: { provider: string; model: string },
): Record<string, unknown> {
  return { ...config, defaultProvider: selection.provider, defaultModel: selection.model };
}