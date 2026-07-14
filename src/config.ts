import fs from "fs";
import os from "os";
import path from "path";
import { parse, stringify } from "@iarna/toml";

export interface ProviderConfig {
  type?: string;
  base_url?: string;
  baseUrl?: string;
  api_key?: string;
  apiKey?: string;
  api_key_env?: string;
  apiKeyEnv?: string;
  model?: string;
  models?: string[];
  max_retries?: number;
  maxRetries?: number;
  retry_delay_ms?: number;
  retryDelayMs?: number;
}

export interface AxumConfig {
  model?: string;
  models?: string[];
  provider?: string;
  providers?: Record<string, ProviderConfig>;
}

export interface LoadedConfig {
  path: string;
  config: AxumConfig;
}

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".axum", "config.toml");

export function expandHome(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

export function defaultConfigPath(): string {
  return DEFAULT_CONFIG_PATH;
}

export function resolveConfigPath(env: NodeJS.ProcessEnv, explicitPath?: string): string {
  return path.resolve(expandHome(explicitPath || env.AXUM_CONFIG || DEFAULT_CONFIG_PATH));
}

export function loadConfig(env: NodeJS.ProcessEnv, explicitPath?: string): LoadedConfig | undefined {
  const configPath = resolveConfigPath(env, explicitPath);
  if (!fs.existsSync(configPath)) return undefined;
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = parse(raw) as unknown as AxumConfig;
  return { path: configPath, config: parsed };
}

export function saveOpenAIProviderConfig(env: NodeJS.ProcessEnv, explicitPath: string | undefined, patch: Partial<ProviderConfig>): LoadedConfig {
  const configPath = resolveConfigPath(env, explicitPath);
  const existing = fs.existsSync(configPath) ? (parse(fs.readFileSync(configPath, "utf8")) as unknown as AxumConfig) : {};
  const providerId = existing.provider || "openai-chat";
  const providers = { ...(existing.providers ?? {}) };
  providers[providerId] = {
    ...(providers[providerId] ?? {}),
    type: providers[providerId]?.type || "openai-chat",
    ...patch,
  };
  const next: AxumConfig = { ...existing, provider: providerId, providers };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, stringify(next as never), "utf8");
  return { path: configPath, config: next };
}

export function selectedProvider(config: AxumConfig | undefined): { id: string; config?: ProviderConfig } {
  const id = config?.provider || "openai-chat";
  return { id, config: config?.providers?.[id] };
}

export function resolveSecret(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("env:")) return env[value.slice(4)];
  return value;
}

export function numberFromConfig(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
