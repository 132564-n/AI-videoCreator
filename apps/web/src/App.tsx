import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectDto, PromptBundleDto, PromptVersionDto, SettingsDto, ShotDto, WorkspaceDto, WorkStage } from "../../../packages/contracts/src/index";
import { ApiError, apiClient, downloadPrompts, streamApi } from "./api";

const STAGES: Array<{ id: WorkStage; label: string; caption: string }> = [
  { id: "idea", label: "一句创意", caption: "对话补问" },
  { id: "brief", label: "创作简报", caption: "方向与约束" },
  { id: "story", label: "故事", caption: "完整叙事" },
  { id: "script", label: "剧本", caption: "场景与对白" },
  { id: "assets", label: "设定", caption: "角色场景道具" },
  { id: "storyboard", label: "分镜", caption: "镜头拆解" },
  { id: "prompts", label: "提示词", caption: "逐镜生成" }
];
const LABEL = Object.fromEntries(STAGES.map((item) => [item.id, item.label])) as Record<WorkStage, string>;
const EMPTY_BUNDLE: PromptBundleDto = { seedreamPositive: "", seedreamNegative: "", seedreamParameters: "", minimaxPositive: "", minimaxNegative: "", minimaxParameters: "", continuityNotes: "" };

function formatBundle(bundle: PromptBundleDto): string {
  return `Seedream 5.0 Lite 首帧图片提示词\n${bundle.seedreamPositive}\n\n负面提示词\n${bundle.seedreamNegative}\n\n建议参数\n${bundle.seedreamParameters}\n\nMiniMax H3 视频提示词\n${bundle.minimaxPositive}\n\n负面提示词\n${bundle.minimaxNegative}\n\n建议参数\n${bundle.minimaxParameters}\n\n连续性说明\n${bundle.continuityNotes}`;
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

function parseStoryboard(content: string): Array<{ sequence: number; title: string; summary: string }> {
  return content.split("\n").flatMap((line) => {
    const matched = line.match(/^\s*镜头\s*(\d+)\s*[：:]\s*([^｜|]+)[｜|](.+)$/);
    return matched ? [{ sequence: Number(matched[1]), title: matched[2]!.trim(), summary: matched[3]!.trim() }] : [];
  });
}

function summarize(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 88 ? `${compact.slice(0, 88)}…` : compact;
}

function StatusMark({ status }: { status: WorkspaceDto["stages"][number]["status"] }) {
  const text = { not_started: "未开始", in_progress: "进行中", saved: "已保存", confirmed: "已确认", stale: "需要重新生成" }[status];
  return <span className={`status status--${status}`}>{text}</span>;
}

function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: ProjectDto) => void }) {
  const [name, setName] = useState("");
  const [productionType, setProductionType] = useState<"anime" | "live_action">("anime");
  const [duration, setDuration] = useState("60");
  const [aspectRatio, setAspectRatio] = useState<ProjectDto["aspectRatio"]>("9:16");
  const [saving, setSaving] = useState(false);
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="new-project-title">
    <div className="modal__heading"><div><span className="kicker">NEW STORY</span><h2 id="new-project-title">新建短片项目</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭">×</button></div>
    <label>项目名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：雨夜末班车" /></label>
    <div className="form-pair"><label>作品类型<select value={productionType} onChange={(event) => setProductionType(event.target.value as typeof productionType)}><option value="anime">动漫</option><option value="live_action">真人</option></select></label><label>目标时长（秒）<input type="number" min="5" value={duration} onChange={(event) => setDuration(event.target.value)} /></label></div>
    <label>画面尺寸<select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as ProjectDto["aspectRatio"])}>{["16:9", "9:16", "1:1", "4:3", "3:4"].map((ratio) => <option key={ratio}>{ratio}</option>)}</select></label>
    <div className="modal__actions"><button className="button button--ghost" onClick={onClose}>取消</button><button className="button button--primary" disabled={!name.trim() || saving} onClick={async () => { setSaving(true); try { onCreated(await apiClient.createProject({ name, productionType, targetDurationSeconds: Number(duration), aspectRatio })); } finally { setSaving(false); } }}>{saving ? "正在创建…" : "开始创作"}</button></div>
  </section></div>;
}

