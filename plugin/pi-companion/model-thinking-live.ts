import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const SAVE_SETTLE_MS = 25;
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Synchronize before the SDK snapshots reasoning and while the session is idle. */
export function registerLiveModelThinking(
	pi: ExtensionAPI,
	modelsPath: () => string = () => join(getAgentDir(), "models.json"),
	options: { explicitThinking?: boolean } = {},
): void {
	const explicit = options.explicitThinking ?? (process.env.AXUM_EXPLICIT_THINKING !== undefined
		? process.env.AXUM_EXPLICIT_THINKING === "1"
		: process.argv.some(arg => arg === "--thinking" || arg.startsWith("--thinking=")));
	let watcher: FSWatcher | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let currentCtx: ExtensionContext | undefined;
	let epoch = 0;
	let pending = Promise.resolve();
	let applied: { model: object; signature: string } | undefined;

	async function refresh(ctx: ExtensionContext, generation: number): Promise<void> {
		const model = ctx.model;
		if (!model || explicit) return;
		const file = modelsPath();
		let text: string;
		try { text = await readFile(file, "utf8"); }
		catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		if (generation !== epoch || ctx.model !== model) return;
		const config: unknown = JSON.parse(text);
		if (!isRecord(config)) throw new TypeError(`Invalid models.json object: ${file}`);
		if (config.providers === undefined) return;
		if (!isRecord(config.providers)) throw new TypeError(`Invalid providers object: ${file}`);
		const provider = Object.hasOwn(config.providers, model.provider) ? config.providers[model.provider] : undefined;
		if (provider === undefined) return;
		if (!isRecord(provider)) throw new TypeError(`Invalid provider ${model.provider}: ${file}`);
		if (provider.models === undefined) return;
		if (!Array.isArray(provider.models)) throw new TypeError(`Invalid models for ${model.provider}: ${file}`);
		const saved = provider.models.find((entry: unknown) => isRecord(entry) && entry.id === model.id);
		if (!isRecord(saved)) { applied = undefined; return; }
		const value = Object.hasOwn(saved, "reasoningEffort") ? saved.reasoningEffort : saved.thinkingLevel;
		if (value === undefined) { applied = undefined; return; }
		const level = LEVELS.find(candidate => candidate === value);
		if (level === undefined) throw new TypeError(`Invalid reasoningEffort for ${model.provider}/${model.id}: ${file}`);
		const signature = JSON.stringify([level, saved.reasoning, saved.thinkingLevelMap]);
		if (applied?.model === model && applied.signature === signature) return;
		const map = saved.thinkingLevelMap;
		if (map !== undefined && !isRecord(map)) throw new TypeError(`Invalid thinkingLevelMap: ${file}`);
		const levelMap: NonNullable<typeof model.thinkingLevelMap> = {};
		if (isRecord(map)) for (const key of LEVELS) {
			const mapped = map[key];
			if (mapped === undefined) continue;
			if (mapped !== null && typeof mapped !== "string") throw new TypeError(`Invalid thinkingLevelMap.${key}: ${file}`);
			levelMap[key] = mapped;
		}
		if (typeof saved.reasoning === "boolean") model.reasoning = saved.reasoning;
		else if (level !== "off") model.reasoning = true;
		if (isRecord(map)) model.thinkingLevelMap = levelMap;
		pi.setThinkingLevel(level);
		applied = { model, signature };
		pi.events.emit("pi-companion:thinking-changed", { provider: model.provider, model: model.id, level: pi.getThinkingLevel() });
	}

	function enqueue(ctx: ExtensionContext): Promise<void> {
		currentCtx = ctx;
		const generation = epoch;
		const run = () => refresh(ctx, generation);
		// Each caller receives its rejection; the next refresh can recover.
		pending = pending.then(run, run);
		return pending;
	}
	function report(error: unknown): void {
		const message = `刷新模型思考强度失败：${error instanceof Error ? error.message : String(error)}`;
		if (currentCtx?.hasUI) currentCtx.ui.notify(message, "error");
		else console.error(message);
	}
	function stop(): void {
		epoch++;
		watcher?.close();
		watcher = undefined;
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		currentCtx = undefined;
		applied = undefined;
	}
	pi.on("session_start", async (_event, ctx) => {
		stop();
		if (explicit || !ctx.model) return;
		currentCtx = ctx;
		const file = modelsPath();
		try {
			watcher = watch(dirname(file), { persistent: false }, (_event, name) => {
				if (name !== null && name.toString() !== basename(file)) return;
				if (timer !== undefined) clearTimeout(timer);
				timer = setTimeout(() => {
					timer = undefined;
					if (currentCtx) void enqueue(currentCtx).catch(report);
				}, SAVE_SETTLE_MS);
				timer.unref();
			});
			watcher.on("error", report);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		await enqueue(ctx);
	});
	pi.on("session_shutdown", stop);
	pi.on("model_select", (_event, ctx) => {
		applied = undefined;
		return enqueue(ctx);
	});
	// before_agent_start precedes createLoopConfig; turn_end precedes prepareNextTurn.
	pi.on("before_agent_start", (_event, ctx) => enqueue(ctx));
	pi.on("turn_end", (_event, ctx) => enqueue(ctx));
}
