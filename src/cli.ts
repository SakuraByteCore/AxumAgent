import { defaultConfigPath, loadConfig, numberFromConfig, resolveConfigPath, resolveSecret, saveDefaultProvider, saveOpenAIProviderConfig, selectedProvider, type AxumConfig, type LoadedConfig } from "./config";
import { OpenAIChatProvider, type ChatMessage } from "./providers/openai-chat";
import { buildSwarmPlan, buildWorkflowPlan, persistSwarmPlan, persistWorkflowPlan, renderSwarmPlan, renderWorkflowPlan } from "./runtime/pi-workflow";
import { AxumRuntimeSession } from "./runtime/session";
import { renderRuntimeDashboard, renderRuntimeEvents } from "./runtime/events";
import { runtimeToolSpecs } from "./runtime/turn";
import { findMode, renderModeList } from "./shell/kilo-shell";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { Component as PiComponent } from "@earendil-works/pi-tui";

export interface AxumCliResult {
  handled: boolean;
  exitCode: number;
}

interface ChatCommandOptions {
  prompt: string;
  providerId: string;
  model: string;
  modelOptions: string[];
  modelWasExplicit: boolean;
  baseUrl: string;
  apiKeyEnv: string;
  apiKeySource: string;
  apiKey?: string;
  system?: string;
  temperature?: number;
  maxRetries: number;
  retryDelayMs: number;
  retryMinDelayMs: number;
  retryMaxDelayMs: number;
  requestTimeoutMs: number;
  configPath?: string;
  runtimeConfig?: AxumConfig;
  json: boolean;
}

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_API_KEY_ENV = "OPENAI_API_KEY";
const DEFAULT_MAX_RETRIES = 8;
const DEFAULT_RETRY_MIN_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 1500;
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
const DEFAULT_SYSTEM_PROMPT = [
  "You are AxumAgent, a concise terminal assistant.",
  "Answer in the user's language by default.",
  "For short, ambiguous, or chat-like inputs, respond naturally and briefly instead of expanding into a dictionary, encyclopedia, or list of interpretations.",
  "Only provide detailed explanations, examples, or multiple interpretations when the user asks for them.",
].join(" ");

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function defaultSystemPrompt(): string {
  return DEFAULT_SYSTEM_PROMPT;
}

function buildChatMessages(options: ChatCommandOptions): ChatMessage[] {
  const messages: ChatMessage[] = [];
  messages.push({ role: "system", content: options.system || defaultSystemPrompt() });
  messages.push({ role: "user", content: options.prompt });
  return messages;
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

function parseProviderConfigLine(value: string | undefined, source: string): { baseUrl?: string; apiKey?: string; model?: string } {
  if (!value) return {};
  const parts = value.trim().split(/\s+/g).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length < 3) throw new Error(`${source} must be: <base_url> <api_key|env:VAR> <model>`);
  const [baseUrl, apiKey, ...modelParts] = parts;
  const model = modelParts.join(" ").trim();
  if (!baseUrl || !apiKey || !model) throw new Error(`${source} must be: <base_url> <api_key|env:VAR> <model>`);
  return { baseUrl, apiKey, model };
}

function resolveApiKeyCandidate(value: string | undefined, env: NodeJS.ProcessEnv, fallbackEnv: string): { key?: string; source: string } {
  if (value?.startsWith("env:")) {
    const name = value.slice(4);
    const key = env[name];
    return { key, source: key ? `env:${name}` : `env:${name}:missing` };
  }
  if (value) return { key: value, source: "literal" };
  const key = env[fallbackEnv];
  return { key, source: key ? `env:${fallbackEnv}` : `env:${fallbackEnv}:missing` };
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
  const flagsWithValues = new Set(["--provider", "--model", "-m", "--base-url", "--api-key-env", "--api-key", "--system", "--temperature", "--max-retries", "--retry-delay-ms", "--retry-min-delay-ms", "--retry-max-delay-ms", "--request-timeout-ms"]);
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
  let providerId = config?.provider || "openai-chat";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--provider") {
      providerId = takeValue(args, i, args[i]);
      i += 1;
    }
  }
  if (config?.providers && !config.providers[providerId]) throw new Error(`provider not found in config: ${providerId}`);
  const provider = providerId === (config?.provider || "openai-chat") ? selectedProvider(config).config : config?.providers?.[providerId];
  const rest: string[] = [];
  const configuredModels = [...(provider?.models ?? []), ...(config?.models ?? [])].filter((model): model is string => typeof model === "string" && model.length > 0);
  const rootProviderLine = parseProviderConfigLine(config?.provider_config ?? config?.providerConfig, "provider_config");
  const providerLine = parseProviderConfigLine(provider?.provider_config ?? provider?.providerConfig, "providers.openai-chat.provider_config");
  const oneLineConfig = { ...rootProviderLine, ...providerLine };
  let model = provider?.model || oneLineConfig.model || config?.model || configuredModels[0] || env.AXUM_MODEL || DEFAULT_MODEL;
  let modelWasExplicit = Boolean(provider?.model || oneLineConfig.model || config?.model || configuredModels[0] || env.AXUM_MODEL);
  let baseUrl = provider?.base_url || provider?.baseUrl || oneLineConfig.baseUrl || env.AXUM_OPENAI_BASE_URL || env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
  let apiKeyEnv = provider?.api_key_env || provider?.apiKeyEnv || env.AXUM_OPENAI_API_KEY_ENV || DEFAULT_API_KEY_ENV;
  let apiKeyCandidate = provider?.api_key || provider?.apiKey || oneLineConfig.apiKey;
  let resolvedApiKey = resolveApiKeyCandidate(apiKeyCandidate, env, apiKeyEnv);
  let apiKey: string | undefined = resolvedApiKey.key;
  let apiKeySource = resolvedApiKey.source;
  let system: string | undefined;
  let temperature: number | undefined;
  let maxRetries = numberFromConfig(provider?.max_retries ?? provider?.maxRetries) ?? (env.AXUM_OPENAI_MAX_RETRIES
    ? parseNonNegativeInteger(env.AXUM_OPENAI_MAX_RETRIES, "AXUM_OPENAI_MAX_RETRIES")
    : DEFAULT_MAX_RETRIES);
  const legacyRetryDelayMs = numberFromConfig(provider?.retry_delay_ms ?? provider?.retryDelayMs) ?? (env.AXUM_OPENAI_RETRY_DELAY_MS
    ? parseNonNegativeInteger(env.AXUM_OPENAI_RETRY_DELAY_MS, "AXUM_OPENAI_RETRY_DELAY_MS")
    : undefined);
  let retryDelayMs = legacyRetryDelayMs ?? 0;
  let retryMinDelayMs = legacyRetryDelayMs ?? numberFromConfig(provider?.retry_min_delay_ms ?? provider?.retryMinDelayMs) ?? (env.AXUM_OPENAI_RETRY_MIN_DELAY_MS
    ? parseNonNegativeInteger(env.AXUM_OPENAI_RETRY_MIN_DELAY_MS, "AXUM_OPENAI_RETRY_MIN_DELAY_MS")
    : DEFAULT_RETRY_MIN_DELAY_MS);
  let retryMaxDelayMs = legacyRetryDelayMs ?? numberFromConfig(provider?.retry_max_delay_ms ?? provider?.retryMaxDelayMs) ?? (env.AXUM_OPENAI_RETRY_MAX_DELAY_MS
    ? parseNonNegativeInteger(env.AXUM_OPENAI_RETRY_MAX_DELAY_MS, "AXUM_OPENAI_RETRY_MAX_DELAY_MS")
    : DEFAULT_RETRY_MAX_DELAY_MS);
  let requestTimeoutMs = numberFromConfig(provider?.request_timeout_ms ?? provider?.requestTimeoutMs) ?? (env.AXUM_OPENAI_REQUEST_TIMEOUT_MS
    ? parseNonNegativeInteger(env.AXUM_OPENAI_REQUEST_TIMEOUT_MS, "AXUM_OPENAI_REQUEST_TIMEOUT_MS")
    : DEFAULT_REQUEST_TIMEOUT_MS);
  let json = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--provider") {
      i += 1;
    } else if (arg === "--model" || arg === "-m") {
      model = takeValue(args, i, arg);
      modelWasExplicit = true;
      i += 1;
    } else if (arg === "--base-url") {
      baseUrl = takeValue(args, i, arg);
      i += 1;
    } else if (arg === "--api-key-env") {
      apiKeyEnv = takeValue(args, i, arg);
      if (!apiKeyCandidate) {
        resolvedApiKey = resolveApiKeyCandidate(undefined, env, apiKeyEnv);
        apiKey = resolvedApiKey.key;
        apiKeySource = resolvedApiKey.source;
      }
      i += 1;
    } else if (arg === "--api-key") {
      apiKeyCandidate = takeValue(args, i, arg);
      resolvedApiKey = resolveApiKeyCandidate(apiKeyCandidate, env, apiKeyEnv);
      apiKey = resolvedApiKey.key;
      apiKeySource = resolvedApiKey.source;
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
      retryMinDelayMs = retryDelayMs;
      retryMaxDelayMs = retryDelayMs;
      i += 1;
    } else if (arg === "--retry-min-delay-ms") {
      retryMinDelayMs = parseNonNegativeInteger(takeValue(args, i, arg), arg);
      retryDelayMs = 0;
      i += 1;
    } else if (arg === "--retry-max-delay-ms") {
      retryMaxDelayMs = parseNonNegativeInteger(takeValue(args, i, arg), arg);
      retryDelayMs = 0;
      i += 1;
    } else if (arg === "--request-timeout-ms") {
      requestTimeoutMs = parseNonNegativeInteger(takeValue(args, i, arg), arg);
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
    providerId,
    model,
    modelOptions: configuredModels,
    modelWasExplicit,
    baseUrl,
    apiKeyEnv,
    apiKey,
    apiKeySource,
    system,
    temperature,
    maxRetries,
    retryDelayMs,
    retryMinDelayMs,
    retryMaxDelayMs,
    requestTimeoutMs,
    configPath: loaded?.path || resolveConfigPath(env, configPath),
    runtimeConfig: config,
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
    "      --max-retries <n>     Retry transient failures (default: AXUM_OPENAI_MAX_RETRIES or 8)",
    "      --retry-delay-ms <n>  Legacy fixed retry delay in milliseconds; overrides min/max when set",
    "      --retry-min-delay-ms <n>  Minimum retry delay in milliseconds (default: AXUM_OPENAI_RETRY_MIN_DELAY_MS or 500)",
    "      --retry-max-delay-ms <n>  Maximum retry delay in milliseconds (default: AXUM_OPENAI_RETRY_MAX_DELAY_MS or 1500)",
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
    "  OPENAI_API_KEY, AXUM_MODEL, AXUM_OPENAI_BASE_URL, AXUM_OPENAI_API_KEY_ENV, AXUM_OPENAI_MAX_RETRIES, AXUM_OPENAI_RETRY_MIN_DELAY_MS, AXUM_OPENAI_RETRY_MAX_DELAY_MS, AXUM_OPENAI_RETRY_DELAY_MS, AXUM_OPENAI_REQUEST_TIMEOUT_MS",
    "",
    "Config:",
    `  Default path: ${defaultConfigPath()}`,
  ].join("\n");
}

