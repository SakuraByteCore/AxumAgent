export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: AxumToolCall[];
}

export interface ChatToolSpec {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAIChatProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface OpenAIChatResult {
  model: string;
  content: string;
  raw: unknown;
  toolCalls?: AxumToolCall[];
  finishReason?: string;
}

export interface AxumToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface AxumSafetyGuardResult<T> {
  value: T;
  corrections: string[];
}

interface OpenAIModelListResponse {
  data?: Array<{ id?: string }>;
  error?: {
    message?: string;
    type?: string;
    code?: string | number;
  };
}

interface OpenAIChatChoice {
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: AxumToolCall[];
  };
  finish_reason?: string;
  delta?: {
    role?: string;
    content?: string | null;
  };
}

interface OpenAIChatResponse {
  model?: string;
  choices?: OpenAIChatChoice[];
  error?: {
    message?: string;
    type?: string;
    code?: string | number;
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function resolveContent(json: OpenAIChatResponse): string {
  const choice = json.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") return content;
  if (choice?.message?.tool_calls?.length) return "";
  throw new Error("OpenAI Chat response did not contain choices[0].message.content");
}

export function sanitizeMessagesForProvider(messages: ChatMessage[]): AxumSafetyGuardResult<ChatMessage[]> {
  const corrections: string[] = [];
  const sanitized = messages.map((message, index) => {
    const role = message.role;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
      corrections.push(`message[${index}] role corrected to user`);
      return { role: "user" as const, content: String(message.content ?? "") };
    }
    const content = String(message.content ?? "");
    if (content.length === 0) corrections.push(`message[${index}] empty content preserved`);
    return { role, content, ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}), ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) };
  });
  return { value: sanitized, corrections };
}

