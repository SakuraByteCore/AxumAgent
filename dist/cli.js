"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderHelp = renderHelp;
exports.runAxumCli = runAxumCli;
const config_1 = require("./config");
const openai_chat_1 = require("./providers/openai-chat");
const promises_1 = require("node:readline/promises");
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_API_KEY_ENV = "OPENAI_API_KEY";
const DEFAULT_MAX_RETRIES = 10;
const DEFAULT_RETRY_DELAY_MS = 250;
function takeValue(args, index, flag) {
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
        throw new Error(`${flag} requires a value`);
    return value;
}
function parseTemperature(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0 || num > 2) {
        throw new Error("--temperature must be a number between 0 and 2");
    }
    return num;
}
function parseNonNegativeInteger(value, flag) {
    const num = Number(value);
    if (!Number.isInteger(num) || num < 0) {
        throw new Error(`${flag} must be a non-negative integer`);
    }
    return num;
}
function extractConfigPath(args) {
    const next = [];
    let configPath;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === "--config") {
            configPath = takeValue(args, i, arg);
            i += 1;
        }
        else {
            next.push(arg);
        }
    }
    return { configPath, args: next };
}
function parseChatArgs(args, env, loaded, configPath, requirePrompt = true) {
    const config = loaded?.config;
    const provider = (0, config_1.selectedProvider)(config).config;
    const rest = [];
    let model = config?.model || provider?.model || env.AXUM_MODEL || DEFAULT_MODEL;
    let baseUrl = provider?.base_url || provider?.baseUrl || env.AXUM_OPENAI_BASE_URL || env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
    let apiKeyEnv = provider?.api_key_env || provider?.apiKeyEnv || env.AXUM_OPENAI_API_KEY_ENV || DEFAULT_API_KEY_ENV;
    let apiKey = (0, config_1.resolveSecret)(provider?.api_key || provider?.apiKey, env);
    let system;
    let temperature;
    let maxRetries = (0, config_1.numberFromConfig)(provider?.max_retries ?? provider?.maxRetries) ?? (env.AXUM_OPENAI_MAX_RETRIES
        ? parseNonNegativeInteger(env.AXUM_OPENAI_MAX_RETRIES, "AXUM_OPENAI_MAX_RETRIES")
        : DEFAULT_MAX_RETRIES);
    let retryDelayMs = (0, config_1.numberFromConfig)(provider?.retry_delay_ms ?? provider?.retryDelayMs) ?? (env.AXUM_OPENAI_RETRY_DELAY_MS
        ? parseNonNegativeInteger(env.AXUM_OPENAI_RETRY_DELAY_MS, "AXUM_OPENAI_RETRY_DELAY_MS")
        : DEFAULT_RETRY_DELAY_MS);
    let json = false;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === "--model" || arg === "-m") {
            model = takeValue(args, i, arg);
            i += 1;
        }
        else if (arg === "--base-url") {
            baseUrl = takeValue(args, i, arg);
            i += 1;
        }
        else if (arg === "--api-key-env") {
            apiKeyEnv = takeValue(args, i, arg);
            i += 1;
        }
        else if (arg === "--api-key") {
            apiKey = takeValue(args, i, arg);
            i += 1;
        }
        else if (arg === "--system") {
            system = takeValue(args, i, arg);
            i += 1;
        }
        else if (arg === "--temperature") {
            temperature = parseTemperature(takeValue(args, i, arg));
            i += 1;
        }
        else if (arg === "--max-retries") {
            maxRetries = parseNonNegativeInteger(takeValue(args, i, arg), arg);
            i += 1;
        }
        else if (arg === "--retry-delay-ms") {
            retryDelayMs = parseNonNegativeInteger(takeValue(args, i, arg), arg);
            i += 1;
        }
        else if (arg === "--json") {
            json = true;
        }
        else if (arg === "--help" || arg === "-h") {
            throw new HelpRequested();
        }
        else if (arg.startsWith("--")) {
            throw new Error(`unknown chat option: ${arg}`);
        }
        else {
            rest.push(arg);
        }
    }
    const prompt = rest.join(" ").trim();
    if (requirePrompt && !prompt)
        throw new Error("chat prompt is required");
    return {
        prompt,
        model,
        baseUrl,
        apiKeyEnv,
        apiKey: apiKey || env[apiKeyEnv],
        system,
        temperature,
        maxRetries,
        retryDelayMs,
        configPath: loaded?.path || configPath,
        json,
    };
}
class HelpRequested extends Error {
    constructor() {
        super("help requested");
    }
}
function renderHelp() {
    return [
        "AxumAgent CLI",
        "",
        "Usage:",
        "  axum chat [options] <prompt>",
        "  axum tui [options] [prompt]",
        "",
        "Chat options:",
        "      --config <path>      Config file path (default: AXUM_CONFIG or ~/.axum/config.toml)",
        "  -m, --model <id>          Model id (default: AXUM_MODEL or gpt-4o-mini)",
        "      --base-url <url>      OpenAI-compatible base URL (default: AXUM_OPENAI_BASE_URL, OPENAI_BASE_URL, or https://api.openai.com/v1)",
        "      --api-key-env <name>  Environment variable that holds the API key (default: OPENAI_API_KEY)",
        "      --api-key <value>     API key value; prefer env in normal use",
        "      --system <text>       Optional system message",
        "      --temperature <0..2>  Optional temperature",
        "      --max-retries <n>     Retry transient failures (default: AXUM_OPENAI_MAX_RETRIES or 10)",
        "      --retry-delay-ms <n>  Base retry delay in milliseconds (default: AXUM_OPENAI_RETRY_DELAY_MS or 250)",
        "      --json                Print provider result as JSON",
        "      --dry-run             Render the terminal UI without calling a provider (tui only)",
        "      --no-alt-screen       Keep terminal scrollback instead of using the alternate screen (tui only)",
        "  -h, --help               Show this help",
        "",
        "Environment:",
        "  OPENAI_API_KEY, AXUM_MODEL, AXUM_OPENAI_BASE_URL, AXUM_OPENAI_API_KEY_ENV, AXUM_OPENAI_MAX_RETRIES, AXUM_OPENAI_RETRY_DELAY_MS",
        "",
        "Config:",
        `  Default path: ${(0, config_1.defaultConfigPath)()}`,
    ].join("\n");
}
function stripAnsi(text) {
    return text.replace(/\u001b\[[0-9;]*m/g, "");
}
function clip(text, width) {
    const plain = stripAnsi(text);
    if (plain.length <= width)
        return text + " ".repeat(width - plain.length);
    return plain.slice(0, Math.max(0, width - 1)) + "…";
}
function wrap(text, width) {
    const words = text.split(/\s+/g).filter(Boolean);
    if (words.length === 0)
        return [""];
    const lines = [];
    let line = "";
    for (const word of words) {
        if (!line) {
            line = word;
        }
        else if (`${line} ${word}`.length <= width) {
            line += ` ${word}`;
        }
        else {
            lines.push(line);
            line = word;
        }
    }
    if (line)
        lines.push(line);
    return lines;
}
function framed(lines, width = 88) {
    const inner = width - 4;
    return lines.map((line) => `│ ${clip(line, inner)} │`).join("\n");
}
function terminalWidth(stdout) {
    const columns = stdout.columns || 88;
    return Math.max(72, Math.min(columns, 110));
}
function renderTuiScreen(options, answer, width = 88, input = "") {
    const inner = width - 4;
    const answerText = answer || "dry-run: provider call skipped";
    const promptLines = wrap(options.prompt || "(empty)", inner - 6).map((line) => `  ${line}`);
    const answerLines = wrap(answerText, inner - 6).map((line) => `  ${line}`);
    const configPath = options.configPath || (0, config_1.defaultConfigPath)();
    const title = "AxumAgent";
    const status = `${options.model} · ${options.baseUrl}`;
    const top = `╭─ ${title} ${"─".repeat(Math.max(1, width - title.length - status.length - 7))} ${status} ╮`;
    const bottom = `╰${"─".repeat(width - 2)}╯`;
    const inputTop = `╭─ message ${"─".repeat(width - 12)}╮`;
    const inputBottom = `╰${"─".repeat(width - 2)}╯`;
    const inputLines = wrap(input, inner - 4);
    const renderedInput = inputLines.length === 1 && inputLines[0] === "" ? ["› "] : inputLines.map((line, index) => `${index === 0 ? "›" : " "} ${line}`);
    return [
        top,
        framed([
            `cwd     ${process.cwd()}`,
            `config  ${configPath}`,
            `retry   ${options.maxRetries} attempts · ${options.retryDelayMs}ms backoff`,
            "",
            "▌ user",
            ...promptLines,
            "",
            "▌ assistant",
            ...answerLines,
            "",
            "─".repeat(Math.max(12, inner)),
            "enter send · /help commands · /exit quit · ctrl+c interrupt",
        ], width),
        bottom,
        inputTop,
        framed(renderedInput, width),
        inputBottom,
    ].join("\n");
}
async function runChat(args, env, stdout, stderr) {
    let options;
    try {
        const extracted = extractConfigPath(args);
        const loaded = (0, config_1.loadConfig)(env, extracted.configPath);
        options = parseChatArgs(extracted.args, env, loaded, extracted.configPath);
    }
    catch (error) {
        if (error instanceof HelpRequested) {
            stdout.write(`${renderHelp()}\n`);
            return 0;
        }
        stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 2;
    }
    if (!options.apiKey) {
        stderr.write(`missing API key: set ${options.apiKeyEnv} or pass --api-key\n`);
        return 2;
    }
    const messages = [];
    if (options.system)
        messages.push({ role: "system", content: options.system });
    messages.push({ role: "user", content: options.prompt });
    try {
        const provider = new openai_chat_1.OpenAIChatProvider({
            apiKey: options.apiKey,
            baseUrl: options.baseUrl,
            model: options.model,
            temperature: options.temperature,
            maxRetries: options.maxRetries,
            retryDelayMs: options.retryDelayMs,
        });
        const result = await provider.chat(messages);
        if (options.json) {
            stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        }
        else {
            stdout.write(`${result.content}\n`);
        }
        return 0;
    }
    catch (error) {
        stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
}
async function resolveTuiAnswer(options, dryRun) {
    if (dryRun)
        return { answer: "dry-run: provider call skipped", exitCode: 0 };
    if (!options.apiKey) {
        return { answer: "missing API key; set config api_key or api_key = \"env:OPENAI_API_KEY\"", exitCode: 2 };
    }
    try {
        const provider = new openai_chat_1.OpenAIChatProvider({
            apiKey: options.apiKey,
            baseUrl: options.baseUrl,
            model: options.model,
            temperature: options.temperature,
            maxRetries: options.maxRetries,
            retryDelayMs: options.retryDelayMs,
        });
        const result = await provider.chat([{ role: "user", content: options.prompt }]);
        return { answer: result.content, exitCode: 0 };
    }
    catch (error) {
        return { answer: error instanceof Error ? error.message : String(error), exitCode: 1 };
    }
}
async function runRawInteractiveTui(options, dryRun, stdout, useAltScreen) {
    const stdin = process.stdin;
    let input = "";
    let screenOptions = { ...options, prompt: "(type a message)" };
    let answer = "waiting for input";
    let lastExitCode = 0;
    const repaint = () => {
        stdout.write("\u001b[2J\u001b[H");
        stdout.write(`${renderTuiScreen(screenOptions, answer, terminalWidth(stdout), input)}\n`);
    };
    if (useAltScreen)
        stdout.write("\u001b[?1049h");
    stdin.setRawMode?.(true);
    stdin.resume();
    repaint();
    try {
        while (true) {
            const chunk = await new Promise((resolve) => stdin.once("data", resolve));
            const text = chunk.toString("utf8");
            if (text === "\u0003")
                return lastExitCode;
            if (text === "\r" || text === "\n") {
                const prompt = input.trim();
                input = "";
                if (!prompt) {
                    repaint();
                    continue;
                }
                if (prompt === "/exit" || prompt === "/quit")
                    return lastExitCode;
                if (prompt === "/help") {
                    answer = "commands: /help · /exit · /quit";
                    repaint();
                    continue;
                }
                screenOptions = { ...options, prompt };
                answer = dryRun ? "dry-run: provider call skipped" : "thinking…";
                repaint();
                const result = await resolveTuiAnswer(screenOptions, dryRun);
                answer = result.answer;
                lastExitCode = result.exitCode;
                repaint();
                continue;
            }
            if (text === "\u007f" || text === "\b") {
                input = input.slice(0, -1);
                repaint();
                continue;
            }
            if (text.startsWith("\u001b"))
                continue;
            input += text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
            repaint();
        }
    }
    finally {
        stdin.setRawMode?.(false);
        if (useAltScreen)
            stdout.write("\u001b[?1049l");
    }
}
async function runLineInteractiveTui(options, dryRun, stdout) {
    const repaint = (screenOptions, answer, input = "") => {
        stdout.write(`${renderTuiScreen(screenOptions, answer, terminalWidth(stdout), input)}\n`);
    };
    repaint({ ...options, prompt: "(type a message)" }, "waiting for input");
    const rl = (0, promises_1.createInterface)({ input: process.stdin, output: process.stdout, prompt: "› " });
    let lastExitCode = 0;
    rl.prompt();
    for await (const line of rl) {
        const prompt = line.trim();
        if (prompt === "/exit" || prompt === "/quit") {
            rl.close();
            return lastExitCode;
        }
        if (prompt === "/help") {
            stdout.write("commands: /help · /exit · /quit\n");
            rl.prompt();
            continue;
        }
        if (!prompt) {
            rl.prompt();
            continue;
        }
        const nextOptions = { ...options, prompt };
        repaint(nextOptions, dryRun ? "dry-run: provider call skipped" : "thinking…");
        const result = await resolveTuiAnswer(nextOptions, dryRun);
        lastExitCode = result.exitCode;
        repaint(nextOptions, result.answer);
        rl.prompt();
    }
    return lastExitCode;
}
async function runTui(args, env, stdout, stderr) {
    const dryRun = args.includes("--dry-run");
    const noAltScreen = args.includes("--no-alt-screen");
    const filteredArgs = args.filter((arg) => arg !== "--dry-run" && arg !== "--no-alt-screen");
    let options;
    let hasPrompt = false;
    try {
        const extracted = extractConfigPath(filteredArgs);
        const loaded = (0, config_1.loadConfig)(env, extracted.configPath);
        hasPrompt = extracted.args.length > 0;
        options = parseChatArgs(extracted.args, env, loaded, extracted.configPath, hasPrompt);
    }
    catch (error) {
        if (error instanceof HelpRequested) {
            stdout.write(`${renderHelp()}\n`);
            return 0;
        }
        stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 2;
    }
    if (!hasPrompt) {
        if (stdout.isTTY && process.stdin.isTTY)
            return runRawInteractiveTui(options, dryRun, stdout, !noAltScreen);
        return runLineInteractiveTui(options, dryRun, stdout);
    }
    const result = await resolveTuiAnswer(options, dryRun);
    stdout.write(`${renderTuiScreen(options, result.answer, terminalWidth(stdout))}\n`);
    return result.exitCode;
}
async function runAxumCli(args, env = process.env, stdout = process.stdout, stderr = process.stderr) {
    if (args[0] === "chat") {
        return { handled: true, exitCode: await runChat(args.slice(1), env, stdout, stderr) };
    }
    if (args[0] === "tui") {
        return { handled: true, exitCode: await runTui(args.slice(1), env, stdout, stderr) };
    }
    if (args[0] === "--help" || args[0] === "-h" || args.length === 0) {
        stdout.write(`${renderHelp()}\n`);
        return { handled: args.length === 0 || args[0] === "--help" || args[0] === "-h", exitCode: 0 };
    }
    stderr.write(`unknown command: ${args[0]}\n`);
    stderr.write("Run `axum --help`.\n");
    return { handled: true, exitCode: 2 };
}
