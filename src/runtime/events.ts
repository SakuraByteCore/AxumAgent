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
  goal: string;
  phase: string;
  now: string;
  next: string;
  progress: string[];
  issues: string[];
  latestEvidence: string;
  commandsRun: number;
  commandsFailed: number;
  filesRead: Set<string>;
  filesChanged: Set<string>;
  calls: Map<string, { name: string; arguments: Record<string, unknown>; summary: string }>;
}

export function renderRuntimeDashboard(events: AxumEvent[]): string {
  const state: RuntimeDashboardState = {
    goal: "waiting for the next task",
    phase: "Idle",
    now: "ready for input",
    next: "send a prompt to start runtime work",
    progress: [],
    issues: [],
    latestEvidence: "none yet",
    commandsRun: 0,
    commandsFailed: 0,
    filesRead: new Set(),
    filesChanged: new Set(),
    calls: new Map(),
  };

  for (const event of events) updateDashboardState(state, event);

  return [
    "◇ current task",
    `  goal: ${clipDetail(state.goal, 96)}`,
    `  status: ${state.phase}`,
    `  now: ${clipDetail(state.now, 96)}`,
    `  next: ${clipDetail(state.next, 96)}`,
    "◇ progress",
    ...(state.progress.length > 0 ? lastLines(state.progress, 5).map((line) => `  ${line}`) : ["  · no task progress yet"]),
    "◇ results",
    `  commands: ${state.commandsRun} run · ${state.commandsFailed} failed`,
    `  files: ${state.filesRead.size} read · ${state.filesChanged.size} changed`,
    `  latest: ${clipDetail(state.latestEvidence, 96)}`,
    "◇ issues",
    ...(state.issues.length > 0 ? lastLines(state.issues, 4).map((line) => `  ${line}`) : ["  none"]),
  ].join("\n");
}

function updateDashboardState(state: RuntimeDashboardState, event: AxumEvent): void {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (event.kind === "turn_started") {
    state.goal = getPrompt(payload) ?? "runtime turn";
    state.phase = "Planning";
    state.now = "starting task";
    state.next = "gather context";
    pushProgress(state, "▶ starting task");
    return;
  }
  if (event.kind === "context_captured") {
    state.phase = "Reading";
    state.now = "context captured";
    state.next = "choose the next action";
    pushProgress(state, "✓ captured context");
    return;
  }
  if (event.kind === "model_sampling_started") {
    state.phase = "Thinking";
    state.now = state.progress.length > 0 ? "deciding the next task step" : "planning the task";
    state.next = "use a tool or answer directly";
    return;
  }
  if (event.kind === "assistant_message") {
    state.phase = "Answering";
    state.now = "preparing the assistant response";
    state.next = "finish the turn unless another step is needed";
    pushProgress(state, "✓ response ready");
    return;
  }
  if (event.kind === "tool_call_requested" && payload) {
    const callId = typeof payload.id === "string" ? payload.id : String(event.id);
    const name = typeof payload.name === "string" ? payload.name : "tool";
    const args = isRecord(payload.arguments) ? payload.arguments : {};
    const summary = summarizeToolAction(name, args);
    state.calls.set(callId, { name, arguments: args, summary });
    state.phase = phaseForTool(name);
    state.now = summary;
    state.next = "wait for result";
    pushProgress(state, `▶ ${summary}`);
    state.latestEvidence = evidenceForToolRequest(name, args, summary);
    if (name === "safe_exec") state.commandsRun += 1;
    if (name === "read") state.filesRead.add(fileForArgs(args));
    if (name === "precise_edit") state.filesChanged.add(fileForArgs(args));
    return;
  }
  if ((event.kind === "tool_call_completed" || event.kind === "permission_denied") && payload) {
    const callId = typeof payload.callId === "string" ? payload.callId : "";
    const call = state.calls.get(callId);
    const name = typeof payload.name === "string" ? payload.name : call?.name ?? "tool";
    const content = typeof payload.content === "string" ? payload.content : "";
    const summary = call?.summary ?? summarizeToolAction(name, call?.arguments ?? {});
    if (event.kind === "permission_denied") {
      state.phase = "Blocked";
      state.now = `${summary} blocked`;
      state.next = "adjust the request or grant a safer allowed path";
      state.issues.push(`${summary}: ${clipDetail(content, 140)}`);
      pushProgress(state, `✗ ${summary} blocked`);
      if (name === "safe_exec") state.commandsFailed += 1;
      if (state.latestEvidence === "none yet") state.latestEvidence = `blocked: ${summary}`;
      return;
    }
    state.phase = "Running";
    state.now = `${summary} finished`;
    state.next = "decide the next task step";
    pushProgress(state, `✓ ${summary}`);
    state.latestEvidence = resultEvidence(name, call?.arguments ?? {}, content);
    return;
  }
  if (event.kind === "provider_warning" && payload) {
    const message = typeof payload.message === "string" ? payload.message : "provider warning";
    state.phase = "Provider";
    state.now = clipDetail(message, 96);
    state.next = "retry, fall back, or show the provider error";
    state.issues.push(`provider: ${clipDetail(message, 140)}`);
    state.latestEvidence = `provider warning: ${clipDetail(message, 96)}`;
    return;
  }
  if (event.kind === "turn_completed") {
    state.phase = "Done";
    state.now = "task completed";
    state.next = "ready for the next prompt";
    pushProgress(state, "✓ completed task");
    return;
  }
  if (event.kind === "turn_failed") {
    const message = typeof payload?.message === "string" ? payload.message : "turn failed";
    state.phase = "Blocked";
    state.now = `failed: ${clipDetail(message, 96)}`;
    state.next = "fix the blocker before retrying";
    state.issues.push(clipDetail(message, 140));
    pushProgress(state, `✗ failed: ${clipDetail(message, 96)}`);
  }
}

