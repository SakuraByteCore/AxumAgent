import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	DEFAULT_VISION_PROMPT,
	NON_VISION_IMAGE_NOTE,
	buildInjectedText,
	buildVisionPrompt,
	extractResponseText,
	imageBlocksOf,
	modelSupportsImages,
	normalizeVisionSettings,
	parseVisionConfig,
	readVisionConfigFile,
	readVisionSettingsFile,
	registerVisionFallback,
	stripNonVisionNote,
	writeVisionSettings,
} from "../plugin/pi-companion/vision-fallback.ts";

const IMAGE = { type: "image", data: "AAAA", mimeType: "image/png" };

function tempConfig(extra = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-vision-"));
	const file = path.join(dir, "axum.json");
	if (Object.keys(extra).length > 0) {
		fs.writeFileSync(file, `${JSON.stringify(extra, null, 2)}\n`);
	}
	return file;
}

function makeFakePi() {
	const handlers = new Map();
	const commands = new Map();
	return {
		handlers,
		commands,
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
	};
}

function makeCtx({ currentModel, visionModel, models, response, selected, cancel } = {}) {
	const notifications = [];
	const calls = [];
	const selects = [];
	const registryModels = models ?? (visionModel ? [visionModel] : []);
	return {
		notifications,
		calls,
		selects,
		model: currentModel,
		signal: undefined,
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
			async select(title, options, opts) {
				selects.push({ title, options, opts });
				if (cancel) return undefined;
				return selected ?? options[0];
			},
		},
		modelRegistry: {
			find(provider, id) {
				return registryModels.find((model) => model.provider === provider && model.id === id);
			},
			getAll() {
				return registryModels;
			},
			async refresh() {
				return {};
			},
			async complete(model, context, options) {
				calls.push({ model, context, options });
				return response ?? { stopReason: "stop", content: [{ type: "text", text: "一张白底黑色线条的图" }] };
			},
		},
	};
}

test("parseVisionConfig 只在显式启用且 provider/model 齐备时生效", () => {
	assert.equal(parseVisionConfig(undefined), undefined);
	assert.equal(parseVisionConfig({ vision: { enabled: false, provider: "p", model: "m" } }), undefined);
	assert.equal(parseVisionConfig({ vision: { enabled: true, provider: "p" } }), undefined);

	const config = parseVisionConfig({ vision: { enabled: true, provider: " p ", model: " m " } });
	assert.equal(config.enabled, true);
	assert.equal(config.provider, "p");
	assert.equal(config.model, "m");
	assert.equal(config.prompt, DEFAULT_VISION_PROMPT);
});

test("normalizeVisionSettings 归一化 prompt 与 maxTokens，非法值被忽略", () => {
	const settings = normalizeVisionSettings({
		vision: { enabled: true, provider: "p", model: "m", prompt: "  自定义  ", maxTokens: 12.7 },
	});
	assert.equal(settings.prompt, "自定义");
	assert.equal(settings.maxTokens, 12);

	const invalid = normalizeVisionSettings({
		vision: { enabled: true, provider: "p", model: "m", maxTokens: -3 },
	});
	assert.equal(invalid.maxTokens, undefined);
});

test("writeVisionSettings 保留 axum.json 其它顶层字段并可回读", () => {
	const file = tempConfig({ defaultProvider: "demo", fastModels: { demo: ["m"] } });
	writeVisionSettings({ enabled: true, provider: "kilo", model: "vision-model", prompt: "描述图片" }, file);

	const raw = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(raw.defaultProvider, "demo");
	assert.deepEqual(raw.fastModels, { demo: ["m"] });
	assert.equal(raw.vision.provider, "kilo");
	assert.equal(raw.vision.model, "vision-model");
	assert.equal(raw.vision.enabled, true);

	assert.deepEqual(readVisionConfigFile(file), {
		enabled: true,
		provider: "kilo",
		model: "vision-model",
		prompt: "描述图片",
	});
	assert.equal(readVisionSettingsFile(file).model, "vision-model");
});

test("模型能力判定与图片块提取", () => {
	assert.equal(modelSupportsImages({ input: ["text", "image"] }), true);
	assert.equal(modelSupportsImages({ input: ["text"] }), false);
	assert.equal(modelSupportsImages(undefined), false);
	assert.deepEqual(imageBlocksOf([{ type: "text", text: "x" }, IMAGE]), [IMAGE]);
	assert.deepEqual(imageBlocksOf("not-an-array"), []);
});

