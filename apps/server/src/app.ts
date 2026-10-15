import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import {
  apiKeySaveSchema,
  editableStageSchema,
  generationSchema,
  messageCreateSchema,
  promptBundleSchema,
  promptCompareSchema,
  promptGenerationSchema,
  promptFormatSchema,
  promptRestoreSchema,
  promptSaveSchema,
  projectCreateSchema,
  projectRenameSchema,
  settingsSaveSchema,
  stageSaveSchema
} from "../../../packages/contracts/src/index.js";
import { createPromptZip, DeepSeekTextModel, type TextModelPort } from "../../../packages/domain/src/index.js";
import { AppStore, StoreError, WindowsDpapiSecretStore, type SecretStore } from "../../../packages/storage/src/index.js";
import { json, errorResponse, readJson } from "./http/response.js";
import { serveStatic } from "./http/static-files.js";
import { assertLoopbackHost, assertOrigin, assertSession, issueSessionCookie } from "./security/request-guard.js";

export interface ApplicationOptions {
  dataRoot?: string;
  webRoot?: string;
  sessionToken?: string;
  secretStore?: SecretStore;
  textModel?: TextModelPort;
}

function match(pathname: string, pattern: RegExp): RegExpExecArray | null {
  return pattern.exec(pathname);
}

function sse(response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
}

function writeEvent(response: ServerResponse, event: string, value: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function conversationHistory(workspace: ReturnType<AppStore["getWorkspace"]>): string {
  const roleLabel = { user: "用户", assistant: "搭子", system: "系统" } as const;
  return workspace.messages.map((message) => `${roleLabel[message.role]}：${message.content}`).join("\n\n");
}

function confirmedDocuments(workspace: ReturnType<AppStore["getWorkspace"]>): string {
  return workspace.stages
    .filter((item) => item.status === "confirmed" && item.content.trim())
    .map((item) => `${item.stage}:\n${item.content}`)
    .join("\n\n");
}

type ConversationDecision =
  | { action: "ask"; message: string }
  | { action: "brief"; message: string; content: string };

function parseConversationDecision(output: string): ConversationDecision {
  const normalized = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    const firstBrace = normalized.indexOf("{");
    const lastBrace = normalized.lastIndexOf("}");
    const value = JSON.parse(firstBrace >= 0 && lastBrace > firstBrace ? normalized.slice(firstBrace, lastBrace + 1) : normalized) as Record<string, unknown>;
    const message = typeof value.message === "string" ? value.message.trim() : "";
    if (value.action === "brief" && message && typeof value.content === "string" && value.content.trim()) {
      return { action: "brief", message, content: value.content.trim() };
    }
    if (value.action === "ask" && message) return { action: "ask", message };
  } catch {
    // 供应商偶尔不遵循 JSON 输出时仍保留自然语言回复，不中断用户对话。
  }
  return { action: "ask", message: normalized || "请再补充一个最关键的信息。" };
}

export class LocalApplication {
  readonly store: AppStore;
  readonly sessionToken: string;
  readonly server: Server;
  readonly secretStore: SecretStore;
  readonly textModel: TextModelPort;
  private readonly webRoot: string;

  constructor(options: ApplicationOptions = {}) {
    this.store = new AppStore(options.dataRoot ? { dataRoot: options.dataRoot } : {});
    this.secretStore = options.secretStore ?? new WindowsDpapiSecretStore(this.store.paths.secretDir);
    this.textModel = options.textModel ?? new DeepSeekTextModel({ apiKey: () => this.secretStore.read("deepseek_api_key") });
    this.sessionToken = options.sessionToken ?? randomBytes(32).toString("base64url");
    this.webRoot = options.webRoot ?? path.resolve("dist/web");
    this.server = createServer((request, response) => void this.handle(request, response));
  }

