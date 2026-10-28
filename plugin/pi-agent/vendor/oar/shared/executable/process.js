import { execFile } from "node:child_process";
import spawn from "cross-spawn";
import { StringDecoder } from "node:string_decoder";
import { nativeError, spawnChecked, spawnFailure, StderrTail } from "./diagnostics.js";
import { trackOwnedProcess } from "./ownership.js";
import { treeResourcesReader } from "./process-resources.js";
import { descendantsOf, killEntries, readProcessTable } from "./process-tree.js";
import { windowsSpawnTarget } from "./windows-shim.js";
export { trackOwnedProcess } from "./ownership.js";
/**
 * How long a process asked to stop (SIGTERM) gets before it is killed outright
 * (SIGKILL): the bound that keeps `kill()` followed by `await exited` from
 * hanging on a process that ignores the request. Generous on purpose: claude
 * answers SIGTERM with a shutdown of its own that runs its SessionEnd hooks
 * and force-exits after max(5 s, hook budget + 5 s), 15 s while writes are
 * still pending (2.1.283; the hook budget defaults to 1.5 s), and cutting that
 * short kills the hooks with it. Observed exits take 0.6-2.3 s.
 */
export const KILL_GRACE_MS = 10_000;
/**
 * The grace period in force: `OAR_KILL_GRACE_MS` when it holds a nonnegative
 * number of milliseconds (a host whose runtimes need longer, e.g. claude with
 * slow SessionEnd hooks, or that wants a faster teardown), else `KILL_GRACE_MS`.
 */
export function killGraceMs(env = process.env) {
    const configured = env.OAR_KILL_GRACE_MS?.trim() ?? "";
    const value = Number(configured);
    return configured.length > 0 && Number.isFinite(value) && value >= 0 ? value : KILL_GRACE_MS;
}
/**
 * POSIX children are spawned detached, which makes each the leader of its own
 * process group, so one signal to the negative pid reaches every process it
 * started (shells, dev servers, MCP servers), not only the child itself.
 * Detaching changes neither stdio nor exit tracking: the pipes stay connected
 * and the child is never unref'd, so the host still observes its exit. It does
 * take the child out of the terminal's job control: Ctrl-C (SIGINT) and SIGHUP
 * reach the host only, so a host that wants them to stop its runtimes
 * disposes its sessions on them. Windows has no process groups, and a
 * detached child there gets its own console, so it stays attached.
 */
export const OWN_PROCESS_GROUP = process.platform !== "win32";
/**
 * Send `signal` to a child spawned with `detached: OWN_PROCESS_GROUP` and to
 * everything in its process group. Falls back to the child alone where there
 * are no groups (Windows) or the group is gone (the child left it; ESRCH).
 * A reaped child's pid can be reused, so call this only while the child, or a
 * process it started, can still be alive.
 */
export function signalProcessGroup(child, signal) {
    if (OWN_PROCESS_GROUP && child.pid !== undefined) {
        try {
            process.kill(-child.pid, signal);
            return;
        }
        catch {
            // Nobody is left in the group; the child itself may still be alive in
            // a group of its own making, so it is signalled directly below.
        }
    }
    child.kill(signal);
}
/**
 * Windows has no process groups: end the child and everything it started by
 * walking its process tree (`taskkill /T /F`), falling back to the child
 * alone when the walk fails.
 */
export function killProcessTree(child) {
    if (child.pid === undefined) {
        child.kill();
        return;
    }
    const killer = execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], (error) => {
        if (error !== null) {
            child.kill();
        }
    });
    trackOwnedProcess(killer);
}
/**
 * Spawn through cross-spawn. On Windows a `.cmd`/`.bat` shim is first
 * resolved to the Node interpreter and script it wraps, so a shim's arguments
 * never reach `cmd.exe` (windows-shim.ts). Line parsing is attached lazily;
 * protocol SDKs can consume the raw streams.
 */
