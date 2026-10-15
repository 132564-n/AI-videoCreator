import { afterEach, describe, expect, it } from "vitest";
import { createTestStore } from "../helpers/store.js";

const active: Array<ReturnType<typeof createTestStore>> = [];
afterEach(() => {
  for (const item of active.splice(0)) item.cleanup();
});

describe("提示词历史", () => {
  it("追加版本、比较任意版本并以新版本恢复", () => {
    const item = createTestStore();
    active.push(item);
    const project = item.store.createProject({
      name: "天台告白",
      productionType: "anime",
      targetDurationSeconds: 20,
      aspectRatio: "16:9"
    });
    const [shot] = item.store.replaceShots(project.id, [{
      sequence: 1,
      title: "晚霞中的纸飞机",
      summary: "少女在天台抛出纸飞机"
    }]);
    if (!shot) throw new Error("镜头创建失败");

    const first = item.store.appendPromptVersion(project.id, shot.id, {
      reason: "首次生成",
      provider: "deepseek",
      model: "deepseek-flash",
      seedreamPositive: "晚霞，少女，纸飞机",
      seedreamNegative: "模糊，畸形手",
      seedreamParameters: "16:9，电影光",
      minimaxPositive: "少女抬手抛出纸飞机，镜头缓慢前推",
      minimaxNegative: "跳帧，人物闪烁",
      minimaxParameters: "5 秒，中等运镜",
      continuityNotes: "保持蓝白校服与红色发带"
    });
    const second = item.store.appendPromptVersion(project.id, shot.id, {
      ...first.bundle,
      reason: "加强动作",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      minimaxPositive: "少女深呼吸后抬手抛出纸飞机，镜头缓慢前推"
    });

    const diff = item.store.comparePromptVersions(project.id, shot.id, first.id, second.id);
    expect(diff.some((line) => line.kind === "removed" && line.text.includes("少女抬手"))).toBe(true);
    expect(diff.some((line) => line.kind === "added" && line.text.includes("少女深呼吸"))).toBe(true);

    const restored = item.store.restorePromptVersion(project.id, shot.id, first.id, "恢复首次版本");
    expect(restored.versionNumber).toBe(3);
    expect(restored.bundle.minimaxPositive).toBe("少女抬手抛出纸飞机，镜头缓慢前推");
    expect(item.store.listPromptVersions(project.id, shot.id)).toHaveLength(3);
  });
});
