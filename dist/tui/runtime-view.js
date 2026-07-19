"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redactTuiText = redactTuiText;
exports.renderRuntimeProjection = renderRuntimeProjection;
exports.runtimeFailureSummary = runtimeFailureSummary;
exports.renderRuntimeTranscript = renderRuntimeTranscript;
exports.renderRuntimeVisibleOutput = renderRuntimeVisibleOutput;
const events_1 = require("../runtime/events");
const text_1 = require("./text");
function redactTuiText(value) {
    return value
        .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer ***")
        .replace(/(api[_-]?key|token|secret|password)=([^\s&]+)/gi, "$1=***")
        .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "gh*_***")
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "jwt.***");
}
function renderRuntimeProjection(session) {
    const events = session.events.snapshot().filter((event) => event.kind !== "session_configured");
    if (events.length === 0)
        return "◇ runtime\n  waiting for first event";
    return (0, events_1.renderRuntimeDashboard)(events).slice(0, 2200);
}
function runtimeStringField(value, key) {
    if (!value || typeof value !== "object")
        return undefined;
    const field = value[key];
    return typeof field === "string" && field.trim() ? field : undefined;
}
function runtimeArgs(payload) {
    if (!payload || typeof payload !== "object")
        return {};
    const args = payload.arguments;
    return args && typeof args === "object" && !Array.isArray(args) ? args : {};
}
function runtimeArgText(args, key) {
    const value = args[key];
    return typeof value === "string" && value.trim() ? value : undefined;
}
function runtimeToolTitle(name, args) {
    if (name === "safe_exec")
        return `Ran ${runtimeArgText(args, "command") ?? "command"}`;
    if (name === "read")
        return `Read ${runtimeArgText(args, "file") ?? runtimeArgText(args, "path") ?? "file"}`;
    if (name === "precise_edit")
        return `Edited ${runtimeArgText(args, "file") ?? runtimeArgText(args, "path") ?? "file"}`;
    return `${name} tool`;
}
function runtimeFailureSummary(message) {
    const text = message instanceof Error ? message.message : String(message ?? "");
    if (/blocked by repeated tool denial/i.test(text))
        return "Tool blocked after repeated denial";
    if (/max tool iterations/i.test(text))
        return "Runtime stopped after too many tool iterations";
    return "Runtime turn failed";
}
function runtimeToolResultSummary(content) {
    const clean = redactTuiText(content).replace(/\s+/g, " ").trim();
    if (!clean)
        return "completed";
    if (/ENOENT|no such file or directory/i.test(clean))
        return "file not found";
    if (/blocked by repeated tool denial/i.test(clean))
        return "tool blocked after repeated denial";
    return (0, text_1.truncateToVisibleWidth)(clean, 96);
}
function renderRuntimeTranscript(session) {
    const events = session.events.snapshot().filter((event) => event.kind !== "session_configured");
    const lines = [];
    const calls = new Map();
    let assistantText = "";
    for (const event of events) {
        const payload = event.payload;
        if (event.kind === "assistant_message_delta") {
            const content = typeof payload?.content === "string" ? payload.content : "";
            if (content)
                assistantText = content;
            continue;
        }
        if (event.kind === "assistant_message") {
            const content = typeof payload?.content === "string" ? payload.content : "";
            if (content)
                assistantText = content;
            continue;
        }
        if (event.kind === "tool_call_requested" && payload) {
            const callId = typeof payload.id === "string" ? payload.id : String(event.id);
            const name = typeof payload.name === "string" ? payload.name : "tool";
            const title = runtimeToolTitle(name, runtimeArgs(payload));
            const lineIndex = lines.length;
            calls.set(callId, { name, title, lineIndex });
            lines.push(`⏳ ${title}`);
            continue;
        }
        if ((event.kind === "tool_call_completed" || event.kind === "permission_denied") && payload) {
            const callId = typeof payload.callId === "string" ? payload.callId : "";
            const call = calls.get(callId);
            const name = typeof payload.name === "string" ? payload.name : call?.name ?? "tool";
            const title = call?.title ?? runtimeToolTitle(name, {});
            const content = typeof payload.content === "string" ? payload.content : "";
            const marker = event.kind === "permission_denied" ? "✗" : "✓";
            const prefix = event.kind === "permission_denied" ? "Blocked" : "Finished";
            const line = `${marker} ${prefix} ${title}`;
            if (call)
                lines[call.lineIndex] = line;
            else
                lines.push(line);
            if (content)
                lines.push(`  ${runtimeToolResultSummary(content)}`);
            continue;
        }
        if (event.kind === "provider_warning") {
            const message = runtimeStringField(payload, "message") ?? "provider warning";
            lines.push(`⚠ Warning: ${(0, text_1.truncateToVisibleWidth)(redactTuiText(message), 120)}`);
            continue;
        }
        if (event.kind === "turn_failed") {
            const message = runtimeStringField(payload, "message") ?? "runtime turn failed";
            lines.push(`✗ ${runtimeFailureSummary(message)}`);
        }
    }
    if (assistantText)
        lines.push(...assistantText.trimEnd().split(/\n/g).map((line, index) => index === 0 ? `• ${line}` : `  ${line}`));
    return lines.join("\n");
}
function renderRuntimeVisibleOutput(session) {
    const projection = renderRuntimeProjection(session);
    const transcript = renderRuntimeTranscript(session);
    return {
        answer: transcript || "• Working",
        projection,
    };
}
