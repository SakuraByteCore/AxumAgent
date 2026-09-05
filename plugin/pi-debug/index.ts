// pi-debug — extension entry point.
//
// Registers a small set of agent-facing slash commands that drive a real
// debugger through the DAP client in `src/dap-client.ts`. The heavy lifting
// (protocol, attach, breakpoints, stepping, stack, variables) lives in `src/`
// and is covered by the end-to-end pressure tests in `test/pi-debug.test.js`;
// this file only binds those capabilities to Pi's command namespace.
//
// The session is a process-wide singleton: `pi-debug:attach` spawns the
// adapter, and every other command operates on that live session until
// `pi-debug:disconnect`. Attaching again tears the previous session down.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DAPProtocolError, DebugSession } from "./src/dap-client.js";
import { probeAdapter } from "./src/adapters.js";

const EXT = "pi-debug";

interface PiContext {
  ui?: {
    notify?(message: string, level?: "info" | "success" | "warning" | "error"): void;
  };
}

let session: DebugSession | null = null;

function currentSession(): DebugSession {
  if (!session) {
    throw new DAPProtocolError("no debug session. Run /pi-debug:attach <lldb|dlv|debugpy> <pid|program> first");
  }
  return session;
}

async function detachActive(): Promise<void> {
  if (session) {
    try {
      await session.close();
    } catch {
      // ignore teardown errors
    } finally {
      session = null;
    }
  }
}

async function attachDebugger(kind: string, target: string): Promise<string> {
  const probe = probeAdapter(kind);
  if (!probe.execPath) {
    throw new DAPProtocolError(`debugger "${kind}" not found on PATH`);
  }
  await detachActive();
  const s = new DebugSession(`${kind} (${target})`);
  await s.start(probe.argv.length > 0 ? [probe.execPath, ...probe.argv] : [probe.execPath]);
  const numericTarget = /^\d+$/.test(target) ? Number(target) : null;
  await s.attach(numericTarget !== null ? { pid: numericTarget } : { program: target });
  session = s;
  return `attached ${kind} -> ${target} (state: ${s.state})`;
}

async function setDebugBreakpoints(rawArgs: string): Promise<string> {
  const specs = rawArgs.trim().split(/\s+/).filter(Boolean);
  if (specs.length === 0) throw new DAPProtocolError("usage: /pi-debug:break <file>:<line> [<file>:<line> ...]");
  const s = currentSession();
  const lines: number[] = [];
  for (const spec of specs) {
    const idx = spec.lastIndexOf(":");
    if (idx <= 0) throw new DAPProtocolError(`invalid breakpoint spec "${spec}" — expected <file>:<line>`);
    const line = Number(spec.slice(idx + 1));
    if (!Number.isInteger(line) || line <= 0) throw new DAPProtocolError(`invalid line in "${spec}"`);
    lines.push(line);
  }
  const result = await s.setBreakpoints(specs[0].slice(0, specs[0].lastIndexOf(":")), lines);
  return `set ${result.installed.length} breakpoint(s)`;
}

async function continueDebug(): Promise<string> {
  const s = currentSession();
  const info = await s.continueAndWaitStopped();
  return `stopped: ${info.reason} (thread ${info.threadId})`;
}

async function stepDebug(verb: string): Promise<string> {
  const command = verb === "in" ? "stepIn" : verb === "out" ? "stepOut" : verb === "next" ? "next" : null;
  if (!command) throw new DAPProtocolError(`invalid step verb "${verb}" — use next|in|out`);
  const s = currentSession();
  await s.step(command);
  return "stepped — use /pi-debug:continue to run to the next stop";
}

async function readStack(raw?: string): Promise<string> {
  const s = currentSession();
  const tid = raw ? Number(raw) : undefined;
  const frames = await s.readStackTrace(tid);
  return frames
    .map((f) => `#${f.id} ${f.name} @ ${f.source?.path ?? "?"}:${f.line}`)
    .join("\n");
}

async function readVariables(raw?: string): Promise<string> {
  const s = currentSession();
  const frameId = raw ? Number(raw) : undefined;
  const vars = await s.readVariables(frameId);
  return vars.map((v) => `  ${v.name}${v.type ? ` (${v.type})` : ""} = ${v.value}`).join("\n") || "(no variables)";
}

async function listThreads(): Promise<string> {
  const s = currentSession();
  const threads = await s.listThreads();
  return threads.map((t) => `#${t.id} ${t.name ?? ""}`).join("\n") || "(no threads)";
}

