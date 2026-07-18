"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AxumEventBus = void 0;
exports.renderRuntimeEvents = renderRuntimeEvents;
class AxumEventBus {
    nextId = 1;
    events = [];
    listeners = new Set();
    emit(kind, payload, turnId) {
        const event = {
            id: this.nextId,
            turnId,
            kind,
            payload,
            createdAt: new Date().toISOString(),
        };
        this.nextId += 1;
        this.events.push(event);
        for (const listener of this.listeners)
            listener(event);
        return event;
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    snapshot() {
        return [...this.events];
    }
}
exports.AxumEventBus = AxumEventBus;
function renderRuntimeEvents(events) {
    const labels = {
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
        assistant_message: "assistant message",
        tool_call_requested: "tool requested",
        tool_call_completed: "tool completed",
        permission_denied: "permission denied",
        turn_completed: "turn completed",
        turn_failed: "turn failed",
    };
    return events.map((event) => `  ${event.id}. ${labels[event.kind] ?? event.kind}${event.turnId ? ` · ${event.turnId}` : ""}`).join("\n");
}
