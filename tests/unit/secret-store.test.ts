import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../packages/storage/src/secret-store.js";

describe("密钥存储端口", () => {
  it("只通过服务端接口保存、读取和清除密钥", async () => {
    const secrets = new InMemorySecretStore();
    expect(await secrets.has("deepseek_api_key")).toBe(false);
    await secrets.set("deepseek_api_key", "sk-not-for-browser");
    expect(await secrets.has("deepseek_api_key")).toBe(true);
    expect(await secrets.read("deepseek_api_key")).toBe("sk-not-for-browser");
    await secrets.delete("deepseek_api_key");
    expect(await secrets.read("deepseek_api_key")).toBeNull();
  });
});
