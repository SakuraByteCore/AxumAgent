import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { findMode, type AxumShellMode } from "../shell/kilo-shell";
import type { AxumConfig } from "../config";

export type AxumWorkflowPhase = "received" | "plan" | "execute" | "auto-fix" | "permission-gated" | "ready";
export type AxumWorkflowStage = "plan" | "execute";

export interface AxumWorkflowHashAnchor {
  id: string;
  target: string;
  hash: string;
  algorithm: "sha256";
  createdAt: string;
}

export interface AxumWorkflowEvent {
  id: number;
  phase: AxumWorkflowPhase;
  stage: AxumWorkflowStage;
  message: string;
  createdAt: string;
  anchor?: AxumWorkflowHashAnchor;
}

export interface AxumWorkflowPlanStep {
  id: string;
  stage: AxumWorkflowStage;
  goal: string;
  status: "pending" | "ready";
}

export interface AxumWorkflowAutoFixLoop {
  enabled: boolean;
  maxAttempts: number;
  anchor: AxumWorkflowHashAnchor;
  correction: "replan" | "reanchor";
}

export interface AxumWorkflowPlan {
  mode: AxumShellMode;
  prompt: string;
  stateDir: string;
  stages: AxumWorkflowPlanStep[];
  anchors: AxumWorkflowHashAnchor[];
  autoFix: AxumWorkflowAutoFixLoop;
  events: AxumWorkflowEvent[];
}

export interface AxumParallelTask {
  id: string;
  prompt: string;
  mode: string;
  status: "planned";
}

export interface AxumSwarmPlan {
  prompt: string;
  stateDir: string;
  coordinator: "main-agent";
  tasks: AxumParallelTask[];
  mergePolicy: "hash-anchor-review";
  createdAt: string;
}

export function resolveProjectStateDir(cwd = process.cwd()): string {
  return path.join(cwd, ".axum", "state");
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function createHashAnchor(target: string, content: string): AxumWorkflowHashAnchor {
  return {
    id: hashText(`${target}\0${content}`).slice(0, 12),
    target,
    hash: hashText(content),
    algorithm: "sha256",
    createdAt: new Date().toISOString(),
  };
}

function event(id: number, phase: AxumWorkflowPhase, stage: AxumWorkflowStage, message: string, anchor?: AxumWorkflowHashAnchor): AxumWorkflowEvent {
  return { id, phase, stage, message, createdAt: new Date().toISOString(), ...(anchor ? { anchor } : {}) };
}

function planSteps(prompt: string): AxumWorkflowPlanStep[] {
  return [
    { id: "plan.scope", stage: "plan", goal: `derive execution plan for: ${prompt}`, status: "ready" },
    { id: "plan.gates", stage: "plan", goal: "resolve permission gates and tool budget before writes", status: "ready" },
    { id: "execute.apply", stage: "execute", goal: "apply the smallest verified code changes", status: "pending" },
    { id: "execute.verify", stage: "execute", goal: "run regression checks and re-anchor changed state", status: "pending" },
  ];
}

export function buildWorkflowPlan(config: AxumConfig | undefined, prompt: string, options: { mode?: string; cwd?: string } = {}): AxumWorkflowPlan {
  const mode = findMode(config, options.mode);
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error("workflow prompt is required");
  const stateDir = resolveProjectStateDir(options.cwd);
  const requestAnchor = createHashAnchor("workflow.prompt", trimmed);
  const toolAnchor = createHashAnchor("workflow.tools", mode.tools.join("\n"));
  return {
    mode,
    prompt: trimmed,
    stateDir,
    stages: planSteps(trimmed),
    anchors: [requestAnchor, toolAnchor],
    autoFix: {
      enabled: true,
      maxAttempts: 3,
      anchor: requestAnchor,
      correction: "replan",
    },
    events: [
      event(1, "received", "plan", `capture request in ${mode.id} shell mode`, requestAnchor),
      event(2, "plan", "plan", "build Codex-style plan stage with explicit gates", requestAnchor),
      event(3, "permission-gated", "plan", `allow tools: ${mode.tools.length ? mode.tools.join(", ") : "none"}`, toolAnchor),
      event(4, "execute", "execute", "enter execute stage after plan gates pass", toolAnchor),
      event(5, "auto-fix", "execute", "if hash anchor drifts, replan and retry bounded corrections", requestAnchor),
      event(6, "ready", "execute", `checkpoint target: ${stateDir}`),
    ],
  };
}

export function buildSwarmPlan(prompt: string, tasks: string[], options: { mode?: string; cwd?: string } = {}): AxumSwarmPlan {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) throw new Error("parallel prompt is required");
  const normalizedTasks = tasks.map((task) => task.trim()).filter(Boolean);
  if (normalizedTasks.length === 0) throw new Error("parallel requires at least one --task");
  return {
    prompt: trimmedPrompt,
    stateDir: resolveProjectStateDir(options.cwd),
    coordinator: "main-agent",
    tasks: normalizedTasks.map((task, index) => ({
      id: `agent-${index + 1}`,
      prompt: task,
      mode: options.mode || "build",
      status: "planned",
    })),
    mergePolicy: "hash-anchor-review",
    createdAt: new Date().toISOString(),
  };
}

