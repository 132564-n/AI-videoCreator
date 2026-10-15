export interface ModelGenerationRequest {
  model: string;
  system: string;
  prompt: string;
}

export type ModelEvent =
  | { type: "delta"; text: string }
  | { type: "completed"; text: string };

export interface ModelStatus {
  ok: boolean;
  message: string;
  models: string[];
}

export interface TextModelPort {
  validateConfiguration(signal?: AbortSignal): Promise<ModelStatus>;
  generate(request: ModelGenerationRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
}

export class InMemoryTextModel implements TextModelPort {
  constructor(private readonly events: Array<{ type: "delta"; text: string }>, private readonly failure?: Error) {}

  async validateConfiguration(): Promise<ModelStatus> {
    return { ok: !this.failure, message: this.failure ? this.failure.message : "连接正常", models: ["deepseek-flash", "deepseek-v4-pro"] };
  }

  async *generate(_request: ModelGenerationRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    if (this.failure) throw this.failure;
    let text = "";
    for (const event of this.events) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("已停止", "AbortError");
      text += event.text;
      yield event;
    }
    yield { type: "completed", text };
  }
}

export class ModelProviderError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}
