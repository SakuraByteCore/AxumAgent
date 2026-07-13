"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAIChatProvider = void 0;
function normalizeBaseUrl(baseUrl) {
    return baseUrl.replace(/\/+$/, "");
}
function resolveContent(json) {
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
        throw new Error("OpenAI Chat response did not contain choices[0].message.content");
    }
    return content;
}
async function readResponseBody(response) {
    const text = await response.text();
    if (!text)
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
class OpenAIChatProvider {
    baseUrl;
    apiKey;
    model;
    temperature;
    fetchImpl;
    constructor(options) {
        this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.openai.com/v1");
        this.apiKey = options.apiKey ?? "";
        this.model = options.model;
        this.temperature = options.temperature;
        this.fetchImpl = options.fetchImpl ?? fetch;
        if (!this.model)
            throw new Error("model is required");
        if (!this.apiKey)
            throw new Error("apiKey is required");
    }
    async chat(messages) {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "authorization": `Bearer ${this.apiKey}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                model: this.model,
                messages,
                ...(typeof this.temperature === "number" ? { temperature: this.temperature } : {}),
            }),
        });
        const raw = await readResponseBody(response);
        if (!response.ok) {
            const err = raw;
            const message = typeof err === "object" && err && "error" in err
                ? err.error?.message
                : typeof err === "string"
                    ? err
                    : response.statusText;
            throw new Error(`OpenAI Chat request failed (${response.status}): ${message || response.statusText}`);
        }
        const json = raw;
        return {
            model: json.model ?? this.model,
            content: resolveContent(json),
            raw: json,
        };
    }
}
exports.OpenAIChatProvider = OpenAIChatProvider;