function SettingsPanel({ onBack, onNotice }: { onBack: () => void; onNotice: (value: string) => void }) {
  const [settings, setSettings] = useState<SettingsDto | null>(null);
  const [model, setModel] = useState<SettingsDto["model"]>("deepseek-flash");
  const [key, setKey] = useState("");
  const [checking, setChecking] = useState(false);
  useEffect(() => { void apiClient.settings().then((value) => { setSettings(value); setModel(value.model); }); }, []);
  return <main className="settings-page" id="main-content">
    <button className="back-button" onClick={onBack}>← 返回创作</button>
    <header className="settings-heading"><span className="kicker">GLOBAL SETTINGS</span><h1>模型设置</h1><p>这里的选择对所有项目生效。</p></header>
    <section className="settings-card"><h2>DeepSeek 官方 API</h2><p className="privacy-note">生成时，本机会把当前项目的完整创作对话、已确认内容和本次要求发送给 DeepSeek，以便延续上下文。项目正文和版本历史仍保存在本机，但 DeepSeek 的数据处理受其隐私政策与开放平台条款约束。</p>
      <label>全局模型<select aria-label="全局模型" value={model} onChange={(event) => setModel(event.target.value as SettingsDto["model"])}><option value="deepseek-flash">DeepSeek Flash</option><option value="deepseek-v4-pro">DeepSeek V4 Pro</option></select></label>
      <label>DeepSeek API Key<input aria-label="DeepSeek API Key" type="password" autoComplete="new-password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={settings?.apiKeyConfigured ? `已配置 ····${settings.apiKeyTail}` : "sk-..."} /><small>密钥经 Windows 当前用户加密后保存；页面不会回显完整密钥。</small></label>
      <div className="settings-actions">{settings?.apiKeyConfigured ? <button className="button button--danger-text" onClick={async () => { await apiClient.clearApiKey(); setSettings(await apiClient.settings()); onNotice("API Key 已清除"); }}>清除密钥</button> : null}<button className="button button--ghost" disabled={!settings?.apiKeyConfigured || checking} onClick={async () => { setChecking(true); try { const result = await apiClient.checkConnection(); onNotice(result.message); } finally { setChecking(false); } }}>{checking ? "正在检查…" : "检查连接"}</button><button className="button button--primary" onClick={async () => { await apiClient.saveSettings("deepseek", model); if (key.trim()) await apiClient.saveApiKey(key.trim()); setKey(""); setSettings(await apiClient.settings()); onNotice("设置已保存"); }}>保存设置</button></div>
    </section>
  </main>;
}

interface PromptShot extends ShotDto { prompt: PromptVersionDto | null }