export function persistWorkflowPlan(plan: AxumWorkflowPlan): string {
  fs.mkdirSync(plan.stateDir, { recursive: true });
  const file = path.join(plan.stateDir, `${Date.now()}-${plan.mode.id}.json`);
  fs.writeFileSync(file, JSON.stringify(plan, null, 2) + "\n", "utf8");
  return file;
}

export function persistSwarmPlan(plan: AxumSwarmPlan): string {
  fs.mkdirSync(plan.stateDir, { recursive: true });
  const file = path.join(plan.stateDir, `${Date.now()}-swarm.json`);
  fs.writeFileSync(file, JSON.stringify(plan, null, 2) + "\n", "utf8");
  return file;
}

export function renderWorkflowPlan(plan: AxumWorkflowPlan, checkpointPath?: string, options: { verbose?: boolean } = {}): string {
  const lines = [
    "◇ Axum workflow",
    `  ◌ ${plan.mode.id} · ${plan.prompt}`,
    "  ✓ plan · request anchored",
  ];
  const middle = plan.events.slice(1, -1);
  if (options.verbose) {
    lines.push(`  ◌ state ${plan.stateDir}`);
    lines.push(`  ◌ anchor ${plan.anchors[0]?.id} sha256:${plan.anchors[0]?.hash.slice(0, 12)}`);
    for (const item of middle) {
      const message = item.phase === "plan"
        ? "shape plan stage"
        : item.phase === "permission-gated"
          ? `gate tools ${plan.mode.tools.length ? plan.mode.tools.join(", ") : "none"}`
          : item.phase === "execute"
            ? "enter execute stage"
            : item.phase === "auto-fix"
              ? `auto-fix loop ${plan.autoFix.maxAttempts}x via hash anchor`
              : item.message;
      lines.push(`  ├─ ${message}`);
    }
  } else if (middle.length > 0) {
    lines.push(`  ⤷ ${middle.length} steps folded (--verbose to expand)`);
  }
  lines.push(`  ✓ execute · ready · ${plan.stateDir}`);
  if (checkpointPath) lines.push(`  ◆ checkpoint ${checkpointPath}`);
  return lines.join("\n");
}

export function renderSwarmPlan(plan: AxumSwarmPlan, checkpointPath?: string): string {
  const lines = [
    "◇ Axum parallel",
    `  ◌ coordinator ${plan.coordinator} · ${plan.prompt}`,
    `  ✓ ${plan.tasks.length} sub-agents planned`,
  ];
  for (const task of plan.tasks) lines.push(`  ├─ ${task.id} [${task.mode}] ${task.prompt}`);
  lines.push(`  ✓ merge policy · ${plan.mergePolicy}`);
  if (checkpointPath) lines.push(`  ◆ checkpoint ${checkpointPath}`);
  return lines.join("\n");
}
