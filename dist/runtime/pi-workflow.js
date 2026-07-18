"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveProjectStateDir = resolveProjectStateDir;
exports.createHashAnchor = createHashAnchor;
exports.buildWorkflowPlan = buildWorkflowPlan;
exports.buildSwarmPlan = buildSwarmPlan;
exports.transitionChildTask = transitionChildTask;
exports.persistWorkflowPlan = persistWorkflowPlan;
exports.persistSwarmPlan = persistSwarmPlan;
exports.renderWorkflowPlan = renderWorkflowPlan;
exports.renderSwarmPlan = renderSwarmPlan;
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const kilo_shell_1 = require("../shell/kilo-shell");
function resolveProjectStateDir(cwd = process.cwd()) {
    return node_path_1.default.join(cwd, ".axum", "state");
}
function hashText(text) {
    return node_crypto_1.default.createHash("sha256").update(text).digest("hex");
}
function createHashAnchor(target, content) {
    return {
        id: hashText(`${target}\0${content}`).slice(0, 12),
        target,
        hash: hashText(content),
        algorithm: "sha256",
        createdAt: new Date().toISOString(),
    };
}
function event(id, phase, stage, message, anchor) {
    return { id, phase, stage, message, createdAt: new Date().toISOString(), ...(anchor ? { anchor } : {}) };
}
function planSteps(prompt) {
    return [
        { id: "plan.scope", stage: "plan", goal: `derive execution plan for: ${prompt}`, status: "ready" },
        { id: "plan.gates", stage: "plan", goal: "resolve permission gates and tool budget before writes", status: "ready" },
        { id: "execute.apply", stage: "execute", goal: "apply the smallest verified code changes", status: "pending" },
        { id: "execute.verify", stage: "execute", goal: "run regression checks and re-anchor changed state", status: "pending" },
    ];
}
function buildWorkflowPlan(config, prompt, options = {}) {
    const mode = (0, kilo_shell_1.findMode)(config, options.mode);
    const trimmed = prompt.trim();
    if (!trimmed)
        throw new Error("workflow prompt is required");
    const stateDir = resolveProjectStateDir(options.cwd);
    const requestAnchor = createHashAnchor("workflow.prompt", trimmed);
    const toolAnchor = createHashAnchor("workflow.tools", mode.tools.join("\n"));
    return {
        mode,
        prompt: trimmed,
        stateDir,
        stages: planSteps(trimmed),
        anchors: [requestAnchor, toolAnchor],
        autoFix: {
            enabled: true,
            maxAttempts: 3,
            anchor: requestAnchor,
            correction: "replan",
        },
        events: [
            event(1, "received", "plan", `capture request in ${mode.id} shell mode`, requestAnchor),
            event(2, "plan", "plan", "build Codex-style plan stage with explicit gates", requestAnchor),
            event(3, "permission-gated", "plan", `allow tools: ${mode.tools.length ? mode.tools.join(", ") : "none"}`, toolAnchor),
            event(4, "execute", "execute", "enter execute stage after plan gates pass", toolAnchor),
            event(5, "auto-fix", "execute", "if hash anchor drifts, replan and retry bounded corrections", requestAnchor),
            event(6, "ready", "execute", `checkpoint target: ${stateDir}`),
        ],
    };
}
function buildSwarmPlan(prompt, tasks, options = {}) {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt)
        throw new Error("parallel prompt is required");
    const normalizedTasks = tasks.map((task) => task.trim()).filter(Boolean);
    if (normalizedTasks.length === 0)
        throw new Error("parallel requires at least one --task");
    const createdAt = new Date().toISOString();
    const plannedTasks = normalizedTasks.map((task, index) => ({
        id: `agent-${index + 1}`,
        prompt: task,
        mode: options.mode || "build",
        status: "planned",
        createdAt,
    }));
    return {
        prompt: trimmedPrompt,
        stateDir: resolveProjectStateDir(options.cwd),
        coordinator: "main-agent",
        tasks: plannedTasks,
        mergePolicy: "hash-anchor-review",
        mergeReview: {
            status: "pending",
            policy: "hash-anchor-review",
            taskIds: plannedTasks.map((task) => task.id),
        },
        createdAt,
    };
}
function transitionChildTask(task, status, details = {}) {
    const at = details.at ?? new Date().toISOString();
    return {
        ...task,
        status,
        ...(status === "running" && !task.startedAt ? { startedAt: at } : {}),
        ...(["succeeded", "failed", "cancelled"].includes(status) ? { completedAt: at } : {}),
        ...(details.summary ? { summary: details.summary } : {}),
        ...(details.error ? { error: details.error } : {}),
    };
}
function persistWorkflowPlan(plan) {
    node_fs_1.default.mkdirSync(plan.stateDir, { recursive: true });
    const file = node_path_1.default.join(plan.stateDir, `${Date.now()}-${plan.mode.id}.json`);
    node_fs_1.default.writeFileSync(file, JSON.stringify(plan, null, 2) + "\n", "utf8");
    return file;
}
function persistSwarmPlan(plan) {
    node_fs_1.default.mkdirSync(plan.stateDir, { recursive: true });
    const file = node_path_1.default.join(plan.stateDir, `${Date.now()}-swarm.json`);
    node_fs_1.default.writeFileSync(file, JSON.stringify(plan, null, 2) + "\n", "utf8");
    return file;
}
function renderWorkflowPlan(plan, checkpointPath, options = {}) {
    const lines = [
        "◇ Axum workflow",
        `  ◌ ${plan.mode.id} · ${plan.prompt}`,
        "  ✓ plan · request anchored",
    ];
    const middle = plan.events.slice(1, -1);
    if (options.verbose) {
        lines.push(`  ◌ state ${plan.stateDir}`);
        lines.push(`  ◌ anchor ${plan.anchors[0]?.id} sha256:${plan.anchors[0]?.hash.slice(0, 12)}`);
        for (const item of middle) {
            const message = item.phase === "plan"
                ? "shape plan stage"
                : item.phase === "permission-gated"
                    ? `gate tools ${plan.mode.tools.length ? plan.mode.tools.join(", ") : "none"}`
                    : item.phase === "execute"
                        ? "enter execute stage"
                        : item.phase === "auto-fix"
                            ? `auto-fix loop ${plan.autoFix.maxAttempts}x via hash anchor`
                            : item.message;
            lines.push(`  ├─ ${message}`);
        }
    }
    else if (middle.length > 0) {
        lines.push(`  ⤷ ${middle.length} steps folded (--verbose to expand)`);
    }
    lines.push(`  ✓ execute · ready · ${plan.stateDir}`);
    if (checkpointPath)
        lines.push(`  ◆ checkpoint ${checkpointPath}`);
    return lines.join("\n");
}
function renderSwarmPlan(plan, checkpointPath) {
    const lines = [
        "◇ Axum parallel",
        `  ◌ coordinator ${plan.coordinator} · ${plan.prompt}`,
        `  ✓ ${plan.tasks.length} sub-agents planned`,
    ];
    for (const task of plan.tasks)
        lines.push(`  ├─ ${task.id} [${task.mode}] ${task.prompt}`);
    lines.push(`  ✓ merge policy · ${plan.mergePolicy} · review ${plan.mergeReview.status}`);
    if (checkpointPath)
        lines.push(`  ◆ checkpoint ${checkpointPath}`);
    return lines.join("\n");
}
