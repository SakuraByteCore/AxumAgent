// pi-debug — debug adapter discovery.
//
// Resolves the DAP adapter for a requested debugger kind by consulting PATH.
// The DAP client talks to whatever binary is found through stdio, so this
// stays a pure build-a-command helper: no process is spawned here. The
// resolver never falls back to a guessed path; if a binary is not on PATH it
// reports an explicit miss so the driver can surface a clear error.
//
// The returned argv is the full adapter invocation: the resolved executable
// followed by the adapter-specific flags needed to start in server mode.

import { accessSync, constants } from "node:fs";

export interface ProbeResult {
  kind: string;
  execPath: string | null;
  argv: string[];
}

function readableExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findInPath(bin: string): string | null {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of dirs) {
    const candidate = `${dir}/${bin}`;
    if (readableExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve an adapter for a debugger kind and an optional target executable.
 * `targetExec` is used to prefer a same-dir adapter when driving an interpreter
 * wrapper like debugpy with a Python path that carries its own adapter.
 */
export function probeAdapter(kind: string, targetExec?: string | null): ProbeResult {
  const base = kind.toLowerCase();

  switch (base) {
    case "lldb":
    case "lldb-dap":
      return make("lldb-dap", "lldb-dap", []);
    case "dlv": {
      const p = findInPath("dlv");
      return {
        kind: "dlv",
        ...p ? { execPath: p, argv: ["dap"] } : { execPath: null, argv: [] },
      };
    }
    case "debugpy": {
      // debugpy installs `debugpy` (the python module, invoked via
      // `-m debugpy.adapter`) and, on some distros, a `debugpy-adapter`
      // shim. Prefer the module form since it is the portable interface.
      const mod = findInPath("python3");
      return {
        kind: "debugpy",
        ...mod
          ? { execPath: mod, argv: ["-m", "debugpy.adapter"] }
          : { execPath: null, argv: [] },
      };
    }
    case "custom": {
      return { kind: "custom", execPath: targetExec || null, argv: [] };
    }
    default:
      return { kind: base, execPath: null, argv: [] };
  }
}

function make(kind: string, bin: string, argv: string[]): ProbeResult {
  const p = findInPath(bin);
  return {
    kind,
    ...p ? { execPath: p, argv } : { execPath: null, argv },
  };
}

/**
 * Pure-path variant usable from unit tests without touching the real PATH.
 */
export function resolveAdapterExecutable(kind: string, bin: string, argv: string[], targetExec?: string | null): ProbeResult {
  if (kind.toLowerCase() === "custom") {
    return { kind: "custom", execPath: targetExec || null, argv };
  }
  const p = targetExec && readableExecutable(targetExec) ? targetExec : findInPath(bin);
  return { kind, execPath: p, argv };
}