import { readFile } from "fs/promises";
import { configPath } from "./paths.js";
import { writeAtomic } from "./fs-write.js";
import { errCode } from "./utils.js";

export type ReplaceMode = "bulk" | "flat";
export interface Config { replaceMode: ReplaceMode; autoRead: boolean }

const DEFAULT_CONFIG: Config = { replaceMode: "bulk", autoRead: false };
let configMutation: Promise<void> = Promise.resolve();

function parseConfig(content: string): Config {
  const parsed = JSON.parse(content) as Partial<Config>;
  return {
    replaceMode: parsed.replaceMode === "flat" ? "flat" : "bulk",
    autoRead: parsed.autoRead === true,
  };
}

async function enqueueConfigMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = configMutation.then(operation, operation);
  configMutation = result.then(() => undefined, () => undefined);
  return result;
}

export async function readConfig(): Promise<Config> {
  try {
    const content = await readFile(configPath(), "utf-8");
    return parseConfig(content);
  } catch (error: unknown) {
    if (errCode(error) !== "ENOENT") console.error("Config file corrupted, using defaults:", error);
    return { ...DEFAULT_CONFIG };
  }
}

export async function writeConfig(config: Config): Promise<void> {
  await writeAtomic(configPath(), JSON.stringify(config, null, 2));
}

export async function toggleReplaceMode(): Promise<ReplaceMode> {
  return enqueueConfigMutation(async () => {
    const config = await readConfig();
    config.replaceMode = config.replaceMode === "bulk" ? "flat" : "bulk";
    await writeConfig(config);
    return config.replaceMode;
  });
}

export async function toggleAutoRead(): Promise<boolean> {
  return enqueueConfigMutation(async () => {
    const config = await readConfig();
    config.autoRead = !config.autoRead;
    await writeConfig(config);
    return config.autoRead;
  });
}
