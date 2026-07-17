import type { AxumConfig, AxumModeConfig } from "../config";

export type AxumToolRisk = "read" | "write" | "exec" | "inspect";

export interface AxumToolSpec {
  id: string;
  description: string;
  risk: AxumToolRisk;
  sandbox: "none" | "project" | "allowlist";
  precision: "line" | "range" | "symbol" | "command";
}

export interface AxumShellMode {
  id: string;
  description: string;
  prompt: string;
  tools: string[];
  builtin: boolean;
}

export const DEFAULT_MODE_ID = "build";

export const TOOL_REGISTRY: Record<string, AxumToolSpec> = {
  read: {
    id: "read",
    description: "Read project files without mutation.",
    risk: "read",
    sandbox: "project",
    precision: "range",
  },
  precise_edit: {
    id: "precise_edit",
    description: "Apply exact local replacements guarded by before/after hash anchors.",
    risk: "write",
    sandbox: "project",
    precision: "range",
  },
  safe_exec: {
    id: "safe_exec",
    description: "Run allowlisted project commands with timeout and cwd sandbox checks.",
    risk: "exec",
    sandbox: "allowlist",
    precision: "command",
  },
  lsp_symbols: {
    id: "lsp_symbols",
    description: "Inspect TypeScript symbol names and locations before editing.",
    risk: "inspect",
    sandbox: "project",
    precision: "symbol",
  },
};

export const BUILTIN_MODES: Record<string, AxumModeConfig> = {
  build: {
    description: "Kilo-style build mode for implementing changes through the Axum workflow runtime.",
    prompt: "You are AxumAgent in build mode. Keep the user-facing shell concise, then execute through the project workflow runtime with checkpoints and permission gates.",
    tools: ["read", "precise_edit", "safe_exec", "lsp_symbols"],
  },
  plan: {
    description: "Kilo-style planning mode for shaping work before execution.",
    prompt: "You are AxumAgent in plan mode. Clarify scope, identify gates, and produce a workflow plan before any write action.",
    tools: ["read", "lsp_symbols"],
  },
  debug: {
    description: "Kilo-style debug mode for failure analysis and minimal verified fixes.",
    prompt: "You are AxumAgent in debug mode. Reproduce, isolate root cause, patch only the failing path, and validate with regression evidence.",
    tools: ["read", "safe_exec", "precise_edit", "lsp_symbols"],
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
      tools: normalizeTools(override.tools || base.tools || []),
      builtin: !configured[id],
    };
  });
}

export function normalizeTools(tools: string[]): string[] {
  return [...new Set(tools)].map((tool) => tool.trim()).filter(Boolean);
}

export function resolveToolSpecs(tools: string[]): AxumToolSpec[] {
  return normalizeTools(tools).map((id) => TOOL_REGISTRY[id] ?? {
    id,
    description: "Config-defined external tool; permission gate required before use.",
    risk: "exec",
    sandbox: "allowlist",
    precision: "command",
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
    const specs = resolveToolSpecs(mode.tools).map((tool) => `${tool.id}:${tool.precision}`).join(", ") || "none";
    lines.push(`${mark} ${mode.id}  ${origin}  ${mode.description}`);
    lines.push(`    tools: ${specs}`);
  }
  return lines.join("\n");
}
