"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveProjectStateDir = resolveProjectStateDir;
exports.buildWorkflowPlan = buildWorkflowPlan;
exports.persistWorkflowPlan = persistWorkflowPlan;
exports.renderWorkflowPlan = renderWorkflowPlan;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const kilo_shell_1 = require("../shell/kilo-shell");
function resolveProjectStateDir(cwd = process.cwd()) {
    return node_path_1.default.join(cwd, ".axum", "state");
}
function event(id, phase, message) {
    return { id, phase, message, createdAt: new Date().toISOString() };
}
function buildWorkflowPlan(config, prompt, options = {}) {
    const mode = (0, kilo_shell_1.findMode)(config, options.mode);
    const trimmed = prompt.trim();
    if (!trimmed)
        throw new Error("workflow prompt is required");
    const stateDir = resolveProjectStateDir(options.cwd);
    return {
        mode,
        prompt: trimmed,
        stateDir,
        events: [
            event(1, "received", `accept user request in ${mode.id} shell mode`),
            event(2, "planned", "translate shell input into pi-style workflow events"),
            event(3, "permission-gated", `allow tools: ${mode.tools.length ? mode.tools.join(", ") : "none"}`),
            event(4, "ready", `checkpoint target: ${stateDir}`),
        ],
    };
}
function persistWorkflowPlan(plan) {
    node_fs_1.default.mkdirSync(plan.stateDir, { recursive: true });
    const file = node_path_1.default.join(plan.stateDir, `${Date.now()}-${plan.mode.id}.json`);
    node_fs_1.default.writeFileSync(file, JSON.stringify(plan, null, 2) + "\n", "utf8");
    return file;
}
function renderWorkflowPlan(plan, checkpointPath) {
    const lines = [
        `Axum workflow (${plan.mode.id})`,
        `shell: Kilo-style mode/prompt UX`,
        `runtime: pi-style event/checkpoint/tool-gate`,
        `state: ${plan.stateDir}`,
        `prompt: ${plan.prompt}`,
        "events:",
    ];
    for (const item of plan.events)
        lines.push(`  ${item.id}. ${item.phase}: ${item.message}`);
    if (checkpointPath)
        lines.push(`checkpoint: ${checkpointPath}`);
    return lines.join("\n");
}
