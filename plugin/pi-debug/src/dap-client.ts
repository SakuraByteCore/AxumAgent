// pi-debug — DAP client over stdio.
//
// The DAP client spawns an adapter process and speaks the Debug Adapter
// Protocol through its stdin/stdout. It is deliberately dependency-free: the
// byte framing, request/response correlation, pending-request table, event
// routing and timeout handling are implemented here.
//
// Lifecycle rules that the pressure tests exercise:
//  - Requests are serialized through a single in-flight gate. If a caller asks
//    for a new request while one is already pending, the client queues it and
//    dispatches only after the prior response arrives (or the pending times
//    out). This prevents reordering the adapter's own lockstep.
//  - Every pending request carries a hard timeout; on expiry the caller is
//    rejected, the request is dropped from the table, and the stream is
//    marked poisoned so no stale response can be correlated to a later one.
//  - A non-success response rejects the pending promise with the adapter's
//    message.
//  - `close()` ends the stdin, waits for the stream to finish, then kills the
//    process. Repeated calls are idempotent and safe from any state.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { DAPMessage, DAPRequest, DAPResponse, DAPEvent, DapPending, Capabilities } from "./types.js";

export class DAPProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DAPProtocolError";
  }
}

export type DAPEventType =
  | "initialized"
  | "stopped"
  | "continued"
  | "breakpoint"
  | "output"
  | "terminated"
  | "thread"
  | "loadedSource"
  | "process"
  | "exited";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export class DAPClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private seq = 0;
  private pending = new Map<number, DapPending>();
  private closed = false;
  private poisoned = false;
  private buffer = "";
  private listeners = new Map<DAPEventType, Set<(body: unknown) => void>>();
  private exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  private inflight = false;
  private queue: Array<{ frame: DAPRequest; resolve: (body: unknown) => void; reject: (e: Error) => void; timeoutMs: number }> = [];

  private adapterLabel: string;

  constructor(adapterLabel: string) {
    this.adapterLabel = adapterLabel;
  }

  /**
   * Start the adapter process and complete the DAP `initialize` handshake.
   * Returns the adapter's capabilities.
   */
  async connect(argv: string[], spawnEnv?: NodeJS.ProcessEnv): Promise<Capabilities> {
    if (this.proc) throw new DAPProtocolError("adapter already connected");
    if (argv.length === 0) throw new DAPProtocolError("empty adapter command");

    const execPath = argv[0];
    const child = spawn(execPath, argv.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv ?? process.env,
    });
    this.proc = child;

    let stderrTail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const tail = (stderrTail + chunk).slice(-2000);
      stderrTail = tail;
    });
    child.on("error", (err) => {
      const e = new DAPProtocolError(`failed to start adapter ${execPath}: ${err.message}\n${stderrTail}`);
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
      this.flushQueueWithError(e);
    });
    child.stdin.setEncoding("utf8");

    let dataAcc = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      dataAcc += chunk;
      let boundary = dataAcc.indexOf("\n");
      while (boundary >= 0) {
        const line = dataAcc.slice(0, boundary).trim();
        dataAcc = dataAcc.slice(boundary + 1);
        if (line) this.dispatchLine(line);
        boundary = dataAcc.indexOf("\n");
      }
    });

    child.on("close", (code, signal) => {
      this.closed = true;
      const e = new DAPProtocolError(
        `adapter ${this.adapterLabel} exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}`,
      );
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(e);
      }
      const old = new Set(this.pending.values());
      this.pending.clear();
      for (const p of old) clearTimeout(p.timer);
      for (const fn of this.exitListeners) {
        try {
          fn(code, signal);
        } catch {
          /* listener errors are isolated */
        }
      }
    });

    return (await this.request("initialize", {
      adapterID: "pi-debug",
      clientID: "pi-debug",
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      supportsVariablePaging: true,
      supportsMemoryReferences: true,
      supportsInvalidatedEvent: true,
      supportsArgsCanBeInterpretedByShell: true,
    })) as Capabilities;
  }

  /** Send a latency-sensitive command, awaiting the correlated response body. */
  request(command: string, args?: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (!this.proc || this.closed) {
      return Promise.reject(new DAPProtocolError("adapter is not connected"));
    }
    if (this.poisoned) {
      return Promise.reject(new DAPProtocolError("adapter stream poisoned; reconnect required"));
    }

    const frame: DAPRequest = {
      seq: ++this.seq,
      type: "request",
      command,
      ...(args !== undefined ? { arguments: args } : {}),
    };

    return new Promise((resolve, reject) => {
      const item = { frame, resolve, reject, timeoutMs };
      if (this.inflight) {
        this.queue.push(item);
        return;
      }
      this.dispatchRequest(item);
    });
  }

  private dispatchRequest(item: { frame: DAPRequest; resolve: (body: unknown) => void; reject: (e: Error) => void; timeoutMs: number }): void {
    this.inflight = true;
    const { frame, resolve, reject, timeoutMs } = item;
    const timer = setTimeout(() => {
      if (!this.pending.delete(frame.seq)) return;
      this.poisoned = true;
      reject(new DAPProtocolError(`request "${frame.command}" timed out after ${timeoutMs}ms`));
      this.inflight = false;
      this.flushQueue();
    }, timeoutMs);

    this.pending.set(frame.seq, {
      resolve: (body) => {
        clearTimeout(timer);
        this.inflight = false;
        resolve(body);
        this.flushQueue();
      },
      reject: (err) => {
        clearTimeout(timer);
        this.inflight = false;
        reject(err);
        this.flushQueue();
      },
      command: frame.command,
      timer,
    });

    if (this.proc && this.proc.stdin.writable) {
      this.proc.stdin.write(`${JSON.stringify(frame)}\n`);
    } else {
      this.pending.delete(frame.seq);
      clearTimeout(timer);
      this.inflight = false;
      reject(new DAPProtocolError("adapter stdin not writable"));
      this.flushQueue();
    }
  }

  private flushQueue(): void {
    if (this.inflight) return;
    const next = this.queue.shift();
    if (!next) return;
    this.dispatchRequest(next);
  }

  private flushQueueWithError(err: Error): void {
    while (this.queue.length) {
      const next = this.queue.shift();
      next.reject(err);
    }
  }

  private dispatchLine(line: string): void {
    let msg: DAPMessage;
    try {
      msg = JSON.parse(line) as DAPMessage;
    } catch {
      return;
    }

    if (msg.type === "response") {
      this.handleResponse(msg as DAPResponse);
    } else if (msg.type === "event") {
      this.handleEvent(msg as DAPEvent);
    } else {
      return;
    }
  }

  private handleResponse(resp: DAPResponse): void {
    const entry = this.pending.get(resp.request_seq);
    if (!entry) {
      // Uncorrelated response: the original request already timed out or the
      // stream is poisoned. Mark the stream poisoned so the stale response's
      // seq can never be reused by a later unrelated request.
      this.poisoned = true;
      return;
    }
    this.pending.delete(resp.request_seq);
    if (!resp.success) {
      const msg = resp.message || `request ${resp.command} failed`;
      entry.reject(new DAPProtocolError(msg));
    } else {
      entry.resolve(resp.body ?? null);
    }
  }

  private handleEvent(ev: DAPEvent): void {
    const kind = ev.event as DAPEventType;
    const set = this.listeners.get(kind);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(ev.body ?? null);
      } catch {
        // a throwing listener must not tear down the client
      }
    }
  }

  on(event: DAPEventType, fn: (body: unknown) => void): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return () => this.listeners.get(event)!.delete(fn);
  }

  onExit(fn: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.exitListeners.add(fn);
    return () => this.exitListeners.delete(fn);
  }

  get isConnected(): boolean {
    return this.proc !== null && !this.closed;
  }

  get pendingCount(): number {
    return this.pending.size + this.queue.length;
  }

  /**
   * End the session: close stdin to signal the adapter it can finish, wait for
   * the child to exit (bounded), then force-kill if it lingers. Idempotent.
   */
  async close(timeoutMs = 5000): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    this.closed = true;

    const exited = new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve();
        return;
      }
      const done = () => resolve();
      proc.once("close", done);
      const fail = setTimeout(done, timeoutMs);
      proc.once("exit", () => clearTimeout(fail));
    });

    try {
      if (proc.stdin.writable) {
        proc.stdin.end();
      } else {
        proc.kill("SIGKILL");
      }
    } catch {
      /* already gone */
    }

    await exited;
    try {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGKILL");
      }
      if (proc.stdin.writable) proc.stdin.destroy();
    } catch {
      /* best-effort cleanup */
    }

    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new DAPProtocolError("client closed"));
    }
    this.pending.clear();
    this.flushQueueWithError(new DAPProtocolError("client closed"));
  }
}

