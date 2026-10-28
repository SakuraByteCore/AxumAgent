import { spawn } from "node:child_process";
import { killGraceMs, OWN_PROCESS_GROUP, signalProcessGroup, trackOwnedProcess } from "./process.js";
import { nativeError, stderrTail } from "./diagnostics.js";
import { isWindowsShim, windowsSpawnTarget } from "./windows-shim.js";
const OUTPUT_LIMIT = 2 * 1024 * 1024;
export const runExecutable = async (executable, args, options = {}) => {
    const timeoutMs = options.timeoutMs ?? 15_000;
    // execFile does not forward `detached` to spawn. Own the actual process
    // group here too, so a hung probe's tools cannot outlive the host.
    const result = await new Promise((resolve) => {
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let failure = null;
        let timedOut = false;
        let stopped = false;
        let timer = null;
        let escalation = null;
        const complete = (code, signal) => {
            clearTimeout(timer ?? undefined);
            clearTimeout(escalation ?? undefined);
            options.signal?.removeEventListener("abort", onAbort);
            const ok = code === 0 && signal === null && failure === null && !stopped;
            const exitCode = ok || failure !== null || stopped ? null : code;
            resolve({
                ok, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), exitCode,
                ...(ok ? {} : { diagnostics: {
                        exitCode, signal, stderr: stderrTail(stderr.toString("utf8")),
                        ...(timedOut ? { timeoutMs } : {}),
                        ...(failure === null ? {} : { error: failure }),
                    } }),
            });
        };
        let stop = null;
        const onAbort = () => {
            failure ??= { code: "ABORT_ERR", message: "The operation was aborted" };
            stop?.();
        };
        try {
            if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
                throw Object.assign(new RangeError("timeoutMs must be a nonnegative integer"), { code: "ERR_OUT_OF_RANGE" });
            }
            // On Windows a `.cmd`/`.bat` shim OAR can read resolves to the Node
            // interpreter and script it wraps, so no argument reaches `cmd.exe`
            // (windows-shim.ts); a shim it cannot read is still launched, which
            // `node:child_process` only does for a `.cmd`/`.bat` through a shell.
            // Off Windows, the inputs unchanged and no shell.
            const target = windowsSpawnTarget(executable, args);
            const child = spawn(target.command, [...target.args], {
                cwd: options.cwd, env: options.env,
                stdio: ["pipe", "pipe", "pipe"],
                detached: OWN_PROCESS_GROUP,
                shell: process.platform === "win32" && isWindowsShim(target.command),
            });
            trackOwnedProcess(child);
            // An exited group leader can leave descendants holding the pipes.
            // Signal the group until close, and retain escalation until then.
            stop = () => {
                if (stopped) {
                    return;
                }
                stopped = true;
                clearTimeout(timer ?? undefined);
                signalProcessGroup(child, "SIGTERM");
                escalation = setTimeout(() => { signalProcessGroup(child, "SIGKILL"); }, killGraceMs());
                escalation.unref();
            };
            const append = (output, chunk, stream) => {
                const remaining = OUTPUT_LIMIT - output.length;
                const next = Buffer.concat([output, chunk.subarray(0, Math.max(0, remaining))]);
                if (chunk.length > remaining) {
                    failure ??= { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", message: `${stream} maxBuffer length exceeded` };
                    stop?.();
                }
                return next;
            };
            child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk, "stdout"); });
            child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk, "stderr"); });
            child.once("error", (error) => { failure ??= nativeError(error); });
            child.once("close", complete);
            if (timeoutMs > 0) {
                timer = setTimeout(() => { timedOut = true; stop?.(); }, timeoutMs);
                timer.unref();
            }
            options.signal?.addEventListener("abort", onAbort, { once: true });
            if (options.signal?.aborted === true) {
                onAbort();
            }
        }
        catch (error) {
            if (!(error instanceof Error)) {
                throw error;
            }
            failure = nativeError(error);
            complete(null, null);
        }
    });
    return result;
};
