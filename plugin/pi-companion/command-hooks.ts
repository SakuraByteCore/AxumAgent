import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd", "PreCompact", "PostCompact"] as const;
export type HookEvent = typeof HOOK_EVENTS[number];
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
type Command = { command: string; timeout: number };
type Group = { matcher?: string; hooks: Command[] };
type Config = { disabled: boolean; hooks: Partial<Record<HookEvent, Group[]>> };
export type HookRequest = {
  event: HookEvent; cwd: string; sessionId: string; transcriptPath?: string;
  trusted: boolean; fields?: JsonObject; matchNames?: string[]; signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
};
export type HookResult = {
  blocked: boolean; reason: string; context: string[]; warnings: string[];
  updatedInput?: JsonObject;
};
const DEFAULT_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 60;
const OUTPUT_LIMIT_BYTES = 256 * 1024;
const BLOCKING_EVENTS = new Set<HookEvent>(["PreToolUse", "UserPromptSubmit"]);
const CONTROLLABLE_EVENTS = new Set<HookEvent>([...BLOCKING_EVENTS, "Stop", "PreCompact"]);
const CONTEXT_EVENTS = new Set<HookEvent>(["SessionStart", "UserPromptSubmit"]);
const TOOL_ALIASES: Record<string, string> = { bash: "Bash", powershell: "PowerShell", read: "Read", edit: "Edit", write: "Write", grep: "Grep", find: "Glob", ls: "LS" };

