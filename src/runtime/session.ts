import type { OpenAIChatProvider } from "../providers/openai-chat";
import type { AxumConfig } from "../config";
import { AxumEventBus } from "./events";
import { createSubmission, type AxumSubmission, type AxumTurnResult } from "./protocol";
import { runCodexLikeTurn } from "./turn";

export interface AxumSessionOptions {
  config?: AxumConfig;
  provider: OpenAIChatProvider;
  cwd?: string;
  mode?: string;
  maxToolIterations?: number;
  systemPrompt?: string;
}

export class AxumRuntimeSession {
  readonly id: string;
  readonly events = new AxumEventBus();
  private readonly submissions: AxumSubmission[] = [];

  constructor(private readonly options: AxumSessionOptions) {
    this.id = `session-${Date.now().toString(36)}`;
    this.events.emit("session_configured", {
      sessionId: this.id,
      cwd: options.cwd ?? process.cwd(),
      mode: options.mode ?? "build",
      providerModel: options.provider.model,
    });
  }

  enqueueUserInput(prompt: string): AxumSubmission<{ prompt: string }> {
    const submission = createSubmission("user_input", { prompt });
    this.submissions.push(submission);
    return submission;
  }

  async runUserTurn(prompt: string, signal?: AbortSignal): Promise<AxumTurnResult> {
    this.enqueueUserInput(prompt);
    return runCodexLikeTurn({
      config: this.options.config,
      provider: this.options.provider,
      eventBus: this.events,
      mode: this.options.mode,
      cwd: this.options.cwd,
      maxToolIterations: this.options.maxToolIterations,
      systemPrompt: this.options.systemPrompt,
    }, prompt, signal);
  }

  submissionSnapshot(): AxumSubmission[] {
    return [...this.submissions];
  }
}
