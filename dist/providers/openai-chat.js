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
    maxRetries;
    retryDelayMs;
    fetchImpl;
    constructor(options) {
        this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.openai.com/v1");
        this.apiKey = options.apiKey ?? "";
        this.model = options.model;
        this.temperature = options.temperature;
        this.maxRetries = options.maxRetries ?? 10;
        this.retryDelayMs = options.retryDelayMs ?? 250;
        this.fetchImpl = options.fetchImpl ?? fetch;
        if (!this.model)
            throw new Error("model is required");
        if (!this.apiKey)
            throw new Error("apiKey is required");
        if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0) {
            throw new Error("maxRetries must be a non-negative integer");
        }
        if (!Number.isInteger(this.retryDelayMs) || this.retryDelayMs < 0) {
            throw new Error("retryDelayMs must be a non-negative integer");
        }
    }
    async chat(messages) {
        let lastError;
        for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
            try {
                return await this.chatOnce(messages);
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                const retryable = error instanceof RetryableOpenAIChatError;
                if (!retryable || attempt >= this.maxRetries)
                    break;
                await sleep(this.retryDelayMs * Math.max(1, attempt + 1));
            }
        }
        throw lastError ?? new Error("OpenAI Chat request failed");
    }
    async chatOnce(messages) {
        let response;
        try {
            response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
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
        }
        catch (error) {
            throw new RetryableOpenAIChatError(`OpenAI Chat request transport failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const raw = await readResponseBody(response);
        if (!response.ok) {
            const err = raw;
            const message = typeof err === "object" && err && "error" in err
                ? err.error?.message
                : typeof err === "string"
                    ? err
                    : response.statusText;
            const errorText = `OpenAI Chat request failed (${response.status}): ${message || response.statusText}`;
            if (isRetryableStatus(response.status))
                throw new RetryableOpenAIChatError(errorText);
            throw new Error(errorText);
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
class RetryableOpenAIChatError extends Error {
}
function isRetryableStatus(status) {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}
function sleep(ms) {
    if (ms <= 0)
        return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
}
