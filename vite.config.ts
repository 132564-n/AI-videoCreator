import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "apps/web",
  plugins: [react()],
  resolve: {
    alias: {
      "@contracts": fileURLToPath(new URL("./packages/contracts/src", import.meta.url)),
      "@domain": fileURLToPath(new URL("./packages/domain/src", import.meta.url))
    }
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    sourcemap: true
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4310"
    }
  }
});

