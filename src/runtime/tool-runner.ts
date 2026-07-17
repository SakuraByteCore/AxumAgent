import fs from "node:fs";
import path from "node:path";
import { findMode, type AxumShellMode } from "../shell/kilo-shell";
import { runLspSymbols, runPreciseEdit, runSafeExec, type AxumToolGate } from "./tools";
import type { AxumConfig } from "../config";
import type { AxumRuntimeToolCall, AxumRuntimeToolOutput } from "./protocol";

export interface AxumToolRunnerOptions {
  config?: AxumConfig;
  mode?: string;
  cwd?: string;
  allowedCommands?: string[];
  timeoutMs?: number;
}

export interface AxumToolRunner {
  mode: AxumShellMode;
  gate: AxumToolGate;
  run(call: AxumRuntimeToolCall): Promise<AxumRuntimeToolOutput>;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function stringArrayArg(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function jsonContent(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function createToolRunner(options: AxumToolRunnerOptions = {}): AxumToolRunner {
  const mode = findMode(options.config, options.mode);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const gate: AxumToolGate = {
    allowedTools: mode.tools,
    cwd,
    allowedCommands: options.allowedCommands,
    timeoutMs: options.timeoutMs,
  };

  return {
    mode,
    gate,
    async run(call: AxumRuntimeToolCall): Promise<AxumRuntimeToolOutput> {
      try {
        if (call.name === "read") {
          if (!mode.tools.includes("read")) throw new Error("tool not allowed by workflow gate: read");
          const file = stringArg(call.arguments, "file") ?? stringArg(call.arguments, "path");
          if (!file) throw new Error("read requires file");
          const root = path.resolve(cwd);
          const absolute = path.resolve(root, file);
          if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error(`path escapes project sandbox: ${file}`);
          const content = fs.readFileSync(absolute, "utf8");
          return { callId: call.id, name: call.name, ok: true, content };
        }
        if (call.name === "precise_edit") {
          const result = runPreciseEdit(gate, {
            file: stringArg(call.arguments, "file") ?? "",
            oldText: stringArg(call.arguments, "oldText") ?? stringArg(call.arguments, "old_text") ?? "",
            newText: stringArg(call.arguments, "newText") ?? stringArg(call.arguments, "new_text") ?? "",
            expectedHash: stringArg(call.arguments, "expectedHash") ?? stringArg(call.arguments, "expected_hash"),
          });
          return { callId: call.id, name: call.name, ok: true, content: jsonContent(result.result) };
        }
        if (call.name === "safe_exec") {
          const result = await runSafeExec(gate, {
            command: stringArg(call.arguments, "command") ?? "",
            args: stringArrayArg(call.arguments, "args"),
          });
          return { callId: call.id, name: call.name, ok: true, content: jsonContent(result.result) };
        }
        if (call.name === "lsp_symbols") {
          const result = runLspSymbols(gate, {
            query: stringArg(call.arguments, "query"),
            files: stringArrayArg(call.arguments, "files"),
          });
          return { callId: call.id, name: call.name, ok: true, content: jsonContent(result.result) };
        }
        throw new Error(`unknown runtime tool: ${call.name}`);
      } catch (error) {
        return { callId: call.id, name: call.name, ok: false, content: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
