import { defaultConfigPath, loadConfig, numberFromConfig, resolveSecret, selectedProvider, type LoadedConfig } from "./config";
import { OpenAIChatProvider, type ChatMessage } from "./providers/openai-chat";

export interface AxumCliResult {
  handled: boolean;
  exitCode: number;
}

interface ChatCommandOptions {
  prompt: string;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
  apiKey?: string;
  system?: string;
  temperature?: number;
  maxRetries: number;
  retryDelayMs: number;
  configPath?: string;
  json: boolean;
}

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_API_KEY_ENV = "OPENAI_API_KEY";
const DEFAULT_MAX_RETRIES = 10;
const DEFAULT_RETRY_DELAY_MS = 250;

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseTemperature(value: string): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 2) {
    throw new Error("--temperature must be a number between 0 and 2");
  }
  return num;
}

function parseNonNegativeInteger(value: string, flag: string): number {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return num;
}

function extractConfigPath(args: string[]): { configPath?: string; args: string[] } {
  const next: string[] = [];
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--config") {
      configPath = takeValue(args, i, arg);
      i += 1;
    } else {
      next.push(arg);
    }
  }
  return { configPath, args: next };
}

function parseChatArgs(args: string[], env: NodeJS.ProcessEnv, loaded?: LoadedConfig, configPath?: string): ChatCommandOptions {
  const config = loaded?.config;
  const provider = selectedProvider(config).config;
  const rest: string[] = [];
  let model = config?.model || provider?.model || env.AXUM_MODEL || DEFAULT_MODEL;
  let baseUrl = provider?.base_url || provider?.baseUrl || env.AXUM_OPENAI_BASE_URL || env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
  let apiKeyEnv = provider?.api_key_env || provider?.apiKeyEnv || env.AXUM_OPENAI_API_KEY_ENV || DEFAULT_API_KEY_ENV;
  let apiKey: string | undefined = resolveSecret(provider?.api_key || provider?.apiKey, env);
  let system: string | undefined;
  let temperature: number | undefined;
  let maxRetries = numberFromConfig(provider?.max_retries ?? provider?.maxRetries) ?? (env.AXUM_OPENAI_MAX_RETRIES
    ? parseNonNegativeInteger(env.AXUM_OPENAI_MAX_RETRIES, "AXUM_OPENAI_MAX_RETRIES")
    : DEFAULT_MAX_RETRIES);
  let retryDelayMs = numberFromConfig(provider?.retry_delay_ms ?? provider?.retryDelayMs) ?? (env.AXUM_OPENAI_RETRY_DELAY_MS
    ? parseNonNegativeInteger(env.AXUM_OPENAI_RETRY_DELAY_MS, "AXUM_OPENAI_RETRY_DELAY_MS")
    : DEFAULT_RETRY_DELAY_MS);
  let json = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--model" || arg === "-m") {
      model = takeValue(args, i, arg);
      i += 1;
    } else if (arg === "--base-url") {
      baseUrl = takeValue(args, i, arg);
      i += 1;
    } else if (arg === "--api-key-env") {
      apiKeyEnv = takeValue(args, i, arg);
      i += 1;
    } else if (arg === "--api-key") {
      apiKey = takeValue(args, i, arg);
      i += 1;
    } else if (arg === "--system") {
      system = takeValue(args, i, arg);
      i += 1;
    } else if (arg === "--temperature") {
      temperature = parseTemperature(takeValue(args, i, arg));
      i += 1;
    } else if (arg === "--max-retries") {
      maxRetries = parseNonNegativeInteger(takeValue(args, i, arg), arg);
      i += 1;
    } else if (arg === "--retry-delay-ms") {
      retryDelayMs = parseNonNegativeInteger(takeValue(args, i, arg), arg);
      i += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new HelpRequested();
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown chat option: ${arg}`);
    } else {
      rest.push(arg);
    }
  }

  const prompt = rest.join(" ").trim();
  if (!prompt) throw new Error("chat prompt is required");

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

export function renderHelp(): string {
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
    `  Default path: ${defaultConfigPath()}`,
  ].join("\n");
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function clip(text: string, width: number): string {
  const plain = stripAnsi(text);
  if (plain.length <= width) return text + " ".repeat(width - plain.length);
  return plain.slice(0, Math.max(0, width - 1)) + "…";
}

function box(title: string, lines: string[], width = 78): string {
  const inner = width - 4;
  const top = `╭─ ${title} ${"─".repeat(Math.max(0, inner - title.length - 1))}╮`;
  const body = lines.map((line) => `│ ${clip(line, inner)} │`);
  const bottom = `╰${"─".repeat(width - 2)}╯`;
  return [top, ...body, bottom].join("\n");
}

function renderTuiScreen(options: ChatCommandOptions, answer?: string): string {
  return [
    box("AxumAgent", [
      "pi-style terminal workspace",
      `model: ${options.model}`,
      `base_url: ${options.baseUrl}`,
      `config: ${options.configPath || defaultConfigPath()}`,
      `retries: ${options.maxRetries} · retry_delay_ms: ${options.retryDelayMs}`,
    ]),
    box("Prompt", [options.prompt || "(empty)" ]),
    box("Assistant", [answer || "dry-run: provider call skipped"]),
    box("Keys", ["Enter: send · Ctrl+C: exit · /help: commands"]),
  ].join("\n");
}

async function runChat(args: string[], env: NodeJS.ProcessEnv, stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream): Promise<number> {
  let options: ChatCommandOptions;
  try {
    const extracted = extractConfigPath(args);
    const loaded = loadConfig(env, extracted.configPath);
    options = parseChatArgs(extracted.args, env, loaded, extracted.configPath);
  } catch (error) {
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

  const messages: ChatMessage[] = [];
  if (options.system) messages.push({ role: "system", content: options.system });
  messages.push({ role: "user", content: options.prompt });

  try {
    const provider = new OpenAIChatProvider({
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
    } else {
      stdout.write(`${result.content}\n`);
    }
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runTui(args: string[], env: NodeJS.ProcessEnv, stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const filteredArgs = args.filter((arg) => arg !== "--dry-run");
  let options: ChatCommandOptions;
  try {
    const extracted = extractConfigPath(filteredArgs);
    const loaded = loadConfig(env, extracted.configPath);
    const promptArgs = extracted.args.length > 0 ? extracted.args : ["(waiting for input)"];
    options = parseChatArgs(promptArgs, env, loaded, extracted.configPath);
  } catch (error) {
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

  const messages: ChatMessage[] = [{ role: "user", content: options.prompt }];
  try {
    const provider = new OpenAIChatProvider({
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
  } catch (error) {
    stdout.write(`${renderTuiScreen(options, error instanceof Error ? error.message : String(error))}\n`);
    return 1;
  }
}

export async function runAxumCli(args: string[], env = process.env, stdout = process.stdout, stderr = process.stderr): Promise<AxumCliResult> {
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
