"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAIChatProvider = void 0;
exports.sanitizeMessagesForProvider = sanitizeMessagesForProvider;
exports.sanitizeToolCallsForProvider = sanitizeToolCallsForProvider;
exports.summarizeProviderErrorBody = summarizeProviderErrorBody;
exports.classifyProviderErrorBody = classifyProviderErrorBody;
function normalizeBaseUrl(baseUrl) {
    return baseUrl.replace(/\/+$/, "");
}
function resolveContent(json) {
    const choice = json.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content === "string")
        return content;
    if (choice?.message?.tool_calls?.length)
        return "";
    throw new Error("OpenAI Chat response did not contain choices[0].message.content");
}
function sanitizeMessagesForProvider(messages) {
    const corrections = [];
    const sanitized = messages.map((message, index) => {
        const role = message.role;
        if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
            corrections.push(`message[${index}] role corrected to user`);
            return { role: "user", content: String(message.content ?? "") };
        }
        const content = String(message.content ?? "");
        if (content.length === 0)
            corrections.push(`message[${index}] empty content preserved`);
        return { role, content, ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}), ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) };
    });
    return { value: sanitized, corrections };
}
function sanitizeToolCallsForProvider(toolCalls, allowedTools) {
    const allowed = new Set(allowedTools);
    const corrections = [];
    const value = toolCalls.flatMap((call, index) => {
        const name = call.function?.name;
        if (!name || !allowed.has(name)) {
            corrections.push(`tool_calls[${index}] dropped: ${name || "missing-name"} is not allowed`);
            return [];
        }
        if (call.type && call.type !== "function")
            corrections.push(`tool_calls[${index}] type corrected to function`);
        return [{ ...call, type: "function", function: { ...call.function, name, arguments: call.function?.arguments ?? "{}" } }];
    });
    return { value, corrections };
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
function collapseWhitespace(value) {
    return value.replace(/\s+/g, " ").trim();
}
function summarizeProviderErrorBody(raw, response) {
    if (typeof raw === "object" && raw && "error" in raw) {
        const message = raw.error?.message;
        return message ? collapseWhitespace(message) : undefined;
    }
    if (typeof raw !== "string")
        return undefined;
    const text = collapseWhitespace(raw);
    const contentType = response?.headers.get("content-type") ?? "";
    const server = response?.headers.get("server") ?? "";
    const isHtml = /text\/html/i.test(contentType) || /^<!doctype html/i.test(text) || /^<html/i.test(text);
    const isCloudflare = /cloudflare/i.test(server) || /Just a moment|challenge-platform|cf_chl|Cloudflare challenge/i.test(text);
    if (isCloudflare)
        return "provider returned a Cloudflare/browser challenge HTML page; this endpoint is not directly CLI/API-compatible from this network";
    if (isHtml)
        return "provider returned HTML instead of JSON; check the base URL, API path, or gateway/proxy compatibility";
    return text.length > 800 ? `${text.slice(0, 800)}…` : text;
}
function classifyProviderErrorBody(raw, response) {
    if (typeof raw === "object" && raw && "error" in raw)
        return "json error";
    if (typeof raw !== "string")
        return response?.ok === false ? "http error" : "unknown";
    const text = collapseWhitespace(raw);
    const contentType = response?.headers.get("content-type") ?? "";
    const server = response?.headers.get("server") ?? "";
    const isHtml = /text\/html/i.test(contentType) || /^<!doctype html/i.test(text) || /^<html/i.test(text);
    const isCloudflare = /cloudflare/i.test(server) || /Just a moment|challenge-platform|cf_chl|Cloudflare challenge/i.test(text);
    if (isCloudflare)
        return `http ${response?.status ?? "unknown"} html challenge`;
    if (isHtml)
        return "wrong base url or html response";
    return response?.ok === false ? "http error" : "unknown";
}
function providerErrorMessage(label, response, raw) {
    return `${label} failed (${response.status}, ${classifyProviderErrorBody(raw, response)}): ${summarizeProviderErrorBody(raw, response) || response.statusText}`;
}
class OpenAIChatProvider {
    baseUrl;
    apiKey;
    model;
    temperature;
    maxRetries;
    retryDelayMs;
    retryMinDelayMs;
    retryMaxDelayMs;
    requestTimeoutMs;
    fetchImpl;
    sleepImpl;
    random;
    constructor(options) {
        this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.openai.com/v1");
        this.apiKey = options.apiKey ?? "";
        this.model = options.model;
        this.temperature = options.temperature;
        this.maxRetries = options.maxRetries ?? 8;
        this.retryDelayMs = options.retryDelayMs ?? 0;
        this.retryMinDelayMs = options.retryDelayMs ?? options.retryMinDelayMs ?? 500;
        this.retryMaxDelayMs = options.retryDelayMs ?? options.retryMaxDelayMs ?? 1500;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 600_000;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.sleepImpl = options.sleepImpl ?? sleep;
        this.random = options.random ?? Math.random;
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
        if (!Number.isInteger(this.retryMinDelayMs) || this.retryMinDelayMs < 0) {
            throw new Error("retryMinDelayMs must be a non-negative integer");
        }
        if (!Number.isInteger(this.retryMaxDelayMs) || this.retryMaxDelayMs < 0) {
            throw new Error("retryMaxDelayMs must be a non-negative integer");
        }
        if (this.retryMinDelayMs > this.retryMaxDelayMs) {
            throw new Error("retryMinDelayMs must be less than or equal to retryMaxDelayMs");
        }
        if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 0) {
            throw new Error("requestTimeoutMs must be a non-negative integer");
        }
    }
    retryDelay() {
        if (this.retryMinDelayMs === this.retryMaxDelayMs)
            return this.retryMinDelayMs;
        const span = this.retryMaxDelayMs - this.retryMinDelayMs;
        return Math.min(this.retryMaxDelayMs, this.retryMinDelayMs + Math.floor(this.random() * (span + 1)));
    }
    async withRetries(label, run) {
        let lastError;
        for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
            try {
                return await run();
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                const retryable = error instanceof RetryableOpenAIChatError;
                if (!retryable || attempt >= this.maxRetries)
                    break;
                await this.sleepImpl(this.retryDelay());
            }
        }
        throw lastError ?? new Error(`${label} failed`);
    }
    async withRequestTimeout(label, run, externalSignal) {
        if (externalSignal?.aborted)
            throw new Error(`${label} cancelled`);
        if (this.requestTimeoutMs === 0)
            return run(externalSignal);
        const controller = new AbortController();
        const abortFromExternal = () => controller.abort(externalSignal?.reason);
        externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
        const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
        try {
            return await run(controller.signal);
        }
        catch (error) {
            if (externalSignal?.aborted) {
                throw new Error(`${label} cancelled`);
            }
            if (controller.signal.aborted) {
                throw new Error(`${label} timed out after ${this.requestTimeoutMs}ms`);
            }
            throw error;
        }
        finally {
            clearTimeout(timer);
            externalSignal?.removeEventListener("abort", abortFromExternal);
        }
    }
    async listModels() {
        const raw = await this.withRetries("OpenAI Models request", () => this.withRequestTimeout("OpenAI Models request", async (signal) => {
            let response;
            try {
                response = await this.fetchImpl(`${this.baseUrl}/models`, {
                    method: "GET",
                    headers: { "Authorization": `Bearer ${this.apiKey}`, "Accept": "application/json" },
                    signal,
                });
            }
            catch (error) {
                throw new RetryableOpenAIChatError(`OpenAI Models request transport failed (network/dns/tls/fetch): ${error instanceof Error ? error.message : String(error)}`);
            }
            return { response, raw: await readResponseBody(response) };
        }));
        const { response } = raw;
        if (!response.ok) {
            throw new Error(providerErrorMessage("OpenAI Models request", response, raw.raw));
        }
        const json = raw.raw;
        return (json.data ?? []).map((model) => model.id).filter((id) => typeof id === "string" && id.length > 0);
    }
    async chat(messages, signal) {
        return this.withRetries("OpenAI Chat request", () => this.chatOnce(messages, signal));
    }
    async chatStream(messages, onDelta, signal) {
        return this.withRetries("OpenAI Chat stream request", () => this.chatStreamOnce(messages, onDelta, signal));
    }
    async chatWithTools(messages, tools, signal) {
        let lastError;
        let attemptedToolFallback = false;
        for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
            try {
                return await this.chatOnce(messages, signal, tools);
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                if (tools.length > 0 && !attemptedToolFallback && !signal?.aborted && /transport failed/.test(lastError.message)) {
                    attemptedToolFallback = true;
                    try {
                        const fallback = await this.chatOnce(messages, signal);
                        return {
                            ...fallback,
                            warnings: [`provider tool-call request failed (${lastError.message}); retried without tools`],
                        };
                    }
                    catch (fallbackError) {
                        lastError = fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
                        const fallbackRetryable = fallbackError instanceof RetryableOpenAIChatError;
                        if (!fallbackRetryable || attempt >= this.maxRetries)
                            break;
                        await this.sleepImpl(this.retryDelay());
                        continue;
                    }
                }
                const retryable = error instanceof RetryableOpenAIChatError;
                if (!retryable || attempt >= this.maxRetries)
                    break;
                await this.sleepImpl(this.retryDelay());
            }
        }
        throw lastError ?? new Error("OpenAI Chat request failed");
    }
    async chatOnce(messages, signal, tools) {
        const guardedMessages = sanitizeMessagesForProvider(messages).value;
        const request = await this.withRequestTimeout("OpenAI Chat request", async (requestSignal) => {
            let response;
            try {
                response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${this.apiKey}`,
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                    },
                    body: JSON.stringify({
                        model: this.model,
                        messages: guardedMessages,
                        ...(typeof this.temperature === "number" ? { temperature: this.temperature } : {}),
                        ...(tools && tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
                    }),
                    signal: requestSignal,
                });
            }
            catch (error) {
                throw new RetryableOpenAIChatError(`OpenAI Chat request transport failed (network/dns/tls/fetch): ${error instanceof Error ? error.message : String(error)}`);
            }
            return { response, raw: await readResponseBody(response) };
        }, signal);
        const { response, raw } = request;
        if (!response.ok) {
            const errorText = providerErrorMessage("OpenAI Chat request", response, raw);
            if (isRetryableStatus(response.status))
                throw new RetryableOpenAIChatError(errorText);
            throw new Error(errorText);
        }
        const json = raw;
        const choice = json.choices?.[0];
        return {
            model: json.model ?? this.model,
            content: resolveContent(json),
            raw: json,
            toolCalls: sanitizeToolCallsForProvider(choice?.message?.tool_calls ?? [], tools?.map((tool) => tool.function.name) ?? []).value,
            finishReason: choice?.finish_reason,
        };
    }
    async chatStreamOnce(messages, onDelta, signal) {
        const guardedMessages = sanitizeMessagesForProvider(messages).value;
        return this.withRequestTimeout("OpenAI Chat stream request", async (requestSignal) => {
            let response;
            try {
                response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${this.apiKey}`,
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                    },
                    body: JSON.stringify({
                        model: this.model,
                        messages: guardedMessages,
                        stream: true,
                        ...(typeof this.temperature === "number" ? { temperature: this.temperature } : {}),
                    }),
                    signal: requestSignal,
                });
            }
            catch (error) {
                throw new RetryableOpenAIChatError(`OpenAI Chat stream request transport failed (network/dns/tls/fetch): ${error instanceof Error ? error.message : String(error)}`);
            }
            if (!response.ok) {
                const raw = await readResponseBody(response);
                const errorText = providerErrorMessage("OpenAI Chat stream request", response, raw);
                if (isRetryableStatus(response.status))
                    throw new RetryableOpenAIChatError(errorText);
                throw new Error(errorText);
            }
            if (!response.body)
                throw new Error("OpenAI Chat stream response did not include a body");
            const content = await readSseContent(response.body, onDelta);
            if (!content)
                throw new Error("OpenAI Chat stream response did not contain delta content");
            return { model: this.model, content, raw: { streamed: true } };
        }, signal);
    }
}
exports.OpenAIChatProvider = OpenAIChatProvider;
async function readSseContent(body, onDelta) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
            const event = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            for (const line of event.split(/\r?\n/g)) {
                if (!line.startsWith("data:"))
                    continue;
                const data = line.slice(5).trim();
                if (!data || data === "[DONE]")
                    continue;
                const json = JSON.parse(data);
                const delta = json.choices?.[0]?.delta?.content ?? "";
                if (delta) {
                    content += delta;
                    onDelta(delta);
                }
            }
            boundary = buffer.indexOf("\n\n");
        }
    }
    return content;
}
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
