import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, unlinkSync } from "node:fs";
import { extname } from "node:path";

// ── Templates ──────────────────────────────────────────────────────────────

const PLAN_FIRST_TEMPLATE = `Research the requirement quickly and re-confirm the plan. Let's discuss the approach first — do not generate any code until I ask you to.`;

// ── Auto-Compact ────────────────────────────────────────────────────────────

const COMPACT_THRESHOLD = 80;
const COMPACT_COOLDOWN_MS = 30_000;
let lastCompactAt = 0;
let pendingCompact: Promise<void> | null = null;
let compactDeferred = false;

async function maybeCompact(_event: unknown, ctx: ExtensionContext): Promise<void> {
	const u = ctx.getContextUsage();
	if (!u || u.tokens == null || u.contextWindow == null) {
		return;
	}
	const pct = Math.round((u.tokens / u.contextWindow) * 100);
	if (pct < COMPACT_THRESHOLD) {
		compactDeferred = false;
		return;
	}
	const now = Date.now();
	if (now - lastCompactAt < COMPACT_COOLDOWN_MS) return;
	if (pendingCompact) return;
	if (compactDeferred) compactDeferred = false;

	lastCompactAt = now;
	const task = (async () => {
		try {
			await pi.sendUserMessage("/compact");
			await new Promise((r) => setTimeout(r, 400));
			await pi.sendUserMessage("继续");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`Auto-compact failed: ${message}`, "warning");
		}
	})();
	pendingCompact = task;
	try {
		await task;
	} finally {
		pendingCompact = null;
	}
}

async function tryDeferredCompact(ctx: ExtensionContext): Promise<void> {
	if (!compactDeferred) return;
	const u = ctx.getContextUsage();
	if (!u || u.tokens == null || u.contextWindow == null) return;
	const pct = Math.round((u.tokens / u.contextWindow) * 100);
	if (pct < COMPACT_THRESHOLD) {
		compactDeferred = false;
		return;
	}
	await maybeCompact("agent_settled", ctx);
}

// ── /clear ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("clear", {
		description: "Delete the current conversation session and start a fresh one",
		getArgumentCompletions: () => null,
		async handler(_args: string, ctx) {
			const sessionFile = ctx.sessionManager.getSessionFile();

			if (!sessionFile) {
				await ctx.newSession({
					withSession: (newCtx) => {
						newCtx.ui.notify("Started a fresh session (in-memory, no file was deleted).", "info");
					},
				});
				return;
			}

			if (extname(sessionFile) !== ".jsonl") {
				ctx.ui.notify(`Refusing to delete: session file is not .jsonl (${sessionFile}).`, "error");
				return;
			}

			const fileToDelete = sessionFile;
			const result = await ctx.newSession({
				withSession: (newCtx) => {
					try {
						if (existsSync(fileToDelete)) {
							unlinkSync(fileToDelete);
							newCtx.ui.notify("Current session deleted. Started a fresh session.", "info");
						} else {
							newCtx.ui.notify("Fresh session started (old file already gone).", "info");
						}
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						newCtx.ui.notify(`Started new session, but failed to delete old file: ${message}`, "warning");
					}
				},
			});

			if (result.cancelled) {
				ctx.ui.notify("New session cancelled; old session preserved.", "warning");
			}
		},
	});

	// ── /plan ──────────────────────────────────────────────────────────────

	pi.registerCommand("plan", {
		description: "Plan first: research the requirement, re-confirm the approach, and discuss before writing code: /plan <requirement>",
		getArgumentCompletions: () => null,
		async handler(args: string, ctx) {
			const requirement = args.trim();
			if (!requirement) {
				ctx.ui.notify("Please provide a requirement: /plan <requirement>", "warning");
				return;
			}
			const prompt = [
				`[Requirement] ${requirement}`,
				"",
				`[Instructions] ${PLAN_FIRST_TEMPLATE}`,
			].join("\n");
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		},
	});

	// ── Auto-Compact Listeners ──────────────────────────────────────────────

	pi.on("agent_start", async (event, ctx) => {
		await maybeCompact(event, ctx);
	});

	pi.on("turn_start", async (event, ctx) => {
		await maybeCompact(event, ctx);
	});

	pi.on("message_update", async (event, ctx) => {
		const u = ctx.getContextUsage();
		if (!u || u.tokens == null || u.contextWindow == null) {
			if (!compactDeferred) {
				compactDeferred = true;
			}
			return;
		}
		await maybeCompact(event, ctx);
	});

	pi.on("agent_settled", async (event, ctx) => {
		await tryDeferredCompact(ctx);
	});
}
