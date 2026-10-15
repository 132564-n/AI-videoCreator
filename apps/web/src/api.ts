import type { ProjectDto, PromptBundleDto, PromptVersionDto, SettingsDto, WorkspaceDto, WorkStage } from "../../../packages/contracts/src/index";

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
  }
}

let sessionPromise: Promise<void> | null = null;
async function ensureSession(): Promise<void> {
  sessionPromise ??= fetch("/api/session", { credentials: "same-origin", cache: "no-store" }).then((response) => {
    if (!response.ok) throw new Error("无法建立本机会话");
  });
  return sessionPromise;
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  await ensureSession();
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string; details?: unknown } } | null;
    throw new ApiError(body?.error?.code ?? "REQUEST_FAILED", body?.error?.message ?? "操作失败", body?.error?.details);
  }
  return response.json() as Promise<T>;
}

export const apiClient = {
  projects: () => api<ProjectDto[]>("/api/projects"),
  workspace: (id: string) => api<WorkspaceDto>(`/api/projects/${id}`),
  createProject: (value: { name: string; productionType: "anime" | "live_action"; targetDurationSeconds: number; aspectRatio: ProjectDto["aspectRatio"] }) =>
    api<ProjectDto>("/api/projects", { method: "POST", body: JSON.stringify(value) }),
  deleteProject: (id: string) => api<{ deleted: boolean }>(`/api/projects/${id}`, { method: "DELETE", body: "{}" }),
  saveStage: (id: string, stage: Exclude<WorkStage, "idea">, content: string, shots?: Array<{ sequence: number; title: string; summary: string }>) =>
    api<WorkspaceDto>(`/api/projects/${id}/stages/${stage}`, { method: "PUT", body: JSON.stringify({ content, ...(shots ? { shots } : {}) }) }),
  stageAction: (id: string, stage: Exclude<WorkStage, "idea">, action: "confirm" | "reopen") =>
    api<WorkspaceDto>(`/api/projects/${id}/stages/${stage}/${action}`, { method: "POST", body: "{}" }),
  shots: (id: string) => api<Array<WorkspaceDto["shots"][number] & { prompt: PromptVersionDto | null }>>(`/api/projects/${id}/shots`),
  promptVersions: (id: string, shotId: string) => api<PromptVersionDto[]>(`/api/projects/${id}/shots/${shotId}/prompts`),
  savePrompt: (id: string, shotId: string, bundle: PromptBundleDto, reason: string, model: string) => api<PromptVersionDto>(`/api/projects/${id}/shots/${shotId}/prompts`, { method: "POST", body: JSON.stringify({ ...bundle, reason, provider: "deepseek", model }) }),
  comparePrompts: (id: string, shotId: string, beforeId: string, afterId: string) => api<Array<{ kind: "unchanged" | "added" | "removed"; text: string }>>(`/api/projects/${id}/shots/${shotId}/prompts/compare`, { method: "POST", body: JSON.stringify({ beforeId, afterId }) }),
  restorePrompt: (id: string, shotId: string, versionId: string) => api<PromptVersionDto>(`/api/projects/${id}/shots/${shotId}/prompts/restore`, { method: "POST", body: JSON.stringify({ versionId, reason: "恢复历史版本" }) }),
  settings: () => api<SettingsDto>("/api/settings"),
  saveSettings: (provider: "deepseek", model: SettingsDto["model"]) => api<{ saved: boolean }>("/api/settings", { method: "PUT", body: JSON.stringify({ provider, model }) }),
  saveApiKey: (apiKey: string) => api<{ configured: boolean; tail: string }>("/api/settings/api-key", { method: "PUT", body: JSON.stringify({ apiKey }) }),
  clearApiKey: () => api<{ configured: boolean }>("/api/settings/api-key", { method: "DELETE", body: "{}" }),
  checkConnection: () => api<{ ok: boolean; message: string; models: string[] }>("/api/settings/connection", { method: "POST", body: "{}" })
};

export interface StreamEvent { event: string; data: unknown }

export async function streamApi(url: string, body: unknown, signal: AbortSignal, onEvent: (event: StreamEvent) => void): Promise<void> {
  await ensureSession();
  const response = await fetch(url, { method: "POST", credentials: "same-origin", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    const value = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(value?.error?.code ?? "GENERATION_FAILED", value?.error?.message ?? "生成失败");
  }
  if (!response.body) throw new ApiError("EMPTY_STREAM", "没有收到生成内容");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const frames = pending.split(/\r?\n\r?\n/);
    pending = frames.pop() ?? "";
    for (const frame of frames) {
      let event = "message";
      let data = "";
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) onEvent({ event, data: JSON.parse(data) });
    }
    if (done) break;
  }
}

export async function downloadPrompts(projectId: string, format: "md" | "txt"): Promise<void> {
  await ensureSession();
  const response = await fetch(`/api/projects/${projectId}/export?format=${format}`, { credentials: "same-origin" });
  if (!response.ok) throw new ApiError("EXPORT_FAILED", "导出失败");
  const href = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = href;
  link.download = `漫剧提示词-${format}.zip`;
  link.click();
  URL.revokeObjectURL(href);
}
