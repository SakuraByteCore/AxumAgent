import { closeSync, constants, lstatSync, openSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const live = new Set();
let hooked = false;
function releaseFifos(directory) {
    let names = [];
    try {
        names = readdirSync(directory);
    }
    catch {
        return;
    }
    for (const name of names) {
        const file = path.join(directory, name);
        try {
            if (lstatSync(file).isFIFO()) {
                closeSync(openSync(file, constants.O_WRONLY | constants.O_NONBLOCK));
            }
        }
        catch {
            // ENXIO: no reader is waiting.
        }
    }
}
function removeDirectory(directory) {
    releaseFifos(directory);
    rmSync(directory, { recursive: true, force: true });
}
function removeLive() {
    for (const directory of live) {
        removeDirectory(directory);
    }
    live.clear();
}
function running(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        // EPERM: the pid runs, as another user.
        return error instanceof Error && "code" in error && error.code === "EPERM";
    }
}
/** Remove `prefix` directories whose host pid no longer runs, releasing their FIFOs first; one that cannot be removed (another user's) stays. */
export async function sweepPrivateTempDirs(prefix) {
    const root = tmpdir();
    const names = await readdir(root).catch(() => []);
    await Promise.all(names.map(async (name) => {
        const pid = name.startsWith(prefix) ? /^(\d+)-/u.exec(name.slice(prefix.length))?.[1] : undefined;
        if (pid === undefined || Number(pid) === process.pid || running(Number(pid))) {
            return;
        }
        const directory = path.join(root, name);
        releaseFifos(directory);
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }));
}
/** A fresh 0700 directory for one runtime process, removed by `remove()` or, failing that, by the backstops above. */
export async function privateTempDir(prefix) {
    await sweepPrivateTempDirs(prefix);
    const directory = await mkdtemp(path.join(tmpdir(), `${prefix}${String(process.pid)}-`));
    if (!hooked) {
        process.on("exit", removeLive);
        hooked = true;
    }
    live.add(directory);
    return {
        path: directory,
        remove: () => {
            live.delete(directory);
            removeDirectory(directory);
        },
    };
}
