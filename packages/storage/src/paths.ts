import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

export interface ManagedPaths {
  root: string;
  dataDir: string;
  databasePath: string;
  evidenceDir: string;
  backupDir: string;
  exportDir: string;
  logDir: string;
  tempDir: string;
  secretDir: string;
}

export function resolveManagedPaths(explicitRoot?: string): ManagedPaths {
  const localAppData = process.env.LOCALAPPDATA;
  const base = explicitRoot ?? (localAppData ? path.join(localAppData, "AI-videoCreator") : path.resolve(".local-data"));
  const root = path.resolve(base);
  const paths: ManagedPaths = {
    root,
    dataDir: path.join(root, "data"),
    databasePath: path.join(root, "data", "creation-v2.db"),
    evidenceDir: path.join(root, "evidence"),
    backupDir: path.join(root, "backups"),
    exportDir: path.join(root, "exports"),
    logDir: path.join(root, "logs"),
    tempDir: path.join(root, "temp"),
    secretDir: path.join(root, "secrets-v2")
  };
  for (const directory of [paths.root, paths.dataDir, paths.evidenceDir, paths.backupDir, paths.exportDir, paths.logDir, paths.tempDir, paths.secretDir]) {
    mkdirSync(directory, { recursive: true });
  }
  return paths;
}

export function safeManagedPath(root: string, ...segments: string[]): string {
  const target = path.resolve(root, ...segments);
  const relative = path.relative(path.resolve(root), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("PATH_OUTSIDE_MANAGED_ROOT");
  return target;
}

export function sanitizeFileName(fileName: string): string {
  const sanitized = fileName.normalize("NFKC").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/\.+$/g, "").trim();
  return (sanitized || "evidence.bin").slice(0, 120);
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

