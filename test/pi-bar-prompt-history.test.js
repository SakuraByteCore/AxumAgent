import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	MAX_PROMPT_HISTORY_ENTRIES,
	appendPromptHistoryEntry,
	loadPromptHistory,
	promptHistoryPath,
} from "../plugin/pi-bar/prompt-history.ts";
import { getDefaultSessionDir } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";

const indexSource = fs.readFileSync(path.join(process.cwd(), "plugin", "pi-bar", "index.ts"), "utf8");

function tmpAgentDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "axum-history-"));
}

function readEntries(file) {
	return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("promptHistoryPath matches pi's per-cwd session directory", () => {
	const agentDir = tmpAgentDir();
	const cwd = fs.realpathSync(tmpAgentDir());
	const file = promptHistoryPath(cwd, agentDir);
	const sessionDir = getDefaultSessionDir(cwd, agentDir); // creates the dir as a side effect
	assert.equal(file, path.join(sessionDir, "prompt-history"));
});

test("different cwds map to different history files", () => {
	const agentDir = tmpAgentDir();
	const a = fs.mkdirSync(path.join(agentDir, "proj-a"), { recursive: true });
	const b = fs.mkdirSync(path.join(agentDir, "proj-b"), { recursive: true });
	assert.ok(a && b);
	assert.notEqual(promptHistoryPath(a, agentDir), promptHistoryPath(b, agentDir));
});

test("append + load round-trips entries including multi-line prompts", () => {
	const agentDir = tmpAgentDir();
	const file = promptHistoryPath(process.cwd(), agentDir);
	appendPromptHistoryEntry(file, "first prompt");
	appendPromptHistoryEntry(file, "multi\nline\nprompt");
	appendPromptHistoryEntry(file, 'with "quotes" and emoji 🌸');
	assert.deepEqual(loadPromptHistory(file), ["first prompt", "multi\nline\nprompt", 'with "quotes" and emoji 🌸']);
});

test("append creates the sessions/--cwd-- directory lazily", () => {
	const agentDir = tmpAgentDir();
	const cwd = fs.realpathSync(tmpAgentDir());
	const file = promptHistoryPath(cwd, agentDir);
	appendPromptHistoryEntry(file, "hello");
	assert.ok(fs.existsSync(file));
	assert.deepEqual(readEntries(file), ["hello"]);
});

test("load of a missing file yields an empty list", () => {
	const file = path.join(tmpAgentDir(), "sessions", "--nope--", "prompt-history");
	assert.deepEqual(loadPromptHistory(file), []);
});

test("load drops blank and non-string-JSON lines", () => {
	const file = path.join(tmpAgentDir(), "prompt-history");
	fs.writeFileSync(file, `"ok"\n\nnot json\n123\ntrue\n"second"\n`);
	assert.deepEqual(loadPromptHistory(file), ["ok", "second"]);
});

test("load caps at the newest MAX entries and rewrites the file", () => {
	const file = path.join(tmpAgentDir(), "prompt-history");
	for (let i = 0; i < MAX_PROMPT_HISTORY_ENTRIES + 10; i++) appendPromptHistoryEntry(file, `entry-${i}`);
	const loaded = loadPromptHistory(file);
	assert.equal(loaded.length, MAX_PROMPT_HISTORY_ENTRIES);
	assert.equal(loaded[0], "entry-10");
	assert.equal(loaded.at(-1), `entry-${MAX_PROMPT_HISTORY_ENTRIES + 9}`);
	assert.equal(readEntries(file).length, MAX_PROMPT_HISTORY_ENTRIES);
});

test("pi-bar wires persistence into the dashed border editor", () => {
	// Seeding runs before the instance history is swapped to the shared array.
	const ctor = indexSource.match(/class DashedBorderEditor[\s\S]*?\n  }\n/)?.[0] ?? "";
	assert.match(ctor, /super\(tui, theme, keybindings, options\);\s*\n\s*ensurePromptHistoryLoaded\(\);/);
	assert.match(ctor, /history = sharedPromptHistory/);
	// addToHistory only persists a changed head that is not already on disk.
	assert.match(indexSource, /override addToHistory\(text: string\): void \{/);
	assert.match(indexSource, /persistedPromptEntries\.has\(newest\)\) return;/);
	assert.match(indexSource, /\.\/prompt-history/);
});
