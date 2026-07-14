"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderHelp = renderHelp;
exports.runAxumCli = runAxumCli;
const config_1 = require("./config");
const openai_chat_1 = require("./providers/openai-chat");
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
function parseChatArgs(args, env, loaded, configPath) {
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
    if (!prompt)
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
function box(title, lines, width = 78) {
    const inner = width - 4;
    const top = `╭─ ${title} ${"─".repeat(Math.max(0, inner - title.length - 1))}╮`;
    const body = lines.map((line) => `│ ${clip(line, inner)} │`);
    const bottom = `╰${"─".repeat(width - 2)}╯`;
    return [top, ...body, bottom].join("\n");
}
function renderTuiScreen(options, answer) {
    return [
        box("AxumAgent", [
            "pi-style terminal workspace",
            `model: ${options.model}`,
            `base_url: ${options.baseUrl}`,
            `config: ${options.configPath || (0, config_1.defaultConfigPath)()}`,
            `retries: ${options.maxRetries} · retry_delay_ms: ${options.retryDelayMs}`,
        ]),
        box("Prompt", [options.prompt || "(empty)"]),
        box("Assistant", [answer || "dry-run: provider call skipped"]),
        box("Keys", ["Enter: send · Ctrl+C: exit · /help: commands"]),
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
async function runTui(args, env, stdout, stderr) {
    const dryRun = args.includes("--dry-run");
    const filteredArgs = args.filter((arg) => arg !== "--dry-run");
    let options;
    try {
        const extracted = extractConfigPath(filteredArgs);
        const loaded = (0, config_1.loadConfig)(env, extracted.configPath);
        const promptArgs = extracted.args.length > 0 ? extracted.args : ["(waiting for input)"];
        options = parseChatArgs(promptArgs, env, loaded, extracted.configPath);
    }
    catch (error) {
        if (error instanceof HelpRequested) {
            stdout.write(`${renderHelp()}\n`);
            return 0;
        }
        stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 2;
    }
    if (dryRun) {
        stdout.write(`${renderTuiScreen(options)}\n`);
        return 0;
    }
    if (!options.apiKey) {
        stdout.write(`${renderTuiScreen(options, "missing API key; set config api_key or api_key = \"env:OPENAI_API_KEY\"")}\n`);
        return 2;
    }
    const messages = [{ role: "user", content: options.prompt }];
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
        stdout.write(`${renderTuiScreen(options, result.content)}\n`);
        return 0;
    }
    catch (error) {
        stdout.write(`${renderTuiScreen(options, error instanceof Error ? error.message : String(error))}\n`);
        return 1;
    }
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
