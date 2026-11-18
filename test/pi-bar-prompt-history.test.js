import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
	MAX_PROMPT_HISTORY_ENTRIES,
	appendPromptHistoryEntry,
	globalPromptHistoryPath,
	loadPromptHistory,
	promptHistoryPath,
	rewritePromptHistory,
} from "../plugin/pi-bar/prompt-history.ts";
import { getDefaultSessionDir } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";

const indexSource = fs.readFileSync(path.join(process.cwd(), "plugin", "pi-bar", "index.ts"), "utf8").replaceAll("\r\n", "\n");

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

test("globalPromptHistoryPath resolves one cross-project history file", () => {
	const agentDir = tmpAgentDir();
	assert.equal(globalPromptHistoryPath(agentDir), path.join(agentDir, "prompt-history-global"));
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

test("read-only load caps entries without changing file bytes or modification time", () => {
	const file = path.join(tmpAgentDir(), "prompt-history");
	const entries = Array.from({ length: MAX_PROMPT_HISTORY_ENTRIES + 10 }, (_, i) => `entry-${i}`);
	rewritePromptHistory(file, entries);
	fs.appendFileSync(file, '\nnot json\n123\n"  "\n');
	const before = fs.readFileSync(file);
	fs.utimesSync(file, 1, 1);
	const modified = fs.statSync(file).mtimeMs;
	assert.deepEqual(loadPromptHistory(file, { readOnly: true }), entries.slice(10));
	assert.deepEqual(fs.readFileSync(file), before);
	assert.equal(fs.statSync(file).mtimeMs, modified);
	const missing = path.join(tmpAgentDir(), "missing");
	assert.deepEqual(loadPromptHistory(missing, { readOnly: true }), []);
	assert.equal(fs.existsSync(missing), false);
});

test("rewritePersistedHistory replaces the whole file and survives load", () => {
	const agentDir = tmpAgentDir();
	const file = promptHistoryPath(process.cwd(), agentDir);
	appendPromptHistoryEntry(file, "doomed");
	rewritePromptHistory(file, ["a", "b", "c"]);
	assert.deepEqual(loadPromptHistory(file), ["a", "b", "c"]);
	assert.deepEqual(readEntries(file), ["a", "b", "c"]);
	rewritePromptHistory(file, []);
	assert.deepEqual(loadPromptHistory(file), []);
	assert.deepEqual(readEntries(file), []);
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
	assert.match(indexSource, /globalPromptHistoryPath\(AGENT_DIR\)/);
	assert.match(indexSource, /globalPromptHistory\.splice\(0, globalPromptHistory\.length, \.\.\.globalEntries\.reverse\(\)\)/);
});

test("the /history command opens a picker that deletes via rewrite", () => {
	assert.match(indexSource, /registerCommand\("history"/);
	assert.match(indexSource, /class PromptHistoryPicker/);
	assert.match(indexSource, /ctx\.ui\.custom\(/);
	// Deletion splices the shared array in place, prunes the dedup ledger,
	// and rewrites the disk file oldest-first from the survivors.
	assert.match(indexSource, /function deletePromptEntries\(texts: string\[\]\): number \{/);
	assert.match(indexSource, /projectPromptHistory\.splice\(index, 1\)/);
	assert.match(indexSource, /persistedPromptEntries\.delete\(text\)/);
	assert.match(indexSource, /rewritePromptHistory\(promptHistoryFile, projectPromptHistory\.slice\(\)\.reverse\(\)\)/);
	assert.match(indexSource, /this\.rows = projectPromptHistory\.slice\(\)/);
	// Picker keys: arrows, space toggle, ctrl+a select-all, enter, escape.
	assert.match(indexSource, /matchesKey\(data, "up"\)/);
	assert.match(indexSource, /matchesKey\(data, "down"\)/);
	assert.match(indexSource, /matchesKey\(data, "space"\)/);
	assert.match(indexSource, /matchesKey\(data, "ctrl\+a"\)/);
	assert.match(indexSource, /matchesKey\(data, "enter"\)/);
	assert.match(indexSource, /matchesKey\(data, "escape"\)/);
});

test("live editor history refresh preserves navigation, drafts and external writes", async (t) => {
	const root = tmpAgentDir();
	const savedDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	const nestedTui = path.resolve("node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js");
	const tui = await import(fs.existsSync(nestedTui) ? pathToFileURL(nestedTui).href : "@earendil-works/pi-tui");
	const previousBindings = tui.getKeybindings();
	const bindings = new tui.KeybindingsManager(tui.TUI_KEYBINDINGS, {
		"tui.editor.historyPrevious": "ctrl+p", "tui.editor.historyNext": "ctrl+n",
	});
	tui.setKeybindings(bindings);
	t.after(() => {
		tui.setKeybindings(previousBindings);
		if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedDir;
		fs.rmSync(root, { recursive: true, force: true });
	});
	const mod = await import(`../plugin/pi-bar/index.ts?live-history=${Date.now()}`);
	const project = promptHistoryPath(process.cwd(), root), global = globalPromptHistoryPath(root);
	const write = (entries, globals = []) => { rewritePromptHistory(project, entries); rewritePromptHistory(global, globals); };
	write(["old", "latest"], ["global-old"]);
	const theme = { borderColor: text => text };
	const editor = new mod.DashedBorderEditor({ terminal: { rows: 24 }, requestRender() {} }, theme, bindings);
	editor.render(80);
	const key = (data) => { editor.handleInput(data); return editor.getText(); };
	await t.test("external add, delete and global promotion appear on the next arrow", () => {
		assert.equal(key("\x1b[A"), "latest");
		write(["old", "external"], ["global-new"]); editor.setText("");
		assert.equal(key("\x1b[A"), "external"); assert.equal(key("\x1b[A"), "old");
		assert.equal(key("\x1b[A"), "global-new"); assert.equal(key("\x1b[B"), "old");
		write(["old"], ["external"]); editor.setText("");
		assert.equal(key("\x1b[A"), "old"); assert.equal(key("\x1b[A"), "external");
		assert.equal(key("\x1b[A"), "external", "promotion must not duplicate the entry");
		write(["old", "middle", "latest"]); editor.setText(""); key("\x10"); key("\x10");
		write(["old", "middle", "latest", "fresh"]);
		assert.equal(key("\x10"), "old", "new entries must not shift the selected record");
	});
	await t.test("deleted browsing entries retain neighbours and restore an exact multiline draft", () => {
		write(["old", "middle", "latest"]); editor.setText("draft\n尾巴"); key("\x1b[D");
		const cursor = editor.getCursor();
		assert.equal(key("\x10"), "latest"); assert.equal(key("\x10"), "middle");
		write(["old", "latest"]);
		assert.equal(key("\x0e"), "latest");
		assert.equal(key("\x0e"), "draft\n尾巴"); assert.deepEqual(editor.getCursor(), cursor);
		key("\x10"); write([]);
		assert.equal(key("\x0e"), "draft\n尾巴"); assert.deepEqual(editor.getCursor(), cursor);
		write(["old", "middle", "latest"]); editor.setText(""); key("\x10"); key("\x10");
		write(["old", "latest"]); assert.equal(key("\x10"), "old");
	});
	await t.test("ordinary multiline movement and completion keep their input routing", () => {
		editor.setText("first\nsecond"); const before = editor.getCursor();
		assert.equal(key("\x1b[A"), "first\nsecond"); assert.ok(editor.getCursor().line < before.line);
		let moves = 0;
		editor.autocompleteState = "prefix";
		editor.autocompleteList = { handleInput() { moves++; } };
		assert.equal(key("\x1b[A"), "first\nsecond"); assert.equal(moves, 1);
		write(["completion-history"]);
		assert.equal(key("\x10"), "completion-history", "dedicated history binding refreshes even with completion open");
	});
	await t.test("submissions reload disk and allow explicitly resubmitting a deleted entry", () => {
		write(["obsolete", "keep"], ["global"]); editor.setText(""); key("\x1b[A");
		write(["keep"], ["global"]); editor.addToHistory("fresh");
		assert.deepEqual(readEntries(project), ["keep", "fresh"]);
		editor.addToHistory("global"); assert.deepEqual(readEntries(project), ["keep", "fresh"]);
		write(["keep"], ["global"]); editor.addToHistory("fresh");
		assert.deepEqual(readEntries(project), ["keep", "fresh"]);
	});
	await t.test("picker deletion synchronizes before rewriting and leaves global history intact", async () => {
		const commands = new Map();
		mod.default({ registerCommand: (name, spec) => commands.set(name, spec), on() {}, events: { on() {}, emit() {} } });
		write(["obsolete", "keep"], ["global"]);
		await commands.get("history").handler("", { hasUI: true, ui: { notify() {}, custom: async factory => {
			let result;
			const picker = factory({}, theme, bindings, value => { result = value; });
			write(["external", "keep"], ["global"]);
			picker.handleInput(" "); picker.handleInput("\r"); picker.handleInput("\x1b");
			return result;
		} } });
		assert.deepEqual(readEntries(project), ["external"]); assert.deepEqual(readEntries(global), ["global"]);
	});
});
