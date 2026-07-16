import fs from "node:fs";
import path from "node:path";
import { findMode, type AxumShellMode } from "../shell/kilo-shell";
import type { AxumConfig } from "../config";

export type AxumWorkflowPhase = "received" | "planned" | "permission-gated" | "ready";

export interface AxumWorkflowEvent {
  id: number;
  phase: AxumWorkflowPhase;
  message: string;
  createdAt: string;
}

export interface AxumWorkflowPlan {
  mode: AxumShellMode;
  prompt: string;
  stateDir: string;
  events: AxumWorkflowEvent[];
}

export function resolveProjectStateDir(cwd = process.cwd()): string {
  return path.join(cwd, ".axum", "state");
}

function event(id: number, phase: AxumWorkflowPhase, message: string): AxumWorkflowEvent {
  return { id, phase, message, createdAt: new Date().toISOString() };
}

export function buildWorkflowPlan(config: AxumConfig | undefined, prompt: string, options: { mode?: string; cwd?: string } = {}): AxumWorkflowPlan {
  const mode = findMode(config, options.mode);
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error("workflow prompt is required");
  const stateDir = resolveProjectStateDir(options.cwd);
  return {
    mode,
    prompt: trimmed,
    stateDir,
    events: [
      event(1, "received", `accept user request in ${mode.id} shell mode`),
      event(2, "planned", "translate shell input into pi-style workflow events"),
      event(3, "permission-gated", `allow tools: ${mode.tools.length ? mode.tools.join(", ") : "none"}`),
      event(4, "ready", `checkpoint target: ${stateDir}`),
    ],
  };
}

export function persistWorkflowPlan(plan: AxumWorkflowPlan): string {
  fs.mkdirSync(plan.stateDir, { recursive: true });
  const file = path.join(plan.stateDir, `${Date.now()}-${plan.mode.id}.json`);
  fs.writeFileSync(file, JSON.stringify(plan, null, 2) + "\n", "utf8");
  return file;
}

export function renderWorkflowPlan(plan: AxumWorkflowPlan, checkpointPath?: string): string {
  const lines = [
    `Axum workflow (${plan.mode.id})`,
    `shell: Kilo-style mode/prompt UX`,
    `runtime: pi-style event/checkpoint/tool-gate`,
    `state: ${plan.stateDir}`,
    `prompt: ${plan.prompt}`,
    "events:",
  ];
  for (const item of plan.events) lines.push(`  ${item.id}. ${item.phase}: ${item.message}`);
  if (checkpointPath) lines.push(`checkpoint: ${checkpointPath}`);
  return lines.join("\n");
}
