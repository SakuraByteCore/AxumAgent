#!/usr/bin/env node
// pi-debug — mock DAP adapter for end-to-end tests.
//
// This is a *real* stdio process that speaks the Debug Adapter Protocol (DAP)
// in the same way lldb-dap / dlv / debugpy do: it reads a newline-delimited
// JSON frame on stdin and writes a JSON frame on stdout. It is stateful — it
// tracks installed breakpoints, thread ids, a program counter and a small
// variable table — so the driver's attach/break/continue/stack/variables flows
// exercise the same message sequencing as a real adapter.
//
// Protocol behaviors worth pinning down for the driver's pressure tests:
//  - Every request gets exactly one correlated response with request_seq.
//  - `continue` with a pending breakpoint either returns immediately with
//    `allThreadsStopped=true` plus error (no stop) or, when `autoHalt` is
//    true, fires a `stopped` event a tick later (the breakpoint-hit path).
//  - A malformed or unknown request returns `success:false`.
//  - `disconnect` ends the process with a clean exit.

// Provide a small breakpoint table so the driver can verify line targets.
const BP_LINE = parseInt(process.env.MOCK_BP_LINE ?? "42", 10);

const state = {
  seq: 0,
  attached: false,
  configured: false,
  breakpoints: [],
  threads: [{ id: 1, name: "main" }],
  stopped: false,
  stopReason: "breakpoint",
  pc: 40,
  autoHalt: process.env.MOCK_AUTO_HALT !== "0",
  ticks: 0,
  silent: false,
};

// Optional injected fault vectors, controlled through env so the same fixture
// covers normal, timeout and error paths without separate scripts.
const fault = {
  dropInit: process.env.MOCK_DROP_INIT === "1",
  silentAfter: process.env.MOCK_SILENT_AFTER === "1", // stop replying to all requests immediately
  silentAfterAttach: process.env.MOCK_SILENT_AFTER_ATTACH === "1", // go silent once attached
  exitOnAttach: process.env.MOCK_EXIT_ON_ATTACH === "1",
  badInitialize: process.env.MOCK_BAD_INITIALIZE === "1",
};

process.stdin.setEncoding("utf8");
process.stdout.setEncoding("utf8");

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(req, body, ok = true) {
  const resp = {
    seq: ++state.seq,
    type: "response",
    request_seq: req.seq,
    success: ok,
    command: req.command,
  };
  if (body !== undefined) resp.body = body;
  if (!ok) resp.message = `mock adapter could not ${req.command}`;
  send(resp);
}

function fireStopped() {
  state.stopped = true;
  send({
    seq: ++state.seq,
    type: "event",
    event: "stopped",
    body: { reason: state.stopReason, threadId: 1, allThreadsStopped: true },
  });
}

let dispatcherPromise = Promise.resolve();

function handleRequest(req) {
  const args = req.arguments ?? {};
  switch (req.command) {
    case "initialize": {
      const body = {
        supportsConfigurationDoneRequest: true,
        supportsTerminateRequest: true,
        supportsSetVariable: true,
      };
      if (fault.badInitialize) return reply(req, undefined, false);
      reply(req, body);
      // Adapters emit `initialized` after initialize and before any further
      // request that depends on capabilities.
      send({ seq: ++state.seq, type: "event", event: "initialized", body: {} });
      break;
    }
    case "configurationDone":
      state.configured = true;
      reply(req, {});
      break;
    case "attach":
      if (fault.exitOnAttach) {
        process.exit(0);
        return;
      }
      state.attached = true;
      reply(req, { threadId: 1 });
      if (fault.silentAfterAttach) {
        // The attach reply above is already flushed to stdout; from now on
        // this adapter stops answering so the driver's next request times out.
        state.silent = true;
      }
      if (fault.autoHalt) {
        // A clean attach emits a single stopped event (waiting at first line).
        fireStopped();
      }
      break;
    case "setBreakpoints": {
      const srcName = args.source?.name ?? "file";
      const installed = [];
      for (const bp of args.breakpoints ?? []) {
        state.breakpoints.push({ line: bp.line, verified: true, id: state.breakpoints.length + 1 });
        installed.push({ line: bp.line, verified: true, id: state.breakpoints.length, source: args.source });
      }
      reply(req, { breakpoints: installed });
      break;
    }
    case "continue": {
      state.ticks += 1;
      const hit = state.breakpoints.length > 0 && state.autoHalt;
      if (!hit) {
        state.stopped = false;
        state.pc = 99;
        reply(req, { allThreadsStopped: false });
        break;
      }
      // The adapter decides whether it stopped synchronously. To model a
      // breakpoint pause that surfaces *after* the continue response, we fire
      // stopped asynchronously — the driver's gate must handle this ordering.
      reply(req, { allThreadsStopped: false });
      const idx = state.ticks;
      setTimeout(() => fireStopped(), 1 + (idx % 3));
      break;
    }
    case "next":
    case "stepIn":
    case "stepOut": {
      state.pc += 1;
      reply(req, {});
      if (state.autoHalt) {
        const idx = state.ticks++;
        setTimeout(() => fireStopped(), 1 + (idx % 3));
      }
      break;
    }
    case "stackTrace": {
      const frames = [
        { id: 3, name: "compute", source: { name: "demo.m", path: "/workspace/src/demo.m" }, line: state.pc, column: 1 },
        { id: 2, name: "main", source: { name: "main.m", path: "/workspace/src/main.m" }, line: 8, column: 1 },
      ];
      reply(req, { stackFrames: frames, totalFrames: 2 });
      break;
    }
    case "scopes": {
      reply(req, {
        scopes: [
          { name: "Locals", variablesReference: 10, expensive: false },
          { name: "Globals", variablesReference: 11, expensive: false },
        ],
      });
      break;
    }
    case "variables": {
      const ref = args.variablesReference;
      if (ref === 10) {
        reply(req, {
          variables: [
            { name: "x", value: "57351", type: "int", variablesReference: 0 },
            { name: "cursor", value: "ptr", type: "char *", variablesReference: 12 },
          ],
        });
      } else if (ref === 11) {
        reply(req, { variables: [{ name: "GLOBAL", value: "42", type: "int", variablesReference: 0 }] });
      } else {
        reply(req, { variables: [{ name: "seen", value: "2", type: "int", variablesReference: 0 }] });
      }
      break;
    }
    case "threads":
      reply(req, { threads: state.threads });
      break;
    case "disconnect":
    case "terminate":
      reply(req, {});
      process.exit(0);
      return;
    default:
      reply(req, undefined, false);
      break;
  }
}

process.stdin.on("data", (chunk) => {
  let lineStart = 0;
  let nl;
  while ((nl = chunk.indexOf("\n", lineStart)) >= 0) {
    const line = chunk.slice(lineStart, nl).trim();
    lineStart = nl + 1;
    if (!line) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame.type !== "request") continue;
    if (fault.dropInit && frame.command === "initialize") continue;
    if (fault.silentAfter || state.silent) continue; // answer nothing, as if wedged
    dispatcherPromise = dispatcherPromise.then(() => handleRequest(frame));
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});