function parseInitArgs(args: string[]): { configPath?: string; baseUrl: string; apiKey: string; model: string; force: boolean } {
  let configPath: string | undefined;
  let baseUrl = DEFAULT_BASE_URL;
  let apiKey = `env:${DEFAULT_API_KEY_ENV}`;
  let model = DEFAULT_MODEL;
  let force = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--config") {
      configPath = takeValue(args, i, arg);
      i += 1;
    } else if (arg === "--provider-config") {
      const parsed = parseProviderConfigLine(takeValue(args, i, arg), arg);
      baseUrl = parsed.baseUrl ?? baseUrl;
      apiKey = parsed.apiKey ?? apiKey;
      model = parsed.model ?? model;
      i += 1;
    } else if (arg === "--base-url") {
      baseUrl = takeValue(args, i, arg);
      i += 1;
    } else if (arg === "--api-key") {
      apiKey = takeValue(args, i, arg);
      i += 1;
    } else if (arg === "--model" || arg === "-m") {
      model = takeValue(args, i, arg);
      i += 1;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new HelpRequested();
    } else {
      throw new Error(`unknown init option: ${arg}`);
    }
  }
  return { configPath, baseUrl, apiKey, model, force };
}

async function runInit(args: string[], env: NodeJS.ProcessEnv, stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream): Promise<number> {
  try {
    const options = parseInitArgs(args);
    const configPath = resolveConfigPath(env, options.configPath);
    const existedBefore = fs.existsSync(configPath);
    if (existedBefore && !options.force) {
      stdout.write(`axum config exists: ${configPath}\n`);
      stdout.write("Use --force to update provider URL/key/model.\n");
      return 0;
    }
    const saved = saveOpenAIProviderConfig(env, options.configPath, {
      base_url: options.baseUrl,
      api_key: options.apiKey,
      model: options.model,
      models: [options.model],
      max_retries: DEFAULT_MAX_RETRIES,
      retry_min_delay_ms: DEFAULT_RETRY_MIN_DELAY_MS,
      retry_max_delay_ms: DEFAULT_RETRY_MAX_DELAY_MS,
      request_timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
    });
    stdout.write(`axum config ${existedBefore ? "updated" : "created"}: ${saved.path}\n`);
    stdout.write(`provider: ${options.baseUrl}\n`);
    stdout.write(`model: ${options.model}\n`);
    stdout.write("Next: axum doctor && axum tui\n");
    return 0;
  } catch (error) {
    if (error instanceof HelpRequested) {
      stdout.write("Usage: axum init [--config <path>] [--provider-config '<url> <key|env:VAR> <model>'] [--base-url <url>] [--api-key <key|env:VAR>] [--model <id>] [--force]\n");
      return 0;
    }
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function packageVersion(): string {
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function apiKeyDisplay(value: string | undefined): string {
  if (!value) return "missing";
  if (value.startsWith("env:")) return value;
  return maskSecret(value);
}

function providerRows(env: NodeJS.ProcessEnv, explicitPath?: string): Array<Record<string, string | boolean>> {
  const loaded = loadConfig(env, explicitPath);
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

function renderProviderRows(env: NodeJS.ProcessEnv, explicitPath?: string): string {
  const rows = providerRows(env, explicitPath);
  return [
    "providers",
    ...rows.map((row, index) => {
      const mark = row.default ? "*" : " ";
      return `${mark} ${index + 1}. ${row.id}  ${row.baseUrl}  ${row.model}  key:${row.key}`;
    }),
    "use: /provider use <id|number>",
  ].join("\n");
}

async function runProviders(args: string[], env: NodeJS.ProcessEnv, stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream): Promise<number> {
  try {
    const extracted = extractConfigPath(args);
    if (extracted.args.some((arg) => arg === "--help" || arg === "-h")) {
      stdout.write("Usage: axum providers [--config <path>] [--json]\n");
      return 0;
    }
    const json = extracted.args.includes("--json");
    const unknown = extracted.args.find((arg) => arg !== "--json");
    if (unknown) throw new Error(`unknown providers option: ${unknown}`);
    const rows = providerRows(env, extracted.configPath);
    if (json) {
      stdout.write(`${JSON.stringify({ providers: rows }, null, 2)}\n`);
    } else {
      stdout.write("AxumAgent providers\n");
      for (const row of rows) {
        const mark = row.default ? "*" : " ";
        stdout.write(`${mark} ${row.id}  ${row.baseUrl}  ${row.model}  key:${row.key}\n`);
      }
    }
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function htmlEscape(value: string | undefined): string {
  return (value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function currentProviderFields(env: NodeJS.ProcessEnv, explicitPath?: string): { configPath: string; baseUrl: string; apiKey: string; model: string } {
  const loaded = loadConfig(env, explicitPath);
  const config = loaded?.config;
  const provider = selectedProvider(config).config;
  const rootProviderLine = parseProviderConfigLine(config?.provider_config ?? config?.providerConfig, "provider_config");
  const providerLine = parseProviderConfigLine(provider?.provider_config ?? provider?.providerConfig, "providers.openai-chat.provider_config");
  const oneLineConfig = { ...rootProviderLine, ...providerLine };
  return {
    configPath: loaded?.path ?? resolveConfigPath(env, explicitPath),
    baseUrl: provider?.base_url || provider?.baseUrl || oneLineConfig.baseUrl || env.AXUM_OPENAI_BASE_URL || env.OPENAI_BASE_URL || DEFAULT_BASE_URL,
    apiKey: provider?.api_key || provider?.apiKey || oneLineConfig.apiKey || `env:${provider?.api_key_env || provider?.apiKeyEnv || env.AXUM_OPENAI_API_KEY_ENV || DEFAULT_API_KEY_ENV}`,
    model: config?.model || provider?.model || oneLineConfig.model || (config?.models ?? [])[0] || (provider?.models ?? [])[0] || env.AXUM_MODEL || DEFAULT_MODEL,
  };
}

function renderConfigWebPage(fields: { configPath: string; baseUrl: string; apiKey: string; model: string }, message?: string): string {
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

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function parseConfigWebArgs(args: string[]): { host: string; port: number; configPath?: string } {
  let host = "127.0.0.1";
  let port = 8787;
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--host") {
      host = takeValue(args, i, arg);
      i += 1;
    } else if (arg === "--port") {
      port = parseNonNegativeInteger(takeValue(args, i, arg), arg);
      i += 1;
    } else if (arg === "--config") {
      configPath = takeValue(args, i, arg);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      throw new HelpRequested();
    } else {
      throw new Error(`unknown config-web option: ${arg}`);
    }
  }
  return { host, port, configPath };
}

async function runConfigWeb(args: string[], env: NodeJS.ProcessEnv, stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream): Promise<number> {
  try {
    const options = parseConfigWebArgs(args);
    const server = http.createServer(async (req, res) => {
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
          const saved = saveOpenAIProviderConfig(env, options.configPath, { base_url: baseUrl, api_key: apiKey, model, models: [model] });
          const html = renderConfigWebPage({ configPath: saved.path, baseUrl, apiKey, model }, "Saved");
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(html);
          return;
        }
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
      } catch (error) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(error instanceof Error ? error.message : String(error));
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, resolve);
    });
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : options.port;
    stdout.write(`AxumAgent config web listening on http://${options.host}:${actualPort}\n`);
    await new Promise<void>((resolve) => {
      const close = () => server.close(() => resolve());
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    });
    return 0;
  } catch (error) {
    if (error instanceof HelpRequested) {
      stdout.write("Usage: axum config-web [--host 127.0.0.1] [--port 8787] [--config <path>]\n");
      return 0;
    }
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function charDisplayWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0 || code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    (code >= 0x0300 && code <= 0x036f)
    || (code >= 0x1ab0 && code <= 0x1aff)
    || (code >= 0x1dc0 && code <= 0x1dff)
    || (code >= 0x20d0 && code <= 0x20ff)
    || (code >= 0xfe00 && code <= 0xfe0f)
  ) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f)
    || code === 0x2329
    || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
  ) return 2;
  return 1;
}

function visibleWidth(text: string): number {
  return Array.from(stripAnsi(text)).reduce((total, char) => total + charDisplayWidth(char), 0);
}

function truncateToVisibleWidth(text: string, width: number): string {
  if (width <= 0) return "";
  let used = 0;
  let result = "";
  for (const char of Array.from(stripAnsi(text))) {
    const charWidth = charDisplayWidth(char);
    if (used + charWidth > width) break;
    result += char;
    used += charWidth;
  }
  return result;
}

function clip(text: string, width: number): string {
  const textWidth = visibleWidth(text);
  if (textWidth <= width) return text + " ".repeat(width - textWidth);
  return `${truncateToVisibleWidth(text, Math.max(0, width - 1))}…`;
}

const SLASH_COMMANDS = [
  { name: "/help", description: "show commands" },
  { name: "/provider", description: "show/set provider url/key" },
  { name: "/providers", description: "list configured providers" },
  { name: "/model", description: "fetch/list/switch models" },
  { name: "/parallel", description: "plan sub-agent tasks" },
  { name: "/tasks", description: "show recent runtime/task state" },
  { name: "/exit", aliases: ["/quit"], description: "exit TUI" },
];

function wrap(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const words = text.split(/\s+/g).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) {
      line = word;
    } else if (visibleWidth(`${line} ${word}`) <= safeWidth) {
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
  return visibleWidth(text) <= width ? [text] : wrap(text, width);
}

function renderAssistantOutput(answer: string): string {
  if (answer === "dry-run: provider call skipped") return "✓ dry-run · provider call skipped";
  return answer;
}

function redactTuiText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer ***")
    .replace(/(api[_-]?key|token|secret|password)=([^\s&]+)/gi, "$1=***")
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "gh*_***")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "jwt.***");
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

