"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderHelp = renderHelp;
exports.runAxumCli = runAxumCli;
const openai_chat_1 = require("./providers/openai-chat");
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_API_KEY_ENV = "OPENAI_API_KEY";
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
function parseChatArgs(args, env) {
    const rest = [];
    let model = env.AXUM_MODEL || DEFAULT_MODEL;
    let baseUrl = env.AXUM_OPENAI_BASE_URL || env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
    let apiKeyEnv = env.AXUM_OPENAI_API_KEY_ENV || DEFAULT_API_KEY_ENV;
    let apiKey;
    let system;
    let temperature;
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
        "  axum <rust-command> [...args]",
        "",
        "Chat options:",
        "  -m, --model <id>          Model id (default: AXUM_MODEL or gpt-4o-mini)",
        "      --base-url <url>      OpenAI-compatible base URL (default: AXUM_OPENAI_BASE_URL, OPENAI_BASE_URL, or https://api.openai.com/v1)",
        "      --api-key-env <name>  Environment variable that holds the API key (default: OPENAI_API_KEY)",
        "      --api-key <value>     API key value; prefer env in normal use",
        "      --system <text>       Optional system message",
        "      --temperature <0..2>  Optional temperature",
        "      --json                Print provider result as JSON",
        "  -h, --help               Show this help",
        "",
        "Environment:",
        "  OPENAI_API_KEY, AXUM_MODEL, AXUM_OPENAI_BASE_URL, AXUM_OPENAI_API_KEY_ENV",
    ].join("\n");
}
async function runChat(args, env, stdout, stderr) {
    let options;
    try {
        options = parseChatArgs(args, env);
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
async function runAxumCli(args, env = process.env, stdout = process.stdout, stderr = process.stderr) {
    if (args[0] === "chat") {
        return { handled: true, exitCode: await runChat(args.slice(1), env, stdout, stderr) };
    }
    if (args[0] === "--help" || args[0] === "-h" || args.length === 0) {
        stdout.write(`${renderHelp()}\n`);
        return { handled: args.length === 0 || args[0] === "--help" || args[0] === "-h", exitCode: 0 };
    }
    return { handled: false, exitCode: 0 };
}
