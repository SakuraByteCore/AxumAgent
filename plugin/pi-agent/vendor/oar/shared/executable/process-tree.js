import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
/** `/proc/<pid>/stat`'s ppid, pgrp and starttime (clock ticks since boot); null once the process is gone. */
function readStat(pid) {
    let stat = "";
    try {
        stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    }
    catch {
        return null;
    }
    // Field 2, the command name, is parenthesized and may itself hold spaces
    // and parentheses; the fields after its last ")" start at field 3 (state).
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const [ppid, pgid, start] = [Number(fields[1]), Number(fields[2]), fields[19]];
    return Number.isInteger(ppid) && Number.isInteger(pgid) && start !== undefined ? { pid, ppid, pgid, start } : null;
}
/** Linux: every process's stat. */
function readProcfs() {
    const table = new Map();
    for (const name of readdirSync("/proc")) {
        const entry = /^\d+$/u.test(name) ? readStat(Number(name)) : null;
        if (entry !== null) {
            table.set(entry.pid, entry);
        }
    }
    return table;
}
/** Other POSIX systems (macOS): one `ps` run; `lstart` is the start time to the second. */
function readPs() {
    const output = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart="], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
        maxBuffer: 16 * 1024 * 1024,
    });
    const table = new Map();
    for (const line of output.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/u.exec(line);
        if (match !== null) {
            const pid = Number(match[1]);
            table.set(pid, { pid, ppid: Number(match[2]), pgid: Number(match[3]), start: match[4] ?? "" });
        }
    }
    return table;
}
/**
 * The process table now (synchronous: the host's `exit` hook reads it too).
 * Empty when it cannot be read; the caller then reaches the process group only.
 */
export function readProcessTable(source = process.platform === "linux" ? "procfs" : "ps") {
    try {
        return source === "procfs" ? readProcfs() : readPs();
    }
    catch {
        return new Map();
    }
}
/** Every process below `pid` in `table`: its children, theirs, and so on. */
export function descendantsOf(table, pid) {
    const children = new Map();
    for (const entry of table.values()) {
        const siblings = children.get(entry.ppid);
        if (siblings === undefined) {
            children.set(entry.ppid, [entry]);
        }
        else {
            siblings.push(entry);
        }
    }
    const found = [];
    const seen = new Set([pid]);
    const pending = [pid];
    for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
        for (const child of children.get(parent) ?? []) {
            if (!seen.has(child.pid)) {
                seen.add(child.pid);
                found.push(child);
                pending.push(child.pid);
            }
        }
    }
    return found;
}
/**
 * SIGKILL each of `entries` that `table` (read just before) shows still
 * running, the same process (same start time), and the process group each
 * belongs to now: the runtime's own, or one a descendant made, which can hold
 * processes started since the entries were read. Never the host, nor its group.
 */
export function killEntries(entries, table) {
    const hostGroup = table.get(process.pid)?.pgid;
    const groups = new Set();
    const pids = new Set();
    for (const entry of entries) {
        const current = table.get(entry.pid);
        if (current === undefined || current.start !== entry.start || current.pid === process.pid) {
            continue;
        }
        pids.add(current.pid);
        if (current.pgid > 1 && current.pgid !== hostGroup) {
            groups.add(current.pgid);
        }
    }
    for (const group of groups) {
        try {
            process.kill(-group, "SIGKILL");
        }
        catch {
            // The group emptied meanwhile.
        }
    }
    for (const pid of pids) {
        try {
            process.kill(pid, "SIGKILL");
        }
        catch {
            // Gone meanwhile.
        }
    }
}
