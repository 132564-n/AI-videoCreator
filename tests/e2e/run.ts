import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { LocalApplication } from "../../apps/server/src/app.js";
import type { ModelEvent, ModelGenerationRequest, ModelStatus, TextModelPort } from "../../packages/domain/src/text-model.js";
import { InMemorySecretStore } from "../../packages/storage/src/secret-store.js";

class StoryModel implements TextModelPort {
  async validateConfiguration(): Promise<ModelStatus> { return { ok: true, message: "假模型连接正常", models: ["deepseek-flash"] }; }
  async *generate(request: ModelGenerationRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    if (signal?.aborted) throw new DOMException("已停止", "AbortError");
    let text = "";
    if (request.system.includes("只输出一个 JSON 对象")) {
      text = request.prompt.includes("温柔和解")
        ? JSON.stringify({ action: "brief", message: "信息已经足够，我整理好了创作简报。", content: "一部六十秒竖屏动漫短片，讲述雨夜车站里两位旧友的克制重逢。结局采用温柔和解。" })
        : JSON.stringify({ action: "ask", message: "这个雨夜重逢，是温柔和解还是遗憾错过？" });
    }
    else if (request.system.includes("brief")) text = "一部六十秒竖屏动漫短片，讲述雨夜车站里两位旧友的克制重逢。";
    else if (request.system.includes("storyboard")) text = "镜头 1：雨夜车站｜林夏撑伞站在末班车站，蓝围巾被风吹起\n镜头 2：隔雨重逢｜周屿穿过雨幕停在林夏面前，两人安静对视";
    else if (request.system.includes("story")) text = "末班车将至，林夏在雨夜站台遇见十年未见的周屿。两人没有追问过去，只把那条蓝围巾重新系好。";
    else if (request.system.includes("script")) text = "场景：雨夜车站。林夏望向站牌。周屿走近：你还是会等最后一班。林夏：这次不是等车。";
    else if (request.system.includes("assets")) text = "角色：林夏，蓝色围巾，湿发；周屿，深灰风衣。场景：旧式公交站，冷蓝雨夜。道具：透明雨伞。";
    else text = JSON.stringify({ seedreamPositive: "雨夜旧车站，人物电影感中景，冷蓝色调", seedreamNegative: "畸形手指，模糊面孔", seedreamParameters: "9:16，电影光影，高细节", minimaxPositive: "镜头缓慢推进，人物在雨中抬眼，围巾随风摆动", minimaxNegative: "画面闪烁，人物漂移", minimaxParameters: "6秒，24fps，稳定运镜", continuityNotes: "保持蓝色围巾、湿发与冷蓝雨夜光线" });
    const midpoint = Math.max(1, Math.floor(text.length / 2));
    yield { type: "delta", text: text.slice(0, midpoint) };
    yield { type: "delta", text: text.slice(midpoint) };
    yield { type: "completed", text };
  }
}

const chromeCandidates = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"];
const chromePath = chromeCandidates.find(existsSync);
if (!chromePath) throw new Error("未找到已安装的 Google Chrome");

const dataRoot = mkdtempSync(path.join(tmpdir(), "ai-video-e2e-"));
const outputDir = path.resolve("test-results/e2e");
mkdirSync(outputDir, { recursive: true });
const application = new LocalApplication({ dataRoot, webRoot: path.resolve("dist/web"), textModel: new StoryModel(), secretStore: new InMemorySecretStore() });
const port = await application.listen(0);
const browser = await chromium.launch({ executablePath: chromePath, headless: true });

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, bypassCSP: true });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "domcontentloaded" });
  if ((await page.title()) !== "漫剧笔搭子 · 从创意到提示词") throw new Error("页面标题不匹配");

  await page.getByRole("button", { name: "新建项目" }).first().click({ force: true });
  await page.getByLabel("项目名称").fill("雨夜末班车");
  await page.getByLabel("目标时长（秒）").fill("60");
  await page.getByLabel("画面尺寸").selectOption("9:16");
  await page.getByRole("button", { name: "开始创作" }).click();
  await page.getByRole("heading", { name: "雨夜末班车" }).waitFor();

  await page.getByLabel("创意对话输入").fill("两个多年未见的人在雨夜末班车站重逢");
  await page.getByRole("button", { name: "发送" }).click();
  await page.getByText("这个雨夜重逢，是温柔和解还是遗憾错过？").first().waitFor();

  await page.getByLabel("创意对话输入").fill("温柔和解");
  await page.getByRole("button", { name: "发送" }).click();
  const briefEditor = page.getByLabel("创作简报内容");
  await briefEditor.waitFor();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "确认此阶段" }).click();

  for (const stage of ["故事", "剧本", "设定", "分镜"]) {
    await page.getByTestId("stage-frame").filter({ hasText: stage }).click();
    await page.getByRole("button", { name: "用 DeepSeek 生成草稿" }).click();
    const editor = page.getByLabel(`${stage}内容`);
    await editor.waitFor();
    await page.waitForFunction((name) => {
      const element = document.querySelector(`textarea[aria-label="${name}内容"]`) as HTMLTextAreaElement | null;
      return Boolean(element?.value.trim());
    }, stage);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("button", { name: "确认此阶段" }).click();
  }

  await page.getByRole("button", { name: "生成全部镜头" }).click();
  await page.getByText(/2 \/ 2/).waitFor();
  await page.getByRole("button", { name: "保存全部生成结果" }).click();
  await page.getByText("全部镜头提示词已保存").waitFor();
  await page.getByRole("button", { name: "确认全部提示词" }).click();
  await page.getByRole("button", { name: "重新编辑提示词" }).click();

  await page.getByRole("button", { name: /雨夜车站/ }).click();
  await page.getByLabel("正向提示词").fill("雨夜旧车站，林夏戴蓝围巾，电影感中景，冷蓝色调");
  await page.getByRole("button", { name: "保存为新版本" }).click();
  await page.getByRole("button", { name: "关闭编辑器" }).click();
  await page.getByRole("button", { name: /雨夜车站/ }).click();
  await page.getByRole("button", { name: "查看差异" }).click();
  await page.locator(".diff-added").first().waitFor();
  await page.getByRole("button", { name: "关闭编辑器" }).click();
  await page.getByRole("button", { name: "确认全部提示词" }).click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Markdown ZIP" }).click();
  const download = await downloadPromise;
  if (!(await download.suggestedFilename()).endsWith(".zip")) throw new Error("导出文件不是 ZIP");

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: path.join(outputDir, "creation-workspace-1440.png") });
  const axeSource = readFileSync(path.resolve("node_modules/axe-core/axe.min.js"), "utf8");
  await page.addScriptTag({ content: axeSource });
  const accessibility = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (context: Document) => Promise<{ violations: Array<{ id: string; impact: string | null; help: string }> }> } }).axe;
    return axe.run(document);
  });
  const serious = accessibility.violations.filter((item) => item.impact === "serious" || item.impact === "critical");
  if (serious.length) throw new Error(`无障碍检查失败：${JSON.stringify(serious)}`);

  process.stdout.write(JSON.stringify({
    browser: "Chrome",
    viewport: "1440x1000",
    completeFlow: "project → conversation → five documents → two prompt shots",
    promptVersionDiff: "passed",
    markdownZip: "passed",
    seriousAccessibilityViolations: serious.length,
    screenshot: path.join(outputDir, "creation-workspace-1440.png")
  }, null, 2));
  await context.close();
} finally {
  await browser.close();
  await application.close();
  rmSync(dataRoot, { recursive: true, force: true });
}