export type DrvState = "idle" | "attached" | "running" | "stopped" | "dead";

export interface StoppedInfo {
  reason: string;
  threadId: number;
  allThreadsStopped: boolean;
}

/**
 * High-level debugger driver on top of {@link DAPClient}. The driver owns a
 * single adapter process and exposes the operations an agent cares about:
 * attach, breakpoint-set, continue-and-wait, stepping, stack and variables.
 *
 * The `continue*` family is built on a stopped-event gate: the driver sends
 * `continue` and then waits until the adapter reports a `stopped` event (or a
 * hard timeout elapses). This mirrors how a real debugger behaves and is the
 * unit the pressure test hammers.
 */
export class DebugSession {
  readonly client: DAPClient;
  state: DrvState = "idle";
  private lastThreadId: number | null = null;
  private stoppedWaiters: Array<{ resolve: (info: StoppedInfo) => void; timer: NodeJS.Timeout }> = [];
  private adapterLabel: string;
  private spawnEnv: NodeJS.ProcessEnv | undefined;

  constructor(adapterLabel: string) {
    this.adapterLabel = adapterLabel;
    this.client = new DAPClient(adapterLabel);
    this.client.on("stopped", (body) => this.handleStopped(body as Record<string, unknown>));
    this.client.on("terminated", () => {
      this.state = "dead";
      this.failStoppedWaiters(new DAPProtocolError(`adapter ${this.adapterLabel} terminated the session`));
    });
    this.client.onExit(() => {
      if (this.state !== "dead") this.state = "dead";
    });
  }

