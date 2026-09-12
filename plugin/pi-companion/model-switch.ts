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
  return entries;
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