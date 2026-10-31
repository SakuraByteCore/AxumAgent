// vision-fallback.ts — 独立视觉提供商回退
//
// 当前会话模型不支持图片输入时（model.input 不含 "image"），本扩展把图片交给
// 单独配置的视觉模型，并把视觉模型返回的文字描述注入主会话：
//   - 用户附带/粘贴的图片：input 事件 → transform（清空 images，改写 text）
//   - 工具结果中的图片（例如 read 读取 PNG）：tool_result 事件 → 图片块换成文本块
//
// 配置来源：~/.pi/agent/axum.json 的 "vision" 块
//   {
//     "vision": {
//       "enabled": true,
//       "provider": "kilo",
//       "model": "nvidia/nemotron-3.5-super-vl:free",
//       "prompt": "可选，覆盖默认描述提示词",
//       "maxTokens": 1024
//     }
//   }
//
// 视觉模型本身仍按 Pi 常规方式写在 ~/.pi/agent/models.json 的 providers 中，
// 因此可以单独建一个只服务图片的 provider（独立 baseUrl / API Key / 模型）。
// 描述请求走 ModelRegistry.complete，鉴权由 provider 配置解析，不落盘凭据。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";

export const VISION_CONFIG_KEY = "vision";

export const DEFAULT_VISION_PROMPT = [
	"Describe the attached image for an assistant that cannot see images.",
	"Report visible text verbatim, plus UI elements, layout, colors and notable objects.",
	"Answer in the language of the accompanying request when it is not empty, otherwise in English.",
].join(" ");

/** read 工具在非视觉模型下追加的固定提示，注入视觉描述后必须移除，否则自相矛盾。 */
export const NON_VISION_IMAGE_NOTE = "[Current model does not support images. The image will be omitted from this request.]";

export interface VisionImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

export interface VisionTextBlock {
	type: "text";
	text: string;
}

export type VisionContentBlock = VisionImageBlock | VisionTextBlock;

export interface VisionSettings {
	enabled: boolean;
	provider: string;
	model: string;
	prompt: string;
	maxTokens?: number;
}

export interface VisionConfig extends VisionSettings {
	enabled: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function defaultAgentDir(): string {
	return join(homedir(), ".pi", "agent");
}

export function visionConfigFile(agentDir: string = defaultAgentDir()): string {
	return join(agentDir, "axum.json");
}

/** 读取 axum.json 里的 vision 原始块并归一化；缺块或类型错误返回 undefined。 */
export function normalizeVisionSettings(raw: unknown): VisionSettings | undefined {
	if (!isRecord(raw)) return undefined;
	const block = raw[VISION_CONFIG_KEY];
	if (!isRecord(block)) return undefined;
	const provider = typeof block.provider === "string" ? block.provider.trim() : "";
	const model = typeof block.model === "string" ? block.model.trim() : "";
	const prompt =
		typeof block.prompt === "string" && block.prompt.trim() ? block.prompt.trim() : DEFAULT_VISION_PROMPT;
	const rawMaxTokens = block.maxTokens;
	const maxTokens =
		typeof rawMaxTokens === "number" && Number.isFinite(rawMaxTokens) && rawMaxTokens > 0
			? Math.floor(rawMaxTokens)
			: undefined;
	return {
		enabled: block.enabled === true,
		provider,
		model,
		prompt,
		...(maxTokens === undefined ? {} : { maxTokens }),
	};
}

/** 仅当显式启用且 provider/model 齐备时，才认为视觉回退可用。 */
export function parseVisionConfig(raw: unknown): VisionConfig | undefined {
	const settings = normalizeVisionSettings(raw);
	if (!settings || !settings.enabled) return undefined;
	if (!settings.provider || !settings.model) return undefined;
	return { ...settings, enabled: true };
}

export function readVisionSettingsFile(file: string): VisionSettings | undefined {
	if (!existsSync(file)) return undefined;
	const text = readFileSync(file, "utf8").trim();
	if (!text) return undefined;
	return normalizeVisionSettings(JSON.parse(text));
}

export function readVisionConfigFile(file: string): VisionConfig | undefined {
	if (!existsSync(file)) return undefined;
	const text = readFileSync(file, "utf8").trim();
	if (!text) return undefined;
	return parseVisionConfig(JSON.parse(text));
}

/** 写回 axum.json，保留其它顶层字段；原子替换避免半写文件。 */
export function writeVisionSettings(settings: VisionSettings, file: string): void {
	let raw: Record<string, unknown> = {};
	if (existsSync(file)) {
		const text = readFileSync(file, "utf8").trim();
		if (text) {
			const parsed = JSON.parse(text);
			if (!isRecord(parsed)) throw new Error(`${file}: 顶层必须是对象`);
			raw = parsed;
		}
	}
	raw[VISION_CONFIG_KEY] = {
		enabled: settings.enabled,
		provider: settings.provider,
		model: settings.model,
		prompt: settings.prompt,
		...(settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens }),
	};
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
}

