import { defaultConfigPath, loadConfig, numberFromConfig, resolveConfigPath, resolveSecret, saveOpenAIProviderConfig, selectedProvider, type LoadedConfig } from "./config";
import { OpenAIChatProvider, type ChatMessage } from "./providers/openai-chat";
import { createInterface } from "node:readline/promises";
import type { Component as PiComponent, Focusable as PiFocusable } from "@earendil-works/pi-tui";

export interface AxumCliResult {
  handled: boolean;
  exitCode: number;
}

interface ChatCommandOptions {
  prompt: string;
  model: string;
  modelOptions: string[];
  modelWasExplicit: boolean;
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

function hasPositionalPrompt(args: string[]): boolean {
  const flagsWithValues = new Set(["--model", "-m", "--base-url", "--api-key-env", "--api-key", "--system", "--temperature", "--max-retries", "--retry-delay-ms"]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (flagsWithValues.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    return true;
  }
  return false;
}

function parseChatArgs(args: string[], env: NodeJS.ProcessEnv, loaded?: LoadedConfig, configPath?: string, requirePrompt = true): ChatCommandOptions {
  const config = loaded?.config;
  const provider = selectedProvider(config).config;
  const rest: string[] = [];
  const configuredModels = [...(config?.models ?? []), ...(provider?.models ?? [])].filter((model): model is string => typeof model === "string" && model.length > 0);
  let model = config?.model || provider?.model || configuredModels[0] || env.AXUM_MODEL || DEFAULT_MODEL;
  let modelWasExplicit = Boolean(config?.model || provider?.model || configuredModels[0] || env.AXUM_MODEL);
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
      modelWasExplicit = true;
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
    modelOptions: configuredModels,
    modelWasExplicit,
    baseUrl,
    apiKeyEnv,
    apiKey: apiKey || env[apiKeyEnv],
    system,
    temperature,
    maxRetries,
    retryDelayMs,
    configPath: loaded?.path || resolveConfigPath(env, configPath),
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

const SLASH_COMMANDS = [
  { name: "/help", description: "show commands" },
  { name: "/provider", description: "show/set provider and model" },
  { name: "/exit", aliases: ["/quit"], description: "exit TUI" },
];

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

function wrapPreservingShortLine(text: string, width: number): string[] {
  return stripAnsi(text).length <= width ? [text] : wrap(text, width);
}

function slashCommandQuery(input: string): string {
  if (!input.startsWith("/")) return "";
  return input.slice(1).trimStart().split(/\s+/)[0] ?? "";
}

function slashCommandLabels(command: (typeof SLASH_COMMANDS)[number]): string[] {
  return [command.name, ...(command.aliases ?? [])];
}

function slashCommandDisplayName(command: (typeof SLASH_COMMANDS)[number]): string {
  return slashCommandLabels(command).join(" / ");
}

function matchingSlashCommands(input: string): typeof SLASH_COMMANDS {
  if (!input.startsWith("/")) return [];
  const query = slashCommandQuery(input);
  return SLASH_COMMANDS.filter((command) => slashCommandLabels(command).some((label) => label.slice(1).startsWith(query)));
}

function clampSelection(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(index, count - 1));
}

function completeSlashCommand(input: string, selectedIndex: number): string | undefined {
  const matches = matchingSlashCommands(input);
  const selected = matches[clampSelection(selectedIndex, matches.length)];
  if (!selected) return undefined;
  const query = slashCommandQuery(input);
  const completed = slashCommandLabels(selected).find((label) => label.slice(1).startsWith(query)) ?? selected.name;
  return `${completed} `;
}

function padCell(text: string, width: number): string {
  const plain = stripAnsi(text);
  if (plain.length <= width) return text + " ".repeat(width - plain.length);
  return plain.slice(0, Math.max(0, width - 1)) + "…";
}

function renderSlashCommandSuggestions(input: string, width: number, selectedIndex = 0): string[] {
  if (!input.startsWith("/")) return [];
  const matches = matchingSlashCommands(input);
  if (matches.length === 0) return ["⌘ commands", "  no matching commands"];

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

function terminalWidth(stdout: NodeJS.WriteStream): number {
  const columns = stdout.columns || 88;
  return Math.max(72, Math.min(columns, 110));
}

function renderTuiScreen(options: ChatCommandOptions, answer: string | undefined, width = 88, input = "", slashSelection = 0, cursorIndex = input.length): string {
  const inner = width - 4;
  const hasPrompt = options.prompt.trim().length > 0;
  const workingMatch = answer?.match(/^working:(\d+)$/);
  const isThinking = workingMatch !== undefined && workingMatch !== null;
  const workingSeconds = workingMatch ? workingMatch[1] : "0";
  const hasAnswer = answer !== undefined && !isThinking;
  const promptLines = hasPrompt ? options.prompt.split(/\n/).flatMap((line) => wrap(line, inner - 6)).map((line) => `  ${line}`) : [];
  const answerLines = hasAnswer ? answer.split(/\n/).flatMap((line) => wrapPreservingShortLine(line, inner - 6)).map((line) => `  ${line}`) : [];
  const headerLines = [
    "✦ AxumAgent v0.1.0",
    `  model ${options.model}    cwd ${process.cwd()}    mode YOLO`,
  ];
  const cursor = "█";
  const safeInput = visibleInput(input);
  const safeCursorIndex = safeInput === input ? clampSelection(cursorIndex, input.length + 1) : safeInput.length;
  const inputText = `${safeInput.slice(0, safeCursorIndex)}${cursor}${safeInput.slice(safeCursorIndex)}`;
  const inputLines = wrap(inputText, inner - 4);
  const renderedInput = inputLines.map((line, index) => `${index === 0 ? "▌" : " "} ${line}`);
  const statusLine = `${options.model} · ${process.cwd()}`;
  const conversationLines: string[] = [];
  if (hasPrompt || hasAnswer || isThinking) {
    if (hasPrompt) conversationLines.push(...promptLines.map((line, index) => (index === 0 ? `›${line.slice(1)}` : line)));
    if (hasPrompt && hasAnswer) conversationLines.push("");
    if (hasAnswer) conversationLines.push(...answerLines);
    if (isThinking) conversationLines.push(...(hasPrompt || hasAnswer ? [""] : []), `• Working (${workingSeconds}s • esc to interrupt)`);
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

function workingStatus(startedAt: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  return `working:${elapsedSeconds}`;
}


function uniqueModels(models: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const model of models) {
    const trimmed = model.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

async function hydrateTuiModels(options: ChatCommandOptions, dryRun: boolean): Promise<ChatCommandOptions> {
  return (await hydrateTuiModelsWithStatus(options, dryRun)).options;
}

async function hydrateTuiModelsWithStatus(options: ChatCommandOptions, dryRun: boolean): Promise<{ options: ChatCommandOptions; error?: string }> {
  const configured = uniqueModels(options.modelOptions);
  if (configured.length > 0) {
    return { options: { ...options, modelOptions: configured, model: options.modelWasExplicit ? options.model : configured[0] } };
  }
  if (dryRun || !options.apiKey) return { options: { ...options, modelOptions: configured } };
  try {
    const provider = new OpenAIChatProvider({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      model: options.model,
      temperature: options.temperature,
      maxRetries: options.maxRetries,
      retryDelayMs: options.retryDelayMs,
    });
    const fetched = uniqueModels(await provider.listModels());
    if (fetched.length === 0) return { options: { ...options, modelOptions: fetched }, error: "provider returned an empty model list" };
    return { options: { ...options, modelOptions: fetched, model: options.modelWasExplicit ? options.model : fetched[0] } };
  } catch (error) {
    return { options: { ...options, modelOptions: configured }, error: error instanceof Error ? error.message : String(error) };
  }
}

function renderModelList(options: ChatCommandOptions): string {
  if (options.modelOptions.length === 0) return `models\n  no configured/fetched model list`;
  const numberWidth = String(options.modelOptions.length).length;
  const rows = options.modelOptions.map((model, index) => {
    const current = model === options.model ? "▸" : " ";
    const suffix = model === options.model ? "  current" : "";
    return `${current} ${String(index + 1).padStart(numberWidth)}  ${model}${suffix}`;
  });
  return ["models", ...rows].join("\n");
}

function switchModel(options: ChatCommandOptions, value: string): { options: ChatCommandOptions; message: string } {
  const target = value.trim();
  if (!target) return { options, message: renderModelList(options) };
  const index = Number(target);
  const selected = Number.isInteger(index) && index >= 1 ? options.modelOptions[index - 1] : target;
  if (!selected) return { options, message: `model index out of range: ${target}` };
  const modelOptions = options.modelOptions.includes(selected) ? options.modelOptions : [...options.modelOptions, selected];
  return { options: { ...options, model: selected, modelOptions, modelWasExplicit: true }, message: `model switched to ${selected}` };
}


function maskSecret(value: string | undefined): string {
  if (!value) return "missing";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function visibleInput(input: string): string {
  return input.replace(/^(\/provider\s+(?:key|api-key)\s+).+$/i, "$1***");
}

function tokenizeRawInput(text: string): string[] {
  const tokens: string[] = [];
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
      if (next === "\u001b" || next === "\u0003" || next === "\t" || next === "\r" || next === "\n" || next === "\u007f" || next === "\b") break;
      end += 1;
    }
    tokens.push(text.slice(index, end));
    index = end;
  }
  return tokens;
}

function providerStatus(options: ChatCommandOptions): string {
  return [
    `provider url: ${options.baseUrl}`,
    `provider key: ${maskSecret(options.apiKey)}`,
    `config: ${options.configPath ?? defaultConfigPath()}`,
    "commands: /provider url <url> · /provider key <key> · /provider model <id|number> · /provider models",
  ].join("\n");
}

async function applyProviderCommand(options: ChatCommandOptions, env: NodeJS.ProcessEnv, value: string): Promise<{ options: ChatCommandOptions; message: string }> {
  const trimmed = value.trim();
  if (!trimmed) return { options, message: providerStatus(options) };
  if (trimmed === "model" || trimmed === "models") return { options, message: renderModelList(options) };
  const modelMatch = trimmed.match(/^models?\s+(.+)$/i);
  if (modelMatch) {
    const switched = switchModel(options, modelMatch[1]);
    const saved = saveOpenAIProviderConfig(env, options.configPath, {
      model: switched.options.model,
      models: switched.options.modelOptions,
    });
    const next = parseChatArgs([], env, saved, saved.path, false);
    return { options: next, message: `${switched.message}\nprovider model saved to ${saved.path}` };
  }
  const match = trimmed.match(/^(url|base-url|key|api-key)\s+(.+)$/i);
  if (!match) {
    return { options, message: "usage: /provider url <url> · /provider key <key> · /provider model <id|number> · /provider models" };
  }
  const kind = match[1].toLowerCase();
  const rawValue = match[2].trim();
  if (!rawValue) return { options, message: "provider value cannot be empty" };
  const patch = kind === "url" || kind === "base-url" ? { base_url: rawValue } : { api_key: rawValue };
  const saved = saveOpenAIProviderConfig(env, options.configPath, patch);
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

async function resolveTuiAnswerStream(options: ChatCommandOptions, dryRun: boolean, onDelta: (answer: string) => void): Promise<{ answer: string; exitCode: number }> {
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
    let streamed = "";
    const result = await provider.chatStream([{ role: "user", content: options.prompt }], (delta) => {
      streamed += delta;
      onDelta(streamed);
    });
    return { answer: result.content, exitCode: 0 };
  } catch (error) {
    return { answer: error instanceof Error ? error.message : String(error), exitCode: 1 };
  }
}

type PiTuiModule = typeof import("@earendil-works/pi-tui");
const importEsm = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<PiTuiModule>;

async function loadPiTui(): Promise<PiTuiModule> {
  return importEsm("@earendil-works/pi-tui");
}

async function runRawInteractiveTui(options: ChatCommandOptions, dryRun: boolean, _stdout: NodeJS.WriteStream, useAltScreen: boolean): Promise<number> {
  const pi = await loadPiTui();
  const terminal = new pi.ProcessTerminal();
  const tui = new pi.TUI(terminal);

  let screenOptions = { ...options, prompt: "" };
  let answer: string | undefined;
  let lastExitCode = 0;
  let input = "";
  let cursorIndex = 0;
  let slashSelection = 0;
  const inputHistory: string[] = [];
  let historyIndex: number | undefined;
  let draftInputBeforeHistory = "";
  let stopped = false;
  let busy = false;
  let isBracketedPaste = false;
  let pasteBuffer = "";

  const normalizePastedInput = (value: string): string => value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");

  const insertInputText = (value: string): void => {
    const printable = normalizePastedInput(value);
    if (!printable) return;
    resetHistoryRecall();
    input = `${input.slice(0, cursorIndex)}${printable}${input.slice(cursorIndex)}`;
    cursorIndex += printable.length;
    slashSelection = 0;
    requestRender();
  };

  const recordInputHistory = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "/exit" || trimmed === "/quit") return;
    if (inputHistory.at(-1) !== trimmed) inputHistory.push(trimmed);
    historyIndex = undefined;
    draftInputBeforeHistory = "";
  };
  const recallPreviousInput = (): void => {
    if (inputHistory.length === 0) return;
    if (historyIndex === undefined) {
      draftInputBeforeHistory = input;
      historyIndex = inputHistory.length - 1;
    } else {
      historyIndex = Math.max(0, historyIndex - 1);
    }
    input = inputHistory[historyIndex];
    cursorIndex = input.length;
    slashSelection = 0;
  };
  const recallNextInput = (): void => {
    if (historyIndex === undefined) return;
    if (historyIndex >= inputHistory.length - 1) {
      historyIndex = undefined;
      input = draftInputBeforeHistory;
      cursorIndex = input.length;
      draftInputBeforeHistory = "";
    } else {
      historyIndex += 1;
      input = inputHistory[historyIndex];
      cursorIndex = input.length;
    }
    slashSelection = 0;
  };
  const resetHistoryRecall = (): void => {
    historyIndex = undefined;
    draftInputBeforeHistory = "";
  };
  const requestRender = (): void => tui.requestRender();
  const stop = (code = lastExitCode): void => {
    if (stopped) return;
    stopped = true;
    lastExitCode = code;
    tui.stop();
  };

  class AxumPiTuiApp implements PiComponent, PiFocusable {
    focused = false;
    invalidate(): void {}
    render(width: number): string[] {
      const lines = renderTuiScreen(screenOptions, answer, width, input, slashSelection, cursorIndex).split("\n");
      return lines.map((line) => pi.truncateToWidth(line, width));
    }
    handleInput(data: string): void {
      void handlePiInput(data);
    }
  }

  const app = new AxumPiTuiApp();

  async function submitPrompt(prompt: string): Promise<void> {
    if (!prompt) {
      requestRender();
      return;
    }
    if (prompt === "/exit" || prompt === "/quit") {
      stop(lastExitCode);
      return;
    }
    if (prompt === "/help") {
      answer = "commands: /help · /provider [url|key|model] · /exit (/quit)";
      requestRender();
      return;
    }
    if (prompt === "/provider" || prompt.startsWith("/provider ")) {
      const applied = await applyProviderCommand(screenOptions, process.env, prompt.slice("/provider".length));
      screenOptions = { ...applied.options, prompt: "" };
      options = { ...applied.options, prompt: options.prompt };
      answer = applied.message;
      requestRender();
      return;
    }
    if (prompt.startsWith("/")) {
      answer = renderSlashCommandSuggestions(prompt, terminal.columns).join("\n");
      requestRender();
      return;
    }

    recordInputHistory(prompt);
    screenOptions = { ...options, prompt };
    if (dryRun) {
      answer = "dry-run: provider call skipped";
      lastExitCode = 0;
      requestRender();
      return;
    }

    busy = true;
    const startedAt = Date.now();
    answer = workingStatus(startedAt);
    requestRender();
    const timer = setInterval(() => {
      answer = workingStatus(startedAt);
      requestRender();
    }, 250);
    try {
      const result = await resolveTuiAnswerStream(screenOptions, dryRun, (streamed) => {
        answer = streamed;
        requestRender();
      });
      answer = result.answer;
      lastExitCode = result.exitCode;
    } finally {
      busy = false;
      clearInterval(timer);
      requestRender();
    }
  }

  async function handlePiInput(data: string): Promise<void> {
    if (pi.matchesKey(data, pi.Key.ctrl("c"))) {
      stop(lastExitCode);
      return;
    }
    if (busy) return;

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
      if (endIndex === -1) return;
      insertInputText(pasteBuffer.slice(0, endIndex));
      const remaining = pasteBuffer.slice(endIndex + pasteEnd.length);
      pasteBuffer = "";
      isBracketedPaste = false;
      if (remaining) await handlePiInput(remaining);
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
      } else {
        recallPreviousInput();
      }
      requestRender();
      return;
    }
    if (pi.matchesKey(data, pi.Key.down)) {
      if (historyIndex === undefined && input.startsWith("/")) {
        const matches = matchingSlashCommands(input);
        slashSelection = matches.length === 0 ? 0 : (slashSelection + 1) % matches.length;
      } else {
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
    if (data.startsWith("\u001b")) return;
    resetHistoryRecall();
    const printable = data.length === 1 ? data.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "") : "";
    if (!printable) return;
    input = `${input.slice(0, cursorIndex)}${printable}${input.slice(cursorIndex)}`;
    cursorIndex += printable.length;
    slashSelection = 0;
    requestRender();
  }

  tui.addChild(app);
  tui.setFocus(app);
  if (useAltScreen) terminal.write("\u001b[?1049h");
  const exitCode = await new Promise<number>((resolve) => {
    const originalStop = tui.stop.bind(tui);
    tui.stop = () => {
      originalStop();
      if (useAltScreen) terminal.write("\u001b[?1049l");
      resolve(lastExitCode);
    };
    tui.start();
  });
  return exitCode;
}

async function runLineInteractiveTui(options: ChatCommandOptions, dryRun: boolean, stdout: NodeJS.WriteStream): Promise<number> {
  const repaint = (screenOptions: ChatCommandOptions, answer: string | undefined, input = ""): void => {
    stdout.write(`${renderTuiScreen(screenOptions, answer, terminalWidth(stdout), input)}\n`);
  };

  repaint({ ...options, prompt: "" }, undefined);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "" });
  let lastExitCode = 0;
  rl.prompt();
  for await (const line of rl) {
    const prompt = line.trim();
    if (prompt === "/exit" || prompt === "/quit") {
      rl.close();
      return lastExitCode;
    }
    if (prompt === "/help") {
      stdout.write("commands: /help · /provider [url|key|model] · /exit (/quit)\n");
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
    } else {
      const startedAt = Date.now();
      repaint(nextOptions, workingStatus(startedAt));
      const timer = setInterval(() => repaint(nextOptions, workingStatus(startedAt)), 250);
      try {
        const result = await resolveTuiAnswerStream(nextOptions, dryRun, (streamed) => repaint(nextOptions, streamed));
        lastExitCode = result.exitCode;
        repaint(nextOptions, result.answer);
      } finally {
        clearInterval(timer);
      }
    }
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
    hasPrompt = hasPositionalPrompt(extracted.args);
    options = parseChatArgs(extracted.args, env, loaded, extracted.configPath, hasPrompt);
  } catch (error) {
    if (error instanceof HelpRequested) {
      stdout.write(`${renderHelp()}\n`);
      return 0;
    }
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  options = await hydrateTuiModels(options, dryRun);

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