  async listen(port = 4310): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        this.server.off("error", reject);
        const address = this.server.address();
        resolve(typeof address === "object" && address ? address.port : port);
      });
    });
  }

  async close(): Promise<void> {
    if (this.server.listening) await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    this.store.close();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const correlationId = randomUUID();
    try {
      assertLoopbackHost(request);
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (request.method === "GET" && url.pathname === "/api/session") {
        issueSessionCookie(response, this.sessionToken);
        json(response, 200, { status: "ready" }, correlationId);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        assertSession(request, this.sessionToken);
        assertOrigin(request);
        await this.routeApi(request, response, url, correlationId);
        return;
      }
      issueSessionCookie(response, this.sessionToken);
      if (!serveStatic(this.webRoot, url.pathname, response)) throw new StoreError("NOT_FOUND", "页面不存在", 404);
    } catch (error) {
      if (!response.headersSent) errorResponse(response, error, correlationId);
      else if (!response.writableEnded) {
        writeEvent(response, "error", { code: (error as { code?: string }).code ?? "GENERATION_FAILED", message: error instanceof Error ? error.message : "生成失败" });
        response.end();
      }
    }
  }

  private async routeApi(request: IncomingMessage, response: ServerResponse, url: URL, correlationId: string): Promise<void> {
    const pathname = url.pathname;
    if (request.method === "GET" && pathname === "/api/health") {
      json(response, 200, { status: "ok", service: "漫剧笔搭子" }, correlationId);
      return;
    }
    if (request.method === "GET" && pathname === "/api/projects") {
      json(response, 200, this.store.listProjects(), correlationId);
      return;
    }
    if (request.method === "POST" && pathname === "/api/projects") {
      json(response, 201, this.store.createProject(await readJson(request, projectCreateSchema)), correlationId);
      return;
    }
    if (pathname === "/api/settings" && request.method === "GET") {
      const key = await this.secretStore.read("deepseek_api_key");
      json(response, 200, { ...this.store.getSettings(), apiKeyConfigured: Boolean(key), apiKeyTail: key ? key.slice(-4) : null }, correlationId);
      return;
    }
    if (pathname === "/api/settings" && request.method === "PUT") {
      this.store.saveSettings(await readJson(request, settingsSaveSchema));
      json(response, 200, { saved: true }, correlationId);
      return;
    }
    if (pathname === "/api/settings/api-key" && request.method === "PUT") {
      const value = await readJson(request, apiKeySaveSchema);
      await this.secretStore.set("deepseek_api_key", value.apiKey);
      json(response, 200, { configured: true, tail: value.apiKey.slice(-4) }, correlationId);
      return;
    }
    if (pathname === "/api/settings/api-key" && request.method === "DELETE") {
      await this.secretStore.delete("deepseek_api_key");
      json(response, 200, { configured: false }, correlationId);
      return;
    }
    if (pathname === "/api/settings/connection" && request.method === "POST") {
      json(response, 200, await this.textModel.validateConfiguration(), correlationId);
      return;
    }

    let route = match(pathname, /^\/api\/projects\/([0-9a-f-]{36})$/i);
    if (route && request.method === "GET") {
      const projectId = route[1]!;
      json(response, 200, { ...this.store.getWorkspace(projectId), shots: this.store.listShots(projectId) }, correlationId);
      return;
    }
    if (route && request.method === "PUT") {
      json(response, 200, this.store.renameProject(route[1]!, (await readJson(request, projectRenameSchema)).name), correlationId);
      return;
    }
    if (route && request.method === "DELETE") {
      this.store.deleteProject(route[1]!);
      json(response, 200, { deleted: true }, correlationId);
      return;
    }

    route = match(pathname, /^\/api\/projects\/([0-9a-f-]{36})\/messages$/i);
    if (route && request.method === "POST") {
      const value = await readJson(request, messageCreateSchema);
      this.store.appendMessage(route[1]!, { role: "user", content: value.content });
      json(response, 201, this.store.getWorkspace(route[1]!).messages.at(-1), correlationId);
      return;
    }

    route = match(pathname, /^\/api\/projects\/([0-9a-f-]{36})\/stages\/([a-z_]+)$/i);
    if (route && request.method === "PUT") {
      const stage = editableStageSchema.parse(route[2]);
      const value = await readJson(request, stageSaveSchema);
      if (stage === "storyboard" && !value.shots) throw new StoreError("STORYBOARD_SHOTS_REQUIRED", "请按镜头格式填写分镜内容", 400);
      json(response, 200, { ...this.store.saveStage(route[1]!, stage, value.content, value.shots), shots: this.store.listShots(route[1]!) }, correlationId);
      return;
    }
    route = match(pathname, /^\/api\/projects\/([0-9a-f-]{36})\/stages\/([a-z_]+)\/(confirm|reopen)$/i);
    if (route && request.method === "POST") {
      const stage = editableStageSchema.parse(route[2]);
      const workspace = route[3] === "confirm" ? this.store.confirmStage(route[1]!, stage) : this.store.reopenStage(route[1]!, stage);
      json(response, 200, { ...workspace, shots: this.store.listShots(route[1]!) }, correlationId);
      return;
    }

    route = match(pathname, /^\/api\/projects\/([0-9a-f-]{36})\/shots$/i);
    if (route && request.method === "GET") {
      json(response, 200, this.store.latestPromptVersions(route[1]!), correlationId);
      return;
    }
    route = match(pathname, /^\/api\/projects\/([0-9a-f-]{36})\/shots\/([0-9a-f-]{36})\/prompts$/i);
    if (route && request.method === "GET") {
      json(response, 200, this.store.listPromptVersions(route[1]!, route[2]!), correlationId);
      return;
    }
    if (route && request.method === "POST") {
      json(response, 201, this.store.appendPromptVersion(route[1]!, route[2]!, await readJson(request, promptSaveSchema)), correlationId);
      return;
    }
    route = match(pathname, /^\/api\/projects\/([0-9a-f-]{36})\/shots\/([0-9a-f-]{36})\/prompts\/compare$/i);
    if (route && request.method === "POST") {
      const value = await readJson(request, promptCompareSchema);
      json(response, 200, this.store.comparePromptVersions(route[1]!, route[2]!, value.beforeId, value.afterId), correlationId);
      return;
    }
    route = match(pathname, /^\/api\/projects\/([0-9a-f-]{36})\/shots\/([0-9a-f-]{36})\/prompts\/restore$/i);
    if (route && request.method === "POST") {
      const value = await readJson(request, promptRestoreSchema);
      json(response, 201, this.store.restorePromptVersion(route[1]!, route[2]!, value.versionId, value.reason), correlationId);
      return;
    }
    route = match(pathname, /^\/api\/projects\/([0-9a-f-]{36})\/export$/i);
    if (route && request.method === "GET") {
      const format = promptFormatSchema.parse(url.searchParams.get("format"));
      const project = this.store.getProject(route[1]!);
      const shots = this.store.latestPromptVersions(route[1]!).filter((shot) => shot.prompt).map((shot) => ({ ...shot, bundle: shot.prompt!.bundle }));
      if (shots.length === 0) throw new StoreError("NO_PROMPTS", "还没有可导出的提示词", 409);
      const zip = createPromptZip(project.name, format, shots);
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/zip");
      response.setHeader("Content-Disposition", `attachment; filename="prompt-export-${format}.zip"`);
      response.end(Buffer.from(zip));
      return;
    }

    route = match(pathname, /^\/api\/projects\/([0-9a-f-]{36})\/generate\/conversation$/i);
    if (route && request.method === "POST") {
      const value = await readJson(request, messageCreateSchema);
      this.store.appendMessage(route[1]!, { role: "user", content: value.content });
      await this.streamConversation(response, route[1]!);
      return;
    }
    route = match(pathname, /^\/api\/projects\/([0-9a-f-]{36})\/generate\/stage$/i);
    if (route && request.method === "POST") {
      const value = await readJson(request, generationSchema);
      await this.streamGeneration(response, route[1]!, value.stage, value.instruction);
      return;
    }
    route = match(pathname, /^\/api\/projects\/([0-9a-f-]{36})\/generate\/prompts$/i);
    if (route && request.method === "POST") {
      const value = await readJson(request, promptGenerationSchema);
      await this.streamPromptBatch(response, route[1]!, value.shotIds, value.instruction);
      return;
    }

    throw new StoreError("NOT_FOUND", "接口不存在", 404);
  }

  private async streamConversation(response: ServerResponse, projectId: string): Promise<void> {
    const workspace = this.store.getWorkspace(projectId);
    const settings = this.store.getSettings();
    const controller = new AbortController();
    response.once("close", () => controller.abort());
    sse(response);
    writeEvent(response, "status", { message: "正在结合此前对话整理…" });
    let output = "";
    for await (const event of this.textModel.generate({
      model: settings.model,
      system: [
        "你是漫剧创作搭档，正在完成一句创意阶段的逐项访谈。",
        "必须结合完整对话历史，尊重用户已经给出的事实与选择，不得重复询问已回答的问题，也不得用项目标题推翻用户正文。",
        "每次最多补问一个会实质影响创作简报的关键问题。可由后续故事、剧本或分镜阶段决定的细节，不要继续追问。",
        "信息足够时立即结束访谈并生成完整创作简报，不要再附加问题。",
        "只输出一个 JSON 对象，不要使用 Markdown 代码围栏。信息不足时输出 {\"action\":\"ask\",\"message\":\"一个明确问题\"}；信息足够时输出 {\"action\":\"brief\",\"message\":\"告知用户简报已就绪\",\"content\":\"可直接编辑的完整中文创作简报\"}。"
      ].join("\n"),
      prompt: `项目：${workspace.project.name}\n类型：${workspace.project.productionType}\n时长：${workspace.project.targetDurationSeconds}秒\n画幅：${workspace.project.aspectRatio}\n\n完整对话历史：\n${conversationHistory(workspace)}`
    }, controller.signal)) if (event.type === "completed") output = event.text;
    const decision = parseConversationDecision(output);
    this.store.appendMessage(projectId, { role: "assistant", content: decision.message });
    if (decision.action === "brief") {
      this.store.beginBrief(projectId);
      writeEvent(response, "stage_draft", { stage: "brief", content: decision.content });
    }
    writeEvent(response, "delta", { text: decision.message });
    writeEvent(response, "completed", { text: decision.message, action: decision.action });
    response.end();
  }

  private async streamGeneration(response: ServerResponse, projectId: string, stage: string, instruction: string): Promise<void> {
    const workspace = this.store.getWorkspace(projectId);
    const context = confirmedDocuments(workspace);
    const settings = this.store.getSettings();
    const controller = new AbortController();
    response.once("close", () => controller.abort());
    sse(response);
    let completed = "";
    const stageInstructions: Record<string, string> = {
      brief: "brief 创作简报：归纳主题、受众、风格、时长、画幅、核心冲突与结局方向，不补造用户尚未决定的关键设定。",
      story: "story 故事：按已确认简报写完整、紧凑且适配目标时长的叙事，包含清楚的开端、转折和结尾。",
      script: "script 剧本：按场景组织动作、对白和节奏，内容必须能继续拆成分镜。",
      assets: "assets 设定：分别列出角色、场景和关键道具；区分固定特征与镜头内可变状态，确保连续性。",
      storyboard: "storyboard 分镜：每个镜头单独一行，严格使用“镜头 1：标题｜画面摘要”格式；摘要包含景别、主体动作、场景状态和连续性要点。",
      prompts: "prompts 提示词：按镜头生成中文提示词。"
    };
    for await (const event of this.textModel.generate({
      model: settings.model,
      system: `你是漫剧创作搭档。${stageInstructions[stage] ?? `生成 ${stage} 阶段内容。`}使用中文，内容要可直接编辑。必须尊重完整对话历史与已确认内容，不得擅自改写用户已经确定的事实。`,
      prompt: `项目：${workspace.project.name}\n类型：${workspace.project.productionType}\n时长：${workspace.project.targetDurationSeconds}秒\n画幅：${workspace.project.aspectRatio}\n完整对话历史：\n${conversationHistory(workspace) || "暂无"}\n\n已确认内容：\n${context || "暂无"}\n\n本次要求：${instruction || "生成当前阶段完整草稿"}`
    }, controller.signal)) {
      if (event.type === "delta") writeEvent(response, "delta", { text: event.text });
      else completed = event.text;
    }
    writeEvent(response, "completed", { text: completed });
    response.end();
  }

  private async streamPromptBatch(response: ServerResponse, projectId: string, shotIds: string[] | undefined, instruction: string): Promise<void> {
    const workspace = this.store.getWorkspace(projectId);
    const context = confirmedDocuments(workspace);
    const requested = shotIds ? new Set(shotIds) : null;
    const shots = this.store.listShots(projectId).filter((shot) => !requested || requested.has(shot.id));
    if (shots.length === 0) throw new StoreError("NO_SHOTS", "请先保存分镜镜头", 409);
    const settings = this.store.getSettings();
    const currentPrompts = new Map(this.store.latestPromptVersions(projectId).map((shot) => [shot.id, shot.prompt?.bundle]));
    const controller = new AbortController();
    response.once("close", () => controller.abort());
    sse(response);
    writeEvent(response, "progress", { total: shots.length, completed: 0, failed: 0 });
    let completed = 0;
    let failed = 0;
    for (const shot of shots) {
      try {
        let output = "";
        for await (const event of this.textModel.generate({
          model: settings.model,
          system: "你是 AI 漫剧提示词专家。只输出 JSON，字段为 seedreamPositive、seedreamNegative、seedreamParameters、minimaxPositive、minimaxNegative、minimaxParameters、continuityNotes。Seedream 内容描述首帧，MiniMax 内容描述从首帧开始的动作、运镜与时长；全部使用中文。",
          prompt: `项目画幅 ${workspace.project.aspectRatio}，镜头 ${shot.sequence}《${shot.title}》：${shot.summary}\n完整对话历史：\n${conversationHistory(workspace) || "暂无"}\n\n已确认创作上下文：\n${context}\n当前版本：${JSON.stringify(currentPrompts.get(shot.id) ?? null)}\n修改要求：${instruction || "生成完整提示词"}`
        }, controller.signal)) if (event.type === "completed") output = event.text;
        const parsed = promptBundleSchema.parse(JSON.parse(output.replace(/^```json\s*|\s*```$/g, "")));
        completed += 1;
        writeEvent(response, "shot", { shotId: shot.id, status: "completed", bundle: parsed });
      } catch (error) {
        failed += 1;
        writeEvent(response, "shot", { shotId: shot.id, status: "failed", message: error instanceof Error ? error.message : "生成失败" });
      }
      writeEvent(response, "progress", { total: shots.length, completed, failed });
    }
    writeEvent(response, "completed", { total: shots.length, completed, failed });
    response.end();
  }
}
