import type { AxumEvent, AxumEventKind } from "./protocol";

export class AxumEventBus {
  private nextId = 1;
  private readonly events: AxumEvent[] = [];
  private readonly listeners = new Set<(event: AxumEvent) => void>();

  emit<T>(kind: AxumEventKind, payload: T, turnId?: string): AxumEvent<T> {
    const event: AxumEvent<T> = {
      id: this.nextId,
      turnId,
      kind,
      payload,
      createdAt: new Date().toISOString(),
    };
    this.nextId += 1;
    this.events.push(event as AxumEvent);
    for (const listener of this.listeners) listener(event as AxumEvent);
    return event;
  }

  subscribe(listener: (event: AxumEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): AxumEvent[] {
    return [...this.events];
  }
}

export function renderRuntimeEvents(events: AxumEvent[]): string {
  const labels: Record<string, string> = {
    session_configured: "session configured",
    turn_started: "turn started",
    context_captured: "context captured",
    child_task_planned: "child task planned",
    child_task_queued: "child task queued",
    child_task_started: "child task started",
    child_task_completed: "child task completed",
    child_task_failed: "child task failed",
    child_task_cancelled: "child task cancelled",
    merge_review_started: "merge review started",
    merge_review_completed: "merge review completed",
    model_sampling_started: "model sampling",
    provider_warning: "provider warning",
    assistant_message: "assistant message",
    tool_call_requested: "tool requested",
    tool_call_completed: "tool completed",
    permission_denied: "permission denied",
    turn_completed: "turn completed",
    turn_failed: "turn failed",
  };
  return events.map((event) => {
    const detail = renderEventDetail(event);
    return `  ${event.id}. ${labels[event.kind] ?? event.kind}${detail ? ` · ${detail}` : ""}${event.turnId ? ` · ${event.turnId}` : ""}`;
  }).join("\n");
}

interface RuntimeDashboardState {
  phase: string;
  now: string;
  next: string;
  steps: string[];
  evidence: string[];
  commands: string[];
  files: string[];
  blocked: string[];
  calls: Map<string, { name: string; arguments: Record<string, unknown> }>;
}

export function renderRuntimeDashboard(events: AxumEvent[]): string {
  const state: RuntimeDashboardState = {
    phase: "Idle",
    now: "waiting for user prompt",
    next: "send a prompt to start runtime work",
    steps: [],
    evidence: [],
    commands: [],
    files: [],
    blocked: [],
    calls: new Map(),
  };

  for (const event of events) updateDashboardState(state, event);

  return [
    "◇ workflow",
    `  ▶ ${state.phase} · ${state.now}`,
    `  next: ${state.next}`,
    "◇ steps",
    ...(state.steps.length > 0 ? lastLines(state.steps, 7).map((line) => `  ${line}`) : ["  · no runtime steps yet"]),
    "◇ evidence",
    ...(state.evidence.length > 0 ? dedupeLast(state.evidence, 8).map((line) => `  ${line}`) : ["  no tool, file, or command evidence yet"]),
    "◇ commands",
    ...(state.commands.length > 0 ? lastLines(state.commands, 5).map((line) => `  ${line}`) : ["  no command activity"]),
    "◇ files",
    ...(state.files.length > 0 ? dedupeLast(state.files, 5).map((line) => `  ${line}`) : ["  no file activity"]),
    "◇ blocked",
    ...(state.blocked.length > 0 ? lastLines(state.blocked, 4).map((line) => `  ${line}`) : ["  none"]),
  ].join("\n");
}

function updateDashboardState(state: RuntimeDashboardState, event: AxumEvent): void {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (event.kind === "turn_started") {
    state.phase = "Planning";
    state.now = "starting turn";
    state.next = "capture context, then sample the model";
    state.steps.push("▶ started turn");
    return;
  }
  if (event.kind === "context_captured") {
    state.phase = "Reading";
    state.now = "captured runtime context";
    state.next = "sample the model with current context";
    state.steps.push("✓ captured context");
    return;
  }
  if (event.kind === "model_sampling_started") {
    const iteration = typeof payload?.iteration === "number" ? ` #${payload.iteration}` : "";
    state.phase = "Thinking";
    state.now = `model sampling${iteration}`;
    state.next = "answer directly or request a tool";
    state.steps.push(`▶ model sampling${iteration}`);
    return;
  }
  if (event.kind === "assistant_message") {
    state.phase = "Answering";
    state.now = "assistant message received";
    state.next = "finish turn unless more tool work is needed";
    state.steps.push("✓ assistant response ready");
    return;
  }
  if (event.kind === "tool_call_requested" && payload) {
    const callId = typeof payload.id === "string" ? payload.id : String(event.id);
    const name = typeof payload.name === "string" ? payload.name : "tool";
    const args = isRecord(payload.arguments) ? payload.arguments : {};
    state.calls.set(callId, { name, arguments: args });
    const request = renderToolRequest(name, args);
    state.phase = phaseForTool(name);
    state.now = request;
    state.next = "wait for tool result";
    state.steps.push(`▶ ${request}`);
    state.evidence.push(`tool ${request} requested`);
    if (name === "safe_exec") {
      const command = renderCommand(args);
      state.commands.push(`$ ${command}  running`);
      state.evidence.push(`cmd ${command} running`);
    }
    if (name === "read") {
      const file = stringField(args, "file") ?? stringField(args, "path") ?? "<missing>";
      state.files.push(`read ${file}`);
      state.evidence.push(`file read ${file}`);
    }
    if (name === "precise_edit") {
      const file = stringField(args, "file") ?? "<missing>";
      state.files.push(`edit ${file}`);
      state.evidence.push(`file edit ${file}`);
    }
    return;
  }
  if ((event.kind === "tool_call_completed" || event.kind === "permission_denied") && payload) {
    const callId = typeof payload.callId === "string" ? payload.callId : "";
    const call = state.calls.get(callId);
    const name = typeof payload.name === "string" ? payload.name : call?.name ?? "tool";
    const content = typeof payload.content === "string" ? payload.content : "";
    if (event.kind === "permission_denied") {
      const blocked = `${renderToolRequest(name, call?.arguments ?? {})}: ${clipDetail(content, 180)}`;
      state.phase = "Blocked";
      state.now = blocked;
      state.next = "adjust the request or grant a safer allowed path";
      state.steps.push(`✗ blocked ${renderToolRequest(name, call?.arguments ?? {})}`);
      state.blocked.push(blocked);
      state.evidence.push(`blocked ${blocked}`);
      if (name === "safe_exec") state.commands.push(renderCommandResult(call?.arguments ?? {}, content, true));
      return;
    }
    state.phase = "Executing";
    state.now = `${name} completed`;
    state.next = "feed result back into the model";
    state.steps.push(`✓ ${name} completed`);
    state.evidence.push(`tool ${name} completed${content ? `: ${summarizeToolContent(content, 120)}` : ""}`);
    if (name === "safe_exec") state.commands.push(renderCommandResult(call?.arguments ?? {}, content, false));
    return;
  }
  if (event.kind === "provider_warning" && payload) {
    const message = typeof payload.message === "string" ? payload.message : "provider warning";
    state.phase = "Provider";
    state.now = clipDetail(message, 120);
    state.next = "retry, fall back, or show the provider error";
    state.steps.push(`! provider warning: ${clipDetail(message, 120)}`);
    state.evidence.push(`provider warning: ${clipDetail(message, 160)}`);
    return;
  }
  if (event.kind === "turn_completed") {
    state.phase = "Done";
    state.now = "turn completed";
    state.next = "ready for the next prompt";
    state.steps.push("✓ completed turn");
    return;
  }
  if (event.kind === "turn_failed") {
    const message = typeof payload?.message === "string" ? payload.message : "turn failed";
    state.phase = "Blocked";
    state.now = `failed: ${clipDetail(message, 120)}`;
    state.next = "fix the blocker before retrying";
    state.steps.push(`✗ failed: ${clipDetail(message, 120)}`);
    state.blocked.push(clipDetail(message, 180));
  }
}

function phaseForTool(name: string): string {
  if (name === "read") return "Reading";
  if (name === "precise_edit") return "Editing";
  if (name === "safe_exec") return "Running";
  return "Executing";
}

function renderEventDetail(event: AxumEvent): string | undefined {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload) return undefined;
  if (event.kind === "tool_call_requested") return typeof payload.name === "string" ? payload.name : undefined;
  if (event.kind === "tool_call_completed" || event.kind === "permission_denied") {
    const name = typeof payload.name === "string" ? payload.name : "tool";
    const content = typeof payload.content === "string" ? payload.content : "";
    return content ? `${name}: ${clipDetail(content, 120)}` : name;
  }
  if (event.kind === "provider_warning" || event.kind === "turn_failed") {
    return typeof payload.message === "string" ? payload.message.slice(0, 160) : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function renderToolRequest(name: string, args: Record<string, unknown>): string {
  if (name === "safe_exec") return `safe_exec ${renderCommand(args)}`;
  if (name === "read") return `read ${stringField(args, "file") ?? stringField(args, "path") ?? "<missing>"}`;
  if (name === "precise_edit") return `precise_edit ${stringField(args, "file") ?? "<missing>"}`;
  return name;
}

function renderCommand(args: Record<string, unknown>): string {
  const command = stringField(args, "command") ?? "<missing>";
  const rawArgs = Array.isArray(args.args) ? args.args.filter((arg): arg is string => typeof arg === "string") : [];
  return redactSensitiveText([command, ...rawArgs].join(" "));
}

function renderCommandResult(args: Record<string, unknown>, content: string, denied: boolean): string {
  if (denied) return `$ ${renderCommand(args)}  denied: ${clipDetail(content, 120)}`;
  const parsed = parseJsonObject(content);
  const stdout = typeof parsed?.stdout === "string" ? parsed.stdout.trim() : "";
  const stderr = typeof parsed?.stderr === "string" ? parsed.stderr.trim() : "";
  const summary = stdout || stderr ? summarizeOutput(stdout || stderr, 140) : "no output";
  return `$ ${renderCommand(args)}  ok: ${summary}`;
}

function summarizeToolContent(content: string, max: number): string {
  const parsed = parseJsonObject(content);
  const stdout = typeof parsed?.stdout === "string" ? parsed.stdout.trim() : "";
  const stderr = typeof parsed?.stderr === "string" ? parsed.stderr.trim() : "";
  return stdout || stderr ? summarizeOutput(stdout || stderr, max) : clipDetail(content, max);
}

function parseJsonObject(content: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function clipDetail(value: string, max: number): string {
  const compact = redactSensitiveText(value).replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, Math.max(0, max - 1))}…` : compact;
}

function summarizeOutput(value: string, max: number): string {
  const redacted = redactSensitiveText(value);
  const lines = redacted.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean);
  const compact = lines.length > 3 ? [...lines.slice(0, 2), `… ${lines.length - 3} more lines`, lines[lines.length - 1]].join(" | ") : lines.join(" | ");
  return clipDetail(compact || redacted, max);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, "Bearer ***")
    .replace(/(authorization\s*[:=]\s*)\S+/gi, "$1***")
    .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*)\S+/gi, "$1***")
    .replace(/([?&](?:api[_-]?key|token|secret|password|passwd|pwd)=)[^\s&]+/gi, "$1***")
    .replace(/(sk-[A-Za-z0-9]{12,})/g, "sk-***")
    .replace(/(gh[pousr]_[A-Za-z0-9_]{12,})/g, "gh***")
    .replace(/([A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})/g, "jwt.***");
}

function lastLines(lines: string[], max: number): string[] {
  return lines.slice(-max);
}

function dedupeLast(lines: string[], max: number): string[] {
  return [...new Set(lines)].slice(-max);
}