function isCompleteSlashCommand(input: string): boolean {
  const trimmed = input.trim();
  return SLASH_COMMANDS.some((command) => slashCommandLabels(command).includes(trimmed));
}

function isBareSlashCommandQuery(input: string): boolean {
  return input.startsWith("/") && !/\s/.test(input.trim());
}

function padCell(text: string, width: number): string {
  const textWidth = visibleWidth(text);
  if (textWidth <= width) return text + " ".repeat(width - textWidth);
  return `${truncateToVisibleWidth(text, Math.max(0, width - 1))}…`;
}

function renderSlashCommandSuggestions(input: string, width: number, selectedIndex = 0): string[] {
  if (!input.startsWith("/")) return [];
  const matches = matchingSlashCommands(input);
  const bodyWidth = Math.max(24, width - 4);
  if (matches.length === 0) return framedSection("Commands", ["no matching commands"], width);

  const selected = clampSelection(selectedIndex, matches.length);
  const labelWidth = Math.min(
    Math.max(...matches.map((command) => slashCommandDisplayName(command).length), 10),
    Math.max(10, Math.floor(bodyWidth * 0.38)),
  );
  const rows = matches.map((command, index) => {
    const marker = index === selected ? "▸" : " ";
    const label = padCell(slashCommandDisplayName(command), labelWidth);
    return `${marker} ${label}  ${command.description}`;
  });
  return framedSection("Commands", rows, width);
}

