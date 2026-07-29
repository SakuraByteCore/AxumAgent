#!/usr/bin/env node
// `code` is a shortcut entry for `axum code`: it spawns the bundled Pi coding
// agent with Axum defaults by delegating to bin/axum.js. Kept as a thin forwarder
// so the axum main path stays single-purpose and has zero hidden mode behavior.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const axum = join(here, "axum.js");

const child = spawn(process.execPath, [axum, "code", ...process.argv.slice(2)], {
	stdio: "inherit",
});
child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	process.exit(code ?? 1);
});
child.on("error", (error) => {
	console.error(`failed to start axum code: ${error.message}`);
	process.exit(1);
});
