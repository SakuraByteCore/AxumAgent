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

export function renderRuntimeDashboard(events: AxumEvent[]): string {
  const activity: string[] = [];
  const commands: string[] = [];
  const files: string[] = [];
  const blocked: string[] = [];
  const calls = new Map<string, { name: string; arguments: Record<string, unknown> }>();

  for (const event of events) {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (event.kind === "turn_started") activity.push("started turn");
    if (event.kind === "model_sampling_started") activity.push(`thinking${typeof payload?.iteration === "number" ? ` #${payload.iteration}` : ""}`);
    if (event.kind === "turn_completed") activity.push("completed turn");
    if (event.kind === "turn_failed") {
      const message = typeof payload?.message === "string" ? payload.message : "turn failed";
      activity.push(`failed: ${clipDetail(message, 120)}`);
      blocked.push(clipDetail(message, 180));
    }
    if (event.kind === "tool_call_requested" && payload) {
      const callId = typeof payload.id === "string" ? payload.id : String(event.id);
      const name = typeof payload.name === "string" ? payload.name : "tool";
      const args = isRecord(payload.arguments) ? payload.arguments : {};
      calls.set(callId, { name, arguments: args });
      activity.push(`requested ${renderToolRequest(name, args)}`);
      if (name === "safe_exec") commands.push(`$ ${renderCommand(args)}  (running)`);
      if (name === "read") files.push(`read ${stringField(args, "file") ?? stringField(args, "path") ?? "<missing>"}`);
      if (name === "precise_edit") files.push(`edit ${stringField(args, "file") ?? "<missing>"}`);
    }
    if ((event.kind === "tool_call_completed" || event.kind === "permission_denied") && payload) {
      const callId = typeof payload.callId === "string" ? payload.callId : "";
      const call = calls.get(callId);
      const name = typeof payload.name === "string" ? payload.name : call?.name ?? "tool";
      const content = typeof payload.content === "string" ? payload.content : "";
      const prefix = event.kind === "permission_denied" ? "denied" : "ok";
      activity.push(`${prefix} ${name}`);
      if (name === "safe_exec") commands.push(renderCommandResult(call?.arguments ?? {}, content, event.kind === "permission_denied"));
      if (event.kind === "permission_denied") blocked.push(`${renderToolRequest(name, call?.arguments ?? {})}: ${clipDetail(content, 180)}`);
    }
  }

  return [
    "◇ activity",
    ...lastLines(activity, 8).map((line) => `  ${line}`),
    "◇ commands",
    ...(commands.length > 0 ? lastLines(commands, 6).map((line) => `  ${line}`) : ["  no command activity"]),
    "◇ files",
    ...(files.length > 0 ? dedupeLast(files, 6).map((line) => `  ${line}`) : ["  no file activity"]),
    "◇ blocked",
    ...(blocked.length > 0 ? lastLines(blocked, 4).map((line) => `  ${line}`) : ["  none"]),
  ].join("\n");
}

function renderEventDetail(event: AxumEvent): string | undefined {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload) return undefined;
  if (event.kind === "tool_call_requested") return typeof payload.name === "string" ? payload.name : undefined;
  if (event.kind === "tool_call_completed" || event.kind === "permission_denied") {
    const name = typeof payload.name === "string" ? payload.name : "tool";
    const content = typeof payload.content === "string" ? payload.content : "";
    return content ? `${name}: ${content.slice(0, 120)}` : name;
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
  return [command, ...rawArgs].join(" ").replace(/(api[_-]?key|token|authorization)=\S+/gi, "$1=***");
}

function renderCommandResult(args: Record<string, unknown>, content: string, denied: boolean): string {
  if (denied) return `$ ${renderCommand(args)}  denied: ${clipDetail(content, 120)}`;
  const parsed = parseJsonObject(content);
  const stdout = typeof parsed?.stdout === "string" ? parsed.stdout.trim() : "";
  const stderr = typeof parsed?.stderr === "string" ? parsed.stderr.trim() : "";
  const summary = stdout || stderr ? clipDetail(stdout || stderr, 140) : "no output";
  return `$ ${renderCommand(args)}  ok: ${summary}`;
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
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, Math.max(0, max - 1))}…` : compact;
}

function lastLines(lines: string[], max: number): string[] {
  return lines.slice(-max);
}

function dedupeLast(lines: string[], max: number): string[] {
  return [...new Set(lines)].slice(-max);
}
