import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createPromptZip } from "../../packages/domain/src/prompt-export.js";

const shot = {
  sequence: 1,
  title: "雨夜/重逢?",
  bundle: {
    seedreamPositive: "雨夜车站，人物正面中景",
    seedreamNegative: "畸形手指",
    seedreamParameters: "16:9，电影感",
    minimaxPositive: "镜头缓慢推进，人物抬眼",
    minimaxNegative: "画面闪烁",
    minimaxParameters: "6 秒，24fps",
    continuityNotes: "保持蓝色围巾和湿发"
  }
};

describe("提示词 ZIP 导出", () => {
  it("按镜头分别生成所选格式并净化文件名", () => {
    const markdown = unzipSync(createPromptZip("夜班车", "md", [shot]));
    expect(Object.keys(markdown)).toEqual(["01-雨夜_重逢_.md"]);
    expect(strFromU8(markdown["01-雨夜_重逢_.md"]!)).toContain("# 镜头 01 · 雨夜/重逢?");
    expect(strFromU8(markdown["01-雨夜_重逢_.md"]!)).toContain("## Seedream 5.0 Lite 首帧图片提示词");

    const text = unzipSync(createPromptZip("夜班车", "txt", [shot]));
    expect(Object.keys(text)).toEqual(["01-雨夜_重逢_.txt"]);
    expect(strFromU8(text["01-雨夜_重逢_.txt"]!)).toContain("MiniMax H3 视频提示词");
    expect(strFromU8(text["01-雨夜_重逢_.txt"]!)).not.toContain("# ");
  });
});
