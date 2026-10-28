import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runExecutable } from "../../shared/executable/run.js";
import { checkMcpServerNames, isHttpMcpServer } from "../../shared/mcp-servers.js";
import { privateTempDir, sweepPrivateTempDirs } from "../../shared/private-temp.js";
/** claude's `--mcp-config` document for the entries: stdio `{type, command, args, env}`, http `{type, url, headers}`. */
export function claudeMcpConfig(servers) {
    return {
        mcpServers: Object.fromEntries(servers.map((server) => [server.name, isHttpMcpServer(server)
                ? { type: "http", url: server.url, ...(server.headers === undefined ? {} : { headers: server.headers }) }
                : { type: "stdio", command: server.command, args: server.args ?? [], ...(server.env === undefined ? {} : { env: server.env }) }])),
    };
}
function errorCode(error) {
    return error instanceof Error && "code" in error ? error.code : undefined;
}
/** A 0600 FIFO at `file`; false where none can be made. */
async function makeFifo(file) {
    if (process.platform === "win32") {
        return false;
    }
    const made = await runExecutable("mkfifo", ["-m", "600", file]);
    return made.ok;
}
/** The write end once a reader has the FIFO open; undefined when `stopped()` first. */
async function openWhenRead(file, stopped) {
    let wait = 5;
    while (!stopped()) {
        try {
            // oxlint-disable-next-line no-await-in-loop -- polling: each attempt waits for the previous one.
            return await open(file, constants.O_WRONLY | constants.O_NONBLOCK);
        }
        catch (error) {
            if (errorCode(error) !== "ENXIO") {
                throw error;
            }
        }
        // oxlint-disable-next-line no-await-in-loop -- as above; unref'd, so polling alone keeps no host alive.
        await delay(wait, undefined, { ref: false });
        wait = Math.min(wait * 2, 100);
    }
    return undefined;
}
/** Write all of `content` to a non-blocking pipe: a full pipe answers EAGAIN until the reader drains it. */
async function writeAll(handle, content, stopped) {
    let rest = content;
    while (rest.length > 0 && !stopped()) {
        try {
            // oxlint-disable-next-line no-await-in-loop -- sequential writes to one pipe.
            const { bytesWritten } = await handle.write(rest);
            rest = rest.subarray(bytesWritten);
        }
        catch (error) {
            if (errorCode(error) !== "EAGAIN") {
                throw error;
            }
            // oxlint-disable-next-line no-await-in-loop -- as above.
            await delay(5, undefined, { ref: false });
        }
    }
}
function fifoHandoff(file, content, directory) {
    let ended = false;
    const stopped = () => ended;
    const end = () => {
        ended = true;
        directory.remove();
    };
    const feed = async () => {
        const handle = await openWhenRead(file, stopped);
        if (handle === undefined) {
            return;
        }
        try {
            await writeAll(handle, Buffer.from(content), stopped);
        }
        finally {
            await handle.close();
        }
    };
    return {
        path: file,
        start: () => {
            // A failed feed (claude closed its end early) leaves claude to report
            // the config it could not read; the directory goes either way.
            void (async () => {
                try {
                    await feed();
                }
                catch {
                    // claude's own error is the report.
                }
                finally {
                    end();
                }
            })();
        },
        end,
    };
}
const PREFIX = "oar-claude-mcp-";
/**
 * Before any claude starts, with servers or without: remove what hosts that
 * died left behind, letting a claude still waiting on such a FIFO go.
 */
export async function sweepAbandonedMcpConfigs() {
    await sweepPrivateTempDirs(PREFIX);
}
/** The handoff for these entries (sweeping as above first). Rejects on an empty or repeated name before anything is created. */
export async function handOverMcpConfig(servers) {
    checkMcpServerNames(servers);
    const directory = await privateTempDir(PREFIX);
    const file = path.join(directory.path, "mcp.json");
    const content = JSON.stringify(claudeMcpConfig(servers));
    try {
        if (await makeFifo(file)) {
            return fifoHandoff(file, content, directory);
        }
        await writeFile(file, content, { mode: 0o600, flag: "wx" });
    }
    catch (error) {
        directory.remove();
        throw error;
    }
    return {
        path: file,
        start: () => {
            // claude reads the file at startup; it goes when claude exits (end).
        },
        end: () => {
            directory.remove();
        },
    };
}
