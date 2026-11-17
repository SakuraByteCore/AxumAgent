import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { capKiloMaxTokens, KILO_PROVIDER_ID } from "./kilo-free.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read the provider override immediately before each SDK request is built. */
export function registerProviderOutputTokens(pi: ExtensionAPI, modelsPath = () => join(getAgentDir(), "models.json")): void {
	pi.on("context", async (_event, ctx) => {
		const model = ctx.model;
		if (!model) return;
		const file = modelsPath();
		let text: string;
		try {
			text = await readFile(file, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		const config: unknown = JSON.parse(text);
		if (!isRecord(config)) throw new TypeError(`Invalid models.json object: ${file}`);
		if (config.providers === undefined) return;
		if (!isRecord(config.providers)) throw new TypeError(`Invalid providers object: ${file}`);
		if (!Object.hasOwn(config.providers, model.provider)) return;
		const provider = config.providers[model.provider];
		if (!isRecord(provider)) throw new TypeError(`Invalid provider ${model.provider}: ${file}`);
		if (!Object.hasOwn(provider, "maxTokens")) return;
		const maxTokens = provider.maxTokens;
		if (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
			throw new TypeError(`Invalid providers.${model.provider}.maxTokens: expected a positive safe integer (${file})`);
		}
		model.maxTokens = model.provider === KILO_PROVIDER_ID
			? capKiloMaxTokens(model.contextWindow, maxTokens)!
			: maxTokens;
	});
}
