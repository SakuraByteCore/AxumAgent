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
