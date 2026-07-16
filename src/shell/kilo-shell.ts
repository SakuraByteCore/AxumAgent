import type { AxumConfig, AxumModeConfig } from "../config";

export interface AxumShellMode {
  id: string;
  description: string;
  prompt: string;
  tools: string[];
  builtin: boolean;
}

export const DEFAULT_MODE_ID = "build";

export const BUILTIN_MODES: Record<string, AxumModeConfig> = {
  build: {
    description: "Kilo-style build mode for implementing changes through the Axum workflow runtime.",
    prompt: "You are AxumAgent in build mode. Keep the user-facing shell concise, then execute through the project workflow runtime with checkpoints and permission gates.",
    tools: ["read", "write", "exec"],
  },
  plan: {
    description: "Kilo-style planning mode for shaping work before execution.",
    prompt: "You are AxumAgent in plan mode. Clarify scope, identify gates, and produce a workflow plan before any write action.",
    tools: ["read"],
  },
  debug: {
    description: "Kilo-style debug mode for failure analysis and minimal verified fixes.",
    prompt: "You are AxumAgent in debug mode. Reproduce, isolate root cause, patch only the failing path, and validate with regression evidence.",
    tools: ["read", "exec"],
  },
};

export function defaultShellMode(config: AxumConfig | undefined): string {
  return config?.shell?.default_mode || config?.shell?.defaultMode || DEFAULT_MODE_ID;
}

export function resolvedModes(config: AxumConfig | undefined): AxumShellMode[] {
  const configured = config?.modes ?? {};
  const ids = new Set([...Object.keys(BUILTIN_MODES), ...Object.keys(configured)]);
  return [...ids].sort().map((id) => {
    const base = BUILTIN_MODES[id] ?? {};
    const override = configured[id] ?? {};
    return {
      id,
      description: override.description || base.description || "Custom Axum shell mode.",
      prompt: override.prompt || base.prompt || "",
      tools: override.tools || base.tools || [],
      builtin: !configured[id],
    };
  });
}

export function findMode(config: AxumConfig | undefined, id?: string): AxumShellMode {
  const target = id || defaultShellMode(config);
  const mode = resolvedModes(config).find((item) => item.id === target);
  if (!mode) throw new Error(`mode not found: ${target}`);
  return mode;
}

export function renderModeList(config: AxumConfig | undefined): string {
  const current = defaultShellMode(config);
  const lines = ["AxumAgent modes", "Kilo-style shell; Axum/pi runtime owns execution state."];
  for (const mode of resolvedModes(config)) {
    const mark = mode.id === current ? "*" : " ";
    const origin = mode.builtin ? "builtin" : "config";
    lines.push(`${mark} ${mode.id}  ${origin}  ${mode.description}`);
  }
  return lines.join("\n");
}
