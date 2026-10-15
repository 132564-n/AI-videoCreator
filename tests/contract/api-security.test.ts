import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalApplication } from "../../apps/server/src/app.js";
import { InMemoryTextModel, type ModelGenerationRequest, type ModelEvent, type ModelStatus, type TextModelPort } from "../../packages/domain/src/text-model.js";
import { InMemorySecretStore } from "../../packages/storage/src/secret-store.js";

const active: Array<{ app: LocalApplication; root: string }> = [];
afterEach(async () => {
  for (const item of active.splice(0)) {
    await item.app.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

class CapturingTextModel implements TextModelPort {
  readonly requests: ModelGenerationRequest[] = [];

  constructor(private readonly output: string) {}

  async validateConfiguration(): Promise<ModelStatus> {
    return { ok: true, message: "连接正常", models: ["deepseek-flash"] };
  }

  async *generate(request: ModelGenerationRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    yield { type: "delta", text: this.output };
    yield { type: "completed", text: this.output };
  }
}

async function start(events = [{ type: "delta" as const, text: "生成内容" }], textModel?: TextModelPort) {
  const root = mkdtempSync(path.join(tmpdir(), "ai-video-api-"));
  const app = new LocalApplication({
    dataRoot: root,
    sessionToken: "contract-test-session-token-00000001",
    secretStore: new InMemorySecretStore(),
    textModel: textModel ?? new InMemoryTextModel(events)
  });
  active.push({ app, root });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const session = await fetch(`${base}/api/session`);
  const cookie = session.headers.get("set-cookie")?.split(";")[0] ?? "";
  return { base, cookie };
}

function headers(base: string, cookie: string) {
  return { Cookie: cookie, Origin: base, "Content-Type": "application/json" };
}

describe("本地创作 API 合同", () => {
  it("无本机会话不能读取项目列表", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/api/projects`);
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("SESSION_REQUIRED");
  });

  it("新建项目后恢复唯一对话和七阶段状态", async () => {
    const { base, cookie } = await start();
    const rejected = await fetch(`${base}/api/projects`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
    expect(rejected.status).toBe(403);

    const created = await fetch(`${base}/api/projects`, {
      method: "POST", headers: headers(base, cookie),
      body: JSON.stringify({ name: "雨夜末班车", productionType: "anime", targetDurationSeconds: 60, aspectRatio: "9:16" })
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };

    const workspace = await fetch(`${base}/api/projects/${project.id}`, { headers: { Cookie: cookie } });
    expect(workspace.status).toBe(200);
    const body = await workspace.json();
    expect(body.project.name).toBe("雨夜末班车");
    expect(body.stages).toHaveLength(7);
    expect(body.messages).toEqual([]);
  });

  it("设置接口只返回密钥状态和尾号", async () => {
    const { base, cookie } = await start();
    await fetch(`${base}/api/settings/api-key`, { method: "PUT", headers: headers(base, cookie), body: JSON.stringify({ apiKey: "sk-super-secret-6789" }) });
    const response = await fetch(`${base}/api/settings`, { headers: { Cookie: cookie } });
    const text = await response.text();
    expect(text).not.toContain("sk-super-secret");
    expect(JSON.parse(text)).toMatchObject({ apiKeyConfigured: true, apiKeyTail: "6789" });
  });

  it("创意对话以流式事件返回并写入同一项目对话", async () => {
    const { base, cookie } = await start([{ type: "delta", text: "故事发生在什么年代？" }]);
    const created = await fetch(`${base}/api/projects`, {
      method: "POST", headers: headers(base, cookie),
      body: JSON.stringify({ name: "旧城", productionType: "live_action", targetDurationSeconds: 90, aspectRatio: "16:9" })
    });
    const project = await created.json() as { id: string };
    const generated = await fetch(`${base}/api/projects/${project.id}/generate/conversation`, {
      method: "POST", headers: headers(base, cookie), body: JSON.stringify({ content: "一个错过末班车的人" })
    });
    const stream = await generated.text();
    expect(stream).toContain("event: delta");
    expect(stream).toContain("故事发生在什么年代？");

    const workspace = await (await fetch(`${base}/api/projects/${project.id}`, { headers: { Cookie: cookie } })).json();
    expect(workspace.messages.map((item: { role: string }) => item.role)).toEqual(["user", "assistant"]);
  });

  it("连续创意问答会把同一项目的完整历史交给模型", async () => {
    const model = new CapturingTextModel(JSON.stringify({ action: "ask", message: "故事最终希望留下什么情绪？" }));
    const { base, cookie } = await start([], model);
    const project = await (await fetch(`${base}/api/projects`, {
      method: "POST", headers: headers(base, cookie),
      body: JSON.stringify({ name: "守护者", productionType: "anime", targetDurationSeconds: 60, aspectRatio: "16:9" })
    })).json() as { id: string };

    await fetch(`${base}/api/projects/${project.id}/generate/conversation`, {
      method: "POST", headers: headers(base, cookie), body: JSON.stringify({ content: "一个神为了星球改造自己" })
    }).then((response) => response.text());
    await fetch(`${base}/api/projects/${project.id}/generate/conversation`, {
      method: "POST", headers: headers(base, cookie), body: JSON.stringify({ content: "结尾是解脱" })
    }).then((response) => response.text());

    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]?.prompt).toContain("用户：一个神为了星球改造自己");
    expect(model.requests[1]?.prompt).toContain("搭子：故事最终希望留下什么情绪？");
    expect(model.requests[1]?.prompt).toContain("用户：结尾是解脱");
  });

  it("信息足够时把创意环节完成并返回未保存的创作简报草稿", async () => {
    const brief = "主题：守护的代价\n叙事：神以机械化换取胜利，最终得到解脱。";
    const model = new CapturingTextModel(JSON.stringify({ action: "brief", message: "信息已经足够，我整理好了创作简报。", content: brief }));
    const { base, cookie } = await start([], model);
    const project = await (await fetch(`${base}/api/projects`, {
      method: "POST", headers: headers(base, cookie),
      body: JSON.stringify({ name: "合格的神", productionType: "anime", targetDurationSeconds: 60, aspectRatio: "16:9" })
    })).json() as { id: string };

    const generated = await fetch(`${base}/api/projects/${project.id}/generate/conversation`, {
      method: "POST", headers: headers(base, cookie), body: JSON.stringify({ content: "按这个完整故事生成，无对白" })
    });
    const stream = await generated.text();
    expect(stream).toContain("event: stage_draft");
    expect(stream).toContain(JSON.stringify(brief).slice(1, -1));

    const workspace = await (await fetch(`${base}/api/projects/${project.id}`, { headers: { Cookie: cookie } })).json();
    expect(workspace.project.currentStage).toBe("brief");
    expect(workspace.stages.find((item: { stage: string }) => item.stage === "idea")?.status).toBe("confirmed");
    expect(workspace.stages.find((item: { stage: string }) => item.stage === "brief")).toMatchObject({ status: "in_progress", content: "" });
  });

  it("批量生成全部镜头提示词并在用户保存前不写入版本", async () => {
    const bundle = JSON.stringify({
      seedreamPositive: "雨夜车站首帧", seedreamNegative: "畸形", seedreamParameters: "9:16",
      minimaxPositive: "镜头缓慢推进", minimaxNegative: "闪烁", minimaxParameters: "6秒",
      continuityNotes: "保持蓝围巾"
    });
    const { base, cookie } = await start([{ type: "delta", text: bundle }]);
    const project = await (await fetch(`${base}/api/projects`, {
      method: "POST", headers: headers(base, cookie),
      body: JSON.stringify({ name: "雨夜", productionType: "anime", targetDurationSeconds: 60, aspectRatio: "9:16" })
    })).json() as { id: string };
    for (const stage of ["brief", "story", "script", "assets"] as const) {
      await fetch(`${base}/api/projects/${project.id}/stages/${stage}`, { method: "PUT", headers: headers(base, cookie), body: JSON.stringify({ content: `${stage}内容` }) });
      await fetch(`${base}/api/projects/${project.id}/stages/${stage}/confirm`, { method: "POST", headers: headers(base, cookie), body: "{}" });
    }
    await fetch(`${base}/api/projects/${project.id}/stages/storyboard`, {
      method: "PUT", headers: headers(base, cookie),
      body: JSON.stringify({ content: "两个镜头", shots: [{ sequence: 1, title: "车站", summary: "人物等待" }, { sequence: 2, title: "重逢", summary: "两人对视" }] })
    });
    await fetch(`${base}/api/projects/${project.id}/stages/storyboard/confirm`, { method: "POST", headers: headers(base, cookie), body: "{}" });

    const generated = await fetch(`${base}/api/projects/${project.id}/generate/prompts`, { method: "POST", headers: headers(base, cookie), body: "{}" });
    const stream = await generated.text();
    expect(stream).toContain('"total":2,"completed":2,"failed":0');
    expect(stream).toContain('"bundle":{"seedreamPositive":"雨夜车站首帧"');
    const shots = await (await fetch(`${base}/api/projects/${project.id}/shots`, { headers: { Cookie: cookie } })).json();
    expect(shots.every((shot: { prompt: unknown }) => shot.prompt === null)).toBe(true);
  });
});
