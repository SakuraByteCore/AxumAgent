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

function notify(ctx: PiContext, message: string, level: "info" | "success" | "warning" | "error" = "info"): void {
  try {
    ctx?.ui?.notify?.(`[${EXT}] ${message}`, level);
  } catch {
    /* notification is best-effort */
  }
}

async function detachActive(): Promise<void> {
  if (session) {
    try {
      await session.close();
    } catch {
      /* ignore teardown errors */
    } finally {
      session = null;
    }
  }
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
    },
  });

  pi.registerCommand(`${EXT}:break`, {
    description: "Set breakpoints. Usage: /pi-debug:break <file>:<line> [<file>:<line> ...]",
    handler: async (rawArgs: string) => {
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
    },
  });

  pi.registerCommand(`${EXT}:continue`, {
    description: "Resume execution and wait for the next stop. Usage: /pi-debug:continue",
    handler: async () => {
      const s = currentSession();
      const info = await s.continueAndWaitStopped();
      return `stopped: ${info.reason} (thread ${info.threadId})`;
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
}