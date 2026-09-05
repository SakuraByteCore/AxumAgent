/**
 * Project-scoped prompt-history persistence backing the pi-bar shared editor
 * history (see plugin/pi-bar/index.ts sharedPromptHistory).
 *
 * Storage layout mirrors pi's own session files: one JSON-encoded string per
 * line under <agentDir>/sessions/<--cwd-slug-->/prompt-history, so history is
 * isolated per project directory and lives next to that project's sessions.
 * Entries are oldest-first on disk; the editor consumes them newest-first.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const MAX_PROMPT_HISTORY_ENTRIES = 100;

/** Resolve the history file for a project cwd, using pi's session-dir slug. */
export function promptHistoryPath(cwd: string, agentDir: string): string {
	const resolvedCwd = resolve(cwd);
	const slug = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(agentDir, "sessions", slug, "prompt-history");
}

/**
 * Read persisted entries for one project, oldest-first. The result is capped
 * at the most recent MAX_PROMPT_HISTORY_ENTRIES entries; when the file held
 * more, it is rewritten so the on-disk copy stays bounded too. Blank and
 * non-string-JSON lines are dropped, a missing file yields an empty list.
 */
export function loadPromptHistory(file: string): string[] {
	if (!existsSync(file)) return [];
	const raw = readFileSync(file, "utf8");
	const entries: string[] = [];
	for (const line of raw.split("\n")) {
		if (!line) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue; // malformed line: drop it, entry was never valid history
		}
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed) entries.push(trimmed);
	}
	if (entries.length <= MAX_PROMPT_HISTORY_ENTRIES) return entries;
	const kept = entries.slice(-MAX_PROMPT_HISTORY_ENTRIES);
	writeFileSync(file, kept.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return kept;
}

/**
 * Append one entry to a project's history file. The caller guarantees the
 * entry is trimmed, non-empty and not already persisted on this path. The
 * file (and its --cwd-slug-- directory) is created lazily, so history works
 * for a project even before any pi session file exists there.
 */
export function appendPromptHistoryEntry(file: string, entry: string): void {
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, JSON.stringify(entry) + "\n");
}