function PromptEditor({ projectId, shot, draft, model, locked, onClose, onSaved, onDirty }: { projectId: string; shot: PromptShot; draft: PromptBundleDto | undefined; model: string; locked: boolean; onClose: () => void; onSaved: () => void; onDirty: (dirty: boolean) => void }) {
  const initial = draft ?? shot.prompt?.bundle ?? EMPTY_BUNDLE;
  const [bundle, setBundle] = useState<PromptBundleDto>(initial);
  const [reason, setReason] = useState(draft ? "批量生成" : "手工修改");
  const [versions, setVersions] = useState<PromptVersionDto[]>([]);
  const [before, setBefore] = useState("");
  const [after, setAfter] = useState("");
  const [diff, setDiff] = useState<Array<{ kind: "unchanged" | "added" | "removed"; text: string }>>([]);
  const [aiBusy, setAiBusy] = useState(false);
  useEffect(() => { void apiClient.promptVersions(projectId, shot.id).then((items) => { setVersions(items); setBefore(items[0]?.id ?? ""); setAfter(items.at(-1)?.id ?? ""); }); }, [projectId, shot.id]);
  const setField = (field: keyof PromptBundleDto, value: string) => { setBundle((current) => ({ ...current, [field]: value })); onDirty(true); };
  return <aside className="editor-dock" aria-label={`镜头 ${shot.sequence} 提示词编辑器`}><header className="editor-heading"><div><span className="kicker">SHOT {String(shot.sequence).padStart(2, "0")}</span><h2>{shot.title}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭编辑器">×</button></header>
    <div className="editor-scroll"><section className="prompt-group"><h3>Seedream 5.0 Lite · 首帧</h3><label>正向提示词<textarea readOnly={locked} value={bundle.seedreamPositive} onChange={(e) => setField("seedreamPositive", e.target.value)} /></label><label>负面提示词<textarea readOnly={locked} value={bundle.seedreamNegative} onChange={(e) => setField("seedreamNegative", e.target.value)} /></label><label>建议参数<input readOnly={locked} value={bundle.seedreamParameters} onChange={(e) => setField("seedreamParameters", e.target.value)} /></label></section>
      <section className="prompt-group"><h3>MiniMax H3 · 视频</h3><label>视频提示词<textarea readOnly={locked} value={bundle.minimaxPositive} onChange={(e) => setField("minimaxPositive", e.target.value)} /></label><label>负面提示词<textarea readOnly={locked} value={bundle.minimaxNegative} onChange={(e) => setField("minimaxNegative", e.target.value)} /></label><label>建议参数<input readOnly={locked} value={bundle.minimaxParameters} onChange={(e) => setField("minimaxParameters", e.target.value)} /></label></section>
      <label>连续性说明<textarea readOnly={locked} value={bundle.continuityNotes} onChange={(e) => setField("continuityNotes", e.target.value)} /></label><label>本次修改说明<input readOnly={locked} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="描述外部生成结果的问题或本次调整要求" /></label><div className="prompt-actions"><button className="button button--ghost" onClick={async () => { await copyText(formatBundle(bundle)); }}>复制本镜头</button><button className="button button--secondary" disabled={locked || !reason.trim() || aiBusy} onClick={async () => { setAiBusy(true); const controller = new AbortController(); let generated: PromptBundleDto | null = null; try { await streamApi(`/api/projects/${projectId}/generate/prompts`, { shotIds: [shot.id], instruction: reason }, controller.signal, ({ event, data }) => { if (event === "shot") { const item = data as { status: string; bundle?: PromptBundleDto }; if (item.status === "completed" && item.bundle) generated = item.bundle; } }); if (generated) { setBundle(generated); onDirty(true); } } finally { setAiBusy(false); } }}>{aiBusy ? "正在修改…" : "让 DeepSeek 按要求修改"}</button></div>
      {versions.length > 1 ? <section className="version-box"><h3>版本比较</h3><div className="version-selects"><select aria-label="较早版本" value={before} onChange={(e) => setBefore(e.target.value)}>{versions.map((item) => <option key={item.id} value={item.id}>v{item.versionNumber}</option>)}</select><span>→</span><select aria-label="较新版本" value={after} onChange={(e) => setAfter(e.target.value)}>{versions.map((item) => <option key={item.id} value={item.id}>v{item.versionNumber}</option>)}</select></div><button className="text-button" onClick={async () => setDiff(await apiClient.comparePrompts(projectId, shot.id, before, after))}>查看差异</button>{diff.length ? <pre className="diff-view">{diff.map((line, index) => <span key={index} className={`diff-${line.kind}`}>{line.kind === "added" ? "+ " : line.kind === "removed" ? "− " : "  "}{line.text}{"\n"}</span>)}</pre> : null}<button className="text-button" disabled={locked || !before} onClick={async () => { await apiClient.restorePrompt(projectId, shot.id, before); onSaved(); }}>恢复较早版本为新版本</button></section> : null}
    </div><footer className="editor-footer"><button className="button button--primary" disabled={locked || Object.values(bundle).some((value) => !value.trim()) || !reason.trim()} onClick={async () => { await apiClient.savePrompt(projectId, shot.id, bundle, reason, model); onDirty(false); onSaved(); }}>保存为新版本</button></footer>
  </aside>;
}

