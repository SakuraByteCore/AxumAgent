import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createHashAnchor, type AxumWorkflowHashAnchor } from "./pi-workflow";
import { resolveToolSpecs, type AxumToolSpec } from "../shell/kilo-shell";

const execFileAsync = promisify(execFile);

export interface AxumToolGate {
  allowedTools: string[];
  cwd: string;
  allowedCommands?: string[];
  timeoutMs?: number;
}

export interface AxumToolResult<T = unknown> {
  tool: string;
  ok: boolean;
  result: T;
  anchors: AxumWorkflowHashAnchor[];
}

export interface PreciseEditRequest {
  file: string;
  oldText: string;
  newText: string;
  expectedHash?: string;
}

export interface SafeExecRequest {
  command: string;
  args?: string[];
}

export interface SymbolLookupRequest {
  query?: string;
  files?: string[];
}

export interface SymbolMatch {
  file: string;
  line: number;
  kind: "function" | "class" | "interface" | "type" | "const" | "export";
  name: string;
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function assertToolAllowed(gate: AxumToolGate, tool: string): AxumToolSpec {
  const spec = resolveToolSpecs(gate.allowedTools).find((item) => item.id === tool);
  if (!spec) throw new Error(`tool not allowed by workflow gate: ${tool}`);
  return spec;
}

function resolveProjectFile(cwd: string, file: string): string {
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, file);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error(`path escapes project sandbox: ${file}`);
  }
  return absolute;
}

export function runPreciseEdit(gate: AxumToolGate, request: PreciseEditRequest): AxumToolResult<{ file: string; beforeHash: string; afterHash: string }> {
  assertToolAllowed(gate, "precise_edit");
  const absolute = resolveProjectFile(gate.cwd, request.file);
  const before = fs.readFileSync(absolute, "utf8");
  const beforeHash = sha256(before);
  if (request.expectedHash && request.expectedHash !== beforeHash) {
    throw new Error(`hash anchor mismatch for ${request.file}`);
  }
  const first = before.indexOf(request.oldText);
  if (first < 0) throw new Error(`oldText not found in ${request.file}`);
  if (before.indexOf(request.oldText, first + request.oldText.length) >= 0) {
    throw new Error(`oldText is not unique in ${request.file}`);
  }
  const after = `${before.slice(0, first)}${request.newText}${before.slice(first + request.oldText.length)}`;
  fs.writeFileSync(absolute, after, "utf8");
  const afterHash = sha256(after);
  return {
    tool: "precise_edit",
    ok: true,
    result: { file: request.file, beforeHash, afterHash },
    anchors: [createHashAnchor(request.file, after)],
  };
}

export async function runSafeExec(gate: AxumToolGate, request: SafeExecRequest): Promise<AxumToolResult<{ stdout: string; stderr: string }>> {
  assertToolAllowed(gate, "safe_exec");
  const allowed = gate.allowedCommands ?? ["npm", "node", "npx"];
  if (!allowed.includes(request.command)) throw new Error(`command not allowed by safe_exec sandbox: ${request.command}`);
  const { stdout, stderr } = await execFileAsync(request.command, request.args ?? [], {
    cwd: path.resolve(gate.cwd),
    timeout: gate.timeoutMs ?? 120_000,
    maxBuffer: 1024 * 1024 * 4,
    windowsHide: true,
  });
  return {
    tool: "safe_exec",
    ok: true,
    result: { stdout, stderr },
    anchors: [createHashAnchor(`safe_exec:${request.command}`, `${request.command} ${(request.args ?? []).join(" ")}\n${stdout}\n${stderr}`)],
  };
}

export function runLspSymbols(gate: AxumToolGate, request: SymbolLookupRequest = {}): AxumToolResult<{ matches: SymbolMatch[] }> {
  assertToolAllowed(gate, "lsp_symbols");
  const root = path.resolve(gate.cwd);
  const files = (request.files && request.files.length > 0 ? request.files : collectTypeScriptFiles(root)).map((file) => resolveProjectFile(root, file));
  const query = request.query?.toLowerCase();
  const matches: SymbolMatch[] = [];
  for (const absolute of files) {
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    const relative = path.relative(root, absolute);
    const lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/g);
    lines.forEach((line, index) => {
      const match = line.match(/^\s*(?:export\s+)?(?:async\s+)?(function|class|interface|type|const)\s+([A-Za-z_$][\w$]*)/)
        ?? line.match(/^\s*export\s+\{\s*([A-Za-z_$][\w$]*)/);
      if (!match) return;
      const kind = (match[1] === undefined ? "export" : match[1]) as SymbolMatch["kind"];
      const name = match[2] ?? match[1];
      if (query && !name.toLowerCase().includes(query)) return;
      matches.push({ file: relative, line: index + 1, kind, name });
    });
  }
  return {
    tool: "lsp_symbols",
    ok: true,
    result: { matches },
    anchors: [createHashAnchor("lsp_symbols", JSON.stringify(matches))],
  };
}

function collectTypeScriptFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        found.push(path.relative(root, absolute));
      }
    }
  };
  walk(root);
  return found.sort();
}
