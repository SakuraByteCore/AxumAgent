"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.uniqueModels = uniqueModels;
exports.hydrateTuiModels = hydrateTuiModels;
exports.hydrateTuiModelsWithStatus = hydrateTuiModelsWithStatus;
exports.fetchTuiModelsWithStatus = fetchTuiModelsWithStatus;
exports.renderModelList = renderModelList;
exports.switchModel = switchModel;
const openai_chat_1 = require("../providers/openai-chat");
function uniqueModels(models) {
    const seen = new Set();
    const result = [];
    for (const model of models) {
        const trimmed = model.trim();
        if (!trimmed || seen.has(trimmed))
            continue;
        seen.add(trimmed);
        result.push(trimmed);
    }
    return result;
}
function createModelListProvider(options) {
    if (!options.apiKey)
        throw new Error(`missing API key: set ${options.apiKeyEnv} or /provider key <key>`);
    return new openai_chat_1.OpenAIChatProvider({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        model: options.model,
        temperature: options.temperature,
        maxRetries: options.maxRetries,
        retryDelayMs: options.retryDelayMs,
        retryMinDelayMs: options.retryMinDelayMs,
        retryMaxDelayMs: options.retryMaxDelayMs,
        requestTimeoutMs: options.requestTimeoutMs,
    });
}
async function hydrateTuiModels(options, dryRun) {
    return (await hydrateTuiModelsWithStatus(options, dryRun)).options;
}
async function hydrateTuiModelsWithStatus(options, dryRun) {
    const configured = uniqueModels(options.modelOptions);
    if (configured.length > 0) {
        return { options: { ...options, modelOptions: configured, model: options.modelWasExplicit ? options.model : configured[0] } };
    }
    if (dryRun || !options.apiKey)
        return { options: { ...options, modelOptions: configured } };
    try {
        const fetched = uniqueModels(await createModelListProvider(options).listModels());
        if (fetched.length === 0)
            return { options: { ...options, modelOptions: fetched }, error: "provider returned an empty model list" };
        return { options: { ...options, modelOptions: fetched, model: options.modelWasExplicit ? options.model : fetched[0] } };
    }
    catch (error) {
        return { options: { ...options, modelOptions: configured }, error: error instanceof Error ? error.message : String(error) };
    }
}
async function fetchTuiModelsWithStatus(options) {
    const configured = uniqueModels(options.modelOptions);
    if (!options.apiKey)
        return { options: { ...options, modelOptions: configured }, error: `missing API key: set ${options.apiKeyEnv} or /provider key <key>` };
    try {
        const fetched = uniqueModels(await createModelListProvider(options).listModels());
        if (fetched.length === 0)
            return { options: { ...options, modelOptions: fetched }, error: "provider returned an empty model list" };
        return { options: { ...options, modelOptions: fetched, model: fetched.includes(options.model) ? options.model : fetched[0] } };
    }
    catch (error) {
        return { options: { ...options, modelOptions: configured }, error: error instanceof Error ? error.message : String(error) };
    }
}
function renderModelList(options, maxRows = 14) {
    if (options.modelOptions.length === 0)
        return `models\n  no configured/fetched model list`;
    const numberWidth = String(options.modelOptions.length).length;
    const currentIndex = Math.max(0, options.modelOptions.indexOf(options.model));
    const formatRow = (model, index) => {
        const current = model === options.model ? "▸" : " ";
        const suffix = model === options.model ? "  current" : "";
        return `${current} ${String(index + 1).padStart(numberWidth)}  ${model}${suffix}`;
    };
    const allRows = options.modelOptions.map(formatRow);
    if (allRows.length <= maxRows)
        return ["models", ...allRows].join("\n");
    const headCount = Math.max(1, maxRows - (currentIndex >= maxRows - 1 ? 2 : 1));
    const rows = allRows.slice(0, headCount);
    if (currentIndex >= headCount) {
        rows.push(`  … ${currentIndex - headCount + 1} hidden before current`);
        rows.push(allRows[currentIndex]);
    }
    const hiddenBelow = allRows.length - (currentIndex >= headCount ? currentIndex + 1 : rows.length);
    if (hiddenBelow > 0)
        rows.push(`  … ${hiddenBelow} more`);
    return ["models", ...rows].join("\n");
}
function switchModel(options, value) {
    const target = value.trim();
    if (!target)
        return { options, message: renderModelList(options) };
    const index = Number(target);
    const selected = Number.isInteger(index) && index >= 1 ? options.modelOptions[index - 1] : target;
    if (!selected)
        return { options, message: `model index out of range: ${target}` };
    const modelOptions = options.modelOptions.includes(selected) ? options.modelOptions : [...options.modelOptions, selected];
    return { options: { ...options, model: selected, modelOptions, modelWasExplicit: true }, message: `model switched to ${selected}` };
}