function terminalWidth(stdout: NodeJS.WriteStream): number {
  const columns = stdout.columns || 88;
  return Math.max(72, Math.min(columns, 110));
}

function framedSection(title: string, body: string[], width: number): string[] {
  const safeWidth = Math.max(24, width);
  const inner = Math.max(1, safeWidth - 4);
  const titleText = ` ${title} `;
  const top = `╭─${titleText}${"─".repeat(Math.max(0, safeWidth - visibleWidth(titleText) - 3))}`;
  const bottom = `╰${"─".repeat(Math.max(0, safeWidth - 1))}`;
  const content = body.length === 0 ? [""] : body;
  return [
    clip(top, safeWidth),
    ...content.flatMap((line) => wrapPreservingShortLine(line, inner)).map((line) => `│ ${clip(line, inner)} │`),
    clip(bottom, safeWidth),
  ];
}

function renderPlainInputDeck(inputText: string, width: number): string[] {
  const safeWidth = Math.max(24, width);
  const horizontal = "─".repeat(safeWidth);
  return [
    horizontal,
    ...wrapPreservingShortLine(inputText, safeWidth).map((line) => clip(line, safeWidth)),
    horizontal,
  ];
}

function compactPathForTui(cwd: string, width: number): string {
  const name = path.basename(cwd) || cwd;
  const compact = `.${path.sep}${name}`;
  if (visibleWidth(compact) <= width) return compact;
  return `…${compact.slice(Math.max(0, compact.length - width + 1))}`;
}

function renderTranscriptLines(text: string, width: number): string[] {
  const inner = Math.max(1, width - 2);
  const lines = text.split(/\n/g);
  return lines.flatMap((line, index) => {
    const prefix = index === 0 ? "› " : "  ";
    return wrapPreservingShortLine(line, Math.max(1, inner - visibleWidth(prefix))).map((wrapped, wrappedIndex) => {
      const linePrefix = index === 0 && wrappedIndex === 0 ? prefix : "  ";
      return `${linePrefix}${wrapped}`;
    });
  });
}

function renderTuiScreen(options: ChatCommandOptions, answer: string | undefined, width = 88, input = "", slashSelection = 0, cursorIndex = input.length, height = 24, status: string | undefined = undefined, showInputPanel = true): string {
  const safeWidth = Math.max(36, width);
  const contentBudget = Math.max(4, height - 12);
  const hasPrompt = options.prompt.trim().length > 0;
  const hasAnswer = answer !== undefined;
  const hasStatus = status !== undefined;

  const header = framedSection("Session", [
    "◇ AxumAgent v0.1.0",
    `◌ ${options.model} · ${compactPathForTui(process.cwd(), safeWidth - 10)}`,
  ], safeWidth);

  const conversation: string[] = [];
  if (hasPrompt) {
    conversation.push(...renderTranscriptLines(options.prompt, safeWidth));
  }
  if (hasAnswer || hasStatus) {
    const rawLines = [
      ...(hasAnswer ? renderAssistantOutput(answer).split(/\n/g) : []),
      ...(hasStatus ? [status] : []),
    ];
    const wrapped = rawLines.flatMap((line) => wrapPreservingShortLine(line, Math.max(1, safeWidth - 4)));
    const clipped = wrapped.length > contentBudget
      ? [
        ...wrapped.slice(0, Math.max(1, contentBudget - 3)),
        `… ${wrapped.length - contentBudget + 1} more`,
        ...wrapped.slice(-2),
      ]
      : wrapped;
    conversation.push(...clipped);
  }

  const safeInput = visibleInput(input);
  const safeCursorIndex = safeInput === input ? clampSelection(cursorIndex, input.length + 1) : safeInput.length;
  const inputText = `${safeInput.slice(0, safeCursorIndex)}█${safeInput.slice(safeCursorIndex)}`;
  const inputPanel = showInputPanel ? renderPlainInputDeck(inputText || "█", safeWidth) : [];
  const commandLines = renderSlashCommandSuggestions(safeInput, safeWidth, slashSelection);

  const screen = [
    ...header,
    "",
    ...(conversation.length > 0 ? [...conversation, ""] : []),
    ...(commandLines.length > 0 ? [...commandLines, ""] : []),
    ...(inputPanel.length > 0 ? inputPanel : []),
  ];
  return screen.map((line) => clip(line, safeWidth)).join("\n");
}

export function formatElapsedDuration(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function workingStatus(startedAt: number): string {
  const elapsed = formatElapsedDuration(Date.now() - startedAt);
  return `• Working (${elapsed} • esc to interrupt)`;
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
      retryMinDelayMs: options.retryMinDelayMs,
      retryMaxDelayMs: options.retryMaxDelayMs,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    const fetched = uniqueModels(await provider.listModels());
    if (fetched.length === 0) return { options: { ...options, modelOptions: fetched }, error: "provider returned an empty model list" };
    return { options: { ...options, modelOptions: fetched, model: options.modelWasExplicit ? options.model : fetched[0] } };
  } catch (error) {
    return { options: { ...options, modelOptions: configured }, error: error instanceof Error ? error.message : String(error) };
  }
}