export function App() {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [settingsView, setSettingsView] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [openStage, setOpenStage] = useState<Exclude<WorkStage, "idea"> | null>(null);
  const [editorText, setEditorText] = useState("");
  const [editorDirty, setEditorDirty] = useState(false);
  const [revisionInstruction, setRevisionInstruction] = useState("");
  const [leaveTarget, setLeaveTarget] = useState<(() => void) | null>(null);
  const [conversationInput, setConversationInput] = useState("");
  const [streamText, setStreamText] = useState("");
  const [generating, setGenerating] = useState(false);
  const generationController = useRef<AbortController | null>(null);
  const [shots, setShots] = useState<PromptShot[]>([]);
  const [promptDrafts, setPromptDrafts] = useState<Record<string, PromptBundleDto>>({});
  const [promptProgress, setPromptProgress] = useState<{ total: number; completed: number; failed: number } | null>(null);
  const [promptFailures, setPromptFailures] = useState<Record<string, string>>({});
  const [selectedShot, setSelectedShot] = useState<PromptShot | null>(null);
  const [model, setModel] = useState("deepseek-flash");

  const loadWorkspace = useCallback(async (id: string) => {
    const value = await apiClient.workspace(id);
    setWorkspace(value);
    setShots(await apiClient.shots(id));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void apiClient.projects().then(async (items) => {
      if (controller.signal.aborted) return;
      setProjects(items);
      if (items[0]) await loadWorkspace(items[0].id);
    }).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "读取项目失败")).finally(() => setLoading(false));
    return () => controller.abort();
  }, [loadWorkspace]);

  useEffect(() => { void apiClient.settings().then((value) => setModel(value.model)).catch(() => undefined); }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (editorDirty) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editorDirty]);

  const activeDocument = openStage ? workspace?.stages.find((item) => item.stage === openStage) : null;
  const promptStage = workspace?.stages.find((item) => item.stage === "prompts");
  const requestNavigation = (action: () => void) => editorDirty ? setLeaveTarget(() => action) : action();
  const openDocument = (stage: Exclude<WorkStage, "idea">) => requestNavigation(() => {
    const document = workspace?.stages.find((item) => item.stage === stage);
    setOpenStage(stage); setEditorText(document?.content ?? ""); setEditorDirty(false); setRevisionInstruction(""); setSelectedShot(null);
  });
  const refresh = async () => { if (workspace) await loadWorkspace(workspace.project.id); };

  const saveDocument = async () => {
    if (!workspace || !openStage) return;
    const storyboardShots = openStage === "storyboard" ? parseStoryboard(editorText) : undefined;
    if (openStage === "storyboard" && storyboardShots?.length === 0) throw new ApiError("STORYBOARD_FORMAT", "分镜请按“镜头 1：标题｜画面摘要”逐行填写");
    const value = await apiClient.saveStage(workspace.project.id, openStage, editorText, storyboardShots);
    setWorkspace(value); setEditorDirty(false); setNotice(`${LABEL[openStage]}已保存`);
  };

  const confirmDocument = async () => {
    if (!workspace || !openStage) return;
    const value = await apiClient.stageAction(workspace.project.id, openStage, "confirm");
    setWorkspace(value);
    if (openStage === "storyboard") setShots(await apiClient.shots(workspace.project.id));
    const confirmedStage = openStage;
    const nextStage = value.project.currentStage;
    if (nextStage !== confirmedStage) {
      if (nextStage === "prompts") {
        setOpenStage(null);
      } else if (nextStage !== "idea") {
        const nextDocument = value.stages.find((item) => item.stage === nextStage);
        setOpenStage(nextStage);
        setEditorText(nextDocument?.content ?? "");
        setEditorDirty(false);
        setRevisionInstruction("");
        setSelectedShot(null);
      }
      setNotice(`${LABEL[confirmedStage]}已确认，已进入${LABEL[nextStage]}`);
    } else {
      setNotice(`${LABEL[confirmedStage]}已确认`);
    }
  };

  const startStageGeneration = async () => {
    if (!workspace || !openStage) return;
    const controller = new AbortController(); generationController.current = controller; setGenerating(true); setEditorText(""); setEditorDirty(true);
    try { await streamApi(`/api/projects/${workspace.project.id}/generate/stage`, { stage: openStage, instruction: revisionInstruction }, controller.signal, ({ event, data }) => { if (event === "delta") setEditorText((value) => value + (data as { text: string }).text); }); }
    catch (caught) { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "生成失败"); }
    finally { setGenerating(false); generationController.current = null; }
  };

  const sendConversation = async () => {
    if (!workspace || !conversationInput.trim()) return;
    const input = conversationInput.trim(); setConversationInput(""); setStreamText(""); setGenerating(true);
    const controller = new AbortController(); generationController.current = controller;
    try { await streamApi(`/api/projects/${workspace.project.id}/generate/conversation`, { content: input }, controller.signal, ({ event, data }) => {
      if (event === "status") setStreamText((data as { message: string }).message);
      if (event === "delta") setStreamText((data as { text: string }).text);
      if (event === "stage_draft") {
        const draft = data as { stage: "brief"; content: string };
        setOpenStage(draft.stage);
        setEditorText(draft.content);
        setEditorDirty(true);
        setRevisionInstruction("");
        setSelectedShot(null);
        setNotice("创作简报草稿已生成，请检查并保存");
      }
    }); await refresh(); setStreamText(""); }
    catch (caught) { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "生成失败"); }
    finally { setGenerating(false); generationController.current = null; }
  };

  const generatePrompts = async (shotIds?: string[]) => {
    if (!workspace) return;
    setGenerating(true); if (!shotIds) setPromptDrafts({}); setPromptFailures((current) => shotIds ? Object.fromEntries(Object.entries(current).filter(([id]) => !shotIds.includes(id))) : {}); const controller = new AbortController(); generationController.current = controller;
    try { await streamApi(`/api/projects/${workspace.project.id}/generate/prompts`, { ...(shotIds ? { shotIds } : {}), instruction: "" }, controller.signal, ({ event, data }) => {
      if (event === "progress") setPromptProgress(data as { total: number; completed: number; failed: number });
      if (event === "shot") { const item = data as { shotId: string; status: string; bundle?: PromptBundleDto; message?: string }; if (item.status === "completed" && item.bundle) setPromptDrafts((value) => ({ ...value, [item.shotId]: item.bundle! })); else if (item.status === "failed") setPromptFailures((value) => ({ ...value, [item.shotId]: item.message ?? "生成失败" })); }
    }); } catch (caught) { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "生成失败"); } finally { setGenerating(false); generationController.current = null; }
  };

  const saveAllPromptDrafts = async () => {
    if (!workspace) return;
    await Promise.all(Object.entries(promptDrafts).map(([shotId, bundle]) => apiClient.savePrompt(workspace.project.id, shotId, bundle, "批量生成", model)));
    setPromptDrafts({}); setShots(await apiClient.shots(workspace.project.id)); await refresh(); setNotice("全部镜头提示词已保存");
  };

  const deleteProject = async (id: string) => {
    const project = projects.find((item) => item.id === id);
    if (!window.confirm(`确定删除“${project?.name ?? "这个项目"}”吗？此操作会删除新版项目数据。`)) return;
    await apiClient.deleteProject(id);
    const remaining = projects.filter((item) => item.id !== id);
    setProjects(remaining);
    setWorkspace(null);
    setOpenStage(null);
    setSelectedShot(null);
    if (remaining[0]) await loadWorkspace(remaining[0].id);
  };

  const cards = useMemo(() => workspace?.stages.filter((item) => item.stage !== "idea" && item.content) ?? [], [workspace]);

  if (settingsView) return <div className="app-shell"><Sidebar projects={projects} activeId={workspace?.project.id} onSelect={(id) => { void loadWorkspace(id); setSettingsView(false); }} onDelete={(id) => void deleteProject(id)} onNew={() => setShowNew(true)} onSettings={() => undefined} /><SettingsPanel onBack={() => setSettingsView(false)} onNotice={setNotice} />{notice ? <div className="toast" role="status">{notice}</div> : null}</div>;

  return <div className={`app-shell ${openStage || selectedShot ? "has-editor" : ""}`}>
    <a href="#main-content" className="skip-link">跳到主要内容</a>
    <Sidebar projects={projects} activeId={workspace?.project.id} onSelect={(id) => requestNavigation(() => { void loadWorkspace(id); setOpenStage(null); })} onDelete={(id) => requestNavigation(() => { void deleteProject(id); })} onNew={() => setShowNew(true)} onSettings={() => requestNavigation(() => setSettingsView(true))} />
    <main className="workspace" id="main-content">
      {loading ? <div className="center-state">正在打开创作桌面…</div> : null}
      {!loading && !workspace ? <div className="center-state"><span className="empty-reel" aria-hidden="true">▣ ▣ ▣</span><h1>从一句创意开始</h1><p>新建一条短片，让故事、剧本、分镜和提示词沿着同一段对话生长。</p><button className="button button--primary" onClick={() => setShowNew(true)}>新建项目</button></div> : null}
      {workspace ? <>
        <header className="project-header"><div><span className="kicker">{workspace.project.productionType === "anime" ? "动漫短片" : "真人短片"} · {workspace.project.targetDurationSeconds} 秒 · {workspace.project.aspectRatio}</span><h1>{workspace.project.name}</h1></div><span className="local-badge">● 本地保存</span></header>
        <nav className="filmstrip" aria-label="创作阶段">{STAGES.map((item, index) => { const stage = workspace.stages.find((value) => value.stage === item.id)!; const number = String(index + 1).padStart(2, "0"); const statusText = { not_started: "未开始", in_progress: "进行中", saved: "已保存", confirmed: "已确认", stale: "需要重新生成" }[stage.status]; return <button key={item.id} data-testid="stage-frame" className={`film-frame ${workspace.project.currentStage === item.id ? "is-current" : ""}`} aria-label={`${number} ${item.label} ${item.caption} ${statusText}`} onClick={() => item.id !== "idea" && openDocument(item.id)}><span className="frame-number">{number}</span><strong>{item.label}</strong><small>{item.caption}</small><StatusMark status={stage.status} /></button>; })}</nav>
        <section className="chat-column" aria-label="创作对话">
          <div className="conversation-day">当前创作</div>
          {workspace.messages.map((message) => <article key={message.id} className={`message message--${message.role}`}><span className="message__role">{message.role === "user" ? "你" : "搭子"}</span><p>{message.content}</p></article>)}
          {cards.map((document) => <article key={document.stage} className={`summary-card ${document.status === "stale" ? "is-stale" : ""}`}><div className="summary-card__bar"><span>{LABEL[document.stage]}</span><StatusMark status={document.status} /></div><h2>{summarize(document.content).split(/[。！？]/)[0] || LABEL[document.stage]}</h2><p>{summarize(document.content)}</p><button onClick={() => openDocument(document.stage as Exclude<WorkStage, "idea">)}>查看{LABEL[document.stage]}全文 <span aria-hidden="true">→</span></button></article>)}
          {streamText ? <article className="message message--assistant is-streaming"><span className="message__role">搭子</span><p>{streamText}<i className="cursor" /></p></article> : null}
          {workspace.project.currentStage === "prompts" || shots.length ? <section className="prompt-board"><div className="prompt-board__heading"><div><span className="kicker">FINAL PROMPTS</span><h2>逐镜提示词</h2></div><button className="button button--secondary" disabled={generating || !shots.length} onClick={() => void generatePrompts()}>{generating ? "正在生成…" : "生成全部镜头"}</button></div>
            {promptProgress ? <div className="progress" aria-label="生成进度"><span style={{ width: `${promptProgress.total ? ((promptProgress.completed + promptProgress.failed) / promptProgress.total) * 100 : 0}%` }} /><p>{promptProgress.completed + promptProgress.failed} / {promptProgress.total} · {promptProgress.failed ? `${promptProgress.failed} 个失败` : "正在逐镜生成"}</p></div> : null}
            {Object.keys(promptFailures).length ? <div className="prompt-failures"><strong>生成失败</strong>{Object.entries(promptFailures).map(([shotId, message]) => <p key={shotId}>{shots.find((shot) => shot.id === shotId)?.title ?? shotId}：{message}</p>)}<button className="button button--ghost" disabled={generating} onClick={() => void generatePrompts(Object.keys(promptFailures))}>只重试失败镜头</button></div> : null}
            <div className="shot-grid">{shots.map((shot) => { const draft = promptDrafts[shot.id]; return <button className="shot-card" key={shot.id} onClick={() => requestNavigation(() => { setSelectedShot(shot); setOpenStage(null); setEditorDirty(false); })}><span>SHOT {String(shot.sequence).padStart(2, "0")}</span><strong>{shot.title}</strong><p>{shot.summary}</p><em>{draft ? "待保存" : shot.promptStatus === "stale" ? "需要重新生成" : shot.prompt ? `版本 ${shot.prompt.versionNumber}` : "等待生成"}</em></button>; })}</div>
            {Object.keys(promptDrafts).length ? <button className="button button--primary save-all" onClick={() => void saveAllPromptDrafts()}>保存全部生成结果</button> : null}
            {shots.length > 0 && shots.every((shot) => ["saved", "confirmed"].includes(shot.promptStatus)) ? promptStage?.status === "confirmed" ? <button className="button button--ghost save-all" onClick={async () => { setWorkspace(await apiClient.stageAction(workspace.project.id, "prompts", "reopen")); setNotice("提示词已重新开放编辑"); }}>重新编辑提示词</button> : <button className="button button--secondary save-all" onClick={async () => { setWorkspace(await apiClient.stageAction(workspace.project.id, "prompts", "confirm")); setShots(await apiClient.shots(workspace.project.id)); setNotice("全部提示词已确认"); }}>确认全部提示词</button> : null}
            {shots.some((shot) => shot.prompt) ? <div className="export-row"><span>使用已保存提示词</span><button className="text-button" onClick={async () => { await copyText(shots.flatMap((shot) => shot.prompt ? [`镜头 ${shot.sequence} · ${shot.title}\n${formatBundle(shot.prompt.bundle)}`] : []).join("\n\n---\n\n")); setNotice("全部提示词已复制"); }}>复制全部</button><button className="text-button" onClick={() => void downloadPrompts(workspace.project.id, "md")}>Markdown ZIP</button><button className="text-button" onClick={() => void downloadPrompts(workspace.project.id, "txt")}>纯文本 ZIP</button></div> : null}
          </section> : null}
          <div className="composer"><textarea aria-label="创意对话输入" value={conversationInput} onChange={(event) => setConversationInput(event.target.value)} placeholder="说说你的创意，或回答搭子的一个问题…" onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendConversation(); } }} /><div className="composer__footer"><span>Enter 发送 · Shift + Enter 换行</span>{generating ? <button className="stop-button" onClick={() => generationController.current?.abort()}>停止</button> : <button className="send-button" disabled={!conversationInput.trim()} onClick={() => void sendConversation()} aria-label="发送">↑</button>}</div></div>
        </section>
      </> : null}
    </main>

    {openStage && workspace ? <aside className="editor-dock" aria-label={`${LABEL[openStage]}编辑器`}><header className="editor-heading"><div><span className="kicker">STAGE {String(STAGES.findIndex((item) => item.id === openStage) + 1).padStart(2, "0")}</span><h2>{LABEL[openStage]}</h2></div><button className="icon-button" onClick={() => requestNavigation(() => setOpenStage(null))} aria-label="关闭编辑器">×</button></header><div className="editor-tools"><StatusMark status={activeDocument?.status ?? "not_started"} /><button className="text-button" disabled={generating || activeDocument?.status === "confirmed"} onClick={() => void startStageGeneration()}>{activeDocument?.content ? "用 DeepSeek 重新生成" : "用 DeepSeek 生成草稿"}</button></div><textarea className="document-editor" aria-label={`${LABEL[openStage]}内容`} readOnly={activeDocument?.status === "confirmed"} value={editorText} onChange={(event) => { setEditorText(event.target.value); setEditorDirty(true); }} placeholder={openStage === "storyboard" ? "镜头 1：标题｜画面摘要" : `在这里编辑${LABEL[openStage]}…`} />{openStage === "storyboard" ? <p className="editor-hint">每行使用“镜头 1：标题｜画面摘要”，保存后会建立逐镜提示词卡片。</p> : null}<label className="revision-request">具体修改要求<textarea value={revisionInstruction} onChange={(event) => setRevisionInstruction(event.target.value)} placeholder="例如：缩短对白，让情绪更克制" /></label><footer className="editor-footer">{activeDocument?.status === "confirmed" ? <button className="button button--secondary" onClick={async () => { setWorkspace(await apiClient.stageAction(workspace.project.id, openStage, "reopen")); setEditorDirty(false); }}>重新编辑</button> : <><button className="button button--secondary" disabled={!editorDirty || !editorText.trim()} onClick={() => void saveDocument().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "保存失败"))}>保存</button><button className="button button--primary" disabled={editorDirty || activeDocument?.status !== "saved"} onClick={() => void confirmDocument()}>确认此阶段</button></>}</footer></aside> : null}
    {selectedShot && workspace ? <PromptEditor projectId={workspace.project.id} shot={selectedShot} draft={promptDrafts[selectedShot.id]} model={model} locked={promptStage?.status === "confirmed"} onClose={() => requestNavigation(() => setSelectedShot(null))} onDirty={setEditorDirty} onSaved={async () => { setShots(await apiClient.shots(workspace.project.id)); await refresh(); setPromptDrafts((current) => { const next = { ...current }; delete next[selectedShot.id]; return next; }); setNotice("提示词新版本已保存"); }} /> : null}

    {showNew ? <NewProjectDialog onClose={() => setShowNew(false)} onCreated={async (project) => { setProjects((items) => [project, ...items]); await loadWorkspace(project.id); setShowNew(false); }} /> : null}
    {leaveTarget ? <div className="modal-backdrop"><section className="modal modal--compact" role="dialog" aria-modal="true" aria-label="尚未保存"><span className="kicker">UNSAVED CHANGES</span><h2>尚未保存</h2><p>当前修改只在页面中。你想怎样处理？</p><div className="leave-actions"><button className="button button--primary" onClick={async () => { await saveDocument(); setLeaveTarget(null); leaveTarget(); }}>保存并继续</button><button className="button button--danger-text" onClick={() => { setEditorDirty(false); setLeaveTarget(null); leaveTarget(); }}>放弃修改</button><button className="button button--ghost" onClick={() => setLeaveTarget(null)}>留在此处</button></div></section></div> : null}
    {notice ? <div className="toast" role="status" onAnimationEnd={() => setNotice("")}>{notice}</div> : null}
    {error ? <div className="error-toast" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label="关闭错误">×</button></div> : null}
  </div>;
}

function Sidebar({ projects, activeId, onSelect, onDelete, onNew, onSettings }: { projects: ProjectDto[]; activeId: string | undefined; onSelect: (id: string) => void; onDelete: (id: string) => void; onNew: () => void; onSettings: () => void }) {
  return <aside className="sidebar"><div className="brand"><span className="brand__mark" aria-hidden="true">羽</span><div><strong>漫剧笔搭子</strong><small>从灵感到提示词</small></div></div><button className="new-project" onClick={onNew}><span>＋</span>新建项目</button><div className="project-list"><p>我的短片</p>{projects.map((project) => <div className={`project-row ${activeId === project.id ? "is-active" : ""}`} key={project.id}><button className="project-open" onClick={() => onSelect(project.id)}><span className="project-thumb" aria-hidden="true">{project.productionType === "anime" ? "漫" : "影"}</span><span><strong>{project.name}</strong><small>{project.aspectRatio} · {project.targetDurationSeconds} 秒</small></span></button><button className="project-delete" aria-label={`删除项目 ${project.name}`} onClick={() => onDelete(project.id)}>×</button></div>)}</div><button className="settings-button" onClick={onSettings}><span aria-hidden="true">⚙</span>设置</button></aside>;
}