export function sanitizeToolCallsForProvider(toolCalls: AxumToolCall[], allowedTools: string[]): AxumSafetyGuardResult<AxumToolCall[]> {
  const allowed = new Set(allowedTools);
  const corrections: string[] = [];
  const value = toolCalls.flatMap((call, index) => {
    const name = call.function?.name;
    if (!name || !allowed.has(name)) {
      corrections.push(`tool_calls[${index}] dropped: ${name || "missing-name"} is not allowed`);
      return [];
    }
    if (call.type && call.type !== "function") corrections.push(`tool_calls[${index}] type corrected to function`);
    return [{ ...call, type: "function" as const, function: { ...call.function, name, arguments: call.function?.arguments ?? "{}" } }];
  });
  return { value, corrections };
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function summarizeProviderErrorBody(raw: unknown, response?: Response): string | undefined {
  if (typeof raw === "object" && raw && "error" in raw) {
    const message = (raw as { error?: { message?: string } }).error?.message;
    return message ? collapseWhitespace(message) : undefined;
  }
  if (typeof raw !== "string") return undefined;
  const text = collapseWhitespace(raw);
  const contentType = response?.headers.get("content-type") ?? "";
  const server = response?.headers.get("server") ?? "";
  const isHtml = /text\/html/i.test(contentType) || /^<!doctype html/i.test(text) || /^<html/i.test(text);
  const isCloudflare = /cloudflare/i.test(server) || /Just a moment|challenge-platform|cf_chl|Cloudflare challenge/i.test(text);
  if (isCloudflare) return "provider returned a Cloudflare/browser challenge HTML page; this endpoint is not directly CLI/API-compatible from this network";
  if (isHtml) return "provider returned HTML instead of JSON; check the base URL, API path, or gateway/proxy compatibility";
  return text.length > 800 ? `${text.slice(0, 800)}…` : text;
}

function providerErrorMessage(label: string, response: Response, raw: unknown): string {
  return `${label} failed (${response.status}): ${summarizeProviderErrorBody(raw, response) || response.statusText}`;
}

export class OpenAIChatProvider {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly temperature?: number;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIChatProviderOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.openai.com/v1");
    this.apiKey = options.apiKey ?? "";
    this.model = options.model;
    this.temperature = options.temperature;
    this.maxRetries = options.maxRetries ?? 10;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 600_000;
    this.fetchImpl = options.fetchImpl ?? fetch;

    if (!this.model) throw new Error("model is required");
    if (!this.apiKey) throw new Error("apiKey is required");
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

  private async withRequestTimeout<T>(label: string, run: (signal?: AbortSignal) => Promise<T>, externalSignal?: AbortSignal): Promise<T> {
    if (externalSignal?.aborted) throw new Error(`${label} cancelled`);
    if (this.requestTimeoutMs === 0) return run(externalSignal);
    const controller = new AbortController();
    const abortFromExternal = (): void => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await run(controller.signal);
    } catch (error) {
      if (externalSignal?.aborted) {
        throw new Error(`${label} cancelled`);
      }
      if (controller.signal.aborted) {
        throw new Error(`${label} timed out after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }
  }

  async listModels(): Promise<string[]> {
    const raw = await this.withRequestTimeout("OpenAI Models request", async (signal) => {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/models`, {
          method: "GET",
          headers: { "authorization": `Bearer ${this.apiKey}` },
          signal,
        });
      } catch (error) {
        throw new RetryableOpenAIChatError(`OpenAI Models request transport failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { response, raw: await readResponseBody(response) };
    });
    const { response } = raw;
    if (!response.ok) {
      throw new Error(providerErrorMessage("OpenAI Models request", response, raw.raw));
    }

    const json = raw.raw as OpenAIModelListResponse;
    return (json.data ?? []).map((model) => model.id).filter((id): id is string => typeof id === "string" && id.length > 0);
  }

  async chat(messages: ChatMessage[], signal?: AbortSignal): Promise<OpenAIChatResult> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.chatOnce(messages, signal);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const retryable = error instanceof RetryableOpenAIChatError;
        if (!retryable || attempt >= this.maxRetries) break;
        await sleep(this.retryDelayMs * Math.max(1, attempt + 1));
      }
    }
    throw lastError ?? new Error("OpenAI Chat request failed");
  }

  async chatStream(messages: ChatMessage[], onDelta: (delta: string) => void, signal?: AbortSignal): Promise<OpenAIChatResult> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.chatStreamOnce(messages, onDelta, signal);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const retryable = error instanceof RetryableOpenAIChatError;
        if (!retryable || attempt >= this.maxRetries) break;
        await sleep(this.retryDelayMs * Math.max(1, attempt + 1));
      }
    }
    throw lastError ?? new Error("OpenAI Chat stream request failed");
  }

  async chatWithTools(messages: ChatMessage[], tools: ChatToolSpec[], signal?: AbortSignal): Promise<OpenAIChatResult> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.chatOnce(messages, signal, tools);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const retryable = error instanceof RetryableOpenAIChatError;
        if (!retryable || attempt >= this.maxRetries) break;
        await sleep(this.retryDelayMs * Math.max(1, attempt + 1));
      }
    }
    throw lastError ?? new Error("OpenAI Chat request failed");
  }

  private async chatOnce(messages: ChatMessage[], signal?: AbortSignal, tools?: ChatToolSpec[]): Promise<OpenAIChatResult> {
    const guardedMessages = sanitizeMessagesForProvider(messages).value;
    const request = await this.withRequestTimeout("OpenAI Chat request", async (requestSignal) => {
      let response: Response;
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
            ...(tools && tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
          }),
          signal: requestSignal,
        });
      } catch (error) {
        throw new RetryableOpenAIChatError(`OpenAI Chat request transport failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { response, raw: await readResponseBody(response) };
    }, signal);
    const { response, raw } = request;
    if (!response.ok) {
      const errorText = providerErrorMessage("OpenAI Chat request", response, raw);
      if (isRetryableStatus(response.status)) throw new RetryableOpenAIChatError(errorText);
      throw new Error(errorText);
    }

    const json = raw as OpenAIChatResponse;
    const choice = json.choices?.[0];
    return {
      model: json.model ?? this.model,
      content: resolveContent(json),
      raw: json,
      toolCalls: sanitizeToolCallsForProvider(choice?.message?.tool_calls ?? [], tools?.map((tool) => tool.function.name) ?? []).value,
      finishReason: choice?.finish_reason,
    };
  }

  private async chatStreamOnce(messages: ChatMessage[], onDelta: (delta: string) => void, signal?: AbortSignal): Promise<OpenAIChatResult> {
    const guardedMessages = sanitizeMessagesForProvider(messages).value;
    return this.withRequestTimeout("OpenAI Chat stream request", async (requestSignal) => {
      let response: Response;
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
      } catch (error) {
        throw new RetryableOpenAIChatError(`OpenAI Chat stream request transport failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (!response.ok) {
        const raw = await readResponseBody(response);
        const errorText = providerErrorMessage("OpenAI Chat stream request", response, raw);
        if (isRetryableStatus(response.status)) throw new RetryableOpenAIChatError(errorText);
        throw new Error(errorText);
      }

      if (!response.body) throw new Error("OpenAI Chat stream response did not include a body");
      const content = await readSseContent(response.body, onDelta);
      if (!content) throw new Error("OpenAI Chat stream response did not contain delta content");
      return { model: this.model, content, raw: { streamed: true } };
    }, signal);
  }
}

async function readSseContent(body: ReadableStream<Uint8Array>, onDelta: (delta: string) => void): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of event.split(/\r?\n/g)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const json = JSON.parse(data) as OpenAIChatResponse;
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

class RetryableOpenAIChatError extends Error {}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