function parsePrompt(raw: string): { cmd: string; args: string[] } | null {
  const p = raw.trim();
  if (!p) return null;
  const lower = p.toLowerCase();

  if (lower.startsWith("attach") || lower.startsWith("启动") || lower.startsWith("连接") || lower.startsWith("附加") || lower.startsWith("调试")) {
    const known = ["debugpy", "dlv", "lldb", "lldb-dap"];
    let kind = "debugpy";
    const rest = p.replace(/^(attach|启动|连接|附加|调试)\s*/i, "").trim();
    for (const k of known) {
      if (rest.startsWith(k) || rest.toLowerCase().startsWith(k)) {
        kind = k;
        const afterKind = rest.slice(k.length).trim();
        const pidM = afterKind.match(/(?:pid|进程)\s*[:=]?\s*(\d+)/i) || afterKind.match(/^\d+$/);
        const target = pidM ? (pidM[1] || pidM[0]) : afterKind;
        return { cmd: "attach", args: [kind, target] };
      }
    }
    const pidM = rest.match(/(?:pid|进程)\s*[:=]?\s*(\d+)/i) || rest.match(/^\d+$/);
    const target = pidM ? (pidM[1] || pidM[0]) : rest;
    return { cmd: "attach", args: [kind, target] };
  }

  if (lower.startsWith("breakpoint") || lower.startsWith("设置断点") || lower.startsWith("断点") || lower.startsWith("break ")) {
    const bp = p.match(/([\w./-]+\.\w+):(\d+)/);
    if (bp) return { cmd: "break", args: [`${bp[1]}:${bp[2]}`] };
    const line = p.match(/第\s*(\d+)\s*行/);
    if (line) return { cmd: "break", args: [`?:${line[1]}`] };
    return null;
  }

  if (lower.startsWith("continue") || lower.startsWith("继续")) {
    return { cmd: "continue", args: [] };
  }

  if (lower.startsWith("step ") || ["step", "next", "in", "out", "下一步", "进入", "跳出"].includes(lower)) {
    if (lower === "in" || lower === "进入") return { cmd: "step", args: ["in"] };
    if (lower === "out" || lower === "跳出") return { cmd: "step", args: ["out"] };
    const m = lower.match(/^(step\s+)(next|in|out)/);
    if (m) return { cmd: "step", args: [m[2]] };
    return { cmd: "step", args: ["next"] };
  }

  if (lower.startsWith("stack") || lower.startsWith("堆栈") || lower.startsWith("调用栈") || lower.startsWith("backtrace")) {
    const tid = p.match(/(?:thread|线程)\s*[:=]?\s*(\d+)/i);
    if (tid) return { cmd: "stack", args: [tid[1]] };
    return { cmd: "stack", args: [] };
  }

  if (lower.startsWith("variables") || lower.startsWith("variable") || lower.startsWith("变量") || lower.startsWith("var ")) {
    const fid = p.match(/(?:frame|帧)\s*[:=]?\s*(\d+)/i);
    if (fid) return { cmd: "variables", args: [fid[1]] };
    return { cmd: "variables", args: [] };
  }

  if (lower.startsWith("thread")) {
    return { cmd: "threads", args: [] };
  }

  if (lower.startsWith("disconnect") || lower.startsWith("断开") || lower.startsWith("结束") || lower.startsWith("退出")) {
    return { cmd: "disconnect", args: [] };
  }

  if (lower.startsWith("status") || lower.startsWith("状态")) {
    return { cmd: "status", args: [] };
  }

  return null;
}

