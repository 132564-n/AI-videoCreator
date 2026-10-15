import { describe, expect, it } from "vitest";
import { DeepSeekTextModel } from "../../packages/domain/src/deepseek-text-model.js";
import { InMemoryTextModel } from "../../packages/domain/src/text-model.js";

async function collect(model: { generate: DeepSeekTextModel["generate"] }) {
  const events = [];
  for await (const event of model.generate({ model: "deepseek-flash", system: "你是编剧", prompt: "写一句" })) events.push(event);
  return events;
}

describe("文本模型端口", () => {
  it("假模型按顺序产生增量和完成事件", async () => {
    const model = new InMemoryTextModel([{ type: "delta", text: "雨夜" }, { type: "delta", text: "重逢" }]);
    expect(await collect(model)).toEqual([
      { type: "delta", text: "雨夜" },
      { type: "delta", text: "重逢" },
      { type: "completed", text: "雨夜重逢" }
    ]);
  });

  it("DeepSeek 适配器解析流式响应且不回显密钥", async () => {
    const fetcher: typeof fetch = async (_input, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer sk-secret-value");
      return new Response([
        'data: {"choices":[{"delta":{"content":"雨夜"}}]}',
        'data: {"choices":[{"delta":{"content":"重逢"},"finish_reason":"stop"}]}',
        "data: [DONE]",
        ""
      ].join("\n\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    const model = new DeepSeekTextModel({ apiKey: async () => "sk-secret-value", fetcher });
    expect(await collect(model)).toEqual([
      { type: "delta", text: "雨夜" },
      { type: "delta", text: "重逢" },
      { type: "completed", text: "雨夜重逢" }
    ]);
  });

  it("把余额不足翻译为可行动错误", async () => {
    const model = new DeepSeekTextModel({
      apiKey: async () => "sk-hidden",
      fetcher: async () => new Response("balance", { status: 402 })
    });
    await expect(collect(model)).rejects.toMatchObject({ code: "DEEPSEEK_BALANCE", status: 402 });
  });
});