  /** Start the adapter and complete the initialize handshake. */
  async start(argv: string[], spawnEnv?: NodeJS.ProcessEnv): Promise<unknown> {
    this.spawnEnv = spawnEnv;
    const caps = await this.client.connect(argv, spawnEnv);
    // configurationDone is a hint, not a guarantee; fire-and-forget is fine.
    try {
      await this.client.request("configurationDone", {}, 5000);
    } catch {
      /* adapter without configurationDone support */
    }
    return caps;
  }

  /** Attach to a running target (pid) or launch a program that is then debugged. */
  async attach(args: Record<string, unknown>): Promise<void> {
    const body = (await this.client.request("attach", args)) as { threadId?: number } | null;
    this.state = "attached";
    if (body && typeof body.threadId === "number") this.lastThreadId = body.threadId;
  }

  /** Set breakpoints on a source, returning the installed ids. */
  async setBreakpoints(filePath: string, lines: number[], sourceMap?: (path: string) => string): Promise<BreakpointResult> {
    const srcName = filePath;
    const sourceRef = {
      name: srcName.split("/").pop() || srcName,
      path: srcName,
    };
    const source = sourceMap ? sourceMap(srcName) : srcName;
    const body = (await this.client.request("setBreakpoints", {
      source,
      breakpoints: lines.map((line) => ({ line })),
    })) as { breakpoints?: Array<{ id?: number; line?: number; verified?: boolean; message?: string }> } | null;
    return {
      nextId: body?.breakpoints?.length ?? 0,
      sourceMap: { [srcName]: source },
      installed: (body?.breakpoints ?? []).filter((b) => b.verified !== false).map((b) => b.id ?? -1),
    };
  }

