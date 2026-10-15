import { LocalApplication } from "./app.js";

const port = Number(process.env.PORT ?? 4310);
const dataRoot = process.env.AI_VIDEO_CREATOR_DATA_ROOT;
const application = new LocalApplication(dataRoot ? { dataRoot } : {});

const actualPort = await application.listen(port);
process.stdout.write(`漫剧笔搭子本地服务已启动：http://127.0.0.1:${actualPort}\n`);

async function shutdown(): Promise<void> {
  await application.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
