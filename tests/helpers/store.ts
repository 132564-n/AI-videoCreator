import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppStore } from "../../packages/storage/src/index.js";

export function createTestStore(): { store: AppStore; root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ai-video-creator-"));
  const store = new AppStore({ dataRoot: root });
  return {
    store,
    root,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

