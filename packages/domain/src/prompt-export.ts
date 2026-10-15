import { strToU8, zipSync } from "fflate";

export type PromptExportFormat = "md" | "txt";

export interface PromptExportBundle {
  seedreamPositive: string;
  seedreamNegative: string;
  seedreamParameters: string;
  minimaxPositive: string;
  minimaxNegative: string;
  minimaxParameters: string;
  continuityNotes: string;
}

export interface PromptExportShot {
  sequence: number;
  title: string;
  bundle: PromptExportBundle;
}

function safeName(value: string): string {
  const normalized = value.normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\.+$/g, "")
    .trim();
  return (normalized || "未命名镜头").slice(0, 80);
}

function markdown(shot: PromptExportShot): string {
  const number = String(shot.sequence).padStart(2, "0");
  const value = shot.bundle;
  return [
    `# 镜头 ${number} · ${shot.title}`,
    "",
    "## Seedream 5.0 Lite 首帧图片提示词",
    value.seedreamPositive,
    "",
    "### 负面提示词",
    value.seedreamNegative,
    "",
    "### 建议参数",
    value.seedreamParameters,
    "",
    "## MiniMax H3 视频提示词",
    value.minimaxPositive,
    "",
    "### 负面提示词",
    value.minimaxNegative,
    "",
    "### 建议参数",
    value.minimaxParameters,
    "",
    "## 连续性说明",
    value.continuityNotes,
    ""
  ].join("\n");
}

function plainText(shot: PromptExportShot): string {
  const number = String(shot.sequence).padStart(2, "0");
  const value = shot.bundle;
  return [
    `镜头 ${number} · ${shot.title}`,
    "",
    "Seedream 5.0 Lite 首帧图片提示词",
    value.seedreamPositive,
    "",
    "Seedream 负面提示词",
    value.seedreamNegative,
    "",
    "Seedream 建议参数",
    value.seedreamParameters,
    "",
    "MiniMax H3 视频提示词",
    value.minimaxPositive,
    "",
    "MiniMax 负面提示词",
    value.minimaxNegative,
    "",
    "MiniMax 建议参数",
    value.minimaxParameters,
    "",
    "连续性说明",
    value.continuityNotes,
    ""
  ].join("\n");
}

export function createPromptZip(_projectName: string, format: PromptExportFormat, shots: PromptExportShot[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const shot of shots) {
    const number = String(shot.sequence).padStart(2, "0");
    const name = `${number}-${safeName(shot.title)}.${format}`;
    files[name] = strToU8(format === "md" ? markdown(shot) : plainText(shot));
  }
  return zipSync(files, { level: 6 });
}
