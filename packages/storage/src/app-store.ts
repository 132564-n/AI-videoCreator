import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { resolveManagedPaths, type ManagedPaths } from "./paths.js";
import { SCHEMA_SQL } from "./schema.js";

export const STAGES = ["idea", "brief", "story", "script", "assets", "storyboard", "prompts"] as const;
export type WorkStage = typeof STAGES[number];
export type StageStatus = "not_started" | "in_progress" | "saved" | "confirmed" | "stale";
export type ProductionType = "anime" | "live_action";
export type AspectRatio = "16:9" | "9:16" | "1:1" | "4:3" | "3:4";

export interface ProjectInput {
  name: string;
  productionType: ProductionType;
  targetDurationSeconds: number;
  aspectRatio: AspectRatio;
}

export interface ProjectRecord extends ProjectInput {
  id: string;
  currentStage: WorkStage;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSnapshot {
  project: ProjectRecord;
  messages: Array<{ id: string; role: "user" | "assistant" | "system"; content: string; createdAt: string }>;
  stages: Array<{ stage: WorkStage; status: StageStatus; content: string; savedAt: string | null; confirmedAt: string | null }>;
}

export interface StoreOptions {
  dataRoot?: string;
  now?: () => Date;
}

export interface ShotRecord {
  id: string;
  sequence: number;
  title: string;
  summary: string;
  promptStatus: "waiting" | "saved" | "confirmed" | "stale";
}

export interface PromptBundle {
  seedreamPositive: string;
  seedreamNegative: string;
  seedreamParameters: string;
  minimaxPositive: string;
  minimaxNegative: string;
  minimaxParameters: string;
  continuityNotes: string;
}

export interface PromptVersionRecord {
  id: string;
  versionNumber: number;
  reason: string;
  provider: string;
  model: string;
  bundle: PromptBundle;
  createdAt: string;
}

export interface PromptVersionInput extends PromptBundle {
  reason: string;
  provider: string;
  model: string;
}

export interface DiffLine {
  kind: "unchanged" | "added" | "removed";
  text: string;
}

export class StoreError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400, public readonly details?: unknown) {
    super(message);
  }
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function formatPromptBundle(bundle: PromptBundle): string {
  return [
    "# Seedream 首帧",
    bundle.seedreamPositive,
    "## Seedream 负面提示词",
    bundle.seedreamNegative,
    "## Seedream 建议参数",
    bundle.seedreamParameters,
    "# MiniMax 视频",
    bundle.minimaxPositive,
    "## MiniMax 负面提示词",
    bundle.minimaxNegative,
    "## MiniMax 建议参数",
    bundle.minimaxParameters,
    "# 连续性说明",
    bundle.continuityNotes
  ].join("\n");
}

