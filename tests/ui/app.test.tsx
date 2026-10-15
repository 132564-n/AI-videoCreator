// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../apps/web/src/App";

const project = {
  id: "11111111-1111-4111-8111-111111111111", name: "雨夜末班车", productionType: "anime",
  targetDurationSeconds: 60, aspectRatio: "9:16", currentStage: "story", createdAt: "2026-10-15T00:00:00Z", updatedAt: "2026-10-15T00:00:00Z"
};
const workspace = {
  project,
  messages: [{ id: "m1", role: "user", content: "一个雨夜重逢的故事", createdAt: "2026-10-15T00:00:00Z" }],
  stages: [
    { stage: "idea", status: "in_progress", content: "", savedAt: null, confirmedAt: null },
    { stage: "brief", status: "confirmed", content: "都市情感短片", savedAt: "x", confirmedAt: "x" },
    { stage: "story", status: "saved", content: "林夏在末班车站遇见多年未见的周屿。", savedAt: "x", confirmedAt: null },
    ...["script", "assets", "storyboard", "prompts"].map((stage) => ({ stage, status: "not_started", content: "", savedAt: null, confirmedAt: null }))
  ],
  shots: []
};

function json(value: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }));
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mockApi() {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/session")) return json({ status: "ready" });
    if (url.endsWith("/api/projects")) return json([project]);
    if (url.endsWith(`/api/projects/${project.id}`)) return json(workspace);
    if (url.endsWith(`/api/projects/${project.id}/shots`)) return json([]);
    if (url.endsWith("/api/settings")) return json({ provider: "deepseek", model: "deepseek-flash", apiKeyConfigured: false, apiKeyTail: null });
    return json({ error: { code: "NOT_FOUND", message: "not found" } }, 404);
  }));
}

describe("对话式创作工作台", () => {
  it("以七阶段胶片条、聊天和右侧内容编辑器组织工作", async () => {
    mockApi();
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "雨夜末班车" })).toBeTruthy();
    expect(screen.getAllByTestId("stage-frame")).toHaveLength(7);
    expect(screen.getByText("一个雨夜重逢的故事")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "查看故事全文" }));
    const editor = screen.getByRole("textbox", { name: "故事内容" });
    expect((editor as HTMLTextAreaElement).value).toBe("林夏在末班车站遇见多年未见的周屿。");
    await user.type(editor, "他们错过了十年。");
    await user.click(screen.getByRole("button", { name: /02 创作简报 方向与约束/ }));
    expect(await screen.findByRole("dialog", { name: "尚未保存" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "保存并继续" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "放弃修改" })).toBeTruthy();
  });

  it("设置页说明发送给 DeepSeek 的数据范围且不回显密钥", async () => {
    mockApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "雨夜末班车" });
    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(await screen.findByText(/会把当前项目的完整创作对话、已确认内容和本次要求发送给 DeepSeek/)).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "全局模型" }) as HTMLSelectElement).value).toBe("deepseek-flash");
    expect((screen.getByLabelText("DeepSeek API Key") as HTMLInputElement).value).toBe("");
  });

  it("确认阶段后自动打开下一阶段编辑器", async () => {
    const nextWorkspace = {
      ...workspace,
      project: { ...project, currentStage: "script" },
      stages: workspace.stages.map((stage) => stage.stage === "story"
        ? { ...stage, status: "confirmed", confirmedAt: "x" }
        : stage.stage === "script" ? { ...stage, status: "in_progress" } : stage)
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/session")) return json({ status: "ready" });
      if (url.endsWith("/api/projects")) return json([project]);
      if (url.endsWith(`/api/projects/${project.id}/stages/story/confirm`)) return json(nextWorkspace);
      if (url.endsWith(`/api/projects/${project.id}`)) return json(workspace);
      if (url.endsWith(`/api/projects/${project.id}/shots`)) return json([]);
      if (url.endsWith("/api/settings")) return json({ provider: "deepseek", model: "deepseek-flash", apiKeyConfigured: false, apiKeyTail: null });
      return json({ error: { code: "NOT_FOUND", message: "not found" } }, 404);
    }));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "雨夜末班车" });
    await user.click(screen.getByRole("button", { name: "查看故事全文" }));
    await user.click(screen.getByRole("button", { name: "确认此阶段" }));
    expect(await screen.findByRole("textbox", { name: "剧本内容" })).toBeTruthy();
  });

  it("创意信息足够时直接打开未保存的创作简报草稿", async () => {
    const briefDraft = "主题：守护的代价\n结局：神在完成守护后获得解脱。";
    const briefWorkspace = {
      ...workspace,
      project: { ...project, currentStage: "brief" },
      stages: workspace.stages.map((stage) => stage.stage === "idea"
        ? { ...stage, status: "confirmed", confirmedAt: "x" }
        : stage.stage === "brief" ? { ...stage, status: "in_progress", content: "", savedAt: null, confirmedAt: null } : stage)
    };
    let workspaceReads = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/session")) return json({ status: "ready" });
      if (url.endsWith("/api/projects")) return json([project]);
      if (url.endsWith(`/api/projects/${project.id}/generate/conversation`)) {
        const frames = [
          `event: stage_draft\ndata: ${JSON.stringify({ stage: "brief", content: briefDraft })}`,
          `event: delta\ndata: ${JSON.stringify({ text: "信息已经足够，我整理好了创作简报。" })}`,
          `event: completed\ndata: ${JSON.stringify({ action: "brief" })}`
        ].join("\n\n") + "\n\n";
        return Promise.resolve(new Response(frames, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
      }
      if (url.endsWith(`/api/projects/${project.id}`)) return json(workspaceReads++ === 0 ? workspace : briefWorkspace);
      if (url.endsWith(`/api/projects/${project.id}/shots`)) return json([]);
      if (url.endsWith("/api/settings")) return json({ provider: "deepseek", model: "deepseek-flash", apiKeyConfigured: false, apiKeyTail: null });
      return json({ error: { code: "NOT_FOUND", message: "not found" } }, 404);
    }));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "雨夜末班车" });
    await user.type(screen.getByRole("textbox", { name: "创意对话输入" }), "完全依赖画面与音乐叙事");
    await user.click(screen.getByRole("button", { name: "发送" }));

    const editor = await screen.findByRole("textbox", { name: "创作简报内容" });
    expect((editor as HTMLTextAreaElement).value).toBe(briefDraft);
    expect(screen.getByRole("button", { name: "保存" })).toBeTruthy();
  });
});
