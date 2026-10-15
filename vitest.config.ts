import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    environmentMatchGlobs: [["tests/ui/**", "jsdom"]],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: { reporter: ["text", "json-summary"] }
  }
});