function object(value: Json): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function configError(file: string, message: string): never {
  throw new Error(`${file}: ${message}`);
}
function parseCommand(value: Json, file: string): Command {
  if (!object(value) || value.type !== "command" || typeof value.command !== "string" || !value.command.trim()) {
    return configError(file, "hooks require type=command and a non-empty command");
  }
  if (value.async || value.asyncRewake) return configError(file, "async hooks are not supported");
  const timeout = value.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_SECONDS) {
    return configError(file, "timeout must be >0 and <=60 seconds");
  }
  return { command: value.command, timeout };
}
function parseConfig(value: Json, file: string): Config {
  if (!object(value)) return configError(file, "configuration must be an object");
  if (value.disableAllHooks !== undefined && typeof value.disableAllHooks !== "boolean") return configError(file, "disableAllHooks must be boolean");
  const config: Config = { disabled: value.disableAllHooks === true, hooks: {} };
  if (config.disabled || value.hooks === undefined) return config;
  if (!object(value.hooks)) return configError(file, "hooks must be an object");
  for (const [name, groups] of Object.entries(value.hooks)) {
    const event = HOOK_EVENTS.find((item) => item === name);
    if (!event || !Array.isArray(groups)) return configError(file, `unsupported event or invalid groups: ${name}`);
    config.hooks[event] = groups.map((group) => {
      if (!object(group) || !Array.isArray(group.hooks)) return configError(file, `${name} requires hooks arrays`);
      const matcher = group.matcher;
      if (matcher !== undefined && typeof matcher !== "string") return configError(file, "matcher must be a regular expression string");
      if (matcher && matcher !== "*") new RegExp(matcher);
      return { matcher, hooks: group.hooks.map((hook) => parseCommand(hook, file)) };
    });
  }
  return config;
}
async function readConfigs(request: HookRequest): Promise<Config[]> {
  const env = request.env ?? process.env;
  const rawDir = env.PI_CODING_AGENT_DIR;
  const agentDir = rawDir === "~" ? homedir() : rawDir?.startsWith("~/") ? join(homedir(), rawDir.slice(2)) : rawDir ? resolve(rawDir) : join(homedir(), ".pi", "agent");
  const files = [join(agentDir, "hooks.json")];
  if (request.trusted) files.push(join(request.cwd, ".pi", "hooks.json"), join(request.cwd, ".pi", "hooks.local.json"));
  const configs: Config[] = [];
  for (const file of files) {
    let text: string;
    try { text = await readFile(file, "utf8"); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") continue; throw error; }
    try {
      const config = parseConfig(JSON.parse(text), file);
      if (config.disabled) return [config];
      configs.push(config);
    }
    catch (error) { throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return configs;
}
function matches(group: Group, request: HookRequest): boolean {
  if (!group.matcher || group.matcher === "*" || request.event === "Stop" || request.event === "UserPromptSubmit") return true;
  const names = [...(request.matchNames ?? [])];
  const toolName = request.fields?.tool_name;
  if (typeof toolName === "string") names.push(toolName, TOOL_ALIASES[toolName] ?? toolName);
  return names.some((name) => new RegExp(group.matcher!).test(name));
}

async function execute(command: Command, request: HookRequest, input: string): Promise<{ code: number; stdout: string; stderr: string }> {
  if (request.signal?.aborted) throw new Error("Hook aborted");
  return new Promise((resolveResult, reject) => {
    const child = spawn(command.command, {
      cwd: request.cwd, shell: true, detached: process.platform !== "win32", windowsHide: true,
      env: { ...(request.env ?? process.env), AXUM_PROJECT_DIR: request.cwd, CLAUDE_PROJECT_DIR: request.cwd, AXUM_SESSION_ID: request.sessionId },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let killing: Promise<void> = Promise.resolve();
    let closed = false;
    let bytes = 0, failure: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (message: string) => {
      if (failure) return;
      failure = new Error(message);
      if (child.pid && process.platform === "win32") {
        killing = new Promise<void>((done) => {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10000 });
          killer.on("error", () => { child.kill("SIGKILL"); done(); });
          killer.on("close", (code) => { if (code !== 0) child.kill("SIGKILL"); done(); });
        });
      } else if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
      void killing.then(() => {
        if (closed) return;
        killTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); child.kill("SIGKILL"); }, 2000);
      });
    };
    const abort = () => kill("Hook aborted");
    const timer = setTimeout(() => kill(`Hook timed out after ${command.timeout}s`), command.timeout * 1000);
    request.signal?.addEventListener("abort", abort, { once: true });
    const collect = (chunks: Buffer[], data: Buffer) => {
      bytes += data.length;
      if (bytes > OUTPUT_LIMIT_BYTES) kill("Hook output exceeded 256 KiB");
      else chunks.push(data);
    };
    child.stdout.on("data", (data: Buffer) => collect(stdout, data));
    child.stderr.on("data", (data: Buffer) => collect(stderr, data));
    child.on("error", (error) => { failure = error; });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") kill(error.message); });
    child.on("close", async (code) => {
      closed = true;
      await killing;
      clearTimeout(timer); clearTimeout(killTimer);
      request.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolveResult({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8").trim(), stderr: Buffer.concat(stderr).toString("utf8").trim() });
    });
    child.stdin.end(input);
    if (request.signal?.aborted) abort();
  });
}
function block(result: HookResult, reason: string): void {
  result.blocked = true;
  result.reason ||= reason;
}
function applyOutput(text: string, request: HookRequest, result: HookResult): void {
  if (!text) return;
  if (!text.startsWith("{")) { if (CONTEXT_EVENTS.has(request.event)) result.context.push(text); return; }
  const output: Json = JSON.parse(text);
  if (!object(output)) throw new Error("Hook output must be an object");
  const specific = output.hookSpecificOutput;
  if (specific !== undefined && (!object(specific) || specific.hookEventName !== request.event)) throw new Error("hookEventName does not match the event");
  const reason = typeof output.reason === "string" ? output.reason : "Blocked by hook";
  if ((output.decision === "block" || output.continue === false) && CONTROLLABLE_EVENTS.has(request.event)) block(result, reason);
  if (!specific || !object(specific)) return;
  if (specific.additionalContext !== undefined) {
    if (typeof specific.additionalContext !== "string") throw new Error("additionalContext must be a string");
    result.context.push(specific.additionalContext);
  }
  if (request.event !== "PreToolUse") return;
  const decision = specific.permissionDecision;
  if (decision !== undefined && decision !== "allow" && decision !== "deny" && decision !== "ask") throw new Error("Invalid permissionDecision");
  if (decision === "deny" || decision === "ask") block(result, typeof specific.permissionDecisionReason === "string" ? specific.permissionDecisionReason : "Tool denied by hook");
  if (specific.updatedInput !== undefined) {
    if (!object(specific.updatedInput)) throw new Error("updatedInput must be an object");
    result.updatedInput = specific.updatedInput;
  }
}
export async function runCommandHooks(request: HookRequest): Promise<HookResult> {
  const result: HookResult = { blocked: false, reason: "", context: [], warnings: [] };
  try {
    const configs = await readConfigs(request);
    if (configs.some((config) => config.disabled)) return result;
    const input = JSON.stringify({ ...request.fields, session_id: request.sessionId, transcript_path: request.transcriptPath ?? "", cwd: request.cwd, hook_event_name: request.event }) + "\n";
    for (const group of configs.flatMap((config) => config.hooks[request.event] ?? [])) {
      if (!matches(group, request)) continue;
      for (const command of group.hooks) {
        try {
          const output = await execute(command, request, input);
          if (output.code === 2) {
            if (CONTROLLABLE_EVENTS.has(request.event)) block(result, output.stderr || "Blocked by hook (exit 2)");
            else result.warnings.push(output.stderr || `${request.event} hook exited 2`);
          } else if (output.code !== 0) throw new Error(output.stderr || `Hook exited ${output.code}`);
          else applyOutput(output.stdout, request, result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.warnings.push(message);
          if (BLOCKING_EVENTS.has(request.event)) block(result, message);
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.warnings.push(message);
    if (BLOCKING_EVENTS.has(request.event)) block(result, message);
  }
  return result;
}
