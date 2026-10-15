import { z } from "zod";

export const stageSchema = z.enum(["idea", "brief", "story", "script", "assets", "storyboard", "prompts"]);
export const editableStageSchema = z.enum(["brief", "story", "script", "assets", "storyboard", "prompts"]);
export const productionTypeSchema = z.enum(["anime", "live_action"]);
export const aspectRatioSchema = z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]);
export const promptFormatSchema = z.enum(["md", "txt"]);
export const modelSchema = z.enum(["deepseek-flash", "deepseek-v4-pro"]);

export const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  productionType: productionTypeSchema,
  targetDurationSeconds: z.number().int().min(5).max(3600),
  aspectRatio: aspectRatioSchema
});
export const projectRenameSchema = z.object({ name: z.string().trim().min(1).max(80) });
export const messageCreateSchema = z.object({ content: z.string().trim().min(1).max(30_000) });
export const stageSaveSchema = z.object({
  content: z.string().min(1).max(500_000),
  shots: z.array(z.object({ sequence: z.number().int().positive(), title: z.string().trim().min(1).max(120), summary: z.string().trim().min(1).max(2_000) })).max(500).optional()
});
export const generationSchema = z.object({
  stage: editableStageSchema,
  instruction: z.string().trim().max(10_000).default("")
});
export const promptGenerationSchema = z.object({
  shotIds: z.array(z.string().uuid()).max(500).optional(),
  instruction: z.string().trim().max(10_000).default("")
});
export const promptBundleSchema = z.object({
  seedreamPositive: z.string().trim().min(1),
  seedreamNegative: z.string().trim().min(1),
  seedreamParameters: z.string().trim().min(1),
  minimaxPositive: z.string().trim().min(1),
  minimaxNegative: z.string().trim().min(1),
  minimaxParameters: z.string().trim().min(1),
  continuityNotes: z.string().trim().min(1)
});
export const promptSaveSchema = promptBundleSchema.extend({
  reason: z.string().trim().min(1).max(300),
  provider: z.string().trim().min(1).max(80).default("deepseek"),
  model: z.string().trim().min(1).max(120)
});
export const promptCompareSchema = z.object({ beforeId: z.string().uuid(), afterId: z.string().uuid() });
export const promptRestoreSchema = z.object({ versionId: z.string().uuid(), reason: z.string().trim().min(1).max(300) });
export const settingsSaveSchema = z.object({ provider: z.literal("deepseek"), model: modelSchema });
export const apiKeySaveSchema = z.object({ apiKey: z.string().trim().min(8).max(500) });

export type WorkStage = z.infer<typeof stageSchema>;
export type EditableStage = z.infer<typeof editableStageSchema>;
export type PromptExportFormat = z.infer<typeof promptFormatSchema>;
export type PromptBundleDto = z.infer<typeof promptBundleSchema>;

export interface ProjectDto {
  id: string;
  name: string;
  productionType: "anime" | "live_action";
  targetDurationSeconds: number;
  aspectRatio: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  currentStage: WorkStage;
  createdAt: string;
  updatedAt: string;
}
export interface ShotDto { id: string; sequence: number; title: string; summary: string; promptStatus: "waiting" | "saved" | "confirmed" | "stale" }
export interface PromptVersionDto { id: string; versionNumber: number; reason: string; provider: string; model: string; bundle: PromptBundleDto; createdAt: string }
export interface WorkspaceDto {
  project: ProjectDto;
  messages: Array<{ id: string; role: "user" | "assistant" | "system"; content: string; createdAt: string }>;
  stages: Array<{ stage: WorkStage; status: "not_started" | "in_progress" | "saved" | "confirmed" | "stale"; content: string; savedAt: string | null; confirmedAt: string | null }>;
  shots: ShotDto[];
}
export interface SettingsDto { provider: "deepseek"; model: "deepseek-flash" | "deepseek-v4-pro"; apiKeyConfigured: boolean; apiKeyTail: string | null }
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; correlationId: string };
}