async function fetchTuiModelsWithStatus(options: ChatCommandOptions): Promise<{ options: ChatCommandOptions; error?: string }> {
  const configured = uniqueModels(options.modelOptions);
  if (!options.apiKey) return { options: { ...options, modelOptions: configured }, error: `missing API key: set ${options.apiKeyEnv} or /provider key <key>` };
  try {
    const provider = new OpenAIChatProvider({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      model: options.model,
      temperature: options.temperature,
      maxRetries: options.maxRetries,
      retryDelayMs: options.retryDelayMs,
      retryMinDelayMs: options.retryMinDelayMs,
      retryMaxDelayMs: options.retryMaxDelayMs,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    const fetched = uniqueModels(await provider.listModels());
    if (fetched.length === 0) return { options: { ...options, modelOptions: fetched }, error: "provider returned an empty model list" };
    return { options: { ...options, modelOptions: fetched, model: fetched.includes(options.model) ? options.model : fetched[0] } };
  } catch (error) {
    return { options: { ...options, modelOptions: configured }, error: error instanceof Error ? error.message : String(error) };
  }
}

function renderModelList(options: ChatCommandOptions, maxRows = 14): string {
  if (options.modelOptions.length === 0) return `models\n  no configured/fetched model list`;
  const numberWidth = String(options.modelOptions.length).length;
  const currentIndex = Math.max(0, options.modelOptions.indexOf(options.model));
  const formatRow = (model: string, index: number): string => {
    const current = model === options.model ? "▸" : " ";
    const suffix = model === options.model ? "  current" : "";
    return `${current} ${String(index + 1).padStart(numberWidth)}  ${model}${suffix}`;
  };
  const allRows = options.modelOptions.map(formatRow);
  if (allRows.length <= maxRows) return ["models", ...allRows].join("\n");

  const headCount = Math.max(1, maxRows - (currentIndex >= maxRows - 1 ? 2 : 1));
  const rows = allRows.slice(0, headCount);
  if (currentIndex >= headCount) {
    rows.push(`  … ${currentIndex - headCount + 1} hidden before current`);
    rows.push(allRows[currentIndex]);
  }
  const hiddenBelow = allRows.length - (currentIndex >= headCount ? currentIndex + 1 : rows.length);
  if (hiddenBelow > 0) rows.push(`  … ${hiddenBelow} more`);
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
    `provider key source: ${options.apiKeySource}`,
    `model ${options.model}`,
    `config: ${options.configPath ?? defaultConfigPath()}`,
    "commands: /providers · /provider use <id|number> · /provider set <url> <key> <model> · /provider url <url> · /provider key <key> · /provider model <id|number> · /model [id|number] · /parallel <goal> :: <task> | <task>",
  ].join("\n");
}

function applyParallelSlashCommand(input: string, mode = "build", persist = true): string {
  const trimmed = input.trim();
  if (!trimmed || !trimmed.includes("::")) {
    return "usage: /parallel <goal> :: <task one> | <task two>";
  }
  const [goal, taskText] = trimmed.split(/::(.+)/s).map((part) => part.trim());
  const tasks = (taskText || "").split("|").map((task) => task.trim()).filter(Boolean);
  if (!goal || tasks.length === 0) return "usage: /parallel <goal> :: <task one> | <task two>";
  const plan = buildSwarmPlan(goal, tasks, { mode });
  const checkpointPath = persist ? persistSwarmPlan(plan) : undefined;
  return renderSwarmPlan(plan, checkpointPath);
}

async function applyModelCommand(options: ChatCommandOptions, env: NodeJS.ProcessEnv, value: string): Promise<{ options: ChatCommandOptions; message: string }> {
  const trimmed = value.trim();
  const fetched = await fetchTuiModelsWithStatus(options);
  let next = fetched.options;
  const fetchNote = fetched.error ? `model list fetch failed: ${fetched.error}` : "model list refreshed";
  if (!trimmed) {
    return { options: next, message: `${fetchNote}\n${renderModelList(next)}` };
  }
  const switched = switchModel(next, trimmed);
  const saved = saveOpenAIProviderConfig(env, next.configPath, {
    model: switched.options.model,
    models: switched.options.modelOptions,
  });
  next = parseChatArgs([], env, saved, saved.path, false);
  return { options: next, message: `${fetchNote}\n${switched.message}\nprovider model saved to ${saved.path}` };
}

function applyProviderUseCommand(options: ChatCommandOptions, env: NodeJS.ProcessEnv, value: string): { options: ChatCommandOptions; message: string } {
  const target = value.trim();
  if (!target) return { options, message: renderProviderRows(env, options.configPath) };
  const rows = providerRows(env, options.configPath);
  const index = Number(target);
  const selected = Number.isInteger(index) && index >= 1 ? String(rows[index - 1]?.id ?? "") : target;
  if (!selected || !rows.some((row) => row.id === selected)) return { options, message: `provider not found: ${target}` };
  const saved = saveDefaultProvider(env, options.configPath, selected);
  const next = parseChatArgs(["--provider", selected], env, saved, saved.path, false);
  return { options: next, message: `provider switched to ${selected}\nmodel ${next.model}\nconfig: ${saved.path}` };
}

async function applyProviderCommand(options: ChatCommandOptions, env: NodeJS.ProcessEnv, value: string): Promise<{ options: ChatCommandOptions; message: string }> {
  const trimmed = value.trim();
  if (!trimmed) return { options, message: providerStatus(options) };
  if (trimmed === "list" || trimmed === "profiles" || trimmed === "providers") return { options, message: renderProviderRows(env, options.configPath) };
  const useMatch = trimmed.match(/^use\s+(.+)$/i);
  if (useMatch) return applyProviderUseCommand(options, env, useMatch[1]);
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
  const setMatch = trimmed.match(/^set\s+(\S+)\s+(\S+)\s+(\S+)$/i);
  if (setMatch) {
    const [, baseUrl, apiKey, model] = setMatch;
    const saved = saveOpenAIProviderConfig(env, options.configPath, {
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
  let loaded: LoadedConfig | undefined;
  try {
    const extracted = extractConfigPath(args);
    loaded = loadConfig(env, extracted.configPath);
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

  const messages = buildChatMessages(options);

  try {
    const provider = new OpenAIChatProvider({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      model: options.model,
      temperature: options.temperature,
      maxRetries: options.maxRetries,
      retryDelayMs: options.retryDelayMs,
      retryMinDelayMs: options.retryMinDelayMs,
      retryMaxDelayMs: options.retryMaxDelayMs,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    const session = new AxumRuntimeSession({
      config: loaded?.config,
      provider,
      cwd: process.cwd(),
      mode: findMode(loaded?.config).id,
      systemPrompt: options.system || defaultSystemPrompt(),
    });
    const result = await session.runUserTurn(options.prompt);
    if (options.json) {
      stdout.write(`${JSON.stringify({ ...result, submissions: session.submissionSnapshot() }, null, 2)}\n`);
    } else {
      stdout.write(`${result.assistantMessage}\n`);
    }
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function providerDebugPreview(options: ChatCommandOptions): Record<string, unknown> {
  return {
    models: {
      method: "GET",
      url: `${options.baseUrl.replace(/\/+$/, "")}/models`,
      headers: {
        Authorization: options.apiKey ? `Bearer ${maskSecret(options.apiKey)}` : "missing",
        Accept: "application/json",
      },
    },
    chat: {
      method: "POST",
      url: `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      headers: {
        Authorization: options.apiKey ? `Bearer ${maskSecret(options.apiKey)}` : "missing",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: {
        model: options.model,
        messages: "<system + user probe>",
        stream: false,
      },
    },
  };
}

async function runDoctor(args: string[], env: NodeJS.ProcessEnv, stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream): Promise<number> {
  try {
    const extracted = extractConfigPath(args);
    if (extracted.args.some((arg) => arg === "--help" || arg === "-h")) {
      stdout.write("Usage: axum doctor [--config <path>] [--json]\n");
      return 0;
    }
    const json = extracted.args.includes("--json");
    const doctorArgs = extracted.args.filter((arg) => arg !== "--json");
    const loaded = loadConfig(env, extracted.configPath);
    const options = parseChatArgs(doctorArgs, env, loaded, extracted.configPath, false);
    const report: Record<string, unknown> = {
      status: "pending",
      config: options.configPath,
      provider: options.providerId,
      providerUrl: options.baseUrl,
      providerKey: options.apiKey ? maskSecret(options.apiKey) : "missing",
      providerKeySource: options.apiKeySource,
      model: options.model,
      requestPreview: providerDebugPreview(options),
    };
    const lines = [
      "AxumAgent doctor",
      `config: ${options.configPath}`,
      `provider: ${options.providerId}`,
      `provider url: ${options.baseUrl}`,
      `provider key: ${options.apiKey ? maskSecret(options.apiKey) : "missing"}`,
      `provider key source: ${options.apiKeySource}`,
      `model: ${options.model}`,
      `models request: GET ${options.baseUrl.replace(/\/+$/, "")}/models`,
      `chat request: POST ${options.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    ];
    const writeReport = (exitCode: number) => {
      if (json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else stdout.write(`${lines.join("\n")}\n`);
      return exitCode;
    };
    if (!options.apiKey) {
      const error = `missing API key: set config api_key, provider_config, or ${options.apiKeyEnv}`;
      report.status = "failed";
      report.error = error;
      lines.push("status: failed", error);
      return writeReport(2);
    }
    const provider = new OpenAIChatProvider({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
      maxRetries: 0,
      retryDelayMs: options.retryDelayMs,
      retryMinDelayMs: options.retryMinDelayMs,
      retryMaxDelayMs: options.retryMaxDelayMs,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    const runRuntimeProbe = async (): Promise<void> => {
      const mode = findMode(loaded?.config);
      const result = await provider.chatWithTools([{ role: "user", content: "Reply with OK only." }], runtimeToolSpecs(mode.tools));
      report.runtimeEndpoint = "ok";
      report.runtimeProbe = result.content.slice(0, 80);
      if (result.warnings?.length) {
        report.runtimeWarnings = result.warnings;
        lines.push(...result.warnings.map((warning) => `runtime warning: ${warning}`));
      }
      lines.push("runtime/tui request: ok");
    };
    try {
      const models = await provider.listModels();
      const warning = models.length > 0 && !models.includes(options.model) ? "configured model was not returned by /models" : undefined;
      report.status = "ok";
      report.modelsEndpoint = "ok";
      report.modelCount = models.length;
      if (models.length > 0) report.firstModel = models[0];
      if (warning) report.warning = warning;
      lines.push(`models endpoint: ok (${models.length})`);
      if (models.length > 0) lines.push(`first model: ${models[0]}`);
      if (warning) lines.push(`warning: ${warning}`);
      try {
        await runRuntimeProbe();
      } catch (runtimeError) {
        const runtimeMessage = runtimeError instanceof Error ? runtimeError.message : String(runtimeError);
        report.status = "failed";
        report.runtimeEndpoint = "failed";
        report.runtimeError = runtimeMessage;
        report.error = runtimeMessage;
        lines.push("runtime/tui request: failed", runtimeMessage, "status: failed");
        return writeReport(1);
      }
      lines.push("status: ok");
      return writeReport(0);
    } catch (error) {
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
        lines.push("chat endpoint: ok", "warning: /models failed, but /chat/completions succeeded");
        try {
          await runRuntimeProbe();
        } catch (runtimeError) {
          const runtimeMessage = runtimeError instanceof Error ? runtimeError.message : String(runtimeError);
          report.status = "failed";
          report.runtimeEndpoint = "failed";
          report.runtimeError = runtimeMessage;
          report.error = runtimeMessage;
          lines.push("runtime/tui request: failed", runtimeMessage, "status: failed");
          return writeReport(1);
        }
        lines.push("status: ok");
        return writeReport(0);
      } catch (chatError) {
        const chatMessage = chatError instanceof Error ? chatError.message : String(chatError);
        report.status = "failed";
        report.chatEndpoint = "failed";
        report.chatError = chatMessage;
        report.error = chatMessage;
        lines.push("chat endpoint: failed", chatMessage, "status: failed");
        return writeReport(1);
      }
    }
  } catch (error) {
    if (error instanceof HelpRequested) {
      stdout.write("Usage: axum doctor [--config <path>] [--json]\n");
      return 0;
    }
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function createProviderForOptions(options: ChatCommandOptions): OpenAIChatProvider {
  if (!options.apiKey) throw new Error("missing API key; set config api_key or api_key = \"env:OPENAI_API_KEY\"");
  return new OpenAIChatProvider({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    model: options.model,
    temperature: options.temperature,
    maxRetries: options.maxRetries,
    retryDelayMs: options.retryDelayMs,
    retryMinDelayMs: options.retryMinDelayMs,
    retryMaxDelayMs: options.retryMaxDelayMs,
    requestTimeoutMs: options.requestTimeoutMs,
  });
}

function renderRuntimeProjection(session: AxumRuntimeSession): string {
  const events = session.events.snapshot().filter((event) => event.kind !== "session_configured");
  if (events.length === 0) return "◇ runtime\n  waiting for first event";
  return renderRuntimeDashboard(events).slice(0, 2200);
}

function runtimeStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}

function runtimeArgs(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const args = (payload as Record<string, unknown>).arguments;
  return args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

function runtimeArgText(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function runtimeToolTitle(name: string, args: Record<string, unknown>): string {
  if (name === "safe_exec") return `Ran ${runtimeArgText(args, "command") ?? "command"}`;
  if (name === "read") return `Read ${runtimeArgText(args, "file") ?? runtimeArgText(args, "path") ?? "file"}`;
  if (name === "precise_edit") return `Edited ${runtimeArgText(args, "file") ?? runtimeArgText(args, "path") ?? "file"}`;
  return `${name} tool`;
}

function runtimeFailureSummary(message: unknown): string {
  const text = message instanceof Error ? message.message : String(message ?? "");
  if (/blocked by repeated tool denial/i.test(text)) return "Tool blocked after repeated denial";
  if (/max tool iterations/i.test(text)) return "Runtime stopped after too many tool iterations";
  return "Runtime turn failed";
}

function runtimeToolResultSummary(content: string): string {
  const clean = redactTuiText(content).replace(/\s+/g, " ").trim();
  if (!clean) return "completed";
  if (/ENOENT|no such file or directory/i.test(clean)) return "file not found";
  if (/blocked by repeated tool denial/i.test(clean)) return "tool blocked after repeated denial";
  return truncateToVisibleWidth(clean, 96);
}

function renderRuntimeTranscript(session: AxumRuntimeSession): string {
  const events = session.events.snapshot().filter((event) => event.kind !== "session_configured");
  const lines: string[] = [];
  const calls = new Map<string, { name: string; title: string; lineIndex: number }>();
  let assistantText = "";
  for (const event of events) {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (event.kind === "assistant_message_delta") {
      const content = typeof payload?.content === "string" ? payload.content : "";
      if (content) assistantText = content;
      continue;
    }
    if (event.kind === "assistant_message") {
      const content = typeof payload?.content === "string" ? payload.content : "";
      if (content) assistantText = content;
      continue;
    }
    if (event.kind === "tool_call_requested" && payload) {
      const callId = typeof payload.id === "string" ? payload.id : String(event.id);
      const name = typeof payload.name === "string" ? payload.name : "tool";
      const title = runtimeToolTitle(name, runtimeArgs(payload));
      const lineIndex = lines.length;
      calls.set(callId, { name, title, lineIndex });
      lines.push(`⏳ ${title}`);
      continue;
    }
    if ((event.kind === "tool_call_completed" || event.kind === "permission_denied") && payload) {
      const callId = typeof payload.callId === "string" ? payload.callId : "";
      const call = calls.get(callId);
      const name = typeof payload.name === "string" ? payload.name : call?.name ?? "tool";
      const title = call?.title ?? runtimeToolTitle(name, {});
      const content = typeof payload.content === "string" ? payload.content : "";
      const marker = event.kind === "permission_denied" ? "✗" : "✓";
      const prefix = event.kind === "permission_denied" ? "Blocked" : "Finished";
      const line = `${marker} ${prefix} ${title}`;
      if (call) lines[call.lineIndex] = line;
      else lines.push(line);
      if (content) lines.push(`  ${runtimeToolResultSummary(content)}`);
      continue;
    }
    if (event.kind === "provider_warning") {
      const message = runtimeStringField(payload, "message") ?? "provider warning";
      lines.push(`⚠ Warning: ${truncateToVisibleWidth(redactTuiText(message), 120)}`);
      continue;
    }
    if (event.kind === "turn_failed") {
      const message = runtimeStringField(payload, "message") ?? "runtime turn failed";
      lines.push(`✗ ${runtimeFailureSummary(message)}`);
    }
  }
  if (assistantText) lines.push(...assistantText.trimEnd().split(/\n/g).map((line, index) => index === 0 ? `• ${line}` : `  ${line}`));
  return lines.join("\n");
}

function renderRuntimeVisibleOutput(session: AxumRuntimeSession): { answer: string; projection: string } {
  const projection = renderRuntimeProjection(session);
  const transcript = renderRuntimeTranscript(session);
  return {
    answer: transcript || "• Working…",
    projection,
  };
}

async function resolveTuiAnswer(options: ChatCommandOptions, dryRun: boolean): Promise<{ answer: string; exitCode: number }> {
  return resolveTuiAnswerStream(options, dryRun, () => undefined);
}

async function resolveTuiAnswerStream(options: ChatCommandOptions, dryRun: boolean, onDelta: (answer: string, projection?: string) => void, signal?: AbortSignal): Promise<{ answer: string; exitCode: number }> {
  if (dryRun) return { answer: "dry-run: provider call skipped", exitCode: 0 };
  let latestAnswer = "";
  try {
    const provider = createProviderForOptions(options);
    const session = new AxumRuntimeSession({
      config: options.runtimeConfig,
      provider,
      cwd: process.cwd(),
      mode: findMode(options.runtimeConfig).id,
      systemPrompt: options.system || defaultSystemPrompt(),
    });
    const emitVisibleOutput = (): void => {
      const rendered = renderRuntimeVisibleOutput(session);
      latestAnswer = rendered.answer;
      onDelta(rendered.answer, rendered.projection);
    };
    const unsubscribe = session.events.subscribe(emitVisibleOutput);
    try {
      emitVisibleOutput();
      const result = await session.runUserTurn(options.prompt, signal);
      const rendered = renderRuntimeVisibleOutput(session);
      const eventSummary = renderRuntimeEvents(result.events);
      const answer = rendered.answer || result.assistantMessage || eventSummary || "runtime completed without assistant content";
      return { answer, exitCode: 0 };
    } finally {
      unsubscribe();
    }
  } catch (error) {
    return { answer: latestAnswer || `✗ ${runtimeFailureSummary(error)}`, exitCode: 1 };
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
  let status: string | undefined;
  let lastExitCode = 0;
  let stopped = false;
  let busy = false;
  let activeRequestController: AbortController | undefined;
  let slashSelection = 0;
  let latestRuntimeProjection = "◇ tasks\n  no runtime task activity yet\n  use /parallel <goal> :: <task> | <task> to plan child tasks";

  const requestRender = (): void => tui.requestRender();
  const stop = (code = lastExitCode): void => {
    if (stopped) return;
    stopped = true;
    lastExitCode = code;
    tui.stop();
  };

  const identity = (text: string): string => text;
  const editorTheme = {
    borderColor: identity,
    selectList: {
      selectedPrefix: identity,
      selectedText: identity,
      description: identity,
      scrollInfo: identity,
      noMatch: identity,
    },
  };
  const editor = new pi.Editor(tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 6 });

  const renderInputStatusBorder = (width: number, value: string): string => {
    const safeWidth = Math.max(1, width);
    const label = ` ${value} `;
    if (pi.visibleWidth(label) >= safeWidth) return pi.truncateToWidth(label, safeWidth);
    const remaining = safeWidth - pi.visibleWidth(label);
    const left = Math.floor(remaining / 2);
    const right = remaining - left;
    return `${"─".repeat(left)}${label}${"─".repeat(right)}`;
  };

  class AxumPiTuiChrome implements PiComponent {
    invalidate(): void {}
    render(width: number): string[] {
      const input = editor.getText();
      const body = renderTuiScreen(screenOptions, answer, width, "", 0, 0, terminal.rows, undefined, false)
        .split("\n");
      const commandLines = renderSlashCommandSuggestions(input, width, slashSelection);
      const lines = [
        ...body,
        ...(commandLines.length > 0 ? [...commandLines] : []),
        "",
      ];
      return lines.map((line) => {
        const truncated = pi.truncateToWidth(line, width);
        return truncated + " ".repeat(Math.max(0, width - pi.visibleWidth(truncated)));
      });
    }
  }

  class AxumPiInputDeck implements PiComponent {
    invalidate(): void {
      editor.invalidate?.();
    }
    render(width: number): string[] {
      const lines = editor.render(width);
      if (!status || lines.length === 0) return lines;
      const decorated = [...lines];
      decorated[decorated.length - 1] = renderInputStatusBorder(width, status);
      return decorated;
    }
  }

  const chrome = new AxumPiTuiChrome();
  const inputDeck = new AxumPiInputDeck();

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
      answer = "commands: /help · /providers · /provider use <id|number> · /provider set <url> <key> <model> · /provider [url|key|model] · /model [id|number] · /parallel <goal> :: <task> | <task> · /tasks · /exit (/quit)";
      status = undefined;
      requestRender();
      return;
    }
    if (prompt === "/providers") {
      answer = renderProviderRows(process.env, screenOptions.configPath);
      status = undefined;
      requestRender();
      return;
    }
    if (prompt === "/tasks") {
      answer = latestRuntimeProjection;
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

    editor.addToHistory(prompt);
    screenOptions = { ...options, prompt };
    if (dryRun) {
      answer = "dry-run: provider call skipped";
      status = undefined;
      lastExitCode = 0;
      requestRender();
      return;
    }

    busy = true;
    editor.disableSubmit = true;
    activeRequestController = new AbortController();
    const startedAt = Date.now();
    status = workingStatus(startedAt);
    requestRender();
    const timer = setInterval(() => {
      status = workingStatus(startedAt);
      requestRender();
    }, 250);
    try {
      const result = await resolveTuiAnswerStream(screenOptions, dryRun, (streamed, projection) => {
        answer = streamed;
        latestRuntimeProjection = projection ?? streamed;
        status = workingStatus(startedAt);
        requestRender();
      }, activeRequestController.signal);
      const wasCancelled = activeRequestController.signal.aborted;
      answer = wasCancelled ? "request cancelled; ready for the next prompt" : result.answer;
      status = undefined;
      lastExitCode = wasCancelled ? 0 : result.exitCode;
    } finally {
      activeRequestController = undefined;
      busy = false;
      editor.disableSubmit = false;
      status = undefined;
      clearInterval(timer);
      requestRender();
    }
  }

  editor.onChange = () => {
    slashSelection = 0;
    requestRender();
  };
  editor.onSubmit = (text: string): void => {
    editor.setText("");
    slashSelection = 0;
    void submitPrompt(text.trim());
  };

  tui.addInputListener((data) => {
    if (busy && (pi.matchesKey(data, pi.Key.ctrl("c")) || data === "\u001b")) {
      activeRequestController?.abort();
      status = "• Cancelling request…";
      requestRender();
      return { consume: true };
    }
    if (pi.matchesKey(data, pi.Key.ctrl("c"))) {
      stop(lastExitCode);
      return { consume: true };
    }
    if (busy) return { consume: true };

    const input = editor.getText();
    if (input.startsWith("/")) {
      const matches = matchingSlashCommands(input);
      if (pi.matchesKey(data, pi.Key.up) && matches.length > 0) {
        slashSelection = (slashSelection + matches.length - 1) % matches.length;
        requestRender();
        return { consume: true };
      }
      if (pi.matchesKey(data, pi.Key.down) && matches.length > 0) {
        slashSelection = (slashSelection + 1) % matches.length;
        requestRender();
        return { consume: true };
      }
      if (pi.matchesKey(data, pi.Key.tab)) {
        const completed = completeSlashCommand(input, slashSelection);
        if (completed) editor.setText(completed);
        slashSelection = 0;
        requestRender();
        return { consume: true };
      }
      if (pi.matchesKey(data, pi.Key.enter) && matches.length > 0 && isBareSlashCommandQuery(input) && !isCompleteSlashCommand(input)) {
        const completed = completeSlashCommand(input, slashSelection);
        if (completed) editor.setText(completed);
        slashSelection = 0;
        requestRender();
        return { consume: true };
      }
    }
    return undefined;
  });

  tui.addChild(chrome);
  tui.addChild(inputDeck);
  tui.setFocus(editor);
  if (useAltScreen) terminal.write("\u001b[?1049h");
  terminal.write("\u001b[?2004h");
  const exitCode = await new Promise<number>((resolve) => {
    const originalStop = tui.stop.bind(tui);
    tui.stop = () => {
      originalStop();
      terminal.write("\u001b[?2004l");
      if (useAltScreen) terminal.write("\u001b[?1049l");
      resolve(lastExitCode);
    };
    tui.start();
  });
  return exitCode;
}

async function runLineInteractiveTui(options: ChatCommandOptions, dryRun: boolean, stdout: NodeJS.WriteStream): Promise<number> {
  const repaint = (screenOptions: ChatCommandOptions, answer: string | undefined, input = ""): void => {
    stdout.write(`${renderTuiScreen(screenOptions, answer, terminalWidth(stdout), input, 0, input.length, stdout.rows || 24)}\n`);
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
      stdout.write("commands: /help · /providers · /provider use <id|number> · /provider set <url> <key> <model> · /provider [url|key|model] · /model [id|number] · /parallel <goal> :: <task> | <task> · /tasks · /exit (/quit)\n");
      rl.prompt();
      continue;
    }
    if (prompt === "/providers") {
      stdout.write(`${renderProviderRows(process.env, options.configPath)}\n`);
      rl.prompt();
      continue;
    }
    if (prompt === "/tasks") {
      stdout.write("tasks: no persistent line-mode runtime task activity; use /parallel <goal> :: <task> | <task> to plan child tasks\n");
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
    } else {
      const startedAt = Date.now();
      let latestProjection = "";
      repaint(nextOptions, workingStatus(startedAt));
      const timer = setInterval(() => repaint(nextOptions, workingStatus(startedAt)), 250);
      try {
        const result = await resolveTuiAnswerStream(nextOptions, dryRun, (streamed, projection) => {
          latestProjection = projection ?? streamed;
          repaint(nextOptions, `${streamed}\n${workingStatus(startedAt)}`);
        });
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
  stdout.write(`${renderTuiScreen(options, result.answer, terminalWidth(stdout), "", 0, 0, stdout.rows || 24)}\n`);
  return result.exitCode;
}

function parseModeArgs(args: string[]): { configPath?: string; json: boolean; mode?: string } {
  let configPath: string | undefined;
  let json = false;
  let mode: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--config") {
      configPath = takeValue(args, i, arg);
      i += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--mode") {
      mode = takeValue(args, i, arg);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      throw new HelpRequested();
    } else {
      throw new Error(`unknown modes option: ${arg}`);
    }
  }
  return { configPath, json, mode };
}

async function runModes(args: string[], env: NodeJS.ProcessEnv, stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream): Promise<number> {
  try {
    const options = parseModeArgs(args);
    const loaded = loadConfig(env, options.configPath);
    if (options.json) {
      const mode = options.mode ? findMode(loaded?.config, options.mode) : undefined;
      stdout.write(`${JSON.stringify(mode ? { mode } : { modes: renderModeList(loaded?.config).split("\n") }, null, 2)}\n`);
    } else if (options.mode) {
      const mode = findMode(loaded?.config, options.mode);
      stdout.write(`${mode.id}\n${mode.description}\ntools: ${mode.tools.join(", ") || "none"}\n`);
    } else {
      stdout.write(`${renderModeList(loaded?.config)}\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof HelpRequested) {
      stdout.write("Usage: axum modes [--config <path>] [--mode <id>] [--json]\n");
      return 0;
    }
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function parseWorkflowArgs(args: string[]): { configPath?: string; mode?: string; dryRun: boolean; verbose: boolean; prompt: string } {
  let configPath: string | undefined;
  let mode: string | undefined;
  let dryRun = false;
  let verbose = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--config") {
      configPath = takeValue(args, i, arg);
      i += 1;
    } else if (arg === "--mode") {
      mode = takeValue(args, i, arg);
      i += 1;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--verbose") {
      verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new HelpRequested();
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown workflow option: ${arg}`);
    } else {
      rest.push(arg);
    }
  }
  return { configPath, mode, dryRun, verbose, prompt: rest.join(" ").trim() };
}

function writeWorkflowRender(stdout: NodeJS.WriteStream, plan: ReturnType<typeof buildWorkflowPlan>, checkpointPath: string | undefined, verbose: boolean): void {
  for (const line of renderWorkflowPlan(plan, checkpointPath, { verbose }).split("\n")) {
    stdout.write(`${line}\n`);
  }
}

async function runWorkflow(args: string[], env: NodeJS.ProcessEnv, stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream): Promise<number> {
  try {
    const options = parseWorkflowArgs(args);
    const loaded = loadConfig(env, options.configPath);
    const plan = buildWorkflowPlan(loaded?.config, options.prompt, { mode: options.mode });
    const checkpointPath = options.dryRun ? undefined : persistWorkflowPlan(plan);
    writeWorkflowRender(stdout, plan, checkpointPath, options.verbose);
    return 0;
  } catch (error) {
    if (error instanceof HelpRequested) {
      stdout.write("Usage: axum workflow [--config <path>] [--mode <id>] [--dry-run] [--verbose] <prompt>\n");
      return 0;
    }
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function parseParallelArgs(args: string[]): { configPath?: string; mode?: string; dryRun: boolean; prompt: string; tasks: string[] } {
  let configPath: string | undefined;
  let mode: string | undefined;
  let dryRun = false;
  const tasks: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--config") {
      configPath = takeValue(args, i, arg);
      i += 1;
    } else if (arg === "--mode") {
      mode = takeValue(args, i, arg);
      i += 1;
    } else if (arg === "--task") {
      tasks.push(takeValue(args, i, arg));
      i += 1;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new HelpRequested();
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown parallel option: ${arg}`);
    } else {
      rest.push(arg);
    }
  }
  return { configPath, mode, dryRun, prompt: rest.join(" ").trim(), tasks };
}

async function runParallel(args: string[], env: NodeJS.ProcessEnv, stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream): Promise<number> {
  try {
    const options = parseParallelArgs(args);
    const loaded = loadConfig(env, options.configPath);
    const mode = findMode(loaded?.config, options.mode).id;
    const plan = buildSwarmPlan(options.prompt, options.tasks, { mode });
    const checkpointPath = options.dryRun ? undefined : persistSwarmPlan(plan);
    stdout.write(`${renderSwarmPlan(plan, checkpointPath)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof HelpRequested) {
      stdout.write("Usage: axum parallel [--config <path>] [--mode <id>] [--dry-run] --task <prompt> --task <prompt> <goal>\n");
      return 0;
    }
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

export async function runAxumCli(args: string[], env = process.env, stdout = process.stdout, stderr = process.stderr): Promise<AxumCliResult> {
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
