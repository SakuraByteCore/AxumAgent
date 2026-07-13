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
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIChatProviderOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.openai.com/v1");
    this.apiKey = options.apiKey ?? "";
    this.model = options.model;
    this.temperature = options.temperature;
    this.fetchImpl = options.fetchImpl ?? fetch;

    if (!this.model) throw new Error("model is required");
    if (!this.apiKey) throw new Error("apiKey is required");
  }

  async chat(messages: ChatMessage[]): Promise<OpenAIChatResult> {
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
      const err = raw as OpenAIChatResponse | string | null;
      const message = typeof err === "object" && err && "error" in err
        ? err.error?.message
        : typeof err === "string"
          ? err
          : response.statusText;
      throw new Error(`OpenAI Chat request failed (${response.status}): ${message || response.statusText}`);
    }

    const json = raw as OpenAIChatResponse;
    return {
      model: json.model ?? this.model,
      content: resolveContent(json),
      raw: json,
    };
  }
}
