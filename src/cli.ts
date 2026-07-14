import { defaultConfigPath, loadConfig, numberFromConfig, resolveSecret, selectedProvider, type LoadedConfig } from "./config";
import { OpenAIChatProvider, type ChatMessage } from "./providers/openai-chat";
import { createInterface } from "node:readline/promises";

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

function parseChatArgs(args: string[], env: NodeJS.ProcessEnv, loaded?: LoadedConfig, configPath?: string, requirePrompt = true): ChatCommandOptions {
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
  if (requirePrompt && !prompt) throw new Error("chat prompt is required");

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
    "      --no-alt-screen       Keep terminal scrollback instead of using the alternate screen (tui only)",
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

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/g).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) {
      line = word;
    } else if (`${line} ${word}`.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function framed(lines: string[], width = 88): string {
  const inner = width - 4;
  return lines.map((line) => `│ ${clip(line, inner)} │`).join("\n");
}

function terminalWidth(stdout: NodeJS.WriteStream): number {
  const columns = stdout.columns || 88;
  return Math.max(72, Math.min(columns, 110));
}

function renderTuiScreen(options: ChatCommandOptions, answer: string | undefined, width = 88, input = ""): string {
  const inner = width - 4;
  const answerText = answer || "dry-run: provider call skipped";
  const promptLines = wrap(options.prompt || "(empty)", inner - 6).map((line) => `  ${line}`);
  const answerLines = wrap(answerText, inner - 6).map((line) => `  ${line}`);
  const configPath = options.configPath || defaultConfigPath();
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

async function resolveTuiAnswer(options: ChatCommandOptions, dryRun: boolean): Promise<{ answer: string; exitCode: number }> {
  if (dryRun) return { answer: "dry-run: provider call skipped", exitCode: 0 };
  if (!options.apiKey) {
    return { answer: "missing API key; set config api_key or api_key = \"env:OPENAI_API_KEY\"", exitCode: 2 };
  }
  try {
    const provider = new OpenAIChatProvider({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      model: options.model,
      temperature: options.temperature,
      maxRetries: options.maxRetries,
      retryDelayMs: options.retryDelayMs,
    });
    const result = await provider.chat([{ role: "user", content: options.prompt }]);
    return { answer: result.content, exitCode: 0 };
  } catch (error) {
    return { answer: error instanceof Error ? error.message : String(error), exitCode: 1 };
  }
}

async function runRawInteractiveTui(options: ChatCommandOptions, dryRun: boolean, stdout: NodeJS.WriteStream, useAltScreen: boolean): Promise<number> {
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
  let input = "";
  let screenOptions = { ...options, prompt: "(type a message)" };
  let answer = "waiting for input";
  let lastExitCode = 0;
  const repaint = (): void => {
    stdout.write("\u001b[2J\u001b[H");
    stdout.write(`${renderTuiScreen(screenOptions, answer, terminalWidth(stdout), input)}\n`);
  };

  if (useAltScreen) stdout.write("\u001b[?1049h");
  stdin.setRawMode?.(true);
  stdin.resume();
  repaint();
  try {
    while (true) {
      const chunk = await new Promise<Buffer>((resolve) => stdin.once("data", resolve));
      const text = chunk.toString("utf8");
      if (text === "\u0003") return lastExitCode;
      if (text === "\r" || text === "\n") {
        const prompt = input.trim();
        input = "";
        if (!prompt) {
          repaint();
          continue;
        }
        if (prompt === "/exit" || prompt === "/quit") return lastExitCode;
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
      if (text.startsWith("\u001b")) continue;
      input += text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
      repaint();
    }
  } finally {
    stdin.setRawMode?.(false);
    if (useAltScreen) stdout.write("\u001b[?1049l");
  }
}

async function runLineInteractiveTui(options: ChatCommandOptions, dryRun: boolean, stdout: NodeJS.WriteStream): Promise<number> {
  const repaint = (screenOptions: ChatCommandOptions, answer: string, input = ""): void => {
    stdout.write(`${renderTuiScreen(screenOptions, answer, terminalWidth(stdout), input)}\n`);
  };

  repaint({ ...options, prompt: "(type a message)" }, "waiting for input");
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "› " });
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

async function runTui(args: string[], env: NodeJS.ProcessEnv, stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const noAltScreen = args.includes("--no-alt-screen");
  const filteredArgs = args.filter((arg) => arg !== "--dry-run" && arg !== "--no-alt-screen");
  let options: ChatCommandOptions;
  let hasPrompt = false;
  try {
    const extracted = extractConfigPath(filteredArgs);
    const loaded = loadConfig(env, extracted.configPath);
    hasPrompt = extracted.args.length > 0;
    options = parseChatArgs(extracted.args, env, loaded, extracted.configPath, hasPrompt);
  } catch (error) {
    if (error instanceof HelpRequested) {
      stdout.write(`${renderHelp()}\n`);
      return 0;
    }
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (!hasPrompt) {
    if (stdout.isTTY && process.stdin.isTTY) return runRawInteractiveTui(options, dryRun, stdout, !noAltScreen);
    return runLineInteractiveTui(options, dryRun, stdout);
  }

  const result = await resolveTuiAnswer(options, dryRun);
  stdout.write(`${renderTuiScreen(options, result.answer, terminalWidth(stdout))}\n`);
  return result.exitCode;
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