function lineDiff(before: string, after: string): DiffLine[] {
  const left = before.split("\n");
  const right = after.split("\n");
  const table = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] = left[i] === right[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      result.push({ kind: "unchanged", text: left[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      result.push({ kind: "removed", text: left[i]! });
      i += 1;
    } else {
      result.push({ kind: "added", text: right[j]! });
      j += 1;
    }
  }
  while (i < left.length) result.push({ kind: "removed", text: left[i++]! });
  while (j < right.length) result.push({ kind: "added", text: right[j++]! });
  return result;
}

function mapProject(row: Record<string, unknown>): ProjectRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    productionType: row.production_type as ProductionType,
    targetDurationSeconds: Number(row.target_duration_seconds),
    aspectRatio: row.aspect_ratio as AspectRatio,
    currentStage: row.current_stage as WorkStage,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export class AppStore {
  readonly paths: ManagedPaths;
  private readonly db: Database.Database;
  private readonly now: () => Date;

  constructor(options: StoreOptions = {}) {
    this.paths = resolveManagedPaths(options.dataRoot);
    this.now = options.now ?? (() => new Date());
    this.db = new Database(this.paths.databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  createProject(input: ProjectInput): ProjectRecord {
    const id = randomUUID();
    const conversationId = randomUUID();
    const timestamp = this.now().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO projects
        (id, name, production_type, target_duration_seconds, aspect_ratio, current_stage, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'idea', ?, ?)`)
        .run(id, input.name.trim(), input.productionType, input.targetDurationSeconds, input.aspectRatio, timestamp, timestamp);
      this.db.prepare("INSERT INTO conversations (id, project_id, created_at) VALUES (?, ?, ?)")
        .run(conversationId, id, timestamp);
      const stageStatement = this.db.prepare(`INSERT INTO stage_documents
        (project_id, stage, status) VALUES (?, ?, ?)`);
      for (const stage of STAGES) stageStatement.run(id, stage, stage === "idea" ? "in_progress" : "not_started");
    })();
    return this.getProject(id);
  }

  listProjects(): ProjectRecord[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all() as Array<Record<string, unknown>>;
    return rows.map(mapProject);
  }

  renameProject(projectId: string, name: string): ProjectRecord {
    const timestamp = this.now().toISOString();
    const result = this.db.prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?")
      .run(name.trim(), timestamp, projectId);
    if (result.changes !== 1) throw new StoreError("PROJECT_NOT_FOUND", "项目不存在", 404);
    return this.getProject(projectId);
  }

  deleteProject(projectId: string): void {
    const result = this.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    if (result.changes !== 1) throw new StoreError("PROJECT_NOT_FOUND", "项目不存在", 404);
  }

  getWorkspace(projectId: string): WorkspaceSnapshot {
    const project = this.getProject(projectId);
    const messages = this.db.prepare(`SELECT messages.* FROM messages
      JOIN conversations ON conversations.id = messages.conversation_id
      WHERE conversations.project_id = ? ORDER BY messages.created_at, messages.rowid`).all(projectId) as Array<Record<string, unknown>>;
    const stageRows = this.db.prepare("SELECT * FROM stage_documents WHERE project_id = ?").all(projectId) as Array<Record<string, unknown>>;
    const byStage = new Map(stageRows.map((row) => [row.stage as WorkStage, row]));
    return {
      project,
      messages: messages.map((row) => ({
        id: String(row.id),
        role: row.role as "user" | "assistant" | "system",
        content: String(row.content),
        createdAt: String(row.created_at)
      })),
      stages: STAGES.map((stage) => {
        const row = byStage.get(stage);
        if (!row) throw new Error(`STAGE_NOT_FOUND:${stage}`);
        return {
          stage,
          status: row.status as StageStatus,
          content: String(row.content),
          savedAt: row.saved_at ? String(row.saved_at) : null,
          confirmedAt: row.confirmed_at ? String(row.confirmed_at) : null
        };
      })
    };
  }

  appendMessage(projectId: string, input: { role: "user" | "assistant" | "system"; content: string }): void {
    const conversation = this.db.prepare("SELECT id FROM conversations WHERE project_id = ?").get(projectId) as { id: string } | undefined;
    if (!conversation) throw Object.assign(new Error("项目不存在"), { code: "PROJECT_NOT_FOUND", status: 404 });
    const timestamp = this.now().toISOString();
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(randomUUID(), conversation.id, input.role, input.content, timestamp);
      this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(timestamp, projectId);
    })();
  }

  beginBrief(projectId: string): WorkspaceSnapshot {
    this.assertProject(projectId);
    const timestamp = this.now().toISOString();
    this.db.transaction(() => {
      const project = this.db.prepare("SELECT current_stage FROM projects WHERE id = ?").get(projectId) as { current_stage: WorkStage };
      if (project.current_stage !== "idea") return;
      this.db.prepare(`UPDATE stage_documents
        SET status = 'confirmed', confirmed_hash = ?, confirmed_at = ?
        WHERE project_id = ? AND stage = 'idea'`)
        .run(contentHash(""), timestamp, projectId);
      this.db.prepare(`UPDATE stage_documents SET status = 'in_progress'
        WHERE project_id = ? AND stage = 'brief' AND status = 'not_started'`).run(projectId);
      this.db.prepare("UPDATE projects SET current_stage = 'brief', updated_at = ? WHERE id = ?").run(timestamp, projectId);
    })();
    return this.getWorkspace(projectId);
  }

  saveStage(projectId: string, stage: Exclude<WorkStage, "idea">, content: string, shots?: Array<{ sequence: number; title: string; summary: string }>): WorkspaceSnapshot {
    this.assertProject(projectId);
    const stageIndex = STAGES.indexOf(stage);
    if (stageIndex > 1) {
      const previous = STAGES[stageIndex - 1]!;
      const row = this.db.prepare("SELECT status FROM stage_documents WHERE project_id = ? AND stage = ?")
        .get(projectId, previous) as { status: StageStatus } | undefined;
      if (row?.status !== "confirmed") throw new StoreError("PREVIOUS_STAGE_UNCONFIRMED", "请先确认上一阶段", 409);
    }
    const timestamp = this.now().toISOString();
    const result = this.db.prepare(`UPDATE stage_documents
      SET content = ?, status = 'saved', saved_at = ?, pending_shots_json = ? WHERE project_id = ? AND stage = ?`)
      .run(content, timestamp, stage === "storyboard" && shots ? JSON.stringify(shots) : null, projectId, stage);
    if (result.changes !== 1) throw new Error("STAGE_NOT_FOUND");
    this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(timestamp, projectId);
    return this.getWorkspace(projectId);
  }

  confirmStage(projectId: string, stage: Exclude<WorkStage, "idea">): WorkspaceSnapshot {
    this.assertProject(projectId);
    const timestamp = this.now().toISOString();
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT content, status, confirmed_hash, pending_shots_json FROM stage_documents WHERE project_id = ? AND stage = ?")
        .get(projectId, stage) as { content: string; status: StageStatus; confirmed_hash: string | null; pending_shots_json: string | null } | undefined;
      if (!row) throw new Error("STAGE_NOT_FOUND");
      if (row.status !== "saved") throw Object.assign(new Error("请先保存当前内容"), { code: "STAGE_NOT_SAVED", status: 409 });
      const nextHash = contentHash(row.content);
      if (row.confirmed_hash && row.confirmed_hash !== nextHash) {
        const stageIndex = STAGES.indexOf(stage);
        const downstream = STAGES.slice(stageIndex + 1);
        if (downstream.length > 0) {
          const placeholders = downstream.map(() => "?").join(", ");
          this.db.prepare(`UPDATE stage_documents SET status = 'stale'
            WHERE project_id = ? AND stage IN (${placeholders}) AND content <> ''`)
            .run(projectId, ...downstream);
        }
        if (STAGES.indexOf(stage) < STAGES.indexOf("prompts")) {
          this.db.prepare(`UPDATE shots SET prompt_status = 'stale' WHERE project_id = ?
            AND EXISTS (SELECT 1 FROM prompt_versions WHERE prompt_versions.shot_id = shots.id)`).run(projectId);
        }
      }
      if (stage === "prompts") {
        const incomplete = this.db.prepare("SELECT COUNT(*) AS value FROM shots WHERE project_id = ? AND prompt_status IN ('waiting', 'stale')")
          .get(projectId) as { value: number };
        if (incomplete.value > 0) throw new StoreError("PROMPTS_INCOMPLETE", "请先生成并保存全部镜头提示词", 409);
        this.db.prepare("UPDATE shots SET prompt_status = 'confirmed' WHERE project_id = ?").run(projectId);
      }
      if (stage === "storyboard" && row.pending_shots_json) {
        this.writeShots(projectId, JSON.parse(row.pending_shots_json) as Array<{ sequence: number; title: string; summary: string }>, timestamp);
      }
      this.db.prepare(`UPDATE stage_documents SET status = 'confirmed', confirmed_hash = ?, confirmed_at = ?, pending_shots_json = NULL
        WHERE project_id = ? AND stage = ?`).run(nextHash, timestamp, projectId, stage);
      const nextStage = STAGES[STAGES.indexOf(stage) + 1] ?? stage;
      if (nextStage !== stage) {
        this.db.prepare(`UPDATE stage_documents SET status = 'in_progress'
          WHERE project_id = ? AND stage = ? AND status = 'not_started'`).run(projectId, nextStage);
      }
      this.db.prepare("UPDATE projects SET current_stage = ?, updated_at = ? WHERE id = ?")
        .run(nextStage, timestamp, projectId);
    })();
    return this.getWorkspace(projectId);
  }

  reopenStage(projectId: string, stage: Exclude<WorkStage, "idea">): WorkspaceSnapshot {
    this.assertProject(projectId);
    const timestamp = this.now().toISOString();
    const result = this.db.prepare(`UPDATE stage_documents SET status = 'in_progress'
      WHERE project_id = ? AND stage = ? AND status IN ('confirmed', 'stale')`).run(projectId, stage);
    if (result.changes !== 1) throw Object.assign(new Error("当前阶段不能重新编辑"), { code: "STAGE_NOT_REOPENABLE", status: 409 });
    this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(timestamp, projectId);
    return this.getWorkspace(projectId);
  }

  replaceShots(projectId: string, input: Array<{ sequence: number; title: string; summary: string }>): ShotRecord[] {
    this.assertProject(projectId);
    const timestamp = this.now().toISOString();
    this.db.transaction(() => {
      this.writeShots(projectId, input, timestamp);
    })();
    return this.listShots(projectId);
  }

  listShots(projectId: string): ShotRecord[] {
    this.assertProject(projectId);
    const rows = this.db.prepare("SELECT id, sequence, title, summary, prompt_status FROM shots WHERE project_id = ? ORDER BY sequence")
      .all(projectId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: String(row.id), sequence: Number(row.sequence), title: String(row.title), summary: String(row.summary), promptStatus: row.prompt_status as ShotRecord["promptStatus"] }));
  }

  appendPromptVersion(projectId: string, shotId: string, input: PromptVersionInput): PromptVersionRecord {
    this.assertShot(projectId, shotId);
    const bundle: PromptBundle = {
      seedreamPositive: input.seedreamPositive,
      seedreamNegative: input.seedreamNegative,
      seedreamParameters: input.seedreamParameters,
      minimaxPositive: input.minimaxPositive,
      minimaxNegative: input.minimaxNegative,
      minimaxParameters: input.minimaxParameters,
      continuityNotes: input.continuityNotes
    };
    const versionNumber = Number((this.db.prepare("SELECT COALESCE(MAX(version_number), 0) AS value FROM prompt_versions WHERE shot_id = ?")
      .get(shotId) as { value: number }).value) + 1;
    const id = randomUUID();
    const timestamp = this.now().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO prompt_versions
        (id, project_id, shot_id, version_number, reason, provider, model, bundle_json, formatted_text, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, projectId, shotId, versionNumber, input.reason, input.provider, input.model, JSON.stringify(bundle), formatPromptBundle(bundle), timestamp);
      const counts = this.db.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM prompt_versions pv WHERE pv.shot_id = shots.id) THEN 1 ELSE 0 END) AS completed
        FROM shots WHERE project_id = ?`).get(projectId) as { total: number; completed: number };
      this.db.prepare(`UPDATE stage_documents SET content = ?, status = 'saved', saved_at = ?
        WHERE project_id = ? AND stage = 'prompts'`).run(`${counts.completed}/${counts.total} 个镜头已有提示词`, timestamp, projectId);
      this.db.prepare("UPDATE shots SET prompt_status = 'saved' WHERE id = ?").run(shotId);
      this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(timestamp, projectId);
    })();
    return this.getPromptVersion(projectId, shotId, id);
  }

  listPromptVersions(projectId: string, shotId: string): PromptVersionRecord[] {
    this.assertShot(projectId, shotId);
    const rows = this.db.prepare("SELECT * FROM prompt_versions WHERE project_id = ? AND shot_id = ? ORDER BY version_number")
      .all(projectId, shotId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapPromptVersion(row));
  }

  latestPromptVersions(projectId: string): Array<ShotRecord & { prompt: PromptVersionRecord | null }> {
    return this.listShots(projectId).map((shot) => {
      const row = this.db.prepare(`SELECT * FROM prompt_versions WHERE project_id = ? AND shot_id = ?
        ORDER BY version_number DESC LIMIT 1`).get(projectId, shot.id) as Record<string, unknown> | undefined;
      return { ...shot, prompt: row ? this.mapPromptVersion(row) : null };
    });
  }

  getSettings(): { provider: "deepseek"; model: "deepseek-flash" | "deepseek-v4-pro" } {
    const row = this.db.prepare("SELECT provider, model FROM app_settings WHERE singleton = 1").get() as { provider: "deepseek"; model: "deepseek-flash" | "deepseek-v4-pro" };
    return row;
  }

  saveSettings(input: { provider: "deepseek"; model: "deepseek-flash" | "deepseek-v4-pro" }): void {
    this.db.prepare("UPDATE app_settings SET provider = ?, model = ?, updated_at = ? WHERE singleton = 1")
      .run(input.provider, input.model, this.now().toISOString());
  }

  comparePromptVersions(projectId: string, shotId: string, beforeId: string, afterId: string): DiffLine[] {
    const before = this.getPromptVersionRow(projectId, shotId, beforeId);
    const after = this.getPromptVersionRow(projectId, shotId, afterId);
    return lineDiff(String(before.formatted_text), String(after.formatted_text));
  }

  restorePromptVersion(projectId: string, shotId: string, versionId: string, reason: string): PromptVersionRecord {
    const source = this.getPromptVersion(projectId, shotId, versionId);
    return this.appendPromptVersion(projectId, shotId, { ...source.bundle, reason, provider: source.provider, model: source.model });
  }

  private getPromptVersion(projectId: string, shotId: string, versionId: string): PromptVersionRecord {
    return this.mapPromptVersion(this.getPromptVersionRow(projectId, shotId, versionId));
  }

  private getPromptVersionRow(projectId: string, shotId: string, versionId: string): Record<string, unknown> {
    this.assertShot(projectId, shotId);
    const row = this.db.prepare("SELECT * FROM prompt_versions WHERE id = ? AND project_id = ? AND shot_id = ?")
      .get(versionId, projectId, shotId) as Record<string, unknown> | undefined;
    if (!row) throw Object.assign(new Error("提示词版本不存在"), { code: "PROMPT_VERSION_NOT_FOUND", status: 404 });
    return row;
  }

  private mapPromptVersion(row: Record<string, unknown>): PromptVersionRecord {
    return {
      id: String(row.id),
      versionNumber: Number(row.version_number),
      reason: String(row.reason),
      provider: String(row.provider),
      model: String(row.model),
      bundle: JSON.parse(String(row.bundle_json)) as PromptBundle,
      createdAt: String(row.created_at)
    };
  }

  private assertShot(projectId: string, shotId: string): void {
    const row = this.db.prepare("SELECT id FROM shots WHERE id = ? AND project_id = ?").get(shotId, projectId);
    if (!row) throw Object.assign(new Error("镜头不存在"), { code: "SHOT_NOT_FOUND", status: 404 });
  }

  private writeShots(projectId: string, input: Array<{ sequence: number; title: string; summary: string }>, timestamp: string): void {
    const existingRows = this.db.prepare("SELECT id, sequence FROM shots WHERE project_id = ?").all(projectId) as Array<{ id: string; sequence: number }>;
    const existing = new Map(existingRows.map((row) => [row.sequence, row.id]));
    const update = this.db.prepare("UPDATE shots SET title = ?, summary = ? WHERE id = ?");
    const insert = this.db.prepare("INSERT INTO shots (id, project_id, sequence, title, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    for (const shot of input) {
      const id = existing.get(shot.sequence);
      if (id) update.run(shot.title, shot.summary, id);
      else insert.run(randomUUID(), projectId, shot.sequence, shot.title, shot.summary, timestamp);
    }
    if (input.length === 0) this.db.prepare("DELETE FROM shots WHERE project_id = ?").run(projectId);
    else {
      const placeholders = input.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM shots WHERE project_id = ? AND sequence NOT IN (${placeholders})`)
        .run(projectId, ...input.map((shot) => shot.sequence));
    }
  }

  getProject(projectId: string): ProjectRecord {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Record<string, unknown> | undefined;
    if (!row) throw Object.assign(new Error("项目不存在"), { code: "PROJECT_NOT_FOUND", status: 404 });
    return mapProject(row);
  }

  private assertProject(projectId: string): void {
    this.getProject(projectId);
  }
}
