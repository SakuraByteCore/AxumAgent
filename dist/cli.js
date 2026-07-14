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
function hasPositionalPrompt(args) {
    const flagsWithValues = new Set(["--model", "-m", "--base-url", "--api-key-env", "--api-key", "--system", "--temperature", "--max-retries", "--retry-delay-ms"]);
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (flagsWithValues.has(arg)) {
            i += 1;
            continue;
        }
        if (arg.startsWith("--"))
            continue;
        return true;
    }
    return false;
}
function parseChatArgs(args, env, loaded, configPath, requirePrompt = true) {
    const config = loaded?.config;
    const provider = (0, config_1.selectedProvider)(config).config;
    const rest = [];
    const configuredModels = [...(config?.models ?? []), ...(provider?.models ?? [])].filter((model) => typeof model === "string" && model.length > 0);
    let model = config?.model || provider?.model || configuredModels[0] || env.AXUM_MODEL || DEFAULT_MODEL;
    let modelWasExplicit = Boolean(config?.model || provider?.model || configuredModels[0] || env.AXUM_MODEL);
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
            modelWasExplicit = true;
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
        modelOptions: configuredModels,
        modelWasExplicit,
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
        "  -m, --model <id>          Model id (default: config models[0], AXUM_MODEL, or gpt-4o-mini)",
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
function box(lines, width = 88) {
    const top = `╭${"─".repeat(width - 2)}╮`;
    const bottom = `╰${"─".repeat(width - 2)}╯`;
    return [top, framed(lines, width), bottom].join("\n");
}
function terminalWidth(stdout) {
    const columns = stdout.columns || 88;
    return Math.max(72, Math.min(columns, 110));
}
function renderTuiScreen(options, answer, width = 88, input = "") {
    const inner = width - 4;
    const hasPrompt = options.prompt.trim().length > 0;
    const workingMatch = answer?.match(/^working:(\d+)$/);
    const isThinking = workingMatch !== undefined && workingMatch !== null;
    const workingSeconds = workingMatch ? workingMatch[1] : "0";
    const hasAnswer = answer !== undefined && !isThinking;
    const promptLines = hasPrompt ? wrap(options.prompt, inner - 6).map((line) => `  ${line}`) : [];
    const answerLines = hasAnswer ? wrap(answer, inner - 6).map((line) => `  ${line}`) : [];
    const cardWidth = Math.min(width, 54);
    const headerLines = [
        ">_ AxumAgent (v0.1.0)",
        "",
        `model:     ${options.model}   /model to change`,
        `directory: ${process.cwd()}`,
        "permissions: YOLO mode",
    ];
    const cursor = "█";
    const inputText = input.length > 0 ? `${input}${cursor}` : "";
    const inputLines = inputText.length > 0 ? wrap(inputText, inner - 4) : [""];
    const renderedInput = inputLines.map((line, index) => `${index === 0 ? "›" : " "} ${line}`);
    const statusLine = `${options.model} · ${process.cwd()}`;
    const conversationLines = [];
    if (hasPrompt || hasAnswer || isThinking) {
        if (hasPrompt)
            conversationLines.push("", ...promptLines.map((line, index) => (index === 0 ? `›${line.slice(1)}` : line)));
        if (hasPrompt && hasAnswer)
            conversationLines.push("");
        if (hasAnswer)
            conversationLines.push(...answerLines);
        if (isThinking)
            conversationLines.push("", `• Working (${workingSeconds}s • esc to interrupt)`);
    }
    return [
        box(headerLines, cardWidth),
        "",
        "Tip: Build faster with AxumAgent.",
        ...conversationLines,
        "",
        ...renderedInput,
        clip(statusLine, width),
    ].join("\n");
}
function workingStatus(startedAt) {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    return `working:${elapsedSeconds}`;
}
function uniqueModels(models) {
    const seen = new Set();
    const result = [];
    for (const model of models) {
        const trimmed = model.trim();
        if (!trimmed || seen.has(trimmed))
            continue;
        seen.add(trimmed);
        result.push(trimmed);
    }
    return result;
}
async function hydrateTuiModels(options, dryRun) {
    const configured = uniqueModels(options.modelOptions);
    if (configured.length > 0) {
        return { ...options, modelOptions: configured, model: options.modelWasExplicit ? options.model : configured[0] };
    }
    if (dryRun || options.modelWasExplicit || !options.apiKey)
        return { ...options, modelOptions: configured };
    try {
        const provider = new openai_chat_1.OpenAIChatProvider({
            apiKey: options.apiKey,
            baseUrl: options.baseUrl,
            model: options.model,
            temperature: options.temperature,
            maxRetries: options.maxRetries,
            retryDelayMs: options.retryDelayMs,
        });
        const fetched = uniqueModels(await provider.listModels());
        if (fetched.length === 0)
            return { ...options, modelOptions: fetched };
        return { ...options, modelOptions: fetched, model: fetched[0] };
    }
    catch {
        return { ...options, modelOptions: configured };
    }
}
function renderModelList(options) {
    if (options.modelOptions.length === 0)
        return `current model: ${options.model}; no configured/fetched model list`;
    return options.modelOptions
        .map((model, index) => `${model === options.model ? "*" : " "} ${index + 1}. ${model}`)
        .join("\n");
}
function switchModel(options, value) {
    const target = value.trim();
    if (!target)
        return { options, message: renderModelList(options) };
    const index = Number(target);
    const selected = Number.isInteger(index) && index >= 1 ? options.modelOptions[index - 1] : target;
    if (!selected)
        return { options, message: `model index out of range: ${target}` };
    const modelOptions = options.modelOptions.includes(selected) ? options.modelOptions : [...options.modelOptions, selected];
    return { options: { ...options, model: selected, modelOptions, modelWasExplicit: true }, message: `model switched to ${selected}` };
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
async function resolveTuiAnswerStream(options, dryRun, onDelta) {
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
        let streamed = "";
        const result = await provider.chatStream([{ role: "user", content: options.prompt }], (delta) => {
            streamed += delta;
            onDelta(streamed);
        });
        return { answer: result.content, exitCode: 0 };
    }
    catch (error) {
        return { answer: error instanceof Error ? error.message : String(error), exitCode: 1 };
    }
}
async function runRawInteractiveTui(options, dryRun, stdout, useAltScreen) {
    const stdin = process.stdin;
    let input = "";
    let screenOptions = { ...options, prompt: "" };
    let answer;
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
                    answer = "commands: /help · /model [id|number] · /exit · /quit";
                    repaint();
                    continue;
                }
                if (prompt === "/model" || prompt.startsWith("/model ")) {
                    const switched = switchModel(screenOptions, prompt.slice("/model".length));
                    screenOptions = { ...switched.options, prompt: "" };
                    options = { ...switched.options, prompt: options.prompt };
                    answer = switched.message;
                    repaint();
                    continue;
                }
                screenOptions = { ...options, prompt };
                if (dryRun) {
                    answer = "dry-run: provider call skipped";
                    lastExitCode = 0;
                    repaint();
                }
                else {
                    const startedAt = Date.now();
                    answer = workingStatus(startedAt);
                    repaint();
                    const timer = setInterval(() => {
                        answer = workingStatus(startedAt);
                        repaint();
                    }, 1000);
                    try {
                        const result = await resolveTuiAnswerStream(screenOptions, dryRun, (streamed) => {
                            answer = streamed;
                            repaint();
                        });
                        answer = result.answer;
                        lastExitCode = result.exitCode;
                    }
                    finally {
                        clearInterval(timer);
                    }
                    repaint();
                }
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
    repaint({ ...options, prompt: "" }, undefined);
    const rl = (0, promises_1.createInterface)({ input: process.stdin, output: process.stdout, prompt: "" });
    let lastExitCode = 0;
    rl.prompt();
    for await (const line of rl) {
        const prompt = line.trim();
        if (prompt === "/exit" || prompt === "/quit") {
            rl.close();
            return lastExitCode;
        }
        if (prompt === "/help") {
            stdout.write("commands: /help · /model [id|number] · /exit · /quit\n");
            rl.prompt();
            continue;
        }
        if (prompt === "/model" || prompt.startsWith("/model ")) {
            const switched = switchModel(options, prompt.slice("/model".length));
            options = switched.options;
            stdout.write(`${switched.message}\n`);
            rl.prompt();
            continue;
        }
        if (!prompt) {
            rl.prompt();
            continue;
        }
        const nextOptions = { ...options, prompt };
        if (dryRun) {
            repaint(nextOptions, "dry-run: provider call skipped");
            lastExitCode = 0;
        }
        else {
            const startedAt = Date.now();
            repaint(nextOptions, workingStatus(startedAt));
            const timer = setInterval(() => repaint(nextOptions, workingStatus(startedAt)), 1000);
            try {
                const result = await resolveTuiAnswerStream(nextOptions, dryRun, (streamed) => repaint(nextOptions, streamed));
                lastExitCode = result.exitCode;
                repaint(nextOptions, result.answer);
            }
            finally {
                clearInterval(timer);
            }
        }
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
        hasPrompt = hasPositionalPrompt(extracted.args);
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
    options = await hydrateTuiModels(options, dryRun);
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
