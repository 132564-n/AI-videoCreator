import { ModelProviderError, type ModelEvent, type ModelGenerationRequest, type ModelStatus, type TextModelPort } from "./text-model.js";

const BASE_URL = "https://api.deepseek.com";

function providerError(status: number): ModelProviderError {
  const known: Record<number, [string, string]> = {
    400: ["DEEPSEEK_REQUEST", "DeepSeek 无法处理当前请求，请调整内容后重试"],
    401: ["DEEPSEEK_AUTH", "DeepSeek API Key 无效，请在设置中更新"],
    402: ["DEEPSEEK_BALANCE", "DeepSeek 账户余额不足，请充值后重试"],
    422: ["DEEPSEEK_REQUEST", "DeepSeek 请求格式不受支持"],
    429: ["DEEPSEEK_RATE_LIMIT", "DeepSeek 请求过于频繁，请稍后重试"],
    500: ["DEEPSEEK_UNAVAILABLE", "DeepSeek 服务暂时不可用，请稍后重试"],
    503: ["DEEPSEEK_UNAVAILABLE", "DeepSeek 服务繁忙，请稍后重试"]
  };
  const [code, message] = known[status] ?? ["DEEPSEEK_ERROR", "DeepSeek 请求失败，请稍后重试"];
  return new ModelProviderError(code, message, status);
}

export interface DeepSeekOptions {
  apiKey: () => Promise<string | null>;
  fetcher?: typeof fetch;
  baseUrl?: string;
}

export class DeepSeekTextModel implements TextModelPort {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: DeepSeekOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.baseUrl = options.baseUrl ?? BASE_URL;
  }

  async validateConfiguration(signal?: AbortSignal): Promise<ModelStatus> {
    const response = await this.authorizedFetch("/models", { method: "GET", ...(signal ? { signal } : {}) });
    if (!response.ok) throw providerError(response.status);
    const body = await response.json() as { data?: Array<{ id?: string }> };
    const models = (body.data ?? []).flatMap((item) => item.id ? [item.id] : []);
    return { ok: true, message: "DeepSeek 连接正常", models };
  }

  async *generate(request: ModelGenerationRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const response = await this.authorizedFetch("/chat/completions", {
      method: "POST",
      ...(signal ? { signal } : {}),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        stream: true,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.prompt }
        ]
      })
    });
    if (!response.ok) throw providerError(response.status);
    if (!response.body) throw new ModelProviderError("DEEPSEEK_EMPTY", "DeepSeek 没有返回内容", 502);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let output = "";
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const frames = pending.split(/\r?\n\r?\n/);
      pending = frames.pop() ?? "";
      for (const frame of frames) {
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }> };
          const text = parsed.choices?.[0]?.delta?.content ?? "";
          if (text) {
            output += text;
            yield { type: "delta", text };
          }
        }
      }
      if (done) break;
    }
    if (!output.trim()) throw new ModelProviderError("DEEPSEEK_EMPTY", "DeepSeek 没有返回有效内容", 502);
    yield { type: "completed", text: output };
  }

  private async authorizedFetch(path: string, init: RequestInit): Promise<Response> {
    const apiKey = await this.options.apiKey();
    if (!apiKey) throw new ModelProviderError("DEEPSEEK_KEY_MISSING", "请先在设置中填写 DeepSeek API Key", 409);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${apiKey}`);
    return this.fetcher(`${this.baseUrl}${path}`, { ...init, headers });
  }
}
