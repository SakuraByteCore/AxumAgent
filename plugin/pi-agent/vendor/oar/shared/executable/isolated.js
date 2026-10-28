import spawn from "cross-spawn";
import { killGraceMs, killProcessTree, OWN_PROCESS_GROUP, signalProcessGroup, trackOwnedProcess } from "./process.js";
import { windowsSpawnTarget } from "./windows-shim.js";
const OUTPUT_LIMIT = 1024 * 1024;
/** After the command itself exits, how long a process it left holding the output pipes may keep them. */
const PIPE_DRAIN_MS = 2000;
function keepTail(text) {
    return text.length > OUTPUT_LIMIT ? text.slice(-OUTPUT_LIMIT) : text;
}
/** Stop the command and everything it started: its process group on POSIX, its process tree on Windows. */
function stopTree(child) {
    if (process.platform === "win32") {
        killProcessTree(child);
        return;
    }
    signalProcessGroup(child, "SIGTERM");
    // Kept after the command exits: what it started may outlive it holding the
    // group, and those get the SIGKILL too.
    setTimeout(() => {
        signalProcessGroup(child, "SIGKILL");
    }, killGraceMs()).unref();
}
/**
 * Run a command that may start others (an updater runs npm or `curl | sh`)
 * with no stdin, no controlling terminal (its own session and process group
 * on POSIX), and a timeout that stops the whole group rather than only the
 * command, so nothing is cut off midway without the caller seeing a timeout
 * or left running after it.
 */
export async function runIsolated(command, args, options) {
    // On Windows a `.cmd`/`.bat` shim resolves to the Node interpreter and
    // script it wraps, so no argument reaches `cmd.exe` (windows-shim.ts).
    const target = windowsSpawnTarget(command, args);
    const child = spawn(target.command, [...target.args], {
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: OWN_PROCESS_GROUP,
        windowsHide: true,
    });
    trackOwnedProcess(child);
    let stdout = "";
    let stderr = "";
    const stop = { timedOut: false };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
        stdout = keepTail(stdout + chunk);
    });
    child.stderr?.on("data", (chunk) => {
        stderr = keepTail(stderr + chunk);
    });
    const timer = setTimeout(() => {
        stop.timedOut = true;
        stopTree(child);
    }, options.timeoutMs);
    const exitCode = await new Promise((resolve) => {
        let code = null;
        child.once("exit", (exit) => {
            code = exit;
            setTimeout(() => {
                resolve(code);
            }, PIPE_DRAIN_MS);
        });
        child.once("close", (exit) => {
            resolve(exit ?? code);
        });
        child.once("error", (error) => {
            stderr += error.message;
            resolve(null);
        });
    });
    clearTimeout(timer);
    return { exitCode: stop.timedOut ? null : exitCode, timedOut: stop.timedOut, stdout, stderr };
}
/**
 * A run's stdout then stderr, verbatim, with oar's note when the timeout
 * stopped it. `what` names the command for that note ("updater", "installer").
 */
export function isolatedOutput(result, timeoutMs, what) {
    const output = `${result.stdout}${result.stderr}`;
    return result.timedOut ? `${output}\n[oar: stopped the ${what} after ${String(timeoutMs)} ms]\n` : output;
}
