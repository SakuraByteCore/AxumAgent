// pi-debug — DAP (Debug Adapter Protocol) types.
//
// This module is a minimal, zero-dependency subset of the Debug Adapter
// Protocol (https://microsoft.github.io/debug-adapter-protocol/). It covers
// init, attach, breakpoint, stepping, thread, stack, scope and variable
// requests plus the events a driver needs to react to: initialized, stopped,
// continued and breakpoint resolved/ignored.
//
// All interfaces are structurally typed so a third-party adapter (lldb-dap,
// dlv, debugpy) can be driven without shipping a copy of the adapter itself.

export interface DAPRequest {
  seq: number;
  type: "request";
  command: string;
  arguments?: unknown;
}

export interface DAPResponse {
  seq: number;
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: unknown;
}

export interface DAPEvent {
  seq: number;
  type: "event";
  event: string;
  body?: unknown;
}

export type DAPMessage = DAPRequest | DAPResponse | DAPEvent;

export interface Capabilities {
  supportsConfigurationDoneRequest?: boolean;
  supportsTerminateRequest?: boolean;
  supportsSetVariable?: boolean;
  supportsConditionalBreakpoints?: boolean;
  supportsFunctionBreakpoints?: boolean;
  supportsEvaluateForHovers?: boolean;
  supportsSteppingGranularity?: boolean;
  supportsLoadedSourcesRequest?: boolean;
  supportsCompletionsRequest?: boolean;
  supportsExceptionInfoRequest?: boolean;
  supportTerminateDebuggee?: boolean;
  supportsDelayedStackTraceLoading?: boolean;
  [key: string]: unknown;
}

export interface AdapterMetadata {
  /** Stable identifier: "lldb-dap" | "dlv" | "debugpy" | "custom". */
  kind: string;
  /** Resolved absolute path to the adapter binary/launcher, or null. */
  execPath: string | null;
  /** Extra argv appended after the attach target (any, in original order). */
  argv?: string[];
}

/**
 * Verbose result of a breakpoint-set operation. `sources` maps each requested
 * source to the adapter's actual installed breakpoints, so the driver can
 * reconcile a `breakpoint` event's source path with the line the caller asked
 * for.
 */
export interface BreakpointResult {
  /** Next DAP breakpoint id returned by the adapter (informational). */
  nextId: number;
  /** Map source relative path -> absolute path used in the request. */
  sourceMap: Record<string, string>;
  /** Final breakpoint ids that actually got installed, in request order. */
  installed: number[];
}

export interface StackFrame {
  id: number;
  name: string;
  source?: { path?: string; name?: string };
  line: number;
  column: number;
}

export interface DapPending {
  resolve: (body: unknown) => void;
  reject: (err: Error) => void;
  command: string;
  timer: NodeJS.Timeout;
}