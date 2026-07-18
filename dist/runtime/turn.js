"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runtimeToolSpecs = runtimeToolSpecs;
exports.runCodexLikeTurn = runCodexLikeTurn;
const node_crypto_1 = __importDefault(require("node:crypto"));
const tool_runner_1 = require("./tool-runner");
const DEFAULT_SYSTEM = [
    "You are AxumAgent, a local coding agent.",
    "Use tools through the runtime loop when project inspection, edits, or validation are needed.",
    "Keep plan and execution separate: inspect first, mutate only through gated tools, then verify.",
].join("\n");
function turnId() {
    return `turn-${Date.now().toString(36)}-${node_crypto_1.default.randomBytes(3).toString("hex")}`;
}
function parseToolArguments(raw) {
    if (!raw)
        return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
function runtimeToolSpecs(allowedTools) {
    const specs = {
        read: {
            type: "function",
            function: {
                name: "read",
                description: "Read a project file within the current workspace sandbox.",
                parameters: { type: "object", properties: { file: { type: "string" }, description: { type: "string" }, intent: { type: "string" } }, required: ["file"] },
            },
        },
        lsp_symbols: {
            type: "function",
            function: {
                name: "lsp_symbols",
                description: "List TypeScript symbols by optional query before editing.",
                parameters: { type: "object", properties: { query: { type: "string" }, files: { type: "array", items: { type: "string" } }, description: { type: "string" }, intent: { type: "string" } } },
            },
        },
        precise_edit: {
            type: "function",
            function: {
                name: "precise_edit",
                description: "Replace one unique text range in a project file, optionally guarded by an expected sha256 hash.",
                parameters: {
                    type: "object",
                    properties: { file: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" }, expectedHash: { type: "string" }, description: { type: "string" }, intent: { type: "string" } },
                    required: ["file", "oldText", "newText"],
                },
            },
        },
        safe_exec: {
            type: "function",
            function: {
                name: "safe_exec",
                description: "Run an allowlisted project command with timeout inside the workspace. Common read-only inspection commands include pwd, ls, find, grep, cat, sed, head, tail, wc, and read-only git subcommands.",
                parameters: { type: "object", properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } }, description: { type: "string" }, intent: { type: "string" } }, required: ["command"] },
            },
        },
    };
    return allowedTools.map((tool) => specs[tool]).filter((tool) => Boolean(tool));
}
function normalizeToolCalls(toolCalls) {
    return toolCalls.map((call, index) => ({
        id: call.id || `call-${index + 1}`,
        name: call.function?.name || "",
        arguments: parseToolArguments(call.function?.arguments),
    })).filter((call) => call.name.length > 0);
}
async function runCodexLikeTurn(options, userPrompt, signal) {
    const id = turnId();
    const runner = options.toolRunner ?? (0, tool_runner_1.createToolRunner)({ config: options.config, mode: options.mode, cwd: options.cwd });
    const maxToolIterations = options.maxToolIterations ?? 8;
    const messages = [
        { role: "system", content: options.systemPrompt ?? DEFAULT_SYSTEM },
        { role: "user", content: userPrompt },
    ];
    const toolOutputs = [];
    const tools = runtimeToolSpecs(runner.mode.tools);
    const deniedCounts = new Map();
    options.eventBus.emit("turn_started", { prompt: userPrompt, mode: runner.mode.id }, id);
    options.eventBus.emit("context_captured", { cwd: runner.gate.cwd, allowedTools: runner.mode.tools }, id);
    let assistantMessage = "";
    for (let iteration = 0; iteration <= maxToolIterations; iteration += 1) {
        options.eventBus.emit("model_sampling_started", { iteration, tools: tools.map((tool) => tool.function.name) }, id);
        const response = await options.provider.chatWithTools(messages, tools, signal);
        for (const warning of response.warnings ?? []) {
            options.eventBus.emit("provider_warning", { message: warning }, id);
        }
        assistantMessage = response.content || assistantMessage;
        const calls = normalizeToolCalls(response.toolCalls ?? []);
        if (calls.length === 0) {
            if (assistantMessage)
                options.eventBus.emit("assistant_message", { content: assistantMessage }, id);
            options.eventBus.emit("turn_completed", { iterations: iteration, toolOutputs: toolOutputs.length }, id);
            return { turnId: id, assistantMessage, toolOutputs, events: options.eventBus.snapshot().filter((event) => event.turnId === id) };
        }
        messages.push({ role: "assistant", content: response.content || "", tool_calls: response.toolCalls });
        for (const call of calls) {
            options.eventBus.emit("tool_call_requested", { id: call.id, name: call.name, arguments: call.arguments }, id);
            const output = await runner.run(call);
            toolOutputs.push(output);
            options.eventBus.emit(output.ok ? "tool_call_completed" : "permission_denied", output, id);
            messages.push({ role: "tool", tool_call_id: call.id, content: output.content });
            if (!output.ok) {
                const signature = `${output.name}:${output.content}`;
                const count = (deniedCounts.get(signature) ?? 0) + 1;
                deniedCounts.set(signature, count);
                if (count >= 2) {
                    const message = `blocked by repeated tool denial: ${output.name}: ${output.content}`;
                    options.eventBus.emit("turn_failed", { message }, id);
                    throw new Error(message);
                }
            }
        }
    }
    const message = `turn exceeded max tool iterations (${maxToolIterations})`;
    options.eventBus.emit("turn_failed", { message }, id);
    throw new Error(message);
}