export default function registerDebug(pi: ExtensionAPI): void {
  pi.registerCommand(`${EXT}:attach`, {
    description: "Attach a debugger. Usage: /pi-debug:attach <lldb|dlv|debugpy> <pid|program>",
    handler: async (rawArgs: string) => {
      const [kind, ...rest] = rawArgs.trim().split(/\s+/);
      if (!kind || rest.length === 0) {
        throw new DAPProtocolError(`usage: /pi-debug:attach <lldb|dlv|debugpy> <pid|program>`);
      }
      const target = rest.join(" ");
      return attachDebugger(kind, target);
    },
  });

  pi.on("session_shutdown", async () => {
    await detachActive();
  });

  pi.registerCommand(`${EXT}:break`, {
    description: "Set breakpoints. Usage: /pi-debug:break <file>:<line> [<file>:<line> ...]",
    handler: async (rawArgs: string) => {
      const specs = rawArgs.trim().split(/\s+/).filter(Boolean);
      if (specs.length === 0) throw new DAPProtocolError("usage: /pi-debug:break <file>:<line> [<file>:<line> ...]");
      return setDebugBreakpoints(rawArgs);
    },
  });

  pi.registerCommand(`${EXT}:continue`, {
    description: "Resume execution and wait for the next stop. Usage: /pi-debug:continue",
    handler: async () => {
      return continueDebug();
    },
  });

  pi.registerCommand(`${EXT}:step`, {
    description: "Step one unit. Usage: /pi-debug:step next|in|out",
    handler: async (rawArgs: string) => {
      const verb = rawArgs.trim().toLowerCase();
      const command = verb === "in" ? "stepIn" : verb === "out" ? "stepOut" : verb === "next" ? "next" : null;
      if (!command) throw new DAPProtocolError(`usage: /pi-debug:step next|in|out`);
      const s = currentSession();
      await s.step(command);
      return "stepped — use /pi-debug:continue to run to the next stop";
    },
  });

  pi.registerCommand(`${EXT}:stack`, {
    description: "Read the current call stack. Usage: /pi-debug:stack [threadId]",
    handler: async (rawArgs: string) => {
      const s = currentSession();
      const tid = rawArgs.trim() ? Number(rawArgs.trim()) : undefined;
      const frames = await s.readStackTrace(tid);
      return frames
        .map((f) => `#${f.id} ${f.name} @ ${f.source?.path ?? "?"}:${f.line}`)
        .join("\n");
    },
  });

  pi.registerCommand(`${EXT}:variables`, {
    description: "Read variables for a frame. Usage: /pi-debug:variables [frameId]",
    handler: async (rawArgs: string) => {
      const s = currentSession();
      const fid = rawArgs.trim() ? Number(rawArgs.trim()) : undefined;
      const vars = await s.readVariables(fid);
      return vars.map((v) => `  ${v.name}${v.type ? ` (${v.type})` : ""} = ${v.value}`).join("\n") || "(no variables)";
    },
  });

  pi.registerCommand(`${EXT}:threads`, {
    description: "List threads. Usage: /pi-debug:threads",
    handler: async () => {
      const s = currentSession();
      const threads = await s.listThreads();
      return threads.map((t) => `#${t.id} ${t.name ?? ""}`).join("\n") || "(no threads)";
    },
  });

  pi.registerCommand(`${EXT}:disconnect`, {
    description: "Tear the debug session down. Usage: /pi-debug:disconnect",
    handler: async () => {
      await detachActive();
      return "debug session closed";
    },
  });

  pi.registerCommand(`${EXT}:status`, {
    description: "Report whether a debug session is active. Usage: /pi-debug:status",
    handler: () => {
      return session ? `session active (${session.state})` : "no active session";
    },
  });

  pi.registerCommand(EXT, {
    description: "Unified debugger interface. Usage: /pi-debug <prompt>",
    handler: async (rawArgs: string) => {
      const parsed = parsePrompt(rawArgs);
      if (!parsed) {
        throw new DAPProtocolError(
          `无法解析调试指令: "${rawArgs}"\n` +
          `用法: /pi-debug <自然语言需求>\n` +
          `例如: /pi-debug 启动 debugpy 调试 ./main.py\n` +
          `     /pi-debug 在 main.go:42 设置断点`
        );
      }
      switch (parsed.cmd) {
        case "attach": {
          const [kind, target] = parsed.args;
          if (!target) {
            throw new DAPProtocolError(`请指定调试目标。例如: /pi-debug 启动 ${kind} 调试 ./app`);
          }
          return attachDebugger(kind, target);
        }
        case "break":
          return setDebugBreakpoints(parsed.args.join(" ") || rawArgs);
        case "continue":
          return continueDebug();
        case "step":
          return stepDebug(parsed.args[0] || "next");
        case "stack":
          return readStack(parsed.args[0]);
        case "variables":
          return readVariables(parsed.args[0]);
        case "threads":
          return listThreads();
        case "disconnect":
          await detachActive();
          return "debug session closed";
        case "status":
          return statusDebug();
        default:
          throw new DAPProtocolError(`unsupported command: ${parsed.cmd}`);
      }
    },
  });
}

function statusDebug(): string {
  return session ? `session active (${session.state})` : "no active session";
}