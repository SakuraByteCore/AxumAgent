"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPreciseEdit = runPreciseEdit;
exports.runSafeExec = runSafeExec;
exports.runLspSymbols = runLspSymbols;
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_child_process_1 = require("node:child_process");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_util_1 = require("node:util");
const pi_workflow_1 = require("./pi-workflow");
const kilo_shell_1 = require("../shell/kilo-shell");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
function sha256(text) {
    return node_crypto_1.default.createHash("sha256").update(text).digest("hex");
}
function assertToolAllowed(gate, tool) {
    const spec = (0, kilo_shell_1.resolveToolSpecs)(gate.allowedTools).find((item) => item.id === tool);
    if (!spec)
        throw new Error(`tool not allowed by workflow gate: ${tool}`);
    return spec;
}
function resolveProjectFile(cwd, file) {
    const root = node_path_1.default.resolve(cwd);
    const absolute = node_path_1.default.resolve(root, file);
    if (absolute !== root && !absolute.startsWith(`${root}${node_path_1.default.sep}`)) {
        throw new Error(`path escapes project sandbox: ${file}`);
    }
    return absolute;
}
function runPreciseEdit(gate, request) {
    assertToolAllowed(gate, "precise_edit");
    const absolute = resolveProjectFile(gate.cwd, request.file);
    const before = node_fs_1.default.readFileSync(absolute, "utf8");
    const beforeHash = sha256(before);
    if (request.expectedHash && request.expectedHash !== beforeHash) {
        throw new Error(`hash anchor mismatch for ${request.file}`);
    }
    const first = before.indexOf(request.oldText);
    if (first < 0)
        throw new Error(`oldText not found in ${request.file}`);
    if (before.indexOf(request.oldText, first + request.oldText.length) >= 0) {
        throw new Error(`oldText is not unique in ${request.file}`);
    }
    const after = `${before.slice(0, first)}${request.newText}${before.slice(first + request.oldText.length)}`;
    node_fs_1.default.writeFileSync(absolute, after, "utf8");
    const afterHash = sha256(after);
    return {
        tool: "precise_edit",
        ok: true,
        result: { file: request.file, beforeHash, afterHash },
        anchors: [(0, pi_workflow_1.createHashAnchor)(request.file, after)],
    };
}
async function runSafeExec(gate, request) {
    assertToolAllowed(gate, "safe_exec");
    const parsed = normalizeSafeExecRequest(request);
    const allowed = gate.allowedCommands ?? ["npm", "node", "npx", "git", "pwd", "ls", "find"];
    if (!allowed.includes(parsed.command))
        throw new Error(`command not allowed by safe_exec sandbox: ${parsed.command}`);
    validateSafeExecArgs(parsed.command, parsed.args);
    const { stdout, stderr } = await execFileAsync(parsed.command, parsed.args, {
        cwd: node_path_1.default.resolve(gate.cwd),
        timeout: gate.timeoutMs ?? 120_000,
        maxBuffer: 1024 * 1024 * 4,
        windowsHide: true,
    });
    return {
        tool: "safe_exec",
        ok: true,
        result: { stdout, stderr },
        anchors: [(0, pi_workflow_1.createHashAnchor)(`safe_exec:${parsed.command}`, `${parsed.command} ${parsed.args.join(" ")}\n${stdout}\n${stderr}`)],
    };
}
function normalizeSafeExecRequest(request) {
    const command = request.command.trim();
    if (request.args && request.args.length > 0)
        return { command, args: request.args };
    const parts = splitCommandLine(command);
    return { command: parts[0] ?? command, args: parts.slice(1) };
}
function validateSafeExecArgs(command, args) {
    if (command === "find") {
        const denied = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir"]);
        for (const arg of args) {
            if (denied.has(arg))
                throw new Error(`find action not allowed by safe_exec sandbox: ${arg}`);
            if (arg.startsWith("/") || arg === ".." || arg.startsWith("../") || arg.includes("/../")) {
                throw new Error(`find path escapes project sandbox: ${arg}`);
            }
        }
    }
    if (command === "ls") {
        for (const arg of args) {
            if (arg.startsWith("/") || arg === ".." || arg.startsWith("../") || arg.includes("/../")) {
                throw new Error(`ls path escapes project sandbox: ${arg}`);
            }
        }
    }
}
function splitCommandLine(command) {
    const parts = [];
    let current = "";
    let quote;
    for (let i = 0; i < command.length; i += 1) {
        const char = command[i];
        if (quote) {
            if (char === quote)
                quote = undefined;
            else
                current += char;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (/\s/.test(char)) {
            if (current) {
                parts.push(current);
                current = "";
            }
            continue;
        }
        current += char;
    }
    if (current)
        parts.push(current);
    return parts;
}
function runLspSymbols(gate, request = {}) {
    assertToolAllowed(gate, "lsp_symbols");
    const root = node_path_1.default.resolve(gate.cwd);
    const files = (request.files && request.files.length > 0 ? request.files : collectTypeScriptFiles(root)).map((file) => resolveProjectFile(root, file));
    const query = request.query?.toLowerCase();
    const matches = [];
    for (const absolute of files) {
        if (!node_fs_1.default.existsSync(absolute) || !node_fs_1.default.statSync(absolute).isFile())
            continue;
        const relative = node_path_1.default.relative(root, absolute);
        const lines = node_fs_1.default.readFileSync(absolute, "utf8").split(/\r?\n/g);
        lines.forEach((line, index) => {
            const match = line.match(/^\s*(?:export\s+)?(?:async\s+)?(function|class|interface|type|const)\s+([A-Za-z_$][\w$]*)/)
                ?? line.match(/^\s*export\s+\{\s*([A-Za-z_$][\w$]*)/);
            if (!match)
                return;
            const kind = (match[1] === undefined ? "export" : match[1]);
            const name = match[2] ?? match[1];
            if (query && !name.toLowerCase().includes(query))
                return;
            matches.push({ file: relative, line: index + 1, kind, name });
        });
    }
    return {
        tool: "lsp_symbols",
        ok: true,
        result: { matches },
        anchors: [(0, pi_workflow_1.createHashAnchor)("lsp_symbols", JSON.stringify(matches))],
    };
}
function collectTypeScriptFiles(root) {
    const found = [];
    const walk = (dir) => {
        for (const entry of node_fs_1.default.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist")
                continue;
            const absolute = node_path_1.default.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(absolute);
            }
            else if (entry.isFile() && entry.name.endsWith(".ts")) {
                found.push(node_path_1.default.relative(root, absolute));
            }
        }
    };
    walk(root);
    return found.sort();
}
