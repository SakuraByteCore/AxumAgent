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
    model_sampling_started: "model sampling",
    assistant_message: "assistant message",
    tool_call_requested: "tool requested",
    tool_call_completed: "tool completed",
    permission_denied: "permission denied",
    turn_completed: "turn completed",
    turn_failed: "turn failed",
  };
  return events.map((event) => `  ${event.id}. ${labels[event.kind] ?? event.kind}${event.turnId ? ` · ${event.turnId}` : ""}`).join("\n");
}
