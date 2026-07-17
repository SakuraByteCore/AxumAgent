"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAIChatProvider = void 0;
exports.sanitizeMessagesForProvider = sanitizeMessagesForProvider;
exports.sanitizeToolCallsForProvider = sanitizeToolCallsForProvider;
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
function sanitizeMessagesForProvider(messages) {
    const corrections = [];
    const sanitized = messages.map((message, index) => {
        const role = message.role;
        if (role !== "system" && role !== "user" && role !== "assistant") {
            corrections.push(`message[${index}] role corrected to user`);
            return { role: "user", content: String(message.content ?? "") };
        }
        const content = String(message.content ?? "");
        if (content.length === 0)
            corrections.push(`message[${index}] empty content preserved`);
        return { role, content };
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
class OpenAIChatProvider {
    baseUrl;
    apiKey;
    model;
    temperature;
    maxRetries;
    retryDelayMs;
    requestTimeoutMs;
    fetchImpl;
    constructor(options) {
        this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.openai.com/v1");
        this.apiKey = options.apiKey ?? "";
        this.model = options.model;
        this.temperature = options.temperature;
        this.maxRetries = options.maxRetries ?? 10;
        this.retryDelayMs = options.retryDelayMs ?? 250;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 600_000;
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
        if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 0) {
            throw new Error("requestTimeoutMs must be a non-negative integer");
        }
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
        const raw = await this.withRequestTimeout("OpenAI Models request", async (signal) => {
            let response;
            try {
                response = await this.fetchImpl(`${this.baseUrl}/models`, {
                    method: "GET",
                    headers: { "authorization": `Bearer ${this.apiKey}` },
                    signal,
                });
            }
            catch (error) {
                throw new RetryableOpenAIChatError(`OpenAI Models request transport failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            return { response, raw: await readResponseBody(response) };
        });
        const { response } = raw;
        if (!response.ok) {
            const err = raw.raw;
            const message = typeof err === "object" && err && "error" in err
                ? err.error?.message
                : typeof err === "string"
                    ? err
                    : response.statusText;
            throw new Error(`OpenAI Models request failed (${response.status}): ${message || response.statusText}`);
        }
        const json = raw.raw;
        return (json.data ?? []).map((model) => model.id).filter((id) => typeof id === "string" && id.length > 0);
    }
    async chat(messages, signal) {
        let lastError;
        for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
            try {
                return await this.chatOnce(messages, signal);
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
    async chatStream(messages, onDelta, signal) {
        let lastError;
        for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
            try {
                return await this.chatStreamOnce(messages, onDelta, signal);
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                const retryable = error instanceof RetryableOpenAIChatError;
                if (!retryable || attempt >= this.maxRetries)
                    break;
                await sleep(this.retryDelayMs * Math.max(1, attempt + 1));
            }
        }
        throw lastError ?? new Error("OpenAI Chat stream request failed");
    }
    async chatOnce(messages, signal) {
        const guardedMessages = sanitizeMessagesForProvider(messages).value;
        const request = await this.withRequestTimeout("OpenAI Chat request", async (requestSignal) => {
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
                        messages: guardedMessages,
                        ...(typeof this.temperature === "number" ? { temperature: this.temperature } : {}),
                    }),
                    signal: requestSignal,
                });
            }
            catch (error) {
                throw new RetryableOpenAIChatError(`OpenAI Chat request transport failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            return { response, raw: await readResponseBody(response) };
        }, signal);
        const { response, raw } = request;
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
    async chatStreamOnce(messages, onDelta, signal) {
        const guardedMessages = sanitizeMessagesForProvider(messages).value;
        return this.withRequestTimeout("OpenAI Chat stream request", async (requestSignal) => {
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
                        messages: guardedMessages,
                        stream: true,
                        ...(typeof this.temperature === "number" ? { temperature: this.temperature } : {}),
                    }),
                    signal: requestSignal,
                });
            }
            catch (error) {
                throw new RetryableOpenAIChatError(`OpenAI Chat stream request transport failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            if (!response.ok) {
                const raw = await readResponseBody(response);
                const err = raw;
                const message = typeof err === "object" && err && "error" in err
                    ? err.error?.message
                    : typeof err === "string"
                        ? err
                        : response.statusText;
                const errorText = `OpenAI Chat stream request failed (${response.status}): ${message || response.statusText}`;
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
