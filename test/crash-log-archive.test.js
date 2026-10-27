import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { archivePendingCrashes } from "../src/crash-log-archive.js";

function withAgentDir(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-crash-"));
	try {
		return fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("unnotified pi crashes are archived and no longer warned about", () => {
	withAgentDir((dir) => {
		const crashPath = path.join(dir, "crashes.json");
		fs.writeFileSync(
			crashPath,
			JSON.stringify([
				{ timestamp: "2026-10-26T14:15:50.437Z", message: "xhigh frozen", notified: true },
				{ timestamp: "2026-10-26T14:37:56.283Z", message: "stale ctx" },
			]),
		);
		assert.deepEqual(archivePendingCrashes(dir), { archived: 1 });
		// pi only warns about unnotified records: every record is marked now.
		const records = JSON.parse(fs.readFileSync(crashPath, "utf8"));
		assert.equal(records.length, 2);
		assert.equal(records.every((record) => record.notified === true), true);
		// The crash evidence is kept in Axum's own archive.
		const archive = JSON.parse(fs.readFileSync(path.join(dir, "axum-crashes.json"), "utf8"));
		assert.equal(archive.length, 1);
		assert.equal(archive[0].message, "stale ctx");
		// Running again archives nothing new.
		assert.deepEqual(archivePendingCrashes(dir), { archived: 0 });
	});
});

test("missing or broken crash logs are ignored", () => {
	withAgentDir((dir) => {
		assert.deepEqual(archivePendingCrashes(dir), { archived: 0 });
		fs.writeFileSync(path.join(dir, "crashes.json"), "{not json");
		assert.deepEqual(archivePendingCrashes(dir), { archived: 0 });
	});
});