export function spawnLineProcess(command, args, options = {}) {
    const target = windowsSpawnTarget(command, args);
    const child = spawnChecked(() => spawn(target.command, [...target.args], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: OWN_PROCESS_GROUP,
    }));
    trackOwnedProcess(child);
    const { stdin, stdout } = child;
    const stderr = new StderrTail();
    const inheritStderr = options.inheritStderr ?? process.env.OAR_CHILD_STDERR === "inherit";
    // Always drain stderr, even after the tail is full and without a host
    // observer. Otherwise a verbose child can block before its next RPC reply.
    child.stderr?.on("data", (chunk) => {
        stderr.append(chunk);
        if (inheritStderr) {
            process.stderr.write(chunk);
        }
    });
    if (stdin === null || stdout === null) {
        throw new Error("line process stdio must be piped");
    }
    stdin.on("error", () => { }); // EPIPE from a child already gone: its exit is what gets recorded.
    const lineHandlers = [];
    const exitHandlers = [];
    let buffer = "";
    let readingLines = false;
    let ended = false;
    let exitCode = null;
    let exitSignal = null;
    let spawnError = undefined;
    let escalation = null;
    // POSIX `killTree`: the child's descendants when kill() began, until they
    // have had their SIGKILL.
    let descendants = [];
    const { promise: spawned, resolve: spawnOk, reject: spawnFailed } = Promise.withResolvers();
    const { promise: exited, resolve: exitDone } = Promise.withResolvers();
    child.once("spawn", spawnOk);
    const end = (code, signal = null) => {
        if (ended) {
            return;
        }
        ended = true;
        exitCode = code;
        exitSignal = signal;
        if (escalation !== null) {
            clearTimeout(escalation);
        }
        if (descendants.length > 0) {
            // The child stopped before its SIGKILL: what it left running of its
            // tree now belongs to nobody, and goes before the exit is reported.
            killEntries(descendants, readProcessTable());
            descendants = [];
        }
        for (const handler of exitHandlers) {
            handler(code);
        }
        exitDone(code);
    };
    child.on("exit", end);
    child.on("error", (error) => {
        spawnError = nativeError(error);
        spawnFailed(spawnFailure(error));
        end(null);
    });
    const readLines = () => {
        // Keep incomplete UTF-8 code points between chunks without changing the
        // raw stdout stream used by protocol SDKs and other observers.
        const decoder = new StringDecoder("utf8");
        stdout.on("data", (chunk) => {
            buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const raw of lines) {
                const line = raw.trim();
                if (line.length > 0) {
                    for (const handler of lineHandlers) {
                        handler(line);
                    }
                }
            }
        });
    };
    return {
        spawned,
        exited,
        stdin,
        stdout,
        diagnostics: () => ({
            exitCode, signal: exitSignal, stderr: stderr.text(),
            ...(spawnError === undefined ? {} : { error: spawnError }),
        }),
        // Never once kill() ended stdin: a write after end is an unhandled 'error'.
        write: (text) => { if (!stdin.writableEnded && !stdin.destroyed) {
            stdin.write(text);
        } },
        onLine(handler) {
            lineHandlers.push(handler);
            if (!readingLines) {
                readingLines = true;
                readLines();
            }
        },
        onExit(handler) {
            if (ended) {
                queueMicrotask(() => {
                    handler(exitCode);
                });
            }
            else {
                exitHandlers.push(handler);
            }
        },
        resources: treeResourcesReader(child, () => ended),
        kill() {
            stdin.end();
            if (ended || escalation !== null) {
                return;
            }
            if (options.killTree === true && process.platform === "win32") {
                killProcessTree(child);
                escalation = setTimeout(() => {
                    child.kill("SIGKILL");
                }, killGraceMs());
                return;
            }
            const { pid } = child;
            const tree = options.killTree === true && pid !== undefined;
            if (tree) {
                // Read while the child runs: once it is gone, what left its group is
                // re-parented and no longer found below it.
                descendants = descendantsOf(readProcessTable(), pid);
            }
            signalProcessGroup(child, "SIGTERM");
            // Cleared by the exit, so it only fires on a process that ignored the
            // SIGTERM; the SIGKILL then takes its whole group down with it.
            escalation = setTimeout(() => {
                if (!tree) {
                    signalProcessGroup(child, "SIGKILL");
                    return;
                }
                // Read again first: the child may have started more since.
                const table = readProcessTable();
                const now = descendantsOf(table, pid);
                signalProcessGroup(child, "SIGKILL");
                killEntries([...descendants, ...now], table);
                descendants = [];
            }, killGraceMs());
        },
    };
}
