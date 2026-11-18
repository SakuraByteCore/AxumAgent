import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Input = "text" | "image";
type ModelInput = { input?: Input[] };

/** Refresh only explicit input declarations; never infer vision support from model names. */
export async function refreshModelInput(ctx: Pick<ExtensionContext, "model">, file?: string): Promise<void> {
  const model = ctx.model;
  if (!model) return;
  const rawDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = rawDir === "~" ? homedir() : rawDir?.startsWith("~/") ? join(homedir(), rawDir.slice(2)) : rawDir ? resolve(rawDir) : join(homedir(), ".pi", "agent");
  let text: string;
  try { text = await readFile(file ?? join(agentDir, "models.json"), "utf8"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
  const config: { providers?: Record<string, { models?: ({ id: string } & ModelInput)[] }> } = JSON.parse(text);
  const entry = config.providers?.[model.provider]?.models?.find((item) => item.id === model.id);
  if (entry?.input === undefined) return;
  if (!Array.isArray(entry.input) || !entry.input.length || entry.input.some((value) => value !== "text" && value !== "image")) {
    throw new Error(`Invalid input modalities for ${model.provider}/${model.id}`);
  }
  model.input = [...entry.input];
}

export function registerModelInputRefresh(pi: ExtensionAPI): void {
  const refresh = async (_event: object, ctx: ExtensionContext) => {
    try { await refreshModelInput(ctx); }
    catch (error) { ctx.ui.notify(`Model input refresh failed: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
  };
  pi.on("input", refresh);
  pi.on("before_agent_start", refresh);
  pi.on("tool_call", refresh);
  pi.on("model_select", refresh);
}