test("提示词与注入文本拼装", () => {
	const prompt = buildVisionPrompt("描述图片", "看看这个截图");
	assert.match(prompt, /描述图片/);
	assert.match(prompt, /User request:\n看看这个截图/);
	assert.equal(buildVisionPrompt("描述图片", "  "), "描述图片");

	const injected = buildInjectedText("图中有一个按钮", "kilo", "vision-model", "这是什么");
	assert.equal(injected, "[vision kilo/vision-model]\n图中有一个按钮\n\n这是什么");
});

test("extractResponseText 拼接文本块并忽略非文本块", () => {
	assert.equal(
		extractResponseText({ content: [{ type: "text", text: "第一段" }, { type: "image", data: "x", mimeType: "image/png" }, { type: "text", text: "第二段" }] }),
		"第一段\n第二段",
	);
	assert.equal(extractResponseText({ content: [] }), "");
	assert.equal(extractResponseText(undefined), "");
});

test("stripNonVisionNote 移除 read 工具的非视觉提示", () => {
	const text = `Read image file [image/png]\n${NON_VISION_IMAGE_NOTE}`;
	assert.equal(stripNonVisionNote(text), "Read image file [image/png]");
});

test("input 事件：当前模型不支持图片时改写为视觉描述并清空图片", async () => {
	const file = tempConfig({
		vision: { enabled: true, provider: "kilo", model: "vision-model", prompt: "描述图片", maxTokens: 256 },
	});
	const pi = makeFakePi();
	registerVisionFallback(pi, { configFile: file });

	const ctx = makeCtx({
		currentModel: { provider: "main", id: "text-only", input: ["text"] },
		visionModel: { provider: "kilo", id: "vision-model", input: ["text", "image"] },
	});

	const result = await pi.handlers.get("input")[0]({ type: "input", text: "这是什么", images: [IMAGE] }, ctx);

	assert.equal(result.action, "transform");
	assert.deepEqual(result.images, []);
	assert.match(result.text, /\[vision kilo\/vision-model\]/);
	assert.match(result.text, /一张白底黑色线条的图/);
	assert.match(result.text, /这是什么/);

	assert.equal(ctx.calls.length, 1);
	assert.equal(ctx.calls[0].model.id, "vision-model");
	assert.equal(ctx.calls[0].options.maxTokens, 256);
	const content = ctx.calls[0].context.messages[0].content;
	assert.equal(content[0].type, "text");
	assert.equal(content[1].data, "AAAA");
});

test("input 事件：当前模型原生支持图片时不触发回退", async () => {
	const file = tempConfig({ vision: { enabled: true, provider: "kilo", model: "vision-model" } });
	const pi = makeFakePi();
	registerVisionFallback(pi, { configFile: file });

	const ctx = makeCtx({
		currentModel: { provider: "main", id: "vision-native", input: ["text", "image"] },
		visionModel: { provider: "kilo", id: "vision-model", input: ["text", "image"] },
	});

	const result = await pi.handlers.get("input")[0]({ type: "input", text: "看图", images: [IMAGE] }, ctx);
	assert.equal(result, undefined);
	assert.equal(ctx.calls.length, 0);
});

test("input 事件：未配置视觉模型时保持原行为并提示一次", async () => {
	const file = tempConfig({});
	const pi = makeFakePi();
	registerVisionFallback(pi, { configFile: file });

	const ctx = makeCtx({ currentModel: { provider: "main", id: "text-only", input: ["text"] } });
	const handler = pi.handlers.get("input")[0];

	assert.equal(await handler({ type: "input", text: "看图", images: [IMAGE] }, ctx), undefined);
	assert.equal(await handler({ type: "input", text: "再看", images: [IMAGE] }, ctx), undefined);
	assert.equal(ctx.calls.length, 0);
	assert.equal(ctx.notifications.length, 1);
	assert.match(ctx.notifications[0].message, /\/vision 从列表中选择视觉模型/);
});

test("tool_result 事件：图片块替换为视觉描述文本并去掉非视觉提示", async () => {
	const file = tempConfig({ vision: { enabled: true, provider: "kilo", model: "vision-model" } });
	const pi = makeFakePi();
	registerVisionFallback(pi, { configFile: file });

	const ctx = makeCtx({
		currentModel: { provider: "main", id: "text-only", input: ["text"] },
		visionModel: { provider: "kilo", id: "vision-model", input: ["text", "image"] },
	});

	const result = await pi.handlers.get("tool_result")[0](
		{
			type: "tool_result",
			toolName: "read",
			input: { path: "shot.png" },
			content: [{ type: "text", text: `Read image file [image/png]\n${NON_VISION_IMAGE_NOTE}` }, IMAGE],
		},
		ctx,
	);

	assert.equal(result.content.length, 2);
	assert.equal(result.content[0].type, "text");
	assert.equal(result.content[0].text, "Read image file [image/png]");
	assert.equal(result.content[1].type, "text");
	assert.match(result.content[1].text, /\[vision kilo\/vision-model\]/);
	assert.equal(ctx.calls.length, 1);
	assert.match(ctx.calls[0].context.messages[0].content[0].text, /Image file: shot\.png/);
});