  private handleStopped(body: Record<string, unknown>): void {
    this.state = "stopped";
    const info: StoppedInfo = {
      reason: typeof body.reason === "string" ? body.reason : "pause",
      threadId: typeof body.threadId === "number" ? body.threadId : this.lastThreadId ?? 0,
      allThreadsStopped: body.allThreadsStopped !== false,
    };
    this.lastThreadId = info.threadId;
    const copy = [...this.stoppedWaiters];
    this.stoppedWaiters = [];
    for (const w of copy) {
      clearTimeout(w.timer);
      w.resolve(info);
    }
  }

  private failStoppedWaiters(err: Error): void {
    const copy = [...this.stoppedWaiters];
    this.stoppedWaiters = [];
    for (const w of copy) {
      clearTimeout(w.timer);
      w.resolve({ reason: err.message, threadId: this.lastThreadId ?? 0, allThreadsStopped: true });
    }
  }

  /** Continue all threads, resolving on the next stopped event (or timeout). */
  async continueAndWaitStopped(timeoutMs = 30_000): Promise<StoppedInfo> {
    this.state = "running";
    const waiting = new Promise<StoppedInfo>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.stoppedWaiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.stoppedWaiters.splice(idx, 1);
        resolve({ reason: "timeout", threadId: this.lastThreadId ?? 0, allThreadsStopped: true });
      }, timeoutMs);
      this.stoppedWaiters.push({ resolve, timer });
    });
    await this.client.request("continue", { threadId: this.lastThreadId ?? 0 });
    return waiting;
  }

  /** Resume, then resolve immediately with no waiting (fire-and-forget step). */
  async step(command: "next" | "stepIn" | "stepOut", threadId?: number): Promise<void> {
    await this.client.request(command, { threadId: threadId ?? this.lastThreadId ?? 0 });
  }

  /** Read the call stack of a thread. Returns a shallow list of frames. */
  async readStackTrace(threadId?: number): Promise<StackFrame[]> {
    const tid = threadId ?? this.lastThreadId ?? 0;
    const body = (await this.client.request("stackTrace", { threadId: tid, levels: 25 })) as { stackFrames?: StackFrame[] } | null;
    return (body?.stackFrames ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      source: f.source ? { path: f.source.path, name: f.source.name } : undefined,
      line: f.line,
      column: f.column,
    }));
  }

  /** List threads plus why the current one is stopped, in one round-trip pair. */
  async listThreads(): Promise<Array<{ id: number; name?: string }>> {
    const body = (await this.client.request("threads", {})) as { threads?: Array<{ id: number; name?: string }> } | null;
    return body?.threads ?? [];
  }

  /** Read top-level variables for a stopped frame. */
  async readVariables(frameId?: number): Promise<Array<{ name: string; type?: string; value: string; variablesReference: number }>> {
    const fid = frameId ?? 0;
    const scopes = (await this.client.request("scopes", { frameId: fid })) as { scopes?: Array<{ name: string; variablesReference: number }> } | null;
    const out: Array<{ name: string; type?: string; value: string; variablesReference: number }> = [];
    for (const scope of scopes?.scopes ?? []) {
      const vbody = (await this.client.request("variables", { variablesReference: scope.variablesReference })) as { variables?: Array<{ name: string; type?: string; value: string; variablesReference: number }> } | null;
      for (const v of vbody?.variables ?? []) {
        out.push({ name: v.name, type: v.type, value: v.value, variablesReference: v.variablesReference });
      }
    }
    return out;
  }

  async close(): Promise<void> {
    this.state = "dead";
    this.failStoppedWaiters(new DAPProtocolError("session closed"));
    await this.client.close();
  }
}

// Re-export common types so consumers only need one import specifier.
export type { StackFrame } from "./types.js";
export type { BreakpointResult } from "./types.js";