function getPrompt(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  const direct = stringField(payload, "prompt") ?? stringField(payload, "message") ?? stringField(payload, "goal");
  if (direct) return direct;
  const request = payload.request;
  if (isRecord(request)) return stringField(request, "prompt") ?? stringField(request, "message") ?? stringField(request, "goal");
  return undefined;
}

function phaseForTool(name: string): string {
  if (name === "read") return "Reading";
  if (name === "precise_edit") return "Editing";
  if (name === "safe_exec") return "Running";
  return "Working";
}

function summarizeToolAction(name: string, args: Record<string, unknown>): string {
  if (name === "safe_exec") return summarizeCommandAction(renderCommand(args));
  if (name === "read") return `read ${fileForArgs(args)}`;
  if (name === "precise_edit") return `edit ${fileForArgs(args)}`;
  return name.replace(/_/g, " ");
}

function summarizeCommandAction(command: string): string {
  const [program, ...rest] = command.split(/\s+/g).filter(Boolean);
  const compactCommand = clipDetail(command, 72);
  if (!program) return "run command";
  if (program === "ls") return `inspect ${firstPathArg(rest) ?? "directory"}`;
  if (program === "find") return `scan ${firstPathArg(rest) ?? "workspace"}`;
  if (program === "grep") return `search ${firstPathArg(rest.slice(1)) ?? "workspace"}`;
  if (program === "cat" || program === "head" || program === "tail" || program === "sed") return `inspect ${firstPathArg(rest) ?? "file"}`;
  if (program === "wc") return `count ${firstPathArg(rest) ?? "workspace"}`;
  if (program === "npm") return rest.length > 0 ? `run npm ${rest.join(" ")}` : "run npm";
  if (program === "git") return rest.length > 0 ? `check git ${rest[0]}` : "check git";
  return `run ${compactCommand}`;
}

function firstPathArg(args: string[]): string | undefined {
  return args.find((arg) => arg && !arg.startsWith("-") && arg !== "|" && arg !== "&&" && arg !== ";");
}

function evidenceForToolRequest(name: string, args: Record<string, unknown>, summary: string): string {
  if (name === "safe_exec") return `${summary} → running`;
  if (name === "read" || name === "precise_edit") return summary;
  return `${summary} requested`;
}

function resultEvidence(name: string, args: Record<string, unknown>, content: string): string {
  const action = summarizeToolAction(name, args);
  if (name === "safe_exec") {
    const parsed = parseJsonObject(content);
    const stdout = typeof parsed?.stdout === "string" ? parsed.stdout.trim() : "";
    const stderr = typeof parsed?.stderr === "string" ? parsed.stderr.trim() : "";
    const output = stdout || stderr;
    return output ? `${action} → ok: ${summarizeOutput(output, 72)}` : `${action} → ok`;
  }
  return `${action} → done`;
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

function fileForArgs(args: Record<string, unknown>): string {
  return stringField(args, "file") ?? stringField(args, "path") ?? "<missing>";
}

function renderCommand(args: Record<string, unknown>): string {
  const command = stringField(args, "command") ?? "<missing>";
  const rawArgs = Array.isArray(args.args) ? args.args.filter((arg): arg is string => typeof arg === "string") : [];
  return redactSensitiveText([command, ...rawArgs].join(" "));
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
    .replace(/([A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g, "jwt.***");
}

function pushProgress(state: RuntimeDashboardState, line: string): void {
  if (state.progress[state.progress.length - 1] === line) return;
  state.progress.push(line);
}

function lastLines(lines: string[], max: number): string[] {
  return lines.slice(-max);
}
