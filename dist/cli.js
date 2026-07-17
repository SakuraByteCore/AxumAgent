"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderHelp = renderHelp;
exports.runAxumCli = runAxumCli;
const config_1 = require("./config");
const openai_chat_1 = require("./providers/openai-chat");
const pi_workflow_1 = require("./runtime/pi-workflow");
const session_1 = require("./runtime/session");
const kilo_shell_1 = require("./shell/kilo-shell");
const node_fs_1 = __importDefault(require("node:fs"));
const node_http_1 = __importDefault(require("node:http"));
const node_path_1 = __importDefault(require("node:path"));
const promises_1 = require("node:readline/promises");
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_API_KEY_ENV = "OPENAI_API_KEY";
const DEFAULT_MAX_RETRIES = 10;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
const DEFAULT_SYSTEM_PROMPT = [
    "You are AxumAgent, a concise terminal assistant.",
    "Answer in the user's language by default.",
    "For short, ambiguous, or chat-like inputs, respond naturally and briefly instead of expanding into a dictionary, encyclopedia, or list of interpretations.",
    "Only provide detailed explanations, examples, or multiple interpretations when the user asks for them.",
].join(" ");
function takeValue(args, index, flag) {
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
        throw new Error(`${flag} requires a value`);
    return value;
}
function defaultSystemPrompt() {
    return DEFAULT_SYSTEM_PROMPT;
}
function buildChatMessages(options) {
    const messages = [];
    messages.push({ role: "system", content: options.system || defaultSystemPrompt() });
    messages.push({ role: "user", content: options.prompt });
    return messages;
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
function parseProviderConfigLine(value, source) {
    if (!value)
        return {};
    const parts = value.trim().split(/\s+/g).filter(Boolean);
    if (parts.length === 0)
        return {};
    if (parts.length < 3)
        throw new Error(`${source} must be: <base_url> <api_key|env:VAR> <model>`);
    const [baseUrl, apiKey, ...modelParts] = parts;
    const model = modelParts.join(" ").trim();
    if (!baseUrl || !apiKey || !model)
        throw new Error(`${source} must be: <base_url> <api_key|env:VAR> <model>`);
    return { baseUrl, apiKey, model };
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
    const flagsWithValues = new Set(["--provider", "--model", "-m", "--base-url", "--api-key-env", "--api-key", "--system", "--temperature", "--max-retries", "--retry-delay-ms", "--request-timeout-ms"]);
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
    let providerId = config?.provider || "openai-chat";
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "--provider") {
            providerId = takeValue(args, i, args[i]);
            i += 1;
        }
    }
    if (config?.providers && !config.providers[providerId])
        throw new Error(`provider not found in config: ${providerId}`);
    const provider = providerId === (config?.provider || "openai-chat") ? (0, config_1.selectedProvider)(config).config : config?.providers?.[providerId];
    const rest = [];
    const configuredModels = [...(config?.models ?? []), ...(provider?.models ?? [])].filter((model) => typeof model === "string" && model.length > 0);
    const rootProviderLine = parseProviderConfigLine(config?.provider_config ?? config?.providerConfig, "provider_config");
    const providerLine = parseProviderConfigLine(provider?.provider_config ?? provider?.providerConfig, "providers.openai-chat.provider_config");
    const oneLineConfig = { ...rootProviderLine, ...providerLine };
    let model = config?.model || provider?.model || oneLineConfig.model || configuredModels[0] || env.AXUM_MODEL || DEFAULT_MODEL;
    let modelWasExplicit = Boolean(config?.model || provider?.model || oneLineConfig.model || configuredModels[0] || env.AXUM_MODEL);
    let baseUrl = provider?.base_url || provider?.baseUrl || oneLineConfig.baseUrl || env.AXUM_OPENAI_BASE_URL || env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
    let apiKeyEnv = provider?.api_key_env || provider?.apiKeyEnv || env.AXUM_OPENAI_API_KEY_ENV || DEFAULT_API_KEY_ENV;
    let apiKey = (0, config_1.resolveSecret)(provider?.api_key || provider?.apiKey || oneLineConfig.apiKey, env);
    let system;
    let temperature;
    let maxRetries = (0, config_1.numberFromConfig)(provider?.max_retries ?? provider?.maxRetries) ?? (env.AXUM_OPENAI_MAX_RETRIES
        ? parseNonNegativeInteger(env.AXUM_OPENAI_MAX_RETRIES, "AXUM_OPENAI_MAX_RETRIES")
        : DEFAULT_MAX_RETRIES);
    let retryDelayMs = (0, config_1.numberFromConfig)(provider?.retry_delay_ms ?? provider?.retryDelayMs) ?? (env.AXUM_OPENAI_RETRY_DELAY_MS
        ? parseNonNegativeInteger(env.AXUM_OPENAI_RETRY_DELAY_MS, "AXUM_OPENAI_RETRY_DELAY_MS")
        : DEFAULT_RETRY_DELAY_MS);
    let requestTimeoutMs = (0, config_1.numberFromConfig)(provider?.request_timeout_ms ?? provider?.requestTimeoutMs) ?? (env.AXUM_OPENAI_REQUEST_TIMEOUT_MS
        ? parseNonNegativeInteger(env.AXUM_OPENAI_REQUEST_TIMEOUT_MS, "AXUM_OPENAI_REQUEST_TIMEOUT_MS")
        : DEFAULT_REQUEST_TIMEOUT_MS);
    let json = false;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === "--provider") {
            i += 1;
        }
        else if (arg === "--model" || arg === "-m") {
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
        else if (arg === "--request-timeout-ms") {
            requestTimeoutMs = parseNonNegativeInteger(takeValue(args, i, arg), arg);
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
        providerId,
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
        requestTimeoutMs,
        configPath: loaded?.path || (0, config_1.resolveConfigPath)(env, configPath),
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
        "  axum init [options]",
        "  axum chat [options] <prompt>",
        "  axum tui [options] [prompt]",
        "  axum doctor [options]",
        "  axum providers [options]",
        "  axum modes [options]",
        "  axum workflow [options] <prompt>",
        "  axum parallel [options] --task <prompt> --task <prompt> <goal>",
        "  axum config-web [options]",
        "  axum --version",
        "",
        "Recommended first run:",
        "  axum init --provider-config \"https://api.openai.com/v1 env:OPENAI_API_KEY gpt-4o-mini\"",
        "  axum doctor",
        "  axum providers",
        "  axum modes",
        "  axum parallel --task \"inspect runtime\" --task \"inspect tools\" \"plan refactor\"",
        "  axum tui",
        "",
        "Common options:",
        "      --config <path>      Config file path (default: AXUM_CONFIG or ~/.axum/config.toml)",
        "      --provider <id>      Use a configured provider id for chat/tui/doctor",
        "  -h, --help               Show help",
        "  -v, --version            Show package version",
        "",
        "Provider setup:",
        "      --provider-config <url> <key|env:VAR> <model>  One-line init/provider setup",
        "      --base-url <url>      OpenAI-compatible base URL (default: AXUM_OPENAI_BASE_URL, OPENAI_BASE_URL, or https://api.openai.com/v1)",
        "      --api-key-env <name>  Environment variable that holds the API key (default: OPENAI_API_KEY)",
        "      --api-key <value>     API key value; prefer env:VAR in normal use",
        "  -m, --model <id>          Model id (default: config models[0], AXUM_MODEL, or gpt-4o-mini)",
        "      --force              Allow init to update an existing config",
        "",
        "Chat/TUI options:",
        "      --system <text>       Optional system message",
        "      --temperature <0..2>  Optional temperature",
        "      --max-retries <n>     Retry transient failures (default: AXUM_OPENAI_MAX_RETRIES or 10)",
        "      --retry-delay-ms <n>  Base retry delay in milliseconds (default: AXUM_OPENAI_RETRY_DELAY_MS or 250)",
        "      --request-timeout-ms <n>  Request timeout in milliseconds; 0 disables (default: AXUM_OPENAI_REQUEST_TIMEOUT_MS or 600000)",
        "      --json                Print provider/doctor result as JSON",
        "      --dry-run             Render the terminal UI without calling a provider (tui only)",
        "      --no-alt-screen       Keep terminal scrollback instead of using the alternate screen (tui only)",
        "      --mode <id>           Use a Kilo-style Axum shell mode for workflow execution",
        "      --task <prompt>       Add a planned sub-agent task for axum parallel",
        "      --verbose             Expand folded workflow steps",
        "",
        "Config web options:",
        "      --host <host>         Config web host (default: 127.0.0.1)",
        "      --port <port>         Config web port (default: 8787)",
        "",
        "Environment:",
        "  OPENAI_API_KEY, AXUM_MODEL, AXUM_OPENAI_BASE_URL, AXUM_OPENAI_API_KEY_ENV, AXUM_OPENAI_MAX_RETRIES, AXUM_OPENAI_RETRY_DELAY_MS, AXUM_OPENAI_REQUEST_TIMEOUT_MS",
        "",
        "Config:",
        `  Default path: ${(0, config_1.defaultConfigPath)()}`,
    ].join("\n");
}
function parseInitArgs(args) {
    let configPath;
    let baseUrl = DEFAULT_BASE_URL;
    let apiKey = `env:${DEFAULT_API_KEY_ENV}`;
    let model = DEFAULT_MODEL;
    let force = false;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === "--config") {
            configPath = takeValue(args, i, arg);
            i += 1;
        }
        else if (arg === "--provider-config") {
            const parsed = parseProviderConfigLine(takeValue(args, i, arg), arg);
            baseUrl = parsed.baseUrl ?? baseUrl;
            apiKey = parsed.apiKey ?? apiKey;
            model = parsed.model ?? model;
            i += 1;
        }
        else if (arg === "--base-url") {
            baseUrl = takeValue(args, i, arg);
            i += 1;
        }
        else if (arg === "--api-key") {
            apiKey = takeValue(args, i, arg);
            i += 1;
        }
        else if (arg === "--model" || arg === "-m") {
            model = takeValue(args, i, arg);
            i += 1;
        }
        else if (arg === "--force") {
            force = true;
        }
        else if (arg === "--help" || arg === "-h") {
            throw new HelpRequested();
        }
        else {
            throw new Error(`unknown init option: ${arg}`);
        }
    }
    return { configPath, baseUrl, apiKey, model, force };
}
async function runInit(args, env, stdout, stderr) {
    try {
        const options = parseInitArgs(args);
        const configPath = (0, config_1.resolveConfigPath)(env, options.configPath);
        const existedBefore = node_fs_1.default.existsSync(configPath);
        if (existedBefore && !options.force) {
            stdout.write(`axum config exists: ${configPath}\n`);
            stdout.write("Use --force to update provider URL/key/model.\n");
            return 0;
        }
        const saved = (0, config_1.saveOpenAIProviderConfig)(env, options.configPath, {
            base_url: options.baseUrl,
            api_key: options.apiKey,
            model: options.model,
            models: [options.model],
            max_retries: DEFAULT_MAX_RETRIES,
            retry_delay_ms: DEFAULT_RETRY_DELAY_MS,
            request_timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
        });
        stdout.write(`axum config ${existedBefore ? "updated" : "created"}: ${saved.path}\n`);
        stdout.write(`provider: ${options.baseUrl}\n`);
        stdout.write(`model: ${options.model}\n`);
        stdout.write("Next: axum doctor && axum tui\n");
        return 0;
    }
    catch (error) {
        if (error instanceof HelpRequested) {
            stdout.write("Usage: axum init [--config <path>] [--provider-config '<url> <key|env:VAR> <model>'] [--base-url <url>] [--api-key <key|env:VAR>] [--model <id>] [--force]\n");
            return 0;
        }
        stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 2;
    }
}
function packageVersion() {
    try {
        const raw = node_fs_1.default.readFileSync(node_path_1.default.resolve(__dirname, "..", "package.json"), "utf8");
        const parsed = JSON.parse(raw);
        return parsed.version || "0.0.0";
    }
    catch {
        return "0.0.0";
    }
}
function apiKeyDisplay(value) {
    if (!value)
        return "missing";
    if (value.startsWith("env:"))
        return value;
    return maskSecret(value);
}
function providerRows(env, explicitPath) {
    const loaded = (0, config_1.loadConfig)(env, explicitPath);
    const config = loaded?.config;
    const defaultProvider = config?.provider || "openai-chat";
    const providers = config?.providers && Object.keys(config.providers).length > 0
        ? config.providers
        : { [defaultProvider]: undefined };
    const rootProviderLine = parseProviderConfigLine(config?.provider_config ?? config?.providerConfig, "provider_config");
    return Object.entries(providers).map(([id, provider]) => {
        const providerLine = parseProviderConfigLine(provider?.provider_config ?? provider?.providerConfig, `providers.${id}.provider_config`);
        const effectiveRootLine = id === defaultProvider ? rootProviderLine : {};
        const oneLineConfig = { ...effectiveRootLine, ...providerLine };
        return {
            id,
            default: id === defaultProvider,
            type: provider?.type || "openai-chat",
            baseUrl: provider?.base_url || provider?.baseUrl || oneLineConfig.baseUrl || env.AXUM_OPENAI_BASE_URL || env.OPENAI_BASE_URL || DEFAULT_BASE_URL,
            model: provider?.model || oneLineConfig.model || (provider?.models ?? [])[0] || config?.model || (config?.models ?? [])[0] || env.AXUM_MODEL || DEFAULT_MODEL,
            key: apiKeyDisplay(provider?.api_key || provider?.apiKey || oneLineConfig.apiKey || `env:${provider?.api_key_env || provider?.apiKeyEnv || env.AXUM_OPENAI_API_KEY_ENV || DEFAULT_API_KEY_ENV}`),
        };
    });
}
async function runProviders(args, env, stdout, stderr) {
    try {
        const extracted = extractConfigPath(args);
        if (extracted.args.some((arg) => arg === "--help" || arg === "-h")) {
            stdout.write("Usage: axum providers [--config <path>] [--json]\n");
            return 0;
        }
        const json = extracted.args.includes("--json");
        const unknown = extracted.args.find((arg) => arg !== "--json");
        if (unknown)
            throw new Error(`unknown providers option: ${unknown}`);
        const rows = providerRows(env, extracted.configPath);
        if (json) {
            stdout.write(`${JSON.stringify({ providers: rows }, null, 2)}\n`);
        }
        else {
            stdout.write("AxumAgent providers\n");
            for (const row of rows) {
                const mark = row.default ? "*" : " ";
                stdout.write(`${mark} ${row.id}  ${row.baseUrl}  ${row.model}  key:${row.key}\n`);
            }
        }
        return 0;
    }
    catch (error) {
        stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 2;
    }
}
function htmlEscape(value) {
    return (value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}
function currentProviderFields(env, explicitPath) {
    const loaded = (0, config_1.loadConfig)(env, explicitPath);
    const config = loaded?.config;
    const provider = (0, config_1.selectedProvider)(config).config;
    const rootProviderLine = parseProviderConfigLine(config?.provider_config ?? config?.providerConfig, "provider_config");
    const providerLine = parseProviderConfigLine(provider?.provider_config ?? provider?.providerConfig, "providers.openai-chat.provider_config");
    const oneLineConfig = { ...rootProviderLine, ...providerLine };
    return {
        configPath: loaded?.path ?? (0, config_1.resolveConfigPath)(env, explicitPath),
        baseUrl: provider?.base_url || provider?.baseUrl || oneLineConfig.baseUrl || env.AXUM_OPENAI_BASE_URL || env.OPENAI_BASE_URL || DEFAULT_BASE_URL,
        apiKey: provider?.api_key || provider?.apiKey || oneLineConfig.apiKey || `env:${provider?.api_key_env || provider?.apiKeyEnv || env.AXUM_OPENAI_API_KEY_ENV || DEFAULT_API_KEY_ENV}`,
        model: config?.model || provider?.model || oneLineConfig.model || (config?.models ?? [])[0] || (provider?.models ?? [])[0] || env.AXUM_MODEL || DEFAULT_MODEL,
    };
}
function renderConfigWebPage(fields, message) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AxumAgent Provider Config</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; background: #0f1115; color: #eceff4; }
    form { display: grid; gap: 14px; padding: 20px; border: 1px solid #2b303b; border-radius: 12px; background: #151923; }
    label { display: grid; gap: 6px; font-size: 14px; color: #b8c0cc; }
    input { font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid #3a4150; background: #0f1115; color: #eceff4; }
    button { width: fit-content; padding: 10px 14px; border: 0; border-radius: 8px; background: #7c9cff; color: #081120; font-weight: 700; cursor: pointer; }
    code, .path { color: #9adbcf; word-break: break-all; }
    .ok { padding: 10px 12px; border-radius: 8px; background: #14351f; color: #b6f5c7; }
    .hint { color: #8d97a8; font-size: 13px; }
  </style>
</head>
<body>
  <h1>AxumAgent Provider Config</h1>
  <p class="hint">Writes to <span class="path">${htmlEscape(fields.configPath)}</span>. This local temporary page only edits provider URL, key, and model.</p>
  ${message ? `<p class="ok">${htmlEscape(message)}</p>` : ""}
  <form method="post" action="/save">
    <label>Base URL
      <input name="base_url" value="${htmlEscape(fields.baseUrl)}" placeholder="https://api.openai.com/v1" required>
    </label>
    <label>API key or env reference
      <input name="api_key" type="password" value="${htmlEscape(fields.apiKey.startsWith("env:") ? fields.apiKey : "")}" placeholder="env:OPENAI_API_KEY, sk-..., or leave blank to keep existing key" autocomplete="off">
    </label>
    <label>Model
      <input name="model" value="${htmlEscape(fields.model)}" placeholder="gpt-4o-mini" required>
    </label>
    <button type="submit">Save provider config</button>
  </form>
  <p class="hint">CLI equivalent: <code>/provider set &lt;url&gt; &lt;key|env:VAR&gt; &lt;model&gt;</code></p>
</body>
</html>`;
}
async function readRequestBody(req) {
    const chunks = [];
    for await (const chunk of req)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
}
function parseConfigWebArgs(args) {
    let host = "127.0.0.1";
    let port = 8787;
    let configPath;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === "--host") {
            host = takeValue(args, i, arg);
            i += 1;
        }
        else if (arg === "--port") {
            port = parseNonNegativeInteger(takeValue(args, i, arg), arg);
            i += 1;
        }
        else if (arg === "--config") {
            configPath = takeValue(args, i, arg);
            i += 1;
        }
        else if (arg === "--help" || arg === "-h") {
            throw new HelpRequested();
        }
        else {
            throw new Error(`unknown config-web option: ${arg}`);
        }
    }
    return { host, port, configPath };
}
async function runConfigWeb(args, env, stdout, stderr) {
    try {
        const options = parseConfigWebArgs(args);
        const server = node_http_1.default.createServer(async (req, res) => {
            try {
                if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
                    const html = renderConfigWebPage(currentProviderFields(env, options.configPath));
                    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                    res.end(html);
                    return;
                }
                if (req.method === "POST" && req.url === "/save") {
                    const body = await readRequestBody(req);
                    const form = new URLSearchParams(body);
                    const current = currentProviderFields(env, options.configPath);
                    const baseUrl = String(form.get("base_url") ?? "").trim();
                    const submittedApiKey = String(form.get("api_key") ?? "").trim();
                    const apiKey = submittedApiKey || current.apiKey;
                    const model = String(form.get("model") ?? "").trim();
                    if (!baseUrl || !apiKey || !model) {
                        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
                        res.end("base_url, api_key, and model are required");
                        return;
                    }
                    const saved = (0, config_1.saveOpenAIProviderConfig)(env, options.configPath, { base_url: baseUrl, api_key: apiKey, model, models: [model] });
                    const html = renderConfigWebPage({ configPath: saved.path, baseUrl, apiKey, model }, "Saved");
                    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                    res.end(html);
                    return;
                }
                res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
                res.end("not found");
            }
            catch (error) {
                res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
                res.end(error instanceof Error ? error.message : String(error));
            }
        });
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(options.port, options.host, resolve);
        });
        const address = server.address();
        const actualPort = typeof address === "object" && address ? address.port : options.port;
        stdout.write(`AxumAgent config web listening on http://${options.host}:${actualPort}\n`);
        await new Promise((resolve) => {
            const close = () => server.close(() => resolve());
            process.once("SIGINT", close);
            process.once("SIGTERM", close);
        });
        return 0;
    }
    catch (error) {
        if (error instanceof HelpRequested) {
            stdout.write("Usage: axum config-web [--host 127.0.0.1] [--port 8787] [--config <path>]\n");
            return 0;
        }
        stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 2;
    }
}
function stripAnsi(text) {
    return text.replace(/\u001b\[[0-9;]*m/g, "");
}
function charDisplayWidth(char) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0 || code < 0x20 || (code >= 0x7f && code < 0xa0))
        return 0;
    if ((code >= 0x0300 && code <= 0x036f)
        || (code >= 0x1ab0 && code <= 0x1aff)
        || (code >= 0x1dc0 && code <= 0x1dff)
        || (code >= 0x20d0 && code <= 0x20ff)
        || (code >= 0xfe00 && code <= 0xfe0f))
        return 0;
    if ((code >= 0x1100 && code <= 0x115f)
        || code === 0x2329
        || code === 0x232a
        || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
        || (code >= 0xac00 && code <= 0xd7a3)
        || (code >= 0xf900 && code <= 0xfaff)
        || (code >= 0xfe10 && code <= 0xfe19)
        || (code >= 0xfe30 && code <= 0xfe6f)
        || (code >= 0xff00 && code <= 0xff60)
        || (code >= 0xffe0 && code <= 0xffe6))
        return 2;
    return 1;
}
function visibleWidth(text) {
    return Array.from(stripAnsi(text)).reduce((total, char) => total + charDisplayWidth(char), 0);
}
function truncateToVisibleWidth(text, width) {
    if (width <= 0)
        return "";
    let used = 0;
    let result = "";
    for (const char of Array.from(stripAnsi(text))) {
        const charWidth = charDisplayWidth(char);
        if (used + charWidth > width)
            break;
        result += char;
        used += charWidth;
    }
    return result;
}
function clip(text, width) {
    const textWidth = visibleWidth(text);
    if (textWidth <= width)
        return text + " ".repeat(width - textWidth);
    return `${truncateToVisibleWidth(text, Math.max(0, width - 1))}…`;
}
const SLASH_COMMANDS = [
    { name: "/help", description: "show commands" },
    { name: "/provider", description: "show/set provider url/key" },
    { name: "/model", description: "fetch/list/switch models" },
    { name: "/parallel", description: "plan sub-agent tasks" },
    { name: "/exit", aliases: ["/quit"], description: "exit TUI" },
];
function wrap(text, width) {
    const safeWidth = Math.max(1, width);
    const words = text.split(/\s+/g).filter(Boolean);
    if (words.length === 0)
        return [""];
    const lines = [];
    let line = "";
    for (const word of words) {
        if (!line) {
            line = word;
        }
        else if (visibleWidth(`${line} ${word}`) <= safeWidth) {
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
function wrapPreservingShortLine(text, width) {
    return visibleWidth(text) <= width ? [text] : wrap(text, width);
}
function renderAssistantOutput(answer) {
    if (answer === "dry-run: provider call skipped")
        return "✓ dry-run · provider call skipped";
    return answer;
}
function slashCommandQuery(input) {
    if (!input.startsWith("/"))
        return "";
    return input.slice(1).trimStart().split(/\s+/)[0] ?? "";
}
function slashCommandLabels(command) {
    return [command.name, ...(command.aliases ?? [])];
}
function slashCommandDisplayName(command) {
    return slashCommandLabels(command).join(" / ");
}
function matchingSlashCommands(input) {
    if (!input.startsWith("/"))
        return [];
    const query = slashCommandQuery(input);
    return SLASH_COMMANDS.filter((command) => slashCommandLabels(command).some((label) => label.slice(1).startsWith(query)));
}
function clampSelection(index, count) {
    if (count <= 0)
        return 0;
    return Math.max(0, Math.min(index, count - 1));
}
function completeSlashCommand(input, selectedIndex) {
    const matches = matchingSlashCommands(input);
    const selected = matches[clampSelection(selectedIndex, matches.length)];
    if (!selected)
        return undefined;
    const query = slashCommandQuery(input);
    const completed = slashCommandLabels(selected).find((label) => label.slice(1).startsWith(query)) ?? selected.name;
    return `${completed} `;
}
function padCell(text, width) {
    const textWidth = visibleWidth(text);
    if (textWidth <= width)
        return text + " ".repeat(width - textWidth);
    return `${truncateToVisibleWidth(text, Math.max(0, width - 1))}…`;
}
function renderSlashCommandSuggestions(input, width, selectedIndex = 0) {
    if (!input.startsWith("/"))
        return [];
    const matches = matchingSlashCommands(input);
    if (matches.length === 0)
        return ["⌘ commands", "  no matching commands"];
    const selected = clampSelection(selectedIndex, matches.length);
    const labelWidth = Math.max(...matches.map((command) => slashCommandDisplayName(command).length));
    const commandWidth = Math.min(Math.max(labelWidth, 10), Math.max(10, Math.floor(width * 0.32)));
    const rows = matches.map((command, index) => {
        const marker = index === selected ? "▸" : " ";
        const commandCell = padCell(slashCommandDisplayName(command), commandWidth);
        return `${marker} ${commandCell} ${command.description}`;
    });
    return ["⌘ commands", ...rows];
}
function terminalWidth(stdout) {
    const columns = stdout.columns || 88;
    return Math.max(72, Math.min(columns, 110));
}
function renderTuiScreen(options, answer, width = 88, input = "", slashSelection = 0, cursorIndex = input.length, height = 24, status = undefined) {
    const inner = width - 4;
    const hasPrompt = options.prompt.trim().length > 0;
    const hasStatus = status !== undefined;
    const hasAnswer = answer !== undefined;
    const promptLines = hasPrompt ? options.prompt.split(/\n/).flatMap((line) => wrap(line, inner - 6)).map((line) => `  ${line}`) : [];
    const rawAnswerLines = hasAnswer ? renderAssistantOutput(answer).split(/\n/).flatMap((line) => wrapPreservingShortLine(line, inner - 6)).map((line) => `  ${line}`) : [];
    const maxAnswerLines = Math.max(4, height - (hasStatus ? 8 : 7));
    const answerLines = rawAnswerLines.length > maxAnswerLines
        ? [...rawAnswerLines.slice(0, maxAnswerLines - 1), `  … ${rawAnswerLines.length - maxAnswerLines + 1} more`]
        : rawAnswerLines;
    const headerLines = [
        "◇ AxumAgent v0.1.0",
        `  ◌ ${options.model} · ${process.cwd()}`,
    ];
    const cursor = "█";
    const safeInput = visibleInput(input);
    const safeCursorIndex = safeInput === input ? clampSelection(cursorIndex, input.length + 1) : safeInput.length;
    const inputText = `${safeInput.slice(0, safeCursorIndex)}${cursor}${safeInput.slice(safeCursorIndex)}`;
    const inputLines = wrap(inputText, inner - 4);
    const renderedInput = inputLines.map((line, index) => `${index === 0 ? "▌" : " "} ${line}`);
    const statusLine = `${options.model} · ${process.cwd()}`;
    const conversationLines = [];
    if (hasPrompt || hasAnswer || hasStatus) {
        if (hasPrompt)
            conversationLines.push(...promptLines.map((line, index) => (index === 0 ? `›${line.slice(1)}` : line)));
        if (hasPrompt && hasAnswer)
            conversationLines.push("");
        if (hasAnswer)
            conversationLines.push(...answerLines);
        if (hasStatus)
            conversationLines.push(...(hasPrompt || hasAnswer ? [""] : []), status);
    }
    const commandLines = renderSlashCommandSuggestions(safeInput, width, slashSelection);
    return [
        ...headerLines,
        "",
        ...conversationLines,
        ...(conversationLines.length > 0 ? [""] : []),
        ...commandLines,
        ...(commandLines.length > 0 ? [""] : []),
        ...renderedInput,
        clip(statusLine, width),
    ].join("\n");
}
function workingStatus(startedAt) {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    return `• Working (${elapsedSeconds}s • esc to interrupt)`;
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
    return (await hydrateTuiModelsWithStatus(options, dryRun)).options;
}
async function hydrateTuiModelsWithStatus(options, dryRun) {
    const configured = uniqueModels(options.modelOptions);
    if (configured.length > 0) {
        return { options: { ...options, modelOptions: configured, model: options.modelWasExplicit ? options.model : configured[0] } };
    }
    if (dryRun || !options.apiKey)
        return { options: { ...options, modelOptions: configured } };
    try {
        const provider = new openai_chat_1.OpenAIChatProvider({
            apiKey: options.apiKey,
            baseUrl: options.baseUrl,
            model: options.model,
            temperature: options.temperature,
            maxRetries: options.maxRetries,
            retryDelayMs: options.retryDelayMs,
            requestTimeoutMs: options.requestTimeoutMs,
        });
        const fetched = uniqueModels(await provider.listModels());
        if (fetched.length === 0)
            return { options: { ...options, modelOptions: fetched }, error: "provider returned an empty model list" };
        return { options: { ...options, modelOptions: fetched, model: options.modelWasExplicit ? options.model : fetched[0] } };
    }
    catch (error) {
        return { options: { ...options, modelOptions: configured }, error: error instanceof Error ? error.message : String(error) };
    }
}
async function fetchTuiModelsWithStatus(options) {
    const configured = uniqueModels(options.modelOptions);
    if (!options.apiKey)
        return { options: { ...options, modelOptions: configured }, error: `missing API key: set ${options.apiKeyEnv} or /provider key <key>` };
    try {
        const provider = new openai_chat_1.OpenAIChatProvider({
            apiKey: options.apiKey,
            baseUrl: options.baseUrl,
            model: options.model,
            temperature: options.temperature,
            maxRetries: options.maxRetries,
            retryDelayMs: options.retryDelayMs,
            requestTimeoutMs: options.requestTimeoutMs,
        });
        const fetched = uniqueModels(await provider.listModels());
        if (fetched.length === 0)
            return { options: { ...options, modelOptions: fetched }, error: "provider returned an empty model list" };
        return { options: { ...options, modelOptions: fetched, model: fetched.includes(options.model) ? options.model : fetched[0] } };
    }
    catch (error) {
        return { options: { ...options, modelOptions: configured }, error: error instanceof Error ? error.message : String(error) };
    }
}
function renderModelList(options, maxRows = 14) {
    if (options.modelOptions.length === 0)
        return `models\n  no configured/fetched model list`;
    const numberWidth = String(options.modelOptions.length).length;
    const currentIndex = Math.max(0, options.modelOptions.indexOf(options.model));
    const formatRow = (model, index) => {
        const current = model === options.model ? "▸" : " ";
        const suffix = model === options.model ? "  current" : "";
        return `${current} ${String(index + 1).padStart(numberWidth)}  ${model}${suffix}`;
    };
    const allRows = options.modelOptions.map(formatRow);
    if (allRows.length <= maxRows)
        return ["models", ...allRows].join("\n");
    const headCount = Math.max(1, maxRows - (currentIndex >= maxRows - 1 ? 2 : 1));
    const rows = allRows.slice(0, headCount);
    if (currentIndex >= headCount) {
        rows.push(`  … ${currentIndex - headCount + 1} hidden before current`);
        rows.push(allRows[currentIndex]);
    }
    const hiddenBelow = allRows.length - (currentIndex >= headCount ? currentIndex + 1 : rows.length);
    if (hiddenBelow > 0)
        rows.push(`  … ${hiddenBelow} more`);
    return ["models", ...rows].join("\n");
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
function maskSecret(value) {
    if (!value)
        return "missing";
    if (value.length <= 8)
        return "***";
    return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
function visibleInput(input) {
    return input.replace(/^(\/provider\s+(?:key|api-key)\s+).+$/i, "$1***");
}
function tokenizeRawInput(text) {
    const tokens = [];
    for (let index = 0; index < text.length;) {
        const char = text[index];
        if (char === "\u001b" && text[index + 1] === "[" && "ABCD".includes(text[index + 2] ?? "")) {
            tokens.push(text.slice(index, index + 3));
            index += 3;
            continue;
        }
        if (char === "\u0003" || char === "\t" || char === "\r" || char === "\n" || char === "\u007f" || char === "\b") {
            tokens.push(char);
            index += 1;
            continue;
        }
        let end = index + 1;
        while (end < text.length) {
            const next = text[end];
            if (next === "\u001b" || next === "\u0003" || next === "\t" || next === "\r" || next === "\n" || next === "\u007f" || next === "\b")
                break;
            end += 1;
        }
        tokens.push(text.slice(index, end));
        index = end;
    }
    return tokens;
}
function providerStatus(options) {
    return [
        `provider url: ${options.baseUrl}`,
        `provider key: ${maskSecret(options.apiKey)}`,
        `config: ${options.configPath ?? (0, config_1.defaultConfigPath)()}`,
        "commands: /provider set <url> <key> <model> · /provider url <url> · /provider key <key> · /provider model <id|number> · /model [id|number] · /parallel <goal> :: <task> | <task>",
    ].join("\n");
}
function applyParallelSlashCommand(input, mode = "build", persist = true) {
    const trimmed = input.trim();
    if (!trimmed || !trimmed.includes("::")) {
        return "usage: /parallel <goal> :: <task one> | <task two>";
    }
    const [goal, taskText] = trimmed.split(/::(.+)/s).map((part) => part.trim());
    const tasks = (taskText || "").split("|").map((task) => task.trim()).filter(Boolean);
    if (!goal || tasks.length === 0)
        return "usage: /parallel <goal> :: <task one> | <task two>";
    const plan = (0, pi_workflow_1.buildSwarmPlan)(goal, tasks, { mode });
    const checkpointPath = persist ? (0, pi_workflow_1.persistSwarmPlan)(plan) : undefined;
    return (0, pi_workflow_1.renderSwarmPlan)(plan, checkpointPath);
}
async function applyModelCommand(options, env, value) {
    const trimmed = value.trim();
    const fetched = await fetchTuiModelsWithStatus(options);
    let next = fetched.options;
    const fetchNote = fetched.error ? `model list fetch failed: ${fetched.error}` : "model list refreshed";
    if (!trimmed) {
        return { options: next, message: `${fetchNote}\n${renderModelList(next)}` };
    }
    const switched = switchModel(next, trimmed);
    const saved = (0, config_1.saveOpenAIProviderConfig)(env, next.configPath, {
        model: switched.options.model,
        models: switched.options.modelOptions,
    });
    next = parseChatArgs([], env, saved, saved.path, false);
    return { options: next, message: `${fetchNote}\n${switched.message}\nprovider model saved to ${saved.path}` };
}
async function applyProviderCommand(options, env, value) {
    const trimmed = value.trim();
    if (!trimmed)
        return { options, message: providerStatus(options) };
    if (trimmed === "model" || trimmed === "models")
        return { options, message: renderModelList(options) };
    const modelMatch = trimmed.match(/^models?\s+(.+)$/i);
    if (modelMatch) {
        const switched = switchModel(options, modelMatch[1]);
        const saved = (0, config_1.saveOpenAIProviderConfig)(env, options.configPath, {
            model: switched.options.model,
            models: switched.options.modelOptions,
        });
        const next = parseChatArgs([], env, saved, saved.path, false);
        return { options: next, message: `${switched.message}\nprovider model saved to ${saved.path}` };
    }
    const setMatch = trimmed.match(/^set\s+(\S+)\s+(\S+)\s+(\S+)$/i);
    if (setMatch) {
        const [, baseUrl, apiKey, model] = setMatch;
        const saved = (0, config_1.saveOpenAIProviderConfig)(env, options.configPath, {
            base_url: baseUrl,
            api_key: apiKey,
            model,
            models: [model],
        });
        let next = parseChatArgs([], env, saved, saved.path, false);
        const hydrated = await hydrateTuiModelsWithStatus(next, false);
        next = hydrated.options;
        const fetchNote = hydrated.error ? `model list fetch failed: ${hydrated.error}` : "model list refreshed";
        return { options: next, message: `provider saved to ${saved.path}\n${fetchNote}\nmodel ${next.model}` };
    }
    const match = trimmed.match(/^(url|base-url|key|api-key)\s+(.+)$/i);
    if (!match) {
        return { options, message: "usage: /provider set <url> <key> <model> · /provider url <url> · /provider key <key> · /provider model <id|number>" };
    }
    const kind = match[1].toLowerCase();
    const rawValue = match[2].trim();
    if (!rawValue)
        return { options, message: "provider value cannot be empty" };
    const patch = kind === "url" || kind === "base-url" ? { base_url: rawValue } : { api_key: rawValue };
    const saved = (0, config_1.saveOpenAIProviderConfig)(env, options.configPath, patch);
    let next = parseChatArgs([], env, saved, saved.path, false);
    const hydrated = await hydrateTuiModelsWithStatus(next, false);
    next = hydrated.options;
    const label = kind === "url" || kind === "base-url" ? "url" : "key";
    const header = `provider ${label} saved to ${saved.path}`;
    if (next.modelOptions.length > 0) {
        return { options: next, message: `${header}\n${renderModelList(next)}` };
    }
    const failure = hydrated.error ? `model list fetch failed: ${hydrated.error}` : "no configured/fetched model list";
    return { options: next, message: `${header}\n${failure}` };
}
async function runChat(args, env, stdout, stderr) {
    let options;
    let loaded;
    try {
        const extracted = extractConfigPath(args);
        loaded = (0, config_1.loadConfig)(env, extracted.configPath);
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
    const messages = buildChatMessages(options);
    try {
        const provider = new openai_chat_1.OpenAIChatProvider({
            apiKey: options.apiKey,
            baseUrl: options.baseUrl,
            model: options.model,
            temperature: options.temperature,
            maxRetries: options.maxRetries,
            retryDelayMs: options.retryDelayMs,
            requestTimeoutMs: options.requestTimeoutMs,
        });
        const session = new session_1.AxumRuntimeSession({
            config: loaded?.config,
            provider,
            cwd: process.cwd(),
            mode: (0, kilo_shell_1.findMode)(loaded?.config).id,
            systemPrompt: options.system || defaultSystemPrompt(),
        });
        const result = await session.runUserTurn(options.prompt);
        if (options.json) {
            stdout.write(`${JSON.stringify({ ...result, submissions: session.submissionSnapshot() }, null, 2)}\n`);
        }
        else {
            stdout.write(`${result.assistantMessage}\n`);
        }
        return 0;
    }
    catch (error) {
        stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
    }
}
async function runDoctor(args, env, stdout, stderr) {
    try {
        const extracted = extractConfigPath(args);
        if (extracted.args.some((arg) => arg === "--help" || arg === "-h")) {
            stdout.write("Usage: axum doctor [--config <path>] [--json]\n");
            return 0;
        }
        const json = extracted.args.includes("--json");
        const doctorArgs = extracted.args.filter((arg) => arg !== "--json");
        const loaded = (0, config_1.loadConfig)(env, extracted.configPath);
        const options = parseChatArgs(doctorArgs, env, loaded, extracted.configPath, false);
        const report = {
            status: "pending",
            config: options.configPath,
            provider: options.providerId,
            providerUrl: options.baseUrl,
            providerKey: options.apiKey ? maskSecret(options.apiKey) : "missing",
            model: options.model,
        };
        const lines = [
            "AxumAgent doctor",
            `config: ${options.configPath}`,
            `provider: ${options.providerId}`,
            `provider url: ${options.baseUrl}`,
            `provider key: ${options.apiKey ? maskSecret(options.apiKey) : "missing"}`,
            `model: ${options.model}`,
        ];
        const writeReport = (exitCode) => {
            if (json)
                stdout.write(`${JSON.stringify(report, null, 2)}\n`);
            else
                stdout.write(`${lines.join("\n")}\n`);
            return exitCode;
        };
        if (!options.apiKey) {
            const error = `missing API key: set config api_key, provider_config, or ${options.apiKeyEnv}`;
            report.status = "failed";
            report.error = error;
            lines.push("status: failed", error);
            return writeReport(2);
        }
        const provider = new openai_chat_1.OpenAIChatProvider({
            baseUrl: options.baseUrl,
            apiKey: options.apiKey,
            model: options.model,
            maxRetries: 0,
            retryDelayMs: options.retryDelayMs,
            requestTimeoutMs: options.requestTimeoutMs,
        });
        try {
            const models = await provider.listModels();
            const warning = models.length > 0 && !models.includes(options.model) ? "configured model was not returned by /models" : undefined;
            report.status = "ok";
            report.modelsEndpoint = "ok";
            report.modelCount = models.length;
            if (models.length > 0)
                report.firstModel = models[0];
            if (warning)
                report.warning = warning;
            lines.push(`models endpoint: ok (${models.length})`);
            if (models.length > 0)
                lines.push(`first model: ${models[0]}`);
            if (warning)
                lines.push(`warning: ${warning}`);
            lines.push("status: ok");
            return writeReport(0);
        }
        catch (error) {
            const modelsMessage = error instanceof Error ? error.message : String(error);
            report.modelsEndpoint = "failed";
            report.modelsError = modelsMessage;
            lines.push("models endpoint: failed", modelsMessage);
            try {
                const chatProbe = await provider.chat([{ role: "user", content: "Reply with OK only." }]);
                report.status = "ok";
                report.chatEndpoint = "ok";
                report.chatProbe = chatProbe.content.slice(0, 80);
                report.warning = "/models failed, but /chat/completions succeeded";
                lines.push("chat endpoint: ok", "warning: /models failed, but /chat/completions succeeded", "status: ok");
                return writeReport(0);
            }
            catch (chatError) {
                const chatMessage = chatError instanceof Error ? chatError.message : String(chatError);
                report.status = "failed";
                report.chatEndpoint = "failed";
                report.chatError = chatMessage;
                report.error = chatMessage;
                lines.push("chat endpoint: failed", chatMessage, "status: failed");
                return writeReport(1);
            }
        }
    }
    catch (error) {
        if (error instanceof HelpRequested) {
            stdout.write("Usage: axum doctor [--config <path>] [--json]\n");
            return 0;
        }
        stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 2;
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
            requestTimeoutMs: options.requestTimeoutMs,
        });
        const result = await provider.chat(buildChatMessages(options));
        return { answer: result.content, exitCode: 0 };
    }
    catch (error) {
        return { answer: error instanceof Error ? error.message : String(error), exitCode: 1 };
    }
}
async function resolveTuiAnswerStream(options, dryRun, onDelta, signal) {
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
            requestTimeoutMs: options.requestTimeoutMs,
        });
        let streamed = "";
        const result = await provider.chatStream(buildChatMessages(options), (delta) => {
            streamed += delta;
            onDelta(streamed);
        }, signal);
        return { answer: result.content, exitCode: 0 };
    }
    catch (error) {
        return { answer: error instanceof Error ? error.message : String(error), exitCode: 1 };
    }
}
const importEsm = new Function("specifier", "return import(specifier)");
async function loadPiTui() {
    return importEsm("@earendil-works/pi-tui");
}
async function runRawInteractiveTui(options, dryRun, _stdout, useAltScreen) {
    const pi = await loadPiTui();
    const terminal = new pi.ProcessTerminal();
    const tui = new pi.TUI(terminal);
    let screenOptions = { ...options, prompt: "" };
    let answer;
    let status;
    let lastExitCode = 0;
    let input = "";
    let cursorIndex = 0;
    let slashSelection = 0;
    const inputHistory = [];
    let historyIndex;
    let draftInputBeforeHistory = "";
    let stopped = false;
    let busy = false;
    let activeRequestController;
    let isBracketedPaste = false;
    let pasteBuffer = "";
    const normalizePastedInput = (value) => value
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/\t/g, "    ")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
    const insertInputText = (value) => {
        const printable = normalizePastedInput(value);
        if (!printable)
            return;
        resetHistoryRecall();
        input = `${input.slice(0, cursorIndex)}${printable}${input.slice(cursorIndex)}`;
        cursorIndex += printable.length;
        slashSelection = 0;
        requestRender();
    };
    const recordInputHistory = (value) => {
        const trimmed = value.trim();
        if (!trimmed || trimmed === "/exit" || trimmed === "/quit")
            return;
        if (inputHistory.at(-1) !== trimmed)
            inputHistory.push(trimmed);
        historyIndex = undefined;
        draftInputBeforeHistory = "";
    };
    const recallPreviousInput = () => {
        if (inputHistory.length === 0)
            return;
        if (historyIndex === undefined) {
            draftInputBeforeHistory = input;
            historyIndex = inputHistory.length - 1;
        }
        else {
            historyIndex = Math.max(0, historyIndex - 1);
        }
        input = inputHistory[historyIndex];
        cursorIndex = input.length;
        slashSelection = 0;
    };
    const recallNextInput = () => {
        if (historyIndex === undefined)
            return;
        if (historyIndex >= inputHistory.length - 1) {
            historyIndex = undefined;
            input = draftInputBeforeHistory;
            cursorIndex = input.length;
            draftInputBeforeHistory = "";
        }
        else {
            historyIndex += 1;
            input = inputHistory[historyIndex];
            cursorIndex = input.length;
        }
        slashSelection = 0;
    };
    const resetHistoryRecall = () => {
        historyIndex = undefined;
        draftInputBeforeHistory = "";
    };
    const requestRender = () => tui.requestRender();
    const stop = (code = lastExitCode) => {
        if (stopped)
            return;
        stopped = true;
        lastExitCode = code;
        tui.stop();
    };
    class AxumPiTuiApp {
        focused = false;
        invalidate() { }
        render(width) {
            const lines = renderTuiScreen(screenOptions, answer, width, input, slashSelection, cursorIndex, terminal.rows, status).split("\n");
            return lines.map((line) => {
                const truncated = pi.truncateToWidth(line, width);
                return truncated + " ".repeat(Math.max(0, width - pi.visibleWidth(truncated)));
            });
        }
        handleInput(data) {
            void handlePiInput(data);
        }
    }
    const app = new AxumPiTuiApp();
    async function submitPrompt(prompt) {
        if (!prompt) {
            requestRender();
            return;
        }
        if (prompt === "/exit" || prompt === "/quit") {
            stop(lastExitCode);
            return;
        }
        if (prompt === "/help") {
            answer = "commands: /help · /provider set <url> <key> <model> · /provider [url|key|model] · /model [id|number] · /parallel <goal> :: <task> | <task> · /exit (/quit)";
            status = undefined;
            requestRender();
            return;
        }
        if (prompt === "/parallel" || prompt.startsWith("/parallel ")) {
            answer = applyParallelSlashCommand(prompt.slice("/parallel".length), "build", !dryRun);
            status = undefined;
            requestRender();
            return;
        }
        if (prompt === "/model" || prompt.startsWith("/model ")) {
            const applied = await applyModelCommand(screenOptions, process.env, prompt.slice("/model".length));
            screenOptions = { ...applied.options, prompt: "" };
            options = { ...applied.options, prompt: options.prompt };
            answer = applied.message;
            status = undefined;
            requestRender();
            return;
        }
        if (prompt === "/provider" || prompt.startsWith("/provider ")) {
            const applied = await applyProviderCommand(screenOptions, process.env, prompt.slice("/provider".length));
            screenOptions = { ...applied.options, prompt: "" };
            options = { ...applied.options, prompt: options.prompt };
            answer = applied.message;
            status = undefined;
            requestRender();
            return;
        }
        if (prompt.startsWith("/")) {
            answer = renderSlashCommandSuggestions(prompt, terminal.columns).join("\n");
            status = undefined;
            requestRender();
            return;
        }
        recordInputHistory(prompt);
        screenOptions = { ...options, prompt };
        if (dryRun) {
            answer = "dry-run: provider call skipped";
            status = undefined;
            lastExitCode = 0;
            requestRender();
            return;
        }
        busy = true;
        activeRequestController = new AbortController();
        const startedAt = Date.now();
        status = workingStatus(startedAt);
        requestRender();
        const timer = setInterval(() => {
            status = workingStatus(startedAt);
            requestRender();
        }, 250);
        try {
            const result = await resolveTuiAnswerStream(screenOptions, dryRun, (streamed) => {
                answer = streamed;
                requestRender();
            }, activeRequestController.signal);
            const wasCancelled = activeRequestController.signal.aborted;
            answer = wasCancelled ? "request cancelled; ready for the next prompt" : result.answer;
            status = undefined;
            lastExitCode = wasCancelled ? 0 : result.exitCode;
        }
        finally {
            activeRequestController = undefined;
            busy = false;
            status = undefined;
            clearInterval(timer);
            requestRender();
        }
    }
    async function handlePiInput(data) {
        if (busy && (pi.matchesKey(data, pi.Key.ctrl("c")) || data === "\u001b")) {
            activeRequestController?.abort();
            status = "• Cancelling request…";
            requestRender();
            return;
        }
        if (pi.matchesKey(data, pi.Key.ctrl("c"))) {
            stop(lastExitCode);
            return;
        }
        if (busy)
            return;
        const pasteStart = "[200~";
        const pasteEnd = "[201~";
        if (isBracketedPaste || data.includes(pasteStart)) {
            let chunk = data;
            if (!isBracketedPaste) {
                const startIndex = data.indexOf(pasteStart);
                insertInputText(data.slice(0, startIndex));
                chunk = data.slice(startIndex + pasteStart.length);
                pasteBuffer = "";
                isBracketedPaste = true;
            }
            pasteBuffer += chunk;
            const endIndex = pasteBuffer.indexOf(pasteEnd);
            if (endIndex === -1)
                return;
            insertInputText(pasteBuffer.slice(0, endIndex));
            const remaining = pasteBuffer.slice(endIndex + pasteEnd.length);
            pasteBuffer = "";
            isBracketedPaste = false;
            if (remaining)
                await handlePiInput(remaining);
            return;
        }
        if (pi.matchesKey(data, pi.Key.tab) && input.startsWith("/")) {
            const completed = completeSlashCommand(input, slashSelection);
            if (completed) {
                input = completed;
                cursorIndex = input.length;
                slashSelection = 0;
            }
            requestRender();
            return;
        }
        if (pi.matchesKey(data, pi.Key.up)) {
            if (historyIndex === undefined && input.startsWith("/")) {
                const matches = matchingSlashCommands(input);
                slashSelection = matches.length === 0 ? 0 : (slashSelection + matches.length - 1) % matches.length;
            }
            else {
                recallPreviousInput();
            }
            requestRender();
            return;
        }
        if (pi.matchesKey(data, pi.Key.down)) {
            if (historyIndex === undefined && input.startsWith("/")) {
                const matches = matchingSlashCommands(input);
                slashSelection = matches.length === 0 ? 0 : (slashSelection + 1) % matches.length;
            }
            else {
                recallNextInput();
            }
            requestRender();
            return;
        }
        if (pi.matchesKey(data, pi.Key.left)) {
            cursorIndex = Math.max(0, cursorIndex - 1);
            requestRender();
            return;
        }
        if (pi.matchesKey(data, pi.Key.right)) {
            cursorIndex = Math.min(input.length, cursorIndex + 1);
            requestRender();
            return;
        }
        if (pi.matchesKey(data, pi.Key.backspace)) {
            resetHistoryRecall();
            if (cursorIndex > 0) {
                input = `${input.slice(0, cursorIndex - 1)}${input.slice(cursorIndex)}`;
                cursorIndex -= 1;
            }
            slashSelection = 0;
            requestRender();
            return;
        }
        if (pi.matchesKey(data, pi.Key.enter)) {
            const prompt = input.trim();
            input = "";
            cursorIndex = 0;
            slashSelection = 0;
            resetHistoryRecall();
            await submitPrompt(prompt);
            return;
        }
        if (data.startsWith("\u001b"))
            return;
        insertInputText(data);
    }
    tui.addChild(app);
    tui.setFocus(app);
    if (useAltScreen)
        terminal.write("\u001b[?1049h");
    terminal.write("\u001b[?2004h");
    const exitCode = await new Promise((resolve) => {
        const originalStop = tui.stop.bind(tui);
        tui.stop = () => {
            originalStop();
            terminal.write("\u001b[?2004l");
            if (useAltScreen)
                terminal.write("\u001b[?1049l");
            resolve(lastExitCode);
        };
        tui.start();
    });
    return exitCode;
}
async function runLineInteractiveTui(options, dryRun, stdout) {
    const repaint = (screenOptions, answer, input = "") => {
        stdout.write(`${renderTuiScreen(screenOptions, answer, terminalWidth(stdout), input, 0, input.length, stdout.rows || 24)}\n`);
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
            stdout.write("commands: /help · /provider set <url> <key> <model> · /provider [url|key|model] · /model [id|number] · /parallel <goal> :: <task> | <task> · /exit (/quit)\n");
            rl.prompt();
            continue;
        }
        if (prompt === "/parallel" || prompt.startsWith("/parallel ")) {
            stdout.write(`${applyParallelSlashCommand(prompt.slice("/parallel".length), "build", !dryRun)}\n`);
            rl.prompt();
            continue;
        }
        if (prompt === "/model" || prompt.startsWith("/model ")) {
            const applied = await applyModelCommand(options, process.env, prompt.slice("/model".length));
            options = applied.options;
            stdout.write(`${applied.message}\n`);
            rl.prompt();
            continue;
        }
        if (prompt === "/provider" || prompt.startsWith("/provider ")) {
            const applied = await applyProviderCommand(options, process.env, prompt.slice("/provider".length));
            options = applied.options;
            stdout.write(`${applied.message}\n`);
            rl.prompt();
            continue;
        }
        if (prompt.startsWith("/")) {
            stdout.write(`${renderSlashCommandSuggestions(prompt, terminalWidth(stdout)).join("\n")}\n`);
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
            const timer = setInterval(() => repaint(nextOptions, workingStatus(startedAt)), 250);
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
    stdout.write(`${renderTuiScreen(options, result.answer, terminalWidth(stdout), "", 0, 0, stdout.rows || 24)}\n`);
    return result.exitCode;
}
function parseModeArgs(args) {
    let configPath;
    let json = false;
    let mode;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === "--config") {
            configPath = takeValue(args, i, arg);
            i += 1;
        }
        else if (arg === "--json") {
            json = true;
        }
        else if (arg === "--mode") {
            mode = takeValue(args, i, arg);
            i += 1;
        }
        else if (arg === "--help" || arg === "-h") {
            throw new HelpRequested();
        }
        else {
            throw new Error(`unknown modes option: ${arg}`);
        }
    }
    return { configPath, json, mode };
}
async function runModes(args, env, stdout, stderr) {
    try {
        const options = parseModeArgs(args);
        const loaded = (0, config_1.loadConfig)(env, options.configPath);
        if (options.json) {
            const mode = options.mode ? (0, kilo_shell_1.findMode)(loaded?.config, options.mode) : undefined;
            stdout.write(`${JSON.stringify(mode ? { mode } : { modes: (0, kilo_shell_1.renderModeList)(loaded?.config).split("\n") }, null, 2)}\n`);
        }
        else if (options.mode) {
            const mode = (0, kilo_shell_1.findMode)(loaded?.config, options.mode);
            stdout.write(`${mode.id}\n${mode.description}\ntools: ${mode.tools.join(", ") || "none"}\n`);
        }
        else {
            stdout.write(`${(0, kilo_shell_1.renderModeList)(loaded?.config)}\n`);
        }
        return 0;
    }
    catch (error) {
        if (error instanceof HelpRequested) {
            stdout.write("Usage: axum modes [--config <path>] [--mode <id>] [--json]\n");
            return 0;
        }
        stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 2;
    }
}
function parseWorkflowArgs(args) {
    let configPath;
    let mode;
    let dryRun = false;
    let verbose = false;
    const rest = [];
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === "--config") {
            configPath = takeValue(args, i, arg);
            i += 1;
        }
        else if (arg === "--mode") {
            mode = takeValue(args, i, arg);
            i += 1;
        }
        else if (arg === "--dry-run") {
            dryRun = true;
        }
        else if (arg === "--verbose") {
            verbose = true;
        }
        else if (arg === "--help" || arg === "-h") {
            throw new HelpRequested();
        }
        else if (arg.startsWith("--")) {
            throw new Error(`unknown workflow option: ${arg}`);
        }
        else {
            rest.push(arg);
        }
    }
    return { configPath, mode, dryRun, verbose, prompt: rest.join(" ").trim() };
}
function writeWorkflowRender(stdout, plan, checkpointPath, verbose) {
    for (const line of (0, pi_workflow_1.renderWorkflowPlan)(plan, checkpointPath, { verbose }).split("\n")) {
        stdout.write(`${line}\n`);
    }
}
async function runWorkflow(args, env, stdout, stderr) {
    try {
        const options = parseWorkflowArgs(args);
        const loaded = (0, config_1.loadConfig)(env, options.configPath);
        const plan = (0, pi_workflow_1.buildWorkflowPlan)(loaded?.config, options.prompt, { mode: options.mode });
        const checkpointPath = options.dryRun ? undefined : (0, pi_workflow_1.persistWorkflowPlan)(plan);
        writeWorkflowRender(stdout, plan, checkpointPath, options.verbose);
        return 0;
    }
    catch (error) {
        if (error instanceof HelpRequested) {
            stdout.write("Usage: axum workflow [--config <path>] [--mode <id>] [--dry-run] [--verbose] <prompt>\n");
            return 0;
        }
        stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 2;
    }
}
function parseParallelArgs(args) {
    let configPath;
    let mode;
    let dryRun = false;
    const tasks = [];
    const rest = [];
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === "--config") {
            configPath = takeValue(args, i, arg);
            i += 1;
        }
        else if (arg === "--mode") {
            mode = takeValue(args, i, arg);
            i += 1;
        }
        else if (arg === "--task") {
            tasks.push(takeValue(args, i, arg));
            i += 1;
        }
        else if (arg === "--dry-run") {
            dryRun = true;
        }
        else if (arg === "--help" || arg === "-h") {
            throw new HelpRequested();
        }
        else if (arg.startsWith("--")) {
            throw new Error(`unknown parallel option: ${arg}`);
        }
        else {
            rest.push(arg);
        }
    }
    return { configPath, mode, dryRun, prompt: rest.join(" ").trim(), tasks };
}
async function runParallel(args, env, stdout, stderr) {
    try {
        const options = parseParallelArgs(args);
        const loaded = (0, config_1.loadConfig)(env, options.configPath);
        const mode = (0, kilo_shell_1.findMode)(loaded?.config, options.mode).id;
        const plan = (0, pi_workflow_1.buildSwarmPlan)(options.prompt, options.tasks, { mode });
        const checkpointPath = options.dryRun ? undefined : (0, pi_workflow_1.persistSwarmPlan)(plan);
        stdout.write(`${(0, pi_workflow_1.renderSwarmPlan)(plan, checkpointPath)}\n`);
        return 0;
    }
    catch (error) {
        if (error instanceof HelpRequested) {
            stdout.write("Usage: axum parallel [--config <path>] [--mode <id>] [--dry-run] --task <prompt> --task <prompt> <goal>\n");
            return 0;
        }
        stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 2;
    }
}
async function runAxumCli(args, env = process.env, stdout = process.stdout, stderr = process.stderr) {
    if (args[0] === "--version" || args[0] === "-v") {
        stdout.write(`${packageVersion()}\n`);
        return { handled: true, exitCode: 0 };
    }
    if (args[0] === "init") {
        return { handled: true, exitCode: await runInit(args.slice(1), env, stdout, stderr) };
    }
    if (args[0] === "chat") {
        return { handled: true, exitCode: await runChat(args.slice(1), env, stdout, stderr) };
    }
    if (args[0] === "tui") {
        return { handled: true, exitCode: await runTui(args.slice(1), env, stdout, stderr) };
    }
    if (args[0] === "doctor") {
        return { handled: true, exitCode: await runDoctor(args.slice(1), env, stdout, stderr) };
    }
    if (args[0] === "providers") {
        return { handled: true, exitCode: await runProviders(args.slice(1), env, stdout, stderr) };
    }
    if (args[0] === "modes") {
        return { handled: true, exitCode: await runModes(args.slice(1), env, stdout, stderr) };
    }
    if (args[0] === "workflow") {
        return { handled: true, exitCode: await runWorkflow(args.slice(1), env, stdout, stderr) };
    }
    if (args[0] === "parallel") {
        return { handled: true, exitCode: await runParallel(args.slice(1), env, stdout, stderr) };
    }
    if (args[0] === "config-web") {
        return { handled: true, exitCode: await runConfigWeb(args.slice(1), env, stdout, stderr) };
    }
    if (args[0] === "--help" || args[0] === "-h" || args.length === 0) {
        stdout.write(`${renderHelp()}\n`);
        return { handled: args.length === 0 || args[0] === "--help" || args[0] === "-h", exitCode: 0 };
    }
    stderr.write(`unknown command: ${args[0]}\n`);
    stderr.write("Run `axum --help`.\n");
    return { handled: true, exitCode: 2 };
}
