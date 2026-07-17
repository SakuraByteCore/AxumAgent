"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createToolRunner = createToolRunner;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const kilo_shell_1 = require("../shell/kilo-shell");
const tools_1 = require("./tools");
function stringArg(args, key) {
    const value = args[key];
    return typeof value === "string" ? value : undefined;
}
function stringArrayArg(args, key) {
    const value = args[key];
    if (!Array.isArray(value))
        return undefined;
    return value.filter((item) => typeof item === "string");
}
function jsonContent(value) {
    return JSON.stringify(value, null, 2);
}
function createToolRunner(options = {}) {
    const mode = (0, kilo_shell_1.findMode)(options.config, options.mode);
    const cwd = node_path_1.default.resolve(options.cwd ?? process.cwd());
    const gate = {
        allowedTools: mode.tools,
        cwd,
        allowedCommands: options.allowedCommands,
        timeoutMs: options.timeoutMs,
    };
    return {
        mode,
        gate,
        async run(call) {
            try {
                if (call.name === "read") {
                    if (!mode.tools.includes("read"))
                        throw new Error("tool not allowed by workflow gate: read");
                    const file = stringArg(call.arguments, "file") ?? stringArg(call.arguments, "path");
                    if (!file)
                        throw new Error("read requires file");
                    const root = node_path_1.default.resolve(cwd);
                    const absolute = node_path_1.default.resolve(root, file);
                    if (absolute !== root && !absolute.startsWith(`${root}${node_path_1.default.sep}`))
                        throw new Error(`path escapes project sandbox: ${file}`);
                    const content = node_fs_1.default.readFileSync(absolute, "utf8");
                    return { callId: call.id, name: call.name, ok: true, content };
                }
                if (call.name === "precise_edit") {
                    const result = (0, tools_1.runPreciseEdit)(gate, {
                        file: stringArg(call.arguments, "file") ?? "",
                        oldText: stringArg(call.arguments, "oldText") ?? stringArg(call.arguments, "old_text") ?? "",
                        newText: stringArg(call.arguments, "newText") ?? stringArg(call.arguments, "new_text") ?? "",
                        expectedHash: stringArg(call.arguments, "expectedHash") ?? stringArg(call.arguments, "expected_hash"),
                    });
                    return { callId: call.id, name: call.name, ok: true, content: jsonContent(result.result) };
                }
                if (call.name === "safe_exec") {
                    const result = await (0, tools_1.runSafeExec)(gate, {
                        command: stringArg(call.arguments, "command") ?? "",
                        args: stringArrayArg(call.arguments, "args"),
                    });
                    return { callId: call.id, name: call.name, ok: true, content: jsonContent(result.result) };
                }
                if (call.name === "lsp_symbols") {
                    const result = (0, tools_1.runLspSymbols)(gate, {
                        query: stringArg(call.arguments, "query"),
                        files: stringArrayArg(call.arguments, "files"),
                    });
                    return { callId: call.id, name: call.name, ok: true, content: jsonContent(result.result) };
                }
                throw new Error(`unknown runtime tool: ${call.name}`);
            }
            catch (error) {
                return { callId: call.id, name: call.name, ok: false, content: error instanceof Error ? error.message : String(error) };
            }
        },
    };
}
