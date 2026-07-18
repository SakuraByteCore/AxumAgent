"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AxumEventBus = void 0;
exports.renderRuntimeEvents = renderRuntimeEvents;
exports.renderRuntimeDashboard = renderRuntimeDashboard;
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
function renderRuntimeDashboard(events) {
    const activity = [];
    const commands = [];
    const files = [];
    const blocked = [];
    const calls = new Map();
    for (const event of events) {
        const payload = event.payload;
        if (event.kind === "turn_started")
            activity.push("started turn");
        if (event.kind === "model_sampling_started")
            activity.push(`thinking${typeof payload?.iteration === "number" ? ` #${payload.iteration}` : ""}`);
        if (event.kind === "turn_completed")
            activity.push("completed turn");
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
            if (name === "safe_exec")
                commands.push(`$ ${renderCommand(args)}  (running)`);
            if (name === "read")
                files.push(`read ${stringField(args, "file") ?? stringField(args, "path") ?? "<missing>"}`);
            if (name === "precise_edit")
                files.push(`edit ${stringField(args, "file") ?? "<missing>"}`);
        }
        if ((event.kind === "tool_call_completed" || event.kind === "permission_denied") && payload) {
            const callId = typeof payload.callId === "string" ? payload.callId : "";
            const call = calls.get(callId);
            const name = typeof payload.name === "string" ? payload.name : call?.name ?? "tool";
            const content = typeof payload.content === "string" ? payload.content : "";
            const prefix = event.kind === "permission_denied" ? "denied" : "ok";
            activity.push(`${prefix} ${name}`);
            if (name === "safe_exec")
                commands.push(renderCommandResult(call?.arguments ?? {}, content, event.kind === "permission_denied"));
            if (event.kind === "permission_denied")
                blocked.push(`${renderToolRequest(name, call?.arguments ?? {})}: ${clipDetail(content, 180)}`);
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
function renderEventDetail(event) {
    const payload = event.payload;
    if (!payload)
        return undefined;
    if (event.kind === "tool_call_requested")
        return typeof payload.name === "string" ? payload.name : undefined;
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
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function stringField(value, key) {
    const field = value[key];
    return typeof field === "string" ? field : undefined;
}
function renderToolRequest(name, args) {
    if (name === "safe_exec")
        return `safe_exec ${renderCommand(args)}`;
    if (name === "read")
        return `read ${stringField(args, "file") ?? stringField(args, "path") ?? "<missing>"}`;
    if (name === "precise_edit")
        return `precise_edit ${stringField(args, "file") ?? "<missing>"}`;
    return name;
}
function renderCommand(args) {
    const command = stringField(args, "command") ?? "<missing>";
    const rawArgs = Array.isArray(args.args) ? args.args.filter((arg) => typeof arg === "string") : [];
    return redactSensitiveText([command, ...rawArgs].join(" "));
}
function renderCommandResult(args, content, denied) {
    if (denied)
        return `$ ${renderCommand(args)}  denied: ${clipDetail(content, 120)}`;
    const parsed = parseJsonObject(content);
    const stdout = typeof parsed?.stdout === "string" ? parsed.stdout.trim() : "";
    const stderr = typeof parsed?.stderr === "string" ? parsed.stderr.trim() : "";
    const summary = stdout || stderr ? summarizeOutput(stdout || stderr, 140) : "no output";
    return `$ ${renderCommand(args)}  ok: ${summary}`;
}
function parseJsonObject(content) {
    try {
        const parsed = JSON.parse(content);
        return isRecord(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function clipDetail(value, max) {
    const compact = redactSensitiveText(value).replace(/\s+/g, " ").trim();
    return compact.length > max ? `${compact.slice(0, Math.max(0, max - 1))}…` : compact;
}
function summarizeOutput(value, max) {
    const redacted = redactSensitiveText(value);
    const lines = redacted.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean);
    const compact = lines.length > 3 ? [...lines.slice(0, 2), `… ${lines.length - 3} more lines`, lines[lines.length - 1]].join(" | ") : lines.join(" | ");
    return clipDetail(compact || redacted, max);
}
function redactSensitiveText(value) {
    return value
        .replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, "Bearer ***")
        .replace(/(authorization\s*[:=]\s*)\S+/gi, "$1***")
        .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*)\S+/gi, "$1***")
        .replace(/(sk-[A-Za-z0-9]{12,})/g, "sk-***")
        .replace(/(gh[pousr]_[A-Za-z0-9_]{12,})/g, "gh***")
        .replace(/([A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})/g, "jwt.***");
}
function lastLines(lines, max) {
    return lines.slice(-max);
}
function dedupeLast(lines, max) {
    return [...new Set(lines)].slice(-max);
}