export function modelSupportsImages(model: { input?: unknown } | undefined): boolean {
	if (!model || !Array.isArray(model.input)) return false;
	return model.input.includes("image");
}

export function imageBlocksOf(content: unknown): VisionImageBlock[] {
	if (!Array.isArray(content)) return [];
	return content.filter(
		(block): block is VisionImageBlock =>
			isRecord(block) && block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string",
	);
}

/** 组装给视觉模型的用户消息：先描述指令，后附图片。 */
export function buildVisionPrompt(prompt: string, userText: string): string {
	const request = userText.trim();
	return request ? `${prompt}\n\nUser request:\n${request}` : prompt;
}

export function buildVisionMessages(prompt: string, images: VisionImageBlock[]): unknown[] {
	return [{ role: "user", content: [{ type: "text", text: prompt }, ...images] }];
}

export function extractResponseText(message: unknown): string {
	if (!isRecord(message) || !Array.isArray(message.content)) return "";
	return message.content
		.filter((block): block is VisionTextBlock => isRecord(block) && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

export function stripNonVisionNote(text: string): string {
	return text.split(NON_VISION_IMAGE_NOTE).join("").trimEnd();
}

/** 主模型收到的注入文本：视觉描述在前，用户原文在后。 */
export function buildInjectedText(description: string, provider: string, model: string, userText: string): string {
	const header = `[vision ${provider}/${model}]`;
	const body = userText.trim();
	return body ? `${header}\n${description}\n\n${body}` : `${header}\n${description}`;
}

function describeRequestText(event: { input?: Record<string, unknown> }): string {
	const input = event.input ?? {};
	const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : "";
	return path ? `Image file: ${path}` : "";
}
/** 选择器里给当前视觉模型加的标记，与 /usemodel 的 "(default)" 风格一致。 */
export const VISION_CURRENT_SUFFIX = "  (current)";

export interface VisionModelRef {
	provider: string;
	id: string;
}

export function visionModelOptions(models: VisionModelRef[], currentProvider: string, currentModel: string): string[] {
	return models.map((model) => {
		const label = `${model.provider}/${model.id}`;
		return currentProvider === model.provider && currentModel === model.id ? `${label}${VISION_CURRENT_SUFFIX}` : label;
	});
}

export function parseVisionOption(label: string): { provider: string; model: string } | undefined {
	const trimmed = label.trim().replace(/\s+\(current\)$/, "");
	const slash = trimmed.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = trimmed.slice(0, slash).trim();
	const model = trimmed.slice(slash + 1).trim();
	if (!provider || !model) return undefined;
	return { provider, model };
}

export function findVisionOptionIndex(options: string[], provider: string, model: string): number {
	const index = options.findIndex((option) => {
		const parsed = parseVisionOption(option);
		return parsed !== undefined && parsed.provider === provider && parsed.model === model;
	});
	return index >= 0 ? index : 0;
}

export function registerVisionFallback(pi: ExtensionAPI, options: { configFile?: string } = {}): void {
	const configFile = options.configFile ?? visionConfigFile();
	let notifiedMissingConfig = false;

	function loadConfig(): VisionConfig | undefined {
		try {
			return readVisionConfigFile(configFile);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return undefined;
		}
	}

	async function describeImages(
		images: VisionImageBlock[],
		userText: string,
		ctx: ExtensionContext,
		config: VisionConfig,
	): Promise<string> {
		const model = ctx.modelRegistry.find(config.provider, config.model);
		if (!model) throw new Error(`视觉模型不存在：${config.provider}/${config.model}`);
		if (!modelSupportsImages(model)) throw new Error(`视觉模型不支持图片输入：${config.provider}/${config.model}`);
		const prompt = buildVisionPrompt(config.prompt, userText);
		const options: Record<string, unknown> = { signal: ctx.signal };
		if (config.maxTokens !== undefined) options.maxTokens = config.maxTokens;
		const message = await ctx.modelRegistry.complete(
			model,
			{ messages: buildVisionMessages(prompt, images) as never },
			options as never,
		);
		if (isRecord(message) && message.stopReason === "error") {
			throw new Error(typeof message.errorMessage === "string" ? message.errorMessage : "视觉模型请求失败");
		}
		const text = extractResponseText(message);
		if (!text) throw new Error("视觉模型返回空描述");
		return text;
	}

	pi.on("input", async (event, ctx) => {
		const images = event.images ?? [];
		if (images.length === 0) return;
		if (modelSupportsImages(ctx.model)) return;
		const config = loadConfig();
		if (!config) {
			if (!notifiedMissingConfig) {
				notifiedMissingConfig = true;
				ctx.ui.notify(
					`当前模型不支持图片，且未配置独立视觉模型（${configFile} 的 vision 块），图片已被忽略。执行 /vision 从列表中选择视觉模型即可启用回退。`,
					"warning",
				);
			}
			return;
		}
		try {
			const description = await describeImages(images, event.text, ctx, config);
			ctx.ui.notify(`视觉回退：${config.provider}/${config.model}`, "info");
			return {
				action: "transform" as const,
				text: buildInjectedText(description, config.provider, config.model, event.text),
				images: [] as VisionImageBlock[],
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`视觉回退失败：${message}`, "error");
			return;
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (modelSupportsImages(ctx.model)) return;
		const images = imageBlocksOf(event.content);
		if (images.length === 0) return;
		const config = loadConfig();
		if (!config) return;
		try {
			const description = await describeImages(images, describeRequestText(event), ctx, config);
			ctx.ui.notify(`视觉回退：${config.provider}/${config.model}`, "info");
			const content: VisionContentBlock[] = [];
			for (const block of event.content as VisionContentBlock[]) {
				if (block.type === "image") {
					content.push({
						type: "text",
						text: `[vision ${config.provider}/${config.model}]\n${description}`,
					});
				} else if (block.type === "text") {
					content.push({ type: "text", text: stripNonVisionNote(block.text) });
				} else {
					content.push(block);
				}
			}
			return { content };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`视觉回退失败：${message}`, "error");
			return;
		}
	});

	pi.registerCommand("vision", {
		description: "选择独立视觉提供商：/vision [status|on|off|list]",
		getArgumentCompletions: () => null,
		async handler(args, ctx) {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const action = parts[0] || "pick";
			const settings = readVisionSettingsFile(configFile) ?? {
				enabled: false,
				provider: "",
				model: "",
				prompt: DEFAULT_VISION_PROMPT,
			};

			if (action === "status") {
				const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(无)";
				const currentVision = ctx.model ? (modelSupportsImages(ctx.model) ? "支持" : "不支持") : "未知";
				const target = settings.provider && settings.model ? `${settings.provider}/${settings.model}` : "(未配置)";
				const state = settings.enabled ? "已启用" : "已停用";
				ctx.ui.notify(
					`视觉回退：${state}；视觉模型：${target}；当前模型：${current}（图片输入${currentVision}）；配置：${configFile}`,
					"info",
				);
				return;
			}

			if (action === "list") {
				const models = ctx.modelRegistry.getAll().filter((model) => modelSupportsImages(model));
				if (models.length === 0) {
					ctx.ui.notify("没有找到声明支持图片输入的模型（models.json 中缺少 \"input\": [\"text\", \"image\"]）。", "warning");
					return;
				}
				const lines = models.map((model) => `${model.provider}/${model.id}`).join("\n");
				ctx.ui.notify(`支持图片输入的模型：\n${lines}`, "info");
				return;
			}

			if (action === "on" || action === "off") {
				if (action === "on" && (!settings.provider || !settings.model)) {
					ctx.ui.notify("请先执行 /vision 从列表中选择视觉模型。", "warning");
					return;
				}
				const next = { ...settings, enabled: action === "on" };
				writeVisionSettings(next, configFile);
				ctx.ui.notify(
					action === "on"
						? `视觉回退已启用：${next.provider}/${next.model}`
						: "视觉回退已停用。",
					"info",
				);
				return;
			}

			if (action !== "pick") {
				ctx.ui.notify("用法：/vision [status|on|off|list]", "warning");
				return;
			}

			try {
				await ctx.modelRegistry.refresh({ allowNetwork: false });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`刷新 provider 配置失败：${message}`, "error");
				return;
			}
			const models = ctx.modelRegistry.getAll().filter((model) => modelSupportsImages(model));
			if (models.length === 0) {
				ctx.ui.notify("没有找到声明支持图片输入的模型（models.json 中缺少 \"input\": [\"text\", \"image\"]）。", "warning");
				return;
			}
			const options = visionModelOptions(models, settings.provider, settings.model);
			const dialogOptions: ExtensionUIDialogOptions & { initialSelectedIndex?: number } = {
				initialSelectedIndex: findVisionOptionIndex(options, settings.provider, settings.model),
			};
			const chosen = await ctx.ui.select("选择视觉模型", options, dialogOptions);
			if (!chosen) {
				ctx.ui.notify("已取消视觉模型选择。", "info");
				return;
			}
			const selection = parseVisionOption(chosen);
			if (!selection) {
				ctx.ui.notify(`无法解析视觉模型：${chosen}`, "error");
				return;
			}
			const next = { ...settings, enabled: true, ...selection };
			writeVisionSettings(next, configFile);
			ctx.ui.notify(`视觉回退已启用：${selection.provider}/${selection.model}`, "info");
		},
	});
}