test("/vision 打开列表选择视觉模型并落盘启用", async () => {
	const file = tempConfig({ defaultProvider: "demo" });
	const pi = makeFakePi();
	registerVisionFallback(pi, { configFile: file });

	const ctx = makeCtx({
		currentModel: { provider: "main", id: "text-only", input: ["text"] },
		models: [
			{ provider: "main", id: "text-only", input: ["text"] },
			{ provider: "kilo", id: "vision-model", input: ["text", "image"] },
			{ provider: "kilo", id: "other-vision", input: ["text", "image"] },
		],
		selected: "kilo/vision-model",
	});

	await pi.commands.get("vision").handler("", ctx);

	assert.equal(ctx.selects.length, 1);
	assert.deepEqual(ctx.selects[0].options, ["kilo/vision-model", "kilo/other-vision"]);
	assert.equal(ctx.selects[0].opts.initialSelectedIndex, 0);

	const raw = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(raw.vision.enabled, true);
	assert.equal(raw.vision.provider, "kilo");
	assert.equal(raw.vision.model, "vision-model");
	assert.equal(raw.defaultProvider, "demo");

	await pi.commands.get("vision").handler("status", ctx);
	assert.match(ctx.notifications.at(-1).message, /视觉回退：已启用/);
});

test("/vision 列表把当前视觉模型标记为 (current) 并定位光标", async () => {
	const file = tempConfig({ vision: { enabled: true, provider: "kilo", model: "other-vision" } });
	const pi = makeFakePi();
	registerVisionFallback(pi, { configFile: file });

	const ctx = makeCtx({
		currentModel: { provider: "main", id: "text-only", input: ["text"] },
		models: [
			{ provider: "kilo", id: "vision-model", input: ["text", "image"] },
			{ provider: "kilo", id: "other-vision", input: ["text", "image"] },
		],
		selected: "kilo/other-vision  (current)",
	});

	await pi.commands.get("vision").handler("", ctx);
	assert.deepEqual(ctx.selects[0].options, ["kilo/vision-model", "kilo/other-vision  (current)"]);
	assert.equal(ctx.selects[0].opts.initialSelectedIndex, 1);

	const raw = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(raw.vision.model, "other-vision");
	assert.equal(raw.vision.enabled, true);
});

test("/vision 取消选择不写配置", async () => {
	const file = tempConfig({});
	const pi = makeFakePi();
	registerVisionFallback(pi, { configFile: file });

	const ctx = makeCtx({
		currentModel: { provider: "main", id: "text-only", input: ["text"] },
		models: [{ provider: "kilo", id: "vision-model", input: ["text", "image"] }],
		selected: undefined,
		cancel: true,
	});

	await pi.commands.get("vision").handler("", ctx);
	assert.equal(fs.existsSync(file), false);
	assert.match(ctx.notifications.at(-1).message, /已取消视觉模型选择/);
});

test("/vision on 在未选择视觉模型前提示先选", async () => {
	const file = tempConfig({});
	const pi = makeFakePi();
	registerVisionFallback(pi, { configFile: file });

	const ctx = makeCtx({ currentModel: { provider: "main", id: "text-only", input: ["text"] } });
	await pi.commands.get("vision").handler("on", ctx);
	assert.equal(fs.existsSync(file), false);
	assert.match(ctx.notifications.at(-1).message, /\/vision 从列表中选择视觉模型/);
});

test("pi-companion 默认导出注册了 /vision 命令与图片钩子", async () => {
	const { default: activateCompanion } = await import("../plugin/pi-companion/index.ts");
	const registered = { commands: new Set(), handlers: new Set(), providers: [], tools: [] };
	const fakePi = {
		registerCommand: (name) => registered.commands.add(name),
		registerProvider: (name) => registered.providers.push(name),
		registerTool: (tool) => registered.tools.push(tool.name),
		on: (event) => registered.handlers.add(event),
		events: { emit() {} },
		sendUserMessage: async () => {},
		setModel: async () => true,
	};
	activateCompanion(fakePi);
	assert.ok(registered.commands.has("vision"));
	assert.ok(registered.handlers.has("input"));
	assert.ok(registered.handlers.has("tool_result"));
});
