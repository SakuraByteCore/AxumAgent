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
        intent: "wait for the user to provide a task",
        next: "send a prompt to start runtime work",
        plan: [],
        issues: [],
        latestEvidence: "none yet",
        latestMeaning: "no runtime evidence yet",
        commandsRun: 0,
        commandsFailed: 0,
        filesRead: new Set(),
        filesChanged: new Set(),
        calls: new Map(),
    };
    for (const event of events)
        updateDashboardState(state, event);
    return [
        "◇ plan",
        ...(state.plan.length > 0 ? lastLines(state.plan, 6).map(renderActivityLine) : ["  · no activity yet"]),
        "◇ now",
        `  goal: ${clipDetail(state.goal, 96)}`,
        `  phase: ${state.phase}`,
        `  intent: ${clipDetail(state.intent, 104)}`,
        `  action: ${clipDetail(state.now, 104)}`,
        "◇ evidence",
        `  ${clipDetail(state.latestEvidence, 112)}`,
        "◇ result",
        `  ${clipDetail(state.latestMeaning, 112)}`,
        `  commands: ${state.commandsRun} run · ${state.commandsFailed} failed`,
        `  files: ${state.filesRead.size} read · ${state.filesChanged.size} changed`,
        "◇ next",
        `  ${clipDetail(state.next, 112)}`,
        "◇ issues",
        ...(state.issues.length > 0 ? lastLines(state.issues, 4).map((line) => `  ${line}`) : ["  none"]),
    ].join("\n");
}
function updateDashboardState(state, event) {
    const payload = event.payload;
    if (event.kind === "turn_started") {
        state.goal = getPrompt(payload) ?? "runtime turn";
        state.phase = "Planning";
        state.now = "understand the request and choose a safe execution path";
        state.intent = "Understand the user request before acting.";
        state.next = "capture workspace context before using tools";
        state.latestMeaning = "The runtime has a user request and is preparing an execution path.";
        pushActivity(state, {
            intent: "Understand the user request before acting.",
            phase: "Planning",
            action: "Start runtime turn",
            target: state.goal,
            status: "running",
            evidence: "turn started",
            meaning: "The agent has accepted the task and is preparing safe next steps.",
            next: "Capture workspace context.",
        });
        return;
    }
    if (event.kind === "context_captured") {
        state.phase = "Reading";
        state.now = "capture workspace context and allowed tools";
        state.intent = "Confirm the execution boundary before taking action.";
        state.next = "decide whether to answer or use a tool";
        state.latestEvidence = contextEvidence(payload);
        state.latestMeaning = "The runtime knows the workspace and tool boundary for this turn.";
        completeLatestActivity(state, "succeeded", state.latestEvidence, state.latestMeaning, state.next);
        pushActivity(state, {
            intent: "Confirm the execution boundary before taking action.",
            phase: "Reading",
            action: "Capture runtime context",
            target: stringField(payload ?? {}, "cwd") ?? "workspace",
            status: "succeeded",
            evidence: state.latestEvidence,
            meaning: state.latestMeaning,
            next: "Ask the model for the next concrete step.",
        });
        return;
    }
    if (event.kind === "model_sampling_started") {
        const iteration = typeof payload?.iteration === "number" ? payload.iteration : undefined;
        state.phase = "Thinking";
        state.now = iteration === 0 ? "plan the first visible step" : "decide the next step from tool evidence";
        state.intent = iteration === 0 ? "Choose a useful first step instead of dumping raw events." : "Use existing evidence to choose the next concrete step.";
        state.next = "use a tool with evidence or answer directly";
        state.latestMeaning = iteration === 0
            ? "The model is choosing an initial plan, not executing blindly."
            : "The model is interpreting previous evidence before continuing.";
        return;
    }
    if (event.kind === "assistant_message") {
        state.phase = "Answering";
        state.now = "prepare the assistant response";
        state.intent = "Return the user-facing result after completing runtime work.";
        state.next = "finish the turn unless another step is needed";
        state.latestEvidence = "assistant response ready";
        state.latestMeaning = "The runtime has enough evidence to answer the user.";
        pushActivity(state, {
            intent: "Return the user-facing result after completing runtime work.",
            phase: "Answering",
            action: "Prepare response",
            target: "assistant message",
            status: "succeeded",
            evidence: state.latestEvidence,
            meaning: state.latestMeaning,
            next: state.next,
        });
        return;
    }
    if (event.kind === "tool_call_requested" && payload) {
        const callId = typeof payload.id === "string" ? payload.id : String(event.id);
        const name = typeof payload.name === "string" ? payload.name : "tool";
        const args = isRecord(payload.arguments) ? payload.arguments : {};
        const summary = summarizeToolAction(name, args);
        const intent = intentForTool(name, args, summary);
        const target = targetForTool(name, args);
        state.calls.set(callId, { name, arguments: args, summary, intent, target });
        state.phase = phaseForTool(name);
        state.now = summary;
        state.intent = intent;
        state.next = "wait for tool evidence";
        state.latestEvidence = evidenceForToolRequest(name, args, summary);
        state.latestMeaning = meaningForToolRequest(name, args);
        pushActivity(state, {
            intent,
            phase: state.phase,
            action: summary,
            target,
            status: "running",
            evidence: state.latestEvidence,
            meaning: state.latestMeaning,
            next: "Interpret the tool result before continuing.",
        });
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
            state.intent = call?.intent ?? "Explain the blocked action instead of hiding it in raw logs.";
            state.next = "adjust the request or grant a safer allowed path";
            state.latestEvidence = `blocked: ${clipDetail(content, 112)}`;
            state.latestMeaning = "The runtime refused this action before it could affect the workspace.";
            state.issues.push(`${summary}: ${clipDetail(content, 140)}`);
            finishActivity(state, summary, "blocked", state.latestEvidence, state.latestMeaning, state.next);
            if (name === "safe_exec")
                state.commandsFailed += 1;
            return;
        }
        state.phase = "Running";
        state.now = `${summary} finished`;
        state.intent = call?.intent ?? "Use the completed tool result as evidence.";
        state.next = "decide the next task step";
        state.latestEvidence = resultEvidence(name, call?.arguments ?? {}, content);
        state.latestMeaning = resultMeaning(name, call?.arguments ?? {}, content);
        finishActivity(state, summary, "succeeded", state.latestEvidence, state.latestMeaning, state.next);
        return;
    }
    if (event.kind === "provider_warning" && payload) {
        const message = typeof payload.message === "string" ? payload.message : "provider warning";
        state.phase = "Provider";
        state.now = clipDetail(message, 96);
        state.intent = "Keep the user aware of provider behavior that may affect the answer.";
        state.next = "retry, fall back, or show the provider error";
        state.issues.push(`provider: ${clipDetail(message, 140)}`);
        state.latestEvidence = `provider warning: ${clipDetail(message, 96)}`;
        state.latestMeaning = "The provider path changed or degraded; the runtime recorded it for the user.";
        pushActivity(state, {
            intent: "Keep the user aware of provider behavior that may affect the answer.",
            phase: "Provider",
            action: "Record provider warning",
            target: "provider",
            status: "blocked",
            evidence: state.latestEvidence,
            meaning: state.latestMeaning,
            next: state.next,
        });
        return;
    }
    if (event.kind === "turn_completed") {
        state.phase = "Done";
        state.now = "task completed";
        state.intent = "Close the loop after the runtime finishes.";
        state.next = "ready for the next prompt";
        state.latestEvidence = "turn completed";
        state.latestMeaning = "The runtime finished the requested turn.";
        completeLatestActivity(state, "succeeded", state.latestEvidence, state.latestMeaning, state.next);
        return;
    }
    if (event.kind === "turn_failed") {
        const message = typeof payload?.message === "string" ? payload.message : "turn failed";
        state.phase = "Blocked";
        state.now = `failed: ${clipDetail(message, 96)}`;
        state.intent = "Explain the blocker before any retry.";
        state.next = "fix the blocker before retrying";
        state.latestEvidence = clipDetail(message, 112);
        state.latestMeaning = "The runtime could not safely finish this turn.";
        state.issues.push(clipDetail(message, 140));
        finishActivity(state, state.plan[state.plan.length - 1]?.action ?? "runtime turn", "failed", state.latestEvidence, state.latestMeaning, state.next);
    }
}
function renderActivityLine(activity) {
    const mark = {
        pending: "○",
        running: "▶",
        succeeded: "✓",
        failed: "✗",
        blocked: "!",
    };
    const target = activity.target && activity.target !== "<missing>" ? ` · ${clipDetail(activity.target, 42)}` : "";
    return `  ${mark[activity.status]} ${activity.phase}: ${clipDetail(activity.action, 72)}${target}`;
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
    if (name === "lsp_symbols")
        return "Inspecting";
    return "Working";
}
function summarizeToolAction(name, args) {
    const description = stringField(args, "description");
    if (description)
        return clipDetail(description, 96);
    if (name === "safe_exec")
        return summarizeCommandAction(renderCommand(args));
    if (name === "read")
        return `Read ${fileForArgs(args)}`;
    if (name === "precise_edit")
        return `Edit ${fileForArgs(args)}`;
    if (name === "lsp_symbols")
        return `Inspect TypeScript symbols${stringField(args, "query") ? ` for ${stringField(args, "query")}` : ""}`;
    return name.replace(/_/g, " ");
}
function summarizeCommandAction(command) {
    const [program, ...rest] = command.split(/\s+/g).filter(Boolean);
    const compactCommand = clipDetail(command, 72);
    if (!program)
        return "Run command";
    if (program === "ls")
        return `Inspect ${firstPathLabel(rest) ?? "directory"}`;
    if (program === "find")
        return `Scan ${firstPathLabel(rest) ?? "workspace"}`;
    if (program === "grep")
        return `Search ${firstPathLabel(rest.slice(1)) ?? "workspace"}`;
    if (program === "cat" || program === "head" || program === "tail" || program === "sed")
        return `Inspect ${firstPathLabel(rest) ?? "file"}`;
    if (program === "wc")
        return `Count ${firstPathLabel(rest) ?? "workspace"}`;
    if (program === "npm")
        return rest.length > 0 ? `Run npm ${rest.join(" ")}` : "Run npm";
    if (program === "git")
        return rest.length > 0 ? `Check git ${rest[0]}` : "Check git";
    return `Run ${compactCommand}`;
}
function targetForTool(name, args) {
    if (name === "safe_exec")
        return renderCommand(args);
    if (name === "read" || name === "precise_edit")
        return fileForArgs(args);
    if (name === "lsp_symbols")
        return stringField(args, "query") ?? "TypeScript symbols";
    return name;
}
function intentForTool(name, args, summary) {
    const intent = stringField(args, "intent") ?? stringField(args, "reason");
    if (intent)
        return clipDetail(intent, 120);
    if (name === "read")
        return "Gather source evidence before deciding on a change.";
    if (name === "precise_edit")
        return "Apply a bounded edit after locating the exact target.";
    if (name === "lsp_symbols")
        return "Map code structure before editing or explaining behavior.";
    if (name === "safe_exec")
        return intentForCommand(renderCommand(args));
    return `Use ${summary} to move the task forward.`;
}
function intentForCommand(command) {
    const [program, ...rest] = command.split(/\s+/g).filter(Boolean);
    if (program === "npm" && rest.join(" ") === "test")
        return "Validate the implementation with the full test suite.";
    if (program === "npm" && rest.join(" ") === "run pack:dry")
        return "Verify the package can be built and packed without publishing.";
    if (program === "git" && rest[0] === "status")
        return "Confirm workspace cleanliness before reporting or committing.";
    if (program === "git" && rest[0] === "diff")
        return "Review the exact local changes before validation or commit.";
    if (program === "grep")
        return "Find the relevant implementation or regression surface.";
    if (["cat", "sed", "head", "tail"].includes(program ?? ""))
        return "Inspect concrete source context before acting.";
    return "Use an allowlisted command to collect evidence or validate work.";
}
function meaningForToolRequest(name, args) {
    if (name === "safe_exec")
        return "The runtime is collecting command evidence, not just printing a raw command.";
    if (name === "read")
        return "The runtime is inspecting source context before deciding.";
    if (name === "precise_edit")
        return "The runtime is about to mutate a specific file through a gated edit.";
    if (name === "lsp_symbols")
        return "The runtime is mapping code structure before making claims.";
    return "The runtime requested a tool step and will interpret the result.";
}
function resultMeaning(name, args, content) {
    if (name === "safe_exec")
        return commandResultMeaning(renderCommand(args), content);
    if (name === "read")
        return "The requested file content is now available as evidence for the next step.";
    if (name === "precise_edit")
        return "The requested file change was applied through the runtime gate.";
    if (name === "lsp_symbols")
        return "The symbol lookup result can guide the next code-level decision.";
    return "The tool step completed and produced evidence for the next decision.";
}
function commandResultMeaning(command, content) {
    const [program, ...rest] = command.split(/\s+/g).filter(Boolean);
    const parsed = parseJsonObject(content);
    const stdout = typeof parsed?.stdout === "string" ? parsed.stdout : "";
    const stderr = typeof parsed?.stderr === "string" ? parsed.stderr : "";
    const output = `${stdout}\n${stderr}`;
    if (program === "npm" && rest.join(" ") === "test")
        return "Tests passed, covering build, syntax checks, CLI regressions, and TUI snapshots.";
    if (program === "npm" && rest.join(" ") === "run pack:dry")
        return "Package dry-run passed, so the distributable contents still build.";
    if (program === "git" && rest[0] === "status")
        return output.trim() ? "Git status found local changes that still need review." : "Git status is clean.";
    if (program === "git" && rest[0] === "diff")
        return output.trim() ? "The diff shows the exact files and lines changed." : "There is no local diff.";
    return output.trim() ? "The command completed and produced output to interpret." : "The command completed without extra output.";
}
function contextEvidence(payload) {
    if (!payload)
        return "workspace context captured";
    const cwd = stringField(payload, "cwd") ?? "workspace";
    const tools = Array.isArray(payload.allowedTools) ? payload.allowedTools.filter((tool) => typeof tool === "string") : [];
    return tools.length > 0 ? `${cwd}; tools: ${tools.join(", ")}` : cwd;
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
    if (name === "read" || name === "precise_edit" || name === "lsp_symbols")
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
function pushActivity(state, activity) {
    const previous = state.plan[state.plan.length - 1];
    if (previous && previous.action === activity.action && previous.status === activity.status && previous.target === activity.target)
        return;
    state.plan.push(activity);
}
function finishActivity(state, action, status, evidence, meaning, next) {
    const index = findLastIndex(state.plan, (activity) => activity.action === action && activity.status === "running");
    if (index >= 0) {
        state.plan[index] = { ...state.plan[index], status, evidence, meaning, next };
        return;
    }
    completeLatestActivity(state, status, evidence, meaning, next);
}
function completeLatestActivity(state, status, evidence, meaning, next) {
    const latest = state.plan[state.plan.length - 1];
    if (!latest || latest.status !== "running")
        return;
    state.plan[state.plan.length - 1] = { ...latest, status, evidence, meaning, next };
}
function findLastIndex(items, predicate) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
        if (predicate(items[index]))
            return index;
    }
    return -1;
}
function lastLines(lines, max) {
    return lines.slice(-max);
}
