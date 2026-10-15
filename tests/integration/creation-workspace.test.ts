import { afterEach, describe, expect, it } from "vitest";
import { createTestStore } from "../helpers/store.js";

const active: Array<ReturnType<typeof createTestStore>> = [];

afterEach(() => {
  for (const item of active.splice(0)) item.cleanup();
});

function setup() {
  const item = createTestStore();
  active.push(item);
  return item.store;
}

describe("创作工作区", () => {
  it("新建短片项目后恢复唯一对话和七阶段状态", () => {
    const store = setup();
    const project = store.createProject({
      name: "雨夜重逢",
      productionType: "live_action",
      targetDurationSeconds: 45,
      aspectRatio: "9:16"
    });

    store.appendMessage(project.id, { role: "user", content: "雨夜里两个旧友重逢" });
    const workspace = store.getWorkspace(project.id);

    expect(workspace.project.name).toBe("雨夜重逢");
    expect(workspace.messages).toMatchObject([{ role: "user", content: "雨夜里两个旧友重逢" }]);
    expect(workspace.stages.map((item) => [item.stage, item.status])).toEqual([
      ["idea", "in_progress"],
      ["brief", "not_started"],
      ["story", "not_started"],
      ["script", "not_started"],
      ["assets", "not_started"],
      ["storyboard", "not_started"],
      ["prompts", "not_started"]
    ]);
  });

  it("只有重新确认发生内容变化时才让下游失效", () => {
    const store = setup();
    const project = store.createProject({
      name: "纸飞机",
      productionType: "anime",
      targetDurationSeconds: 30,
      aspectRatio: "16:9"
    });

    store.saveStage(project.id, "brief", "青春校园，30 秒");
    store.confirmStage(project.id, "brief");
    store.saveStage(project.id, "story", "女孩把纸飞机送回少年手中。");
    store.confirmStage(project.id, "story");

    store.reopenStage(project.id, "brief");
    store.saveStage(project.id, "brief", "雨后校园，30 秒");
    expect(store.getWorkspace(project.id).stages.find((item) => item.stage === "story")?.status).toBe("confirmed");

    store.confirmStage(project.id, "brief");
    expect(store.getWorkspace(project.id).stages.find((item) => item.stage === "story")?.status).toBe("stale");
  });

  it("确认当前阶段后把下一阶段标为进行中", () => {
    const store = setup();
    const project = store.createProject({ name: "纸飞机", productionType: "anime", targetDurationSeconds: 30, aspectRatio: "16:9" });
    store.beginBrief(project.id);
    store.saveStage(project.id, "brief", "青春校园，30 秒");

    const workspace = store.confirmStage(project.id, "brief");

    expect(workspace.project.currentStage).toBe("story");
    expect(workspace.stages.find((item) => item.stage === "story")?.status).toBe("in_progress");
  });

  it("分镜草稿保存不替换现有镜头，重新确认后保留同编号提示词并标记失效", () => {
    const store = setup();
    const project = store.createProject({ name: "车站", productionType: "anime", targetDurationSeconds: 30, aspectRatio: "9:16" });
    for (const stage of ["brief", "story", "script", "assets"] as const) {
      store.saveStage(project.id, stage, `${stage}内容`);
      store.confirmStage(project.id, stage);
    }
    store.saveStage(project.id, "storyboard", "镜头 1：旧标题｜旧摘要", [{ sequence: 1, title: "旧标题", summary: "旧摘要" }]);
    store.confirmStage(project.id, "storyboard");
    const shot = store.listShots(project.id)[0];
    if (!shot) throw new Error("镜头创建失败");
    store.appendPromptVersion(project.id, shot.id, {
      reason: "首次生成", provider: "deepseek", model: "deepseek-flash",
      seedreamPositive: "首帧", seedreamNegative: "模糊", seedreamParameters: "9:16",
      minimaxPositive: "推进", minimaxNegative: "闪烁", minimaxParameters: "6秒", continuityNotes: "蓝围巾"
    });
    store.confirmStage(project.id, "prompts");

    store.reopenStage(project.id, "storyboard");
    store.saveStage(project.id, "storyboard", "镜头 1：新标题｜新摘要", [{ sequence: 1, title: "新标题", summary: "新摘要" }]);
    expect(store.listShots(project.id)[0]?.title).toBe("旧标题");
    expect(store.listPromptVersions(project.id, shot.id)).toHaveLength(1);

    store.confirmStage(project.id, "storyboard");
    expect(store.listShots(project.id)[0]?.title).toBe("新标题");
    expect(store.listPromptVersions(project.id, shot.id)).toHaveLength(1);
    expect(store.getWorkspace(project.id).stages.find((item) => item.stage === "prompts")?.status).toBe("stale");
  });
});
