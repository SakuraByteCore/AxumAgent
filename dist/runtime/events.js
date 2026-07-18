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
    const state = {
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
    for (const event of events)
        updateDashboardState(state, event);
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
function updateDashboardState(state, event) {
    const payload = event.payload;
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
        if (name === "safe_exec")
            state.commandsRun += 1;
        if (name === "read")
            state.filesRead.add(fileForArgs(args));
        if (name === "precise_edit")
            state.filesChanged.add(fileForArgs(args));
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
            if (name === "safe_exec")
                state.commandsFailed += 1;
            if (state.latestEvidence === "none yet")
                state.latestEvidence = `blocked: ${summary}`;
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
function getPrompt(payload) {
    if (!payload)
        return undefined;
    const direct = stringField(payload, "prompt") ?? stringField(payload, "message") ?? stringField(payload, "goal");
    if (direct)
        return direct;
    const request = payload.request;
    if (isRecord(request))
        return stringField(request, "prompt") ?? stringField(request, "message") ?? stringField(request, "goal");
    return undefined;
}
function phaseForTool(name) {
    if (name === "read")
        return "Reading";
    if (name === "precise_edit")
        return "Editing";
    if (name === "safe_exec")
        return "Running";
    return "Working";
}
function summarizeToolAction(name, args) {
    if (name === "safe_exec")
        return summarizeCommandAction(renderCommand(args));
    if (name === "read")
        return `read ${fileForArgs(args)}`;
    if (name === "precise_edit")
        return `edit ${fileForArgs(args)}`;
    return name.replace(/_/g, " ");
}
function summarizeCommandAction(command) {
    const [program, ...rest] = command.split(/\s+/g).filter(Boolean);
    const compactCommand = clipDetail(command, 72);
    if (!program)
        return "run command";
    if (program === "ls")
        return `inspect ${firstPathLabel(rest) ?? "directory"}`;
    if (program === "find")
        return `scan ${firstPathLabel(rest) ?? "workspace"}`;
    if (program === "grep")
        return `search ${firstPathLabel(rest.slice(1)) ?? "workspace"}`;
    if (program === "cat" || program === "head" || program === "tail" || program === "sed")
        return `inspect ${firstPathLabel(rest) ?? "file"}`;
    if (program === "wc")
        return `count ${firstPathLabel(rest) ?? "workspace"}`;
    if (program === "npm")
        return rest.length > 0 ? `run npm ${rest.join(" ")}` : "run npm";
    if (program === "git")
        return rest.length > 0 ? `check git ${rest[0]}` : "check git";
    return `run ${compactCommand}`;
}
function firstPathLabel(args) {
    const value = args.find((arg) => arg && !arg.startsWith("-") && arg !== "|" && arg !== "&&" && arg !== ";");
    if (!value || value === "." || value === "./")
        return value ? "workspace" : undefined;
    return value.replace(/^\.\//, "");
}
function evidenceForToolRequest(name, args, summary) {
    if (name === "safe_exec")
        return `${summary} → running`;
    if (name === "read" || name === "precise_edit")
        return summary;
    return `${summary} requested`;
}
function resultEvidence(name, args, content) {
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
function fileForArgs(args) {
    return stringField(args, "file") ?? stringField(args, "path") ?? "<missing>";
}
function renderCommand(args) {
    const command = stringField(args, "command") ?? "<missing>";
    const rawArgs = Array.isArray(args.args) ? args.args.filter((arg) => typeof arg === "string") : [];
    return redactSensitiveText([command, ...rawArgs].join(" "));
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
        .replace(/([?&](?:api[_-]?key|token|secret|password|passwd|pwd)=)[^\s&]+/gi, "$1***")
        .replace(/(sk-[A-Za-z0-9]{12,})/g, "sk-***")
        .replace(/(gh[pousr]_[A-Za-z0-9_]{12,})/g, "gh***")
        .replace(/([A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g, "jwt.***");
}
function pushProgress(state, line) {
    if (state.progress[state.progress.length - 1] === line)
        return;
    state.progress.push(line);
}
function lastLines(lines, max) {
    return lines.slice(-max);
}
