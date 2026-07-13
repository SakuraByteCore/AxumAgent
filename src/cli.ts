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

function parseChatArgs(args: string[], env: NodeJS.ProcessEnv): ChatCommandOptions {
  const rest: string[] = [];
  let model = env.AXUM_MODEL || DEFAULT_MODEL;
  let baseUrl = env.AXUM_OPENAI_BASE_URL || env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
  let apiKeyEnv = env.AXUM_OPENAI_API_KEY_ENV || DEFAULT_API_KEY_ENV;
  let apiKey: string | undefined;
  let system: string | undefined;
  let temperature: number | undefined;
  let maxRetries = env.AXUM_OPENAI_MAX_RETRIES
    ? parseNonNegativeInteger(env.AXUM_OPENAI_MAX_RETRIES, "AXUM_OPENAI_MAX_RETRIES")
    : DEFAULT_MAX_RETRIES;
  let retryDelayMs = env.AXUM_OPENAI_RETRY_DELAY_MS
    ? parseNonNegativeInteger(env.AXUM_OPENAI_RETRY_DELAY_MS, "AXUM_OPENAI_RETRY_DELAY_MS")
    : DEFAULT_RETRY_DELAY_MS;
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
    "",
    "Chat options:",
    "  -m, --model <id>          Model id (default: AXUM_MODEL or gpt-4o-mini)",
    "      --base-url <url>      OpenAI-compatible base URL (default: AXUM_OPENAI_BASE_URL, OPENAI_BASE_URL, or https://api.openai.com/v1)",
    "      --api-key-env <name>  Environment variable that holds the API key (default: OPENAI_API_KEY)",
    "      --api-key <value>     API key value; prefer env in normal use",
    "      --system <text>       Optional system message",
    "      --temperature <0..2>  Optional temperature",
    "      --max-retries <n>     Retry transient failures (default: AXUM_OPENAI_MAX_RETRIES or 10)",
    "      --retry-delay-ms <n>  Base retry delay in milliseconds (default: AXUM_OPENAI_RETRY_DELAY_MS or 250)",
    "      --json                Print provider result as JSON",
    "  -h, --help               Show this help",
    "",
    "Environment:",
    "  OPENAI_API_KEY, AXUM_MODEL, AXUM_OPENAI_BASE_URL, AXUM_OPENAI_API_KEY_ENV, AXUM_OPENAI_MAX_RETRIES, AXUM_OPENAI_RETRY_DELAY_MS",
  ].join("\n");
}

async function runChat(args: string[], env: NodeJS.ProcessEnv, stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream): Promise<number> {
  let options: ChatCommandOptions;
  try {
    options = parseChatArgs(args, env);
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

export async function runAxumCli(args: string[], env = process.env, stdout = process.stdout, stderr = process.stderr): Promise<AxumCliResult> {
  if (args[0] === "chat") {
    return { handled: true, exitCode: await runChat(args.slice(1), env, stdout, stderr) };
  }
  if (args[0] === "--help" || args[0] === "-h" || args.length === 0) {
    stdout.write(`${renderHelp()}\n`);
    return { handled: args.length === 0 || args[0] === "--help" || args[0] === "-h", exitCode: 0 };
  }
  stderr.write(`unknown command: ${args[0]}\n`);
  stderr.write("Run `axum --help`.\n");
  return { handled: true, exitCode: 2 };
}
