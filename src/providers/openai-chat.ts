export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface OpenAIChatProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export interface OpenAIChatResult {
  model: string;
  content: string;
  raw: unknown;
}

interface OpenAIChatChoice {
  message?: {
    role?: string;
    content?: string | null;
  };
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
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("OpenAI Chat response did not contain choices[0].message.content");
  }
  return content;
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

export class OpenAIChatProvider {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly temperature?: number;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIChatProviderOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.openai.com/v1");
    this.apiKey = options.apiKey ?? "";
    this.model = options.model;
    this.temperature = options.temperature;
    this.maxRetries = options.maxRetries ?? 10;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.fetchImpl = options.fetchImpl ?? fetch;

    if (!this.model) throw new Error("model is required");
    if (!this.apiKey) throw new Error("apiKey is required");
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0) {
      throw new Error("maxRetries must be a non-negative integer");
    }
    if (!Number.isInteger(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw new Error("retryDelayMs must be a non-negative integer");
    }
  }

  async chat(messages: ChatMessage[]): Promise<OpenAIChatResult> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.chatOnce(messages);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const retryable = error instanceof RetryableOpenAIChatError;
        if (!retryable || attempt >= this.maxRetries) break;
        await sleep(this.retryDelayMs * Math.max(1, attempt + 1));
      }
    }
    throw lastError ?? new Error("OpenAI Chat request failed");
  }

  async chatStream(messages: ChatMessage[], onDelta: (delta: string) => void): Promise<OpenAIChatResult> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.chatStreamOnce(messages, onDelta);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const retryable = error instanceof RetryableOpenAIChatError;
        if (!retryable || attempt >= this.maxRetries) break;
        await sleep(this.retryDelayMs * Math.max(1, attempt + 1));
      }
    }
    throw lastError ?? new Error("OpenAI Chat stream request failed");
  }

  private async chatOnce(messages: ChatMessage[]): Promise<OpenAIChatResult> {
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
          messages,
          ...(typeof this.temperature === "number" ? { temperature: this.temperature } : {}),
        }),
      });
    } catch (error) {
      throw new RetryableOpenAIChatError(`OpenAI Chat request transport failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const raw = await readResponseBody(response);
    if (!response.ok) {
      const err = raw as OpenAIChatResponse | string | null;
      const message = typeof err === "object" && err && "error" in err
        ? err.error?.message
        : typeof err === "string"
          ? err
          : response.statusText;
      const errorText = `OpenAI Chat request failed (${response.status}): ${message || response.statusText}`;
      if (isRetryableStatus(response.status)) throw new RetryableOpenAIChatError(errorText);
      throw new Error(errorText);
    }

    const json = raw as OpenAIChatResponse;
    return {
      model: json.model ?? this.model,
      content: resolveContent(json),
      raw: json,
    };
  }

  private async chatStreamOnce(messages: ChatMessage[], onDelta: (delta: string) => void): Promise<OpenAIChatResult> {
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
          messages,
          stream: true,
          ...(typeof this.temperature === "number" ? { temperature: this.temperature } : {}),
        }),
      });
    } catch (error) {
      throw new RetryableOpenAIChatError(`OpenAI Chat stream request transport failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      const raw = await readResponseBody(response);
      const err = raw as OpenAIChatResponse | string | null;
      const message = typeof err === "object" && err && "error" in err
        ? err.error?.message
        : typeof err === "string"
          ? err
          : response.statusText;
      const errorText = `OpenAI Chat stream request failed (${response.status}): ${message || response.statusText}`;
      if (isRetryableStatus(response.status)) throw new RetryableOpenAIChatError(errorText);
      throw new Error(errorText);
    }

    if (!response.body) throw new Error("OpenAI Chat stream response did not include a body");
    const content = await readSseContent(response.body, onDelta);
    if (!content) throw new Error("OpenAI Chat stream response did not contain delta content");
    return { model: this.model, content, raw: { streamed: true } };
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
