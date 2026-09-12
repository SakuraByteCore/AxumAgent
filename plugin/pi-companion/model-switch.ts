// model-switch.ts — pure helpers for the /usemodel slash command.
// Zero runtime relative imports so node --test can import it directly from source.

export interface ModelSwitchAlias {
  provider: string;
  model: string;
}

export interface ModelSwitchConfig {
  aliases: Record<string, ModelSwitchAlias>;
}

export function emptyModelSwitchConfig(): ModelSwitchConfig {
  return { aliases: {} };
}

/** Coerce unknown parsed JSON into a validated ModelSwitchConfig, dropping invalid entries. */
export function parseModelSwitchConfig(raw: unknown): ModelSwitchConfig {
  const aliases: Record<string, ModelSwitchAlias> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const rawAliases = (raw as Record<string, unknown>).aliases;
    if (rawAliases && typeof rawAliases === "object" && !Array.isArray(rawAliases)) {
      for (const [key, value] of Object.entries(rawAliases as Record<string, unknown>)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const entry = value as Record<string, unknown>;
          const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
          const model = typeof entry.model === "string" ? entry.model.trim() : "";
          if (provider && model) aliases[key] = { provider, model };
        }
      }
    }
  }
  return { aliases };
}

/**
 * Resolve a /usemodel argument into a { provider, model } reference.
 * Resolution order: exact alias key first, then a literal "provider/model".
 * Returns null when the argument matches neither (no aliasing guesswork).
 */
export function resolveModelSwitchArg(
  aliases: Record<string, ModelSwitchAlias>,
  arg: string,
): ModelSwitchAlias | null {
  const trimmed = arg.trim();
  if (!trimmed) return null;
  const alias = aliases[trimmed];
  if (alias) return { provider: alias.provider, model: alias.model };
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const provider = trimmed.slice(0, slash).trim();
    const model = trimmed.slice(slash + 1).trim();
    if (provider && model) return { provider, model };
  }
  return null;
}

/** Merge a { provider, model } selection into a settings object, preserving other keys. */
export function applyDefaultSelection(
  config: Record<string, unknown>,
  selection: { provider: string; model: string },
): Record<string, unknown> {
  return { ...config, defaultProvider: selection.provider, defaultModel: selection.model };
